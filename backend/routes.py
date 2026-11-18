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
            notes.append(f"No shipping lane found ({e}); route laid direct")
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
            notes.append("Offshore sections follow shipping lanes; inshore sections are planned on the charts")
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
        notes.append("No safe path found; route laid direct. Check the route")
        return [start, end]
    if (cost[tuple(np.array(path).T)] >= BLOCKED_COST).any():
        notes.append("Route crosses shallow water, land or a hazard (e.g. at a berth in shallow water). Check the route")
    if (grid[tuple(np.array(path).T)] == 0).any():
        notes.append("Part of the route is outside NOAA charts and was not checked")
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
                issues.append(("danger", "shallow", f"Charted depth {min(d for d in too if d is not None) if any(d is not None for d in too) else 0:.1f} m, less than {depth:.1f} m required", here))
            spots = data["soundings"]
            spots = spots[spots[:, 2] < depth] if len(spots) else spots
            if len(spots):
                hit = shapely.contains_xy(here, spots[:, 0], spots[:, 1])
                if hit.any():
                    worst = spots[hit][spots[hit][:, 2].argmin()]
                    issues.append(("danger", "shallow", f"Sounding {worst[2]:.1f} m, less than {depth:.1f} m required", shapely.Point(worst[:2])))
            straddle = [(d1, d2) for d1, d2, kind in bands if kind == 3]
            if straddle:
                d1, d2 = min(straddle, key=lambda b: b[0] or 0)
                issues.append(("caution", "depth band", f"Depth area {d1 or 0:.1f}–{d2:.1f} m spans {depth:.1f} m required; no shallower sounding charted. Verify", here))
            if any(g.intersects(here) for g in data["land"]):
                issues.append(("danger", "land", "Land within cross-track limit", here))
            for g, sounding, layer, hname in data["hazards"]:
                if g.intersects(here) and (sounding is None or sounding < depth):
                    what = {"WRECKS": "Wreck", "UWTROC": "Rock", "OBSTRN": "Obstruction"}[layer]
                    over = f", least depth {sounding:.1f} m" if sounding is not None else ", least depth unknown"
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
            issues.append(("caution", "uncharted", "Leg partly outside NOAA charts; not checked", outside))
        when += rhumb_nm(pa, pb) / speed * 3600
        order = {"danger": 0, "caution": 1, "info": 2}
        for severity, kind, text, where in sorted(issues, key=lambda x: order[x[0]]):
            p = where.representative_point() if not isinstance(where, shapely.Point) else where
            found.append({"leg": i, "severity": severity, "kind": kind, "text": text, "at": [round(p.x, 6), round(p.y, 6)]})
    return dedupe_findings(found)


def bridge_finding(g, clear, name, at, eta, air) -> tuple:
    title = name or "Bridge"
    if clear is None:
        return ("caution", "bridge", f"{title}: no charted clearance", at)
    level, mhw = tide_at(at.x, at.y, eta)
    if level is None or mhw is None:
        room, said = clear, f"clearance {clear:.1f} m above MHW (no tide prediction for time of passage)"
    else:
        room = clear + mhw - level
        said = f"clearance {room:.1f} m at predicted tide ({clear:.1f} m above MHW)"
    if air is None:
        return ("info", "bridge", f"{title}: {said}; enter air draught to check", at)
    air = float(air)
    if room < air:
        return ("danger", "bridge", f"{title}: {said}, less than air draught {air:.1f} m", at)
    return ("info", "bridge", f"{title}: {said}, {room - air:.1f} m above air draught", at)


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


# --- ports, their approaches, and a voyage through the forecast

APPROACH_REACH = 25  # nm round a port to look for its pilot boarding place or fairway buoy
APPROACH_FAR = 60  # nm, then, for a port far up a river or channel
SAMPLE_HOURS = 1.0  # of steaming between looks at the forecast along a leg


def find_ports(q: str, most: int = 12) -> list:
    """Ports by name or code, those whose name starts so first."""
    import route

    by_code, by_name = route.ports()
    q = q.strip().upper()
    if not q:
        return []
    hits = [p for c, p in by_code.items() if c.upper().replace(" ", "") == q.replace(" ", "")]
    starts = [p for n, p in by_name.items() if n.startswith(q)]
    within = [p for n, p in by_name.items() if q in n and not n.startswith(q)]
    seen, out = set(), []
    for p in hits + starts + within:
        if p["code"] not in seen:
            seen.add(p["code"])
            out.append({"code": p["code"], "name": p["name"], "lng": p["lng"], "lat": p["lat"]})
        if len(out) >= most:
            break
    return out


@functools.lru_cache(maxsize=64)
def approach_marks(name: str, version) -> list:
    """A chart's pilot boarding places and safe-water (fairway) buoys: (kind, name, lng, lat)."""
    path = sync.cell_path(sync.catalog.by_name[name])
    layers = set(pyogrio.list_layers(path)[:, 0])
    marks = []
    for layer, kind in (("PILBOP", "pilot boarding place"), ("BOYSAW", "fairway buoy")):
        if layer in layers:
            frame = pyogrio.read_dataframe(path, layer=layer, columns=["OBJNAM"])
            for g, n in zip(frame.geometry, frame["OBJNAM"]):
                if g is not None and not g.is_empty:
                    p = g.representative_point()
                    marks.append((kind, n if isinstance(n, str) else None, p.x, p.y))
    return marks


def approach(lng: float, lat: float) -> dict:
    """Where a voyage to or from a port begins at sea: the nearest charted pilot boarding place within reach of it,
    or else the outermost fairway buoy; looking further out for a port far up a river or channel; failing all of
    those, the port itself."""
    for reach in (APPROACH_REACH, APPROACH_FAR):
        found = approach_within(lng, lat, reach)
        if found:
            return found
    return {"lng": lng, "lat": lat, "kind": "port", "name": None, "nm_from_port": 0.0}


def approach_within(lng: float, lat: float, reach: float):
    pad = reach / 60
    area = shapely.box(lng - pad / max(math.cos(math.radians(lat)), 0.2), lat - pad,
                       lng + pad / max(math.cos(math.radians(lat)), 0.2), lat + pad)
    found = []
    # (coastal and approach charts first: that's where sea buoys and pilot stations are charted)
    for chart in sorted(sync.catalog.over(area), key=lambda c: (c.band > 4, c.band))[:24]:
        found += approach_marks(chart.name, sync.on_disk.get(chart.name))
    for kind in ("pilot boarding place", "fairway buoy"):
        near = [(rhumb_nm([lng, lat], [x, y]), name, x, y) for k, name, x, y in found if k == kind]
        near = [n for n in near if n[0] <= reach]
        if near:
            # the pilots' nearest place; the sea buoy, the outermost fairway buoy, where the channel begins
            d, name, x, y = min(near) if kind == "pilot boarding place" else max(near)
            return {"lng": round(x, 6), "lat": round(y, 6), "kind": kind, "name": name, "nm_from_port": round(d, 1)}
    return None


def forecast_at(points: list, hours: list, now: float) -> list:
    """The forecast at each place at the hour the vessel is there (None past it, or over land): waves, their
    period, swell, wind and current."""
    import weather

    snapped = [(round(round(lat / 0.5) * 0.5, 3), round(round(lng / 0.5) * 0.5, 3)) for lng, lat in points]
    missing = sorted({p for p, h in zip(snapped, hours) if h < FORECAST_HOURS
                      and not (p in weather.point_cache and weather.point_cache[p][0] > time.time())})
    for i in range(0, len(missing), weather.BATCH):
        try:
            weather.fetch(missing[i : i + weather.BATCH])
        except (OSError, ValueError, KeyError):
            break  # (what's to hand is used; the rest goes without)
    out = []
    for p, h in zip(snapped, hours):
        cached = weather.point_cache.get(p)
        if h >= FORECAST_HOURS or not cached:
            out.append(None)
            continue
        _, start, values = cached
        at = int((now + h * 3600 - start) // 3600)
        if not 0 <= at < len(values.get("wave") or []):
            out.append(None)
            continue
        pick = lambda k: (values.get(k) or [None] * (at + 1))[at] if k in values else None
        out.append({k: pick(k) for k in ("wave", "waveFrom", "period", "swell", "swellFrom", "swellPeriod", "sea",
                                         "seaFrom", "seaPeriod", "wind", "windFrom", "current", "currentTo")})
    return out


FORECAST_HOURS = 7 * 24  # hours ahead the marine forecast reaches, about


def voyage(route_: dict, vessel: dict | None = None) -> dict:
    """The route sailed through the forecast: each leg looked at every SAMPLE_HOURS of steaming, its speed through
    the water cut by the waves (route.speed_lost) from the leg's ordered speed, and the current added along the
    course. Past the forecast, the ordered speed. With each leg's times, and a timeline for the motions."""
    import route

    vessel = vessel or {}
    length = float(vessel.get("length") or 150)
    waypoints = route_.get("waypoints") or []
    start = float(route_.get("departure") or time.time())
    now = time.time()
    when = start
    legs, timeline = [], []
    for i, (a, b) in enumerate(zip(waypoints, waypoints[1:])):
        leg = b.get("leg") or {}
        order = float(leg.get("speed") or route_.get("speed") or SPEED)
        pa, pb = [a["lng"], a["lat"]], [b["lng"], b["lat"]]
        great = leg.get("geometry") == "great"
        points = great_circle(pa, pb, 64) if great else [pa, pb]
        total = sum(rhumb_nm(p, q) for p, q in zip(points, points[1:]))
        n = max(1, int(math.ceil(total / (order * SAMPLE_HOURS))))
        # the leg in n pieces, each at its own place, heading and time
        done, left, loss_sum, worst, beyond = 0.0, total, 0.0, 0.0, False
        leg_start = when
        piece = total / n
        for k in range(n):
            frac = (k + 0.5) / n
            here = point_along(points, total * frac) if great else [pa[0] + (pb[0] - pa[0]) * frac, pa[1] + (pb[1] - pa[1]) * frac]
            ahead = point_along(points, min(total, total * frac + 0.5)) if great else pb
            heading = route.bearing(here, ahead)
            f = forecast_at([here], [(when - now) / 3600], now)[0]
            stw = order
            sog = order
            if f and f.get("wave") is not None and f.get("waveFrom") is not None:
                lost = route.speed_lost(f["wave"], f["waveFrom"], heading, length)
                stw = order * (1 - lost)
                loss_sum += lost
                worst = max(worst, f["wave"])
                sog = stw
                if f.get("current") is not None and f.get("currentTo") is not None:
                    # (in knots, flowing toward currentTo: what of it runs along the course)
                    sog = max(0.5, stw + f["current"] * math.cos(math.radians(f["currentTo"] - heading)))
            else:
                beyond = True
            timeline.append({"leg": i, "t": when, "lng": round(here[0], 4), "lat": round(here[1], 4), "heading": round(heading, 1),
                             "speed": round(sog, 2), "stw": round(stw, 2), "forecast": f})
            when += piece / sog * 3600
        legs.append({"leg": i, "nm": round(total, 2), "order": order, "depart": leg_start, "arrive": when,
                     "speed": round(total / ((when - leg_start) / 3600), 2) if when > leg_start else order,
                     "loss_pct": round(100 * loss_sum / n, 1), "worst_wave": round(worst, 1), "beyond_forecast": beyond})
    out = {"departure": start, "arrival": when, "legs": legs, "timeline": timeline,
           "note": "Speed loss in waves estimated by rule of thumb, not from sea trials. Beyond the forecast range, ordered speed is used."}
    ship = ship_of(vessel.get("my"))
    if ship:
        my = vessel["my"]
        motions_on(timeline, {**ship, "depth": my.get("depth")}, my.get("cargo") or [], float(my.get("lcf") or ship["lbp"] / 2),
                   float(my.get("kg") or 0))
    return out


# --- weather routing: three ways from the start to the end through the forecast, by isochrones

ISO_HOURS = 3.0  # between isochrones
ISO_SPREAD = 80  # ° either side of the way to the end, the headings tried from each point
ISO_STEP = 10  # ° between them
ISO_SECTORS = 72  # bearings from the start that the front is kept one point each in
ISO_MOST = 120  # isochrones at most (15 days)
LAND_CLEAR = 8  # nm round each end where the coarse land is let be (a sea buoy can sit on its outline)


def sea_of(f: dict) -> list:
    """A forecast's sea as components (height, period, from): the wind's sea and the swell, or the sea all told."""
    if not f:
        return []
    parts = []
    if f.get("sea") and f.get("seaFrom") is not None:
        parts.append((f["sea"], f.get("seaPeriod") or f.get("period") or 6.0, f["seaFrom"]))
    if f.get("swell") and f.get("swellFrom") is not None:
        parts.append((f["swell"], f.get("swellPeriod") or f.get("period") or 9.0, f["swellFrom"]))
    if not parts and f.get("wave") and f.get("waveFrom") is not None:
        parts.append((f["wave"], f.get("period") or 7.0, f["waveFrom"]))
    return parts


def under_way(order: float, heading: float, f: dict | None, length: float, ship: dict | None):
    """Speed over the ground on a heading in this forecast, and her motions (None without a ship to judge them)."""
    import motions
    import route

    sog, motion = order, None
    if f and f.get("wave") is not None and f.get("waveFrom") is not None:
        sog = order * (1 - route.speed_lost(f["wave"], f["waveFrom"], heading, length))
        if f.get("current") is not None and f.get("currentTo") is not None:
            sog = max(0.5, sog + f["current"] * math.cos(math.radians(f["currentTo"] - heading)))
    if ship:
        motion = motions.respond(ship, heading, sog, sea_of(f))
    return sog, motion


def step_from(p: list, heading: float, nm: float) -> list:
    r = math.radians(heading)
    lat = p[1] + nm * math.cos(r) / 60
    mid = math.radians((p[1] + lat) / 2)
    return [p[0] + nm * math.sin(r) / (60 * max(math.cos(mid), 0.05)), lat]


def sea_room(start: list, end: list):
    """Land to keep off, coarse (Natural Earth's): within a box round the way, less a circle round each end."""
    pad = 12.0
    box = shapely.box(min(start[0], end[0]) - pad, min(start[1], end[1]) - pad, max(start[0], end[0]) + pad,
                      min(85, max(start[1], end[1]) + pad))
    polys, tree = charts.load_polygons(sync.land_source("overview"))
    near = polys[tree.query(box, "intersects")]
    if not len(near):
        return None
    land = shapely.intersection(shapely.union_all(near), box)
    for p in (start, end):
        land = land.difference(shapely.Point(p).buffer(LAND_CLEAR / 60))
    shapely.prepare(land)
    return land


def isochrone_route(start: list, end: list, depart: float, order: float, length: float, ship: dict | None,
                    comfort: bool, land) -> dict | None:
    """The quickest way through the forecast (or, with comfort, the one with the least time weighted by how hard the
    sea works her): each ISO_HOURS, from each point of the front, the headings either side of the way to the end;
    of what's reached, the best in each sector of bearing from the start kept. Waypoints and times."""
    import motions
    import route

    now = time.time()
    front = [{"p": start, "t": depart, "cost": 0.0, "parent": None, "motion": None, "sog": order}]
    finish = None
    seen = []
    for _ in range(ISO_MOST):
        reached = []
        hours = [(n["t"] - now) / 3600 for n in front]
        casts = forecast_at([n["p"] for n in front], hours, now)
        for n, f in zip(front, casts):
            to_end = route.nm(n["p"], end)
            way = route.bearing(n["p"], end)
            for dh in range(-ISO_SPREAD, ISO_SPREAD + 1, ISO_STEP):
                heading = (way + dh) % 360
                sog, motion = under_way(order, heading, f, length, ship)
                weight = motions.comfort_cost(motion) if comfort and motion else 1.0
                run = sog * ISO_HOURS
                if dh == 0 and run >= to_end:  # (the end within this step, made good straight to it)
                    hours_left = to_end / sog
                    cost = n["cost"] + hours_left * weight
                    if finish is None or cost < finish["cost"]:
                        finish = {"p": end, "t": n["t"] + hours_left * 3600, "cost": cost, "parent": n, "motion": motion, "sog": sog}
                    continue
                p = step_from(n["p"], heading, run)
                if land is not None and land.intersects(shapely.LineString([n["p"], p])):
                    continue
                reached.append({"p": p, "t": n["t"] + ISO_HOURS * 3600, "cost": n["cost"] + ISO_HOURS * weight,
                                "parent": n, "motion": motion, "sog": sog})
        if finish is not None and (not reached or min(route.nm(r["p"], end) for r in reached) > 0):
            # (a point that's already arrived beats any still at sea, as all of them have spent as long)
            break
        if not reached:
            return None
        # the best in each sector of bearing from the start: nearest the end, for its time and discomfort
        best = {}
        for r in reached:
            sector = int(route.bearing(start, r["p"]) // (360 / ISO_SECTORS))
            score = route.nm(r["p"], end) / order + r["cost"]
            if sector not in best or score < best[sector][0]:
                best[sector] = (score, r)
        front = [r for _, r in sorted(best.values(), key=lambda s: s[0])[:ISO_SECTORS]]
        seen.append(len(front))
    if finish is None:
        return None
    path, n = [], finish
    while n is not None:
        path.append(n)
        n = n["parent"]
    path.reverse()
    return {"waypoints": [[round(n["p"][0], 5), round(n["p"][1], 5)] for n in path], "times": [n["t"] for n in path],
            "arrival": finish["t"], "nm": sum(route.nm(a["p"], b["p"]) for a, b in zip(path, path[1:]))}


def ship_of(my: dict | None) -> dict | None:
    """What the motions need of a vessel, from the Routes panel's My vessel."""
    if not my or not my.get("lbp"):
        return None
    return {"lbp": float(my["lbp"]), "beam": float(my["beam"]), "draught": float(my.get("draught") or 5.0),
            "gm": float(my.get("gm") or 1.0), "roll_period": my.get("roll_period")}


def motions_on(timeline: list, ship: dict, cargo: list, lcf: float, kg: float) -> None:
    """Each sample of a passage given her motions there and the accelerations at each cargo position (in place)."""
    import motions

    draught = ship["draught"]
    for s in timeline:
        m = motions.respond(ship, s["heading"], s["speed"], sea_of(s.get("forecast")))
        s["motion"] = {"roll": round(m["roll"], 1), "pitch": round(m["pitch"], 1), "heave": round(m["heave"], 2),
                       "roll_period": round(m["roll_period"], 1), "warnings": m["warnings"]}
        points = cargo or [{"name": "Deck amidships, side", "x": lcf, "y": ship["beam"] / 2, "z": ship.get("depth", draught + 6)}]
        s["accelerations"] = [{"name": c["name"], **{k: round(v, 3) for k, v in
                               motions.accelerations(m, c["x"] - lcf, c["y"], c["z"] - draught).items()}} for c in points[:12]]


def weather_routes(route_: dict, my: dict | None) -> dict:
    """Three ways from the route's first waypoint to its last through the forecast: the fastest, the most
    comfortable (time weighted by roll and pitch, steering round the worst), and the route as planned; each with its
    passage, her motions along it, and the accelerations at her cargo."""
    import route

    wps = route_.get("waypoints") or []
    start, end = [wps[0]["lng"], wps[0]["lat"]], [wps[-1]["lng"], wps[-1]["lat"]]
    depart = float(route_.get("departure") or time.time())
    order = float(route_.get("speed") or SPEED)
    ship = ship_of(my)
    length = float((my or {}).get("lbp") or 150)
    land = sea_room(start, end)
    options = []
    planned = voyage(route_, {"length": length})
    options.append({"name": "Planned route", "waypoints": [[w["lng"], w["lat"]] for w in wps], "arrival": planned["arrival"],
                    "nm": sum(l["nm"] for l in planned["legs"]), "timeline": planned["timeline"]})
    for name, comfort in (("Fastest", False), ("Least motion", True)):
        found = isochrone_route(start, end, depart, order, length, ship if (comfort or ship) else None, comfort, land)
        if not found:
            continue
        r = {"waypoints": [{"lng": x, "lat": y, "leg": {"speed": order}} for x, y in found["waypoints"]], "speed": order,
             "departure": depart}
        sailed = voyage(r, {"length": length})
        options.append({"name": name, "waypoints": found["waypoints"], "arrival": sailed["arrival"],
                        "nm": round(found["nm"], 1), "timeline": sailed["timeline"]})
    for o in options:
        if ship:
            motions_on(o["timeline"], {**ship, "depth": (my or {}).get("depth")}, (my or {}).get("cargo") or [],
                       float((my or {}).get("lcf") or ship["lbp"] / 2), float((my or {}).get("kg") or 0))
            rolls = [s["motion"]["roll"] for s in o["timeline"]]
            o["worst_roll"] = max(rolls, default=0.0)
            o["worst_pitch"] = max((s["motion"]["pitch"] for s in o["timeline"]), default=0.0)
            o["worst_transverse"] = max((a["transverse"] for s in o["timeline"] for a in s["accelerations"]), default=0.0)
            o["warnings"] = sorted({w for s in o["timeline"] for w in s["motion"]["warnings"]})
        o["hours"] = round((o["arrival"] - depart) / 3600, 1)
        o["worst_wave"] = max(((s.get("forecast") or {}).get("wave") or 0 for s in o["timeline"]), default=0.0)
    return {"departure": depart, "options": options, "note": "Open-Meteo forecast, about 7 days ahead. "
            "Motions estimated from GM and sea state, not from vessel seakeeping data. Routes avoid coarse coastline only: check the selected route against the charts. Planning aid only. Not for navigation."}
