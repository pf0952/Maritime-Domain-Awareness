"""Routes: kept, planned and checked against NOAA's charts. A planning aid only, not for navigation.

A route is waypoints, each with the leg that runs on to the next (rhumb line or great circle, its cross-track
distance and speed), and the vessel it's for (draught, air draught, the under-keel clearance wanted).

Planning lays a route between two points: inshore, by A* across a grid of the finest charts' depth areas, keeping out
of water shallower than the draught and the clearance, and off land and hazards; offshore, along searoute's shipping
lanes. Checking runs each leg's corridor across the charts: shallow water, land, hazards, restricted areas, and
bridges, with the clearance under each at the tide on arrival."""
import functools
import heapq
import json
import math
import threading
import time
from pathlib import Path

import numpy as np
import pyogrio
import rasterio.features
import rasterio.transform
import searoute
import shapely

import charts
import route
import sync
import tides

STORE = Path(__file__).parent.parent / "enc" / "routes.json"
NM = 1852  # m
METRES = 111_320  # to a degree of latitude
FINEST = 6  # the charts' finest band
OFFSHORE = 60  # nm: further apart than this, the middle of a route follows the shipping lanes
COAST_RUN = 25  # nm along the lanes from each end that's planned through the charts instead
GRID_CELLS = 500  # across the longer side of a planning grid, at most
GRID_CELL = 40  # m, at the least
PAD = 0.3  # of the span, round a planning grid, and never less than PAD_NM
PAD_NM = 3
KEEP_OFF = 3  # cells: water this near the unsafe costs more, so routes keep to the middle of channels
UNCHARTED_COST = 3  # water outside NOAA's charts: allowed, but not chosen over charted water
BAND_COST = 4  # a depth band whose shallow end is under the depth wanted and deep end over: allowed, if no sounding
# in it is too shallow, but kept out of where there's better
BLOCKED_COST = 1000  # water too shallow, land or a hazard: only where there's no other way, as to a berth in shallows
HAZARD_M = 50  # m kept off a wreck, rock, obstruction or sounding too shallow to pass over
XTD = 0.1  # nm either side of a leg, when a route gives none
SPEED = 10  # knots, when a route gives none
HAZARDS = ("WRECKS", "UWTROC", "OBSTRN")
RESTRICTED = {2: "nature reserve", 4: "nature reserve", 7: "bird sanctuary",
              8: "game reserve", 9: "seal sanctuary", 12: "anchoring prohibited", 14: "military area",
              17: "fishing prohibited", 20: "no wake area", 22: "speed restricted", 24: "military firing area",
              25: "historic wreck area", 26: "seaplane landing area"}  # CATREA, those worth naming


# --- kept routes


store_lock = threading.Lock()  # (two saves at once would each write back what the other hadn't seen)


def load() -> dict:
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write(kept: dict) -> dict:
    """All of them, at once: the whole file appears, or none of it."""
    STORE.parent.mkdir(parents=True, exist_ok=True)
    fresh = STORE.with_suffix(".tmp")
    fresh.write_text(json.dumps(kept, indent=1), encoding="utf-8")
    fresh.replace(STORE)
    return kept


def save(name: str, route: dict) -> dict:
    with store_lock:
        kept = load()
        kept[name] = {**route, "name": name}
        return write(kept)


def delete(name: str) -> dict:
    with store_lock:
        kept = load()
        kept.pop(name, None)
        return write(kept)


# --- the charts along a route


def safe_depth(vessel: dict) -> float:
    return float(vessel.get("draught") or 0) + float(vessel.get("ukc") or 0)


def cell(name: str) -> dict:
    """A chart's water, land, hazards, restricted areas and bridges, as shapely arrays with what matters of each: as
    the edition of it on disk now has them."""
    return read_cell(name, sync.on_disk.get(name))


@functools.lru_cache(maxsize=32)  # (a big harbour chart is ~10 MB read, and takes a second or two)
def read_cell(name: str, version) -> dict:
    """cell's, kept by edition: a NOAA update is a new key, read afresh."""
    path = sync.cell_path(sync.catalog.by_name[name])
    layers = set(pyogrio.list_layers(path)[:, 0])

    def read(layer, columns=()):
        if layer not in layers:
            return None
        frame = pyogrio.read_dataframe(path, layer=layer, columns=list(columns))
        return frame[~frame.geometry.isna() & ~frame.geometry.is_empty]

    number = lambda v: None if v is None or np.isnan(v) else float(v)
    water_parts = [charts.polygons(path, layer, ("DRVAL1", "DRVAL2")) for layer in ("DEPARE", "DRGARE")]
    water = [(g, number(d1), number(d2)) for frame in water_parts for g, d1, d2 in zip(frame.geometry, frame["DRVAL1"], frame["DRVAL2"])]
    soundings = np.empty((0, 3))
    frame = read("SOUNDG")
    if frame is not None and len(frame):
        soundings = shapely.get_coordinates(frame.geometry.to_numpy(), include_z=True)
    land = charts.polygons(path, "LNDARE").geometry.to_list()
    hazards = []
    for layer in HAZARDS:
        frame = read(layer, ("VALSOU", "OBJNAM"))
        if frame is not None:
            for g, sounding, name in zip(frame.geometry, frame["VALSOU"], frame["OBJNAM"]):
                hazards.append((g, None if sounding is None or np.isnan(sounding) else float(sounding),
                                layer, name if isinstance(name, str) else None))
    restricted = []
    frame = read("RESARE", ("CATREA", "OBJNAM"))
    if frame is not None:
        for g, kinds, name in zip(frame.geometry, frame["CATREA"], frame["OBJNAM"]):
            kind = next((RESTRICTED[k] for k in charts.numbers(kinds) if k in RESTRICTED), None)
            if kind and g.geom_type in ("Polygon", "MultiPolygon"):
                restricted.append((g, kind, name if isinstance(name, str) else None))
    bridges = []
    frame = read("BRIDGE", ("VERCLR", "VERCCL", "OBJNAM"))
    if frame is not None:
        for g, clear, closed, name in zip(frame.geometry, frame["VERCLR"], frame["VERCCL"], frame["OBJNAM"]):
            c = clear if clear is not None and not np.isnan(clear) else closed
            bridges.append((g, None if c is None or np.isnan(c) else float(c), name if isinstance(name, str) else None))
    return {"water": water, "soundings": soundings, "land": land, "hazards": hazards, "restricted": restricted, "bridges": bridges}


def depth_kind(shallow: float | None, deep: float | None, wanted: float) -> int:
    """1: deep enough everywhere; 3: a band reaching both sides of the depth wanted; 2: too shallow everywhere."""
    if shallow is not None and shallow >= wanted:
        return 1
    if deep is not None and deep >= wanted:
        return 3
    return 2


def charted(area: shapely.Geometry) -> list:
    """The finest charts over an area, finest first, each with the part of the area it has to itself."""
    picked, taken = [], shapely.Polygon()
    for chart in sync.catalog.pick(area, FINEST):
        own = chart.cover.difference(taken)
        taken = taken.union(chart.cover)
        picked.append((chart.name, own))
    return picked


# --- planning


def plan(start: list, end: list, vessel: dict, xtd: float = XTD) -> dict:
    """Waypoints from start to end, [lng, lat] each, and notes on how it was laid."""
    notes = []
    span = rhumb_nm(start, end)
    if span > OFFSHORE:
        try:
            lanes = searoute.searoute(start, end, units="naut")["geometry"]["coordinates"]
        except Exception as e:  # (searoute raises plain errors for points it can't place)
            lanes = None
            notes.append(f"No shipping lane found ({e}): planned straight across")
        if lanes and len(lanes) > 2:
            out = point_along(lanes, COAST_RUN)
            back = point_along(lanes[::-1], COAST_RUN)
            middle = [p for p in lanes if rhumb_nm(p, start) > COAST_RUN and rhumb_nm(p, end) > COAST_RUN]
            head = grid_route(start, out, vessel, xtd, notes)
            tail = grid_route(back, end, vessel, xtd, notes)
            # the lanes know nothing of draught: a leg of them that runs over shallows is laid through the charts instead
            lane = [out] + simplify_lanes(middle) + [back]
            mended = [lane[0]]
            for a, b in zip(lane, lane[1:]):
                mended += grid_route(a, b, vessel, xtd, notes)[1:] if leg_blocked(a, b, vessel, xtd) else [b]
            points = head + mended[1:-1] + tail
            notes.append("Offshore, it follows the shipping lanes; inshore, the charts")
            return {"waypoints": dedupe(points), "notes": notes}
    return {"waypoints": dedupe(grid_route(start, end, vessel, xtd, notes)), "notes": notes}


def grid_route(start: list, end: list, vessel: dict, xtd: float, notes: list) -> list:
    """A* across the charts between two points, then cut down to the fewest legs whose cross-track band stays out of
    unsafe water, where the channel's wide enough for that."""
    lat0 = (start[1] + end[1]) / 2
    across = METRES * math.cos(math.radians(lat0))
    span_m = math.hypot((end[0] - start[0]) * across, (end[1] - start[1]) * METRES)
    pad = max(span_m * PAD, PAD_NM * NM)
    west, east = min(start[0], end[0]) - pad / across, max(start[0], end[0]) + pad / across
    south, north = min(start[1], end[1]) - pad / METRES, max(start[1], end[1]) + pad / METRES
    size = max(GRID_CELL, max((east - west) * across, (north - south) * METRES) / GRID_CELLS)
    cols = max(2, int((east - west) * across / size))
    rows = max(2, int((north - south) * METRES / size))
    transform = rasterio.transform.from_bounds(west, south, east, north, cols, rows)
    # 0: no NOAA chart, 1: deep enough, 3: a band reaching both sides of the depth wanted, 2: too shallow, land or a
    # hazard. Coarsest first, so the finer charts win
    grid = np.zeros((rows, cols), dtype=np.uint8)
    area = shapely.box(west, south, east, north)
    picked = charted(area)
    depth = safe_depth(vessel)
    for name, own in reversed(picked):
        found = cell(name)
        shapes = [(g, depth_kind(d1, d2, depth)) for g, d1, d2 in found["water"]]
        shapes += [(g, 2) for g in found["land"]]
        if shapes:
            rasterio.features.rasterize(shapes, out=grid, transform=transform)
    hazard_mask = np.zeros_like(grid)
    for name, own in picked:
        found = cell(name)
        stops = [g for g, sounding, *_ in found["hazards"] if sounding is None or sounding < depth]
        shallow = found["soundings"][found["soundings"][:, 2] < depth]
        if len(shallow):
            inside = shapely.contains_xy(own, shallow[:, 0], shallow[:, 1])
            stops += list(shapely.points(shallow[inside, :2]))
        if stops:
            rasterio.features.rasterize([(g, 1) for g in stops], out=hazard_mask, transform=transform, all_touched=True)
    blocked = (grid == 2) | grow(hazard_mask == 1, round(HAZARD_M / size))
    near = grow(blocked, KEEP_OFF) & ~blocked
    cost = np.select([grid == 0, grid == 3], [UNCHARTED_COST, BAND_COST], 1.0) + near * 2.0
    cost[blocked] = BLOCKED_COST
    to_cell = lambda p: (int((north - p[1]) / (north - south) * rows), int((p[0] - west) / (east - west) * cols))
    to_point = lambda r, c: [west + (c + 0.5) * (east - west) / cols, north - (r + 0.5) * (north - south) / rows]
    a, b = clamp(to_cell(start), rows, cols), clamp(to_cell(end), rows, cols)
    path = astar(cost, a, b)
    if not path:
        notes.append("No way was found: laid straight, check it")
        return [start, end]
    if (cost[tuple(np.array(path).T)] >= BLOCKED_COST).any():
        notes.append("Part of it has to cross water too shallow, land or a hazard, as to a berth in shallows: check it")
    if (grid[tuple(np.array(path).T)] == 0).any():
        notes.append("Part of it is outside NOAA's charts, where nothing could be checked")
    band = cost.copy()
    band[grow(blocked, math.ceil(xtd * NM / size))] = BLOCKED_COST
    # (shallows round the ends, as a berth's, are crossed in a straight run rather than a waypoint a cell)
    reach = max(2, NM / size)
    rr, cc = np.ogrid[:rows, :cols]
    for r0, c0 in (a, b):
        ends = (rr - r0) ** 2 + (cc - c0) ** 2 <= reach**2
        band[ends] = np.minimum(band[ends], UNCHARTED_COST)
        cost = cost.copy()
        cost[ends] = np.minimum(cost[ends], UNCHARTED_COST)
    keep = [0]
    while keep[-1] < len(path) - 1:
        i = keep[-1]
        j = len(path) - 1
        while j > i + 1 and not (clear_line(band, path[i], path[j]) or (band[path[i]] >= BLOCKED_COST and clear_line(cost, path[i], path[j]))):
            j = max(i + 1, (i + j) // 2) if j - i > 64 else j - 1
        keep.append(j)
    points = [to_point(*path[k]) for k in keep]
    # (where it had to cross the shallows, the cut above leaves a waypoint a cell: those in line are merged)
    inline = shapely.LineString([start] + points[1:-1] + [end]).simplify(0.5 * size / METRES)
    return [list(p) for p in inline.coords]


def leg_blocked(a: list, b: list, vessel: dict, xtd: float) -> bool:
    """Whether a straight leg's band crosses water too shallow everywhere, land, or a sounding or hazard too shallow."""
    depth = safe_depth(vessel)
    _, band = corridor(a, b, xtd, False)
    for name, own in charted(band):
        here = band.intersection(own)
        if here.is_empty:
            continue
        data = cell(name)
        if any(depth_kind(d1, d2, depth) == 2 and g.intersects(here) for g, d1, d2 in data["water"]):
            return True
        if any(g.intersects(here) for g in data["land"]):
            return True
        spots = data["soundings"]
        if len(spots) and shapely.contains_xy(here, *spots[spots[:, 2] < depth][:, :2].T).any():
            return True
    return False


def grow(mask: np.ndarray, cells: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(cells):
        step = out.copy()
        step[1:] |= out[:-1]
        step[:-1] |= out[1:]
        step[:, 1:] |= out[:, :-1]
        step[:, :-1] |= out[:, 1:]
        out = step
    return out


def clamp(rc: tuple, rows: int, cols: int) -> tuple:
    return min(max(rc[0], 0), rows - 1), min(max(rc[1], 0), cols - 1)


def astar(cost: np.ndarray, a: tuple, b: tuple) -> list:
    rows, cols = cost.shape
    steps = [(-1, 0, 1), (1, 0, 1), (0, -1, 1), (0, 1, 1), (-1, -1, 1.4142), (-1, 1, 1.4142), (1, -1, 1.4142), (1, 1, 1.4142)]
    best = {a: 0.0}
    came = {}
    queue = [(0.0, a)]
    guess = lambda p: math.hypot(p[0] - b[0], p[1] - b[1])
    while queue:
        _, here = heapq.heappop(queue)
        if here == b:
            path = [here]
            while here in came:
                here = came[here]
                path.append(here)
            return path[::-1]
        so_far = best[here]
        for dr, dc, length in steps:
            r, c = here[0] + dr, here[1] + dc
            if not (0 <= r < rows and 0 <= c < cols):
                continue
            step = cost[r, c]
            total = so_far + length * step
            if total < best.get((r, c), math.inf):
                best[(r, c)] = total
                came[(r, c)] = here
                heapq.heappush(queue, (total + guess((r, c)), (r, c)))
    return []


def clear_line(cost: np.ndarray, a: tuple, b: tuple) -> bool:
    """Whether a straight leg between two cells stays out of blocked ones."""
    n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) * 2) + 1
    rs = np.rint(np.linspace(a[0], b[0], n)).astype(int)
    cs = np.rint(np.linspace(a[1], b[1], n)).astype(int)
    return not (cost[rs, cs] >= BLOCKED_COST).any()


rhumb_nm = route.nm  # (nautical miles, flat about the middle latitude: near enough for a leg)


def point_along(line: list, nm: float) -> list:
    gone = 0.0
    for p, q in zip(line, line[1:]):
        step = rhumb_nm(p, q)
        if gone + step >= nm:
            f = (nm - gone) / (step or 1)
            return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]
        gone += step
    return line[-1]


def simplify_lanes(points: list) -> list:
    if len(points) < 3:
        return points
    return [list(p) for p in shapely.LineString(points).simplify(0.05).coords]


def dedupe(points: list) -> list:
    out = []
    for p in points:
        if not out or rhumb_nm(out[-1], p) > 0.01:
            out.append([round(p[0], 6), round(p[1], 6)])
    return out


# --- checking


def corridor(a: list, b: list, xtd_nm: float, great: bool) -> tuple:
    """A leg's line, and the band either side of it, in degrees."""
    points = great_circle(a, b) if great else [a, b]
    line = shapely.LineString(points)
    lat = math.radians((a[1] + b[1]) / 2)
    squash = math.cos(lat)
    flat = shapely.transform(line, lambda xy: xy * [squash, 1])
    band = shapely.transform(shapely.buffer(flat, xtd_nm * NM / METRES, cap_style="round"), lambda xy: xy / [squash, 1])
    return line, band


def great_circle(a: list, b: list, steps: int = 32) -> list:
    (l1, p1), (l2, p2) = [(math.radians(x), math.radians(y)) for x, y in (a, b)]
    v1 = np.array([math.cos(p1) * math.cos(l1), math.cos(p1) * math.sin(l1), math.sin(p1)])
    v2 = np.array([math.cos(p2) * math.cos(l2), math.cos(p2) * math.sin(l2), math.sin(p2)])
    angle = math.acos(max(-1.0, min(1.0, float(v1 @ v2))))
    if angle < 1e-9:
        return [a, b]
    out = []
    for k in range(steps + 1):
        f = k / steps
        v = (math.sin((1 - f) * angle) * v1 + math.sin(f * angle) * v2) / math.sin(angle)
        out.append([math.degrees(math.atan2(v[1], v[0])), math.degrees(math.asin(v[2]))])
    return out


def check(route: dict) -> list:
    """Each leg's findings, worst first: { kind, text, at: [lng, lat], severity: 'danger' | 'caution' | 'info' }."""
    vessel = route.get("vessel") or {}
    depth = safe_depth(vessel)
    air = vessel.get("air_draught")
    waypoints = route.get("waypoints") or []
    start = route.get("departure") or time.time()
    when = float(start)
    found = []
    for i, (a, b) in enumerate(zip(waypoints, waypoints[1:])):
        leg = b.get("leg") or {}  # (as in RTZ: a waypoint carries the leg that runs to it)
        speed = float(leg.get("speed") or route.get("speed") or SPEED)
        xtd = float(leg.get("xtd") or route.get("xtd") or XTD)
        pa, pb = [a["lng"], a["lat"]], [b["lng"], b["lat"]]
        line, band = corridor(pa, pb, xtd, leg.get("geometry") == "great")
        issues = []
        covered = shapely.Polygon()
        for name, own in charted(band):
            here = band.intersection(own)
            if here.is_empty:
                continue
            covered = covered.union(here)
            data = cell(name)
            bands = [(d1, d2, depth_kind(d1, d2, depth)) for g, d1, d2 in data["water"] if g.intersects(here)]
            too = [d1 for d1, d2, kind in bands if kind == 2]
            if too:
                issues.append(("danger", "shallow", f"Water {min(d for d in too if d is not None) if any(d is not None for d in too) else 0:.1f} m deep at chart datum, under the {depth:.1f} m wanted", here))
            spots = data["soundings"]
            spots = spots[spots[:, 2] < depth] if len(spots) else spots
            if len(spots):
                hit = shapely.contains_xy(here, spots[:, 0], spots[:, 1])
                if hit.any():
                    worst = spots[hit][spots[hit][:, 2].argmin()]
                    issues.append(("danger", "shallow", f"Sounding of {worst[2]:.1f} m, under the {depth:.1f} m wanted", shapely.Point(worst[:2])))
            straddle = [(d1, d2) for d1, d2, kind in bands if kind == 3]
            if straddle:
                d1, d2 = min(straddle, key=lambda b: b[0] or 0)
                issues.append(("caution", "depth band", f"Depth band {d1 or 0:.1f} to {d2:.1f} m: no sounding under the {depth:.1f} m wanted here, but check", here))
            if any(g.intersects(here) for g in data["land"]):
                issues.append(("danger", "land", "Land within the cross-track distance", here))
            for g, sounding, layer, hname in data["hazards"]:
                if g.intersects(here) and (sounding is None or sounding < depth):
                    what = {"WRECKS": "Wreck", "UWTROC": "Rock", "OBSTRN": "Obstruction"}[layer]
                    over = f", {sounding:.1f} m over it" if sounding is not None else ", depth over it unknown"
                    issues.append(("danger", "hazard", f"{what}{f' ({hname})' if hname else ''}{over}", g))
            for g, kind, rname in data["restricted"]:
                if g.intersects(here):
                    issues.append(("caution", "restricted", f"Restricted area: {kind}{f', {rname}' if rname else ''}", g))
            for g, clear, bname in data["bridges"]:
                if not g.intersects(line):
                    continue
                at = line.intersection(g).representative_point()
                eta = when + rhumb_nm(pa, [at.x, at.y]) / speed * 3600
                issues.append(bridge_finding(g, clear, bname, at, eta, air))
        outside = band.difference(covered)
        if outside.area > band.area * 0.02:
            issues.append(("caution", "uncharted", "Part of this leg is outside NOAA's charts: not checked", outside))
        when += rhumb_nm(pa, pb) / speed * 3600
        order = {"danger": 0, "caution": 1, "info": 2}
        for severity, kind, text, where in sorted(issues, key=lambda x: order[x[0]]):
            p = where.representative_point() if not isinstance(where, shapely.Point) else where
            found.append({"leg": i, "severity": severity, "kind": kind, "text": text, "at": [round(p.x, 6), round(p.y, 6)]})
    return dedupe_findings(found)


def bridge_finding(g, clear, name, at, eta, air) -> tuple:
    title = name or "Bridge"
    if clear is None:
        return ("caution", "bridge", f"{title}: the chart gives no clearance", at)
    level, mhw = tide_at(at.x, at.y, eta)
    if level is None or mhw is None:
        room, said = clear, f"{clear:.1f} m above MHW (no tide for the time of passing)"
    else:
        room = clear + mhw - level
        said = f"{room:.1f} m at the tide when passing ({clear:.1f} m above MHW)"
    if air is None:
        return ("info", "bridge", f"{title}: {said}; give an air draught to check it", at)
    air = float(air)
    if room < air:
        return ("danger", "bridge", f"{title}: {said}, under the air draught of {air:.1f} m", at)
    return ("info", "bridge", f"{title}: {said}, {room - air:.1f} m over the air draught", at)


def tide_at(lng: float, lat: float, when: float) -> tuple:
    """The water's height above datum at a time, and MHW, from the nearest station: None for either if unknown."""
    try:
        _, station = tides.nearest(lat, lng)
        if station is None:
            return None, None
        series = tides.series(station)
    except (OSError, ValueError):
        return None, None
    hours = (when - series["now"]) / 3600
    index = hours + tides.HOURS
    levels = series["levels"]
    if not 0 <= index <= len(levels) - 1:
        return None, series.get("mhw")
    low = int(math.floor(index))
    high = min(low + 1, len(levels) - 1)
    return levels[low] + (levels[high] - levels[low]) * (index - low), series.get("mhw")


def dedupe_findings(found: list) -> list:
    """One of each finding a leg has: a shallow patch seen in three charts is one patch. A restricted area once a
    route, where it's first entered."""
    seen, out = set(), []
    for f in found:
        key = (f["kind"], f["text"]) if f["kind"] == "restricted" else (f["leg"], f["kind"], f["text"])
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out
