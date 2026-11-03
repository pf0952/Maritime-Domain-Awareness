"""Vessels lying alongside, set clear of the quay.

AIS positions are a few metres out at the best of times, and a ship tied up at a pier is drawn half inside it. Where a
stopped vessel's hull runs into the land the charts draw, it's turned to lie along the nearest edge of that land, as a
ship tied up does, and moved out onto the water just clear of it. Only the land that's drawn there counts: a chart's
own, less what finer charts take over, or OpenStreetMap's where no chart reaches."""
import functools
import math

import numpy as np
import shapely
from shapely import affinity

import charts
import sync

METRES = 111320  # to a degree of latitude
GAP = 1.0  # m left between hull and quay
FURTHEST = 3  # beams: a vessel would have to move further than this to clear the land, so it's somewhere else
TANGENT = 5  # m either way along the quay, to tell which way it runs
STEP = 0.5  # m


@functools.lru_cache(maxsize=64)
def chart_land(name: str, key: str) -> shapely.Geometry:
    """A chart's land, less where finer charts take over at the finest tier, as it's drawn close in. key is the
    compiled file's, so a new edition or a new finer chart reads it again."""
    chart = sync.catalog.by_name[name]
    land = shapely.union_all(charts.polygons(sync.cell_path(chart), "LNDARE").geometry.to_numpy())
    hole = sync.cut_out(chart, 6, sync.catalog)
    return land.difference(shapely.from_wkb(hole)) if hole else land


def land_near(area: shapely.Geometry) -> shapely.Geometry:
    picked = sync.catalog.pick(area, 6)
    found = [chart_land(c.name, sync.chart_file(c, 6, sync.catalog).stem) for c in picked if c.name in sync.on_disk]
    covered = shapely.union_all([c.cover for c in picked]) if picked else shapely.Polygon()
    if sync.COAST.exists():
        west, south, east, north = area.bounds
        coast = shapely.union_all(charts.coast_in(sync.COAST, (west, south, east, north), 1e-5))
        found.append(coast.difference(covered))
    return shapely.intersection(shapely.union_all(found), area) if found else shapely.Polygon()


def hull(length: float, beam: float, heading: float, x: float = 0, y: float = 0) -> shapely.Polygon:
    """A vessel's footprint in metres east and north: a box, turned clockwise from north."""
    box = shapely.box(-beam / 2, -length / 2, beam / 2, length / 2)
    return affinity.translate(affinity.rotate(box, -heading, origin=(0, 0)), x, y)


def alongside(land: shapely.Geometry, length: float, beam: float, heading: float | None) -> tuple | None:
    """Where a hull centred at 0, 0 should lie to be clear of the land (metres east and north, and a heading), or None
    if it's clear already or can't be cleared nearby. With no heading, it's only known to be in the land if its
    middle, a beam across, is."""
    footprint = hull(length, beam, heading) if heading is not None else shapely.Point(0, 0).buffer(beam / 2)
    if not footprint.intersects(land):
        return None
    edge = land.boundary
    if edge.is_empty:
        return None
    along = edge.project(shapely.Point(0, 0))
    a, b = edge.interpolate(max(along - TANGENT, 0)), edge.interpolate(min(along + TANGENT, edge.length))
    quay = math.degrees(math.atan2(b.x - a.x, b.y - a.y)) % 360
    # the way along the quay nearest the way it was heading
    turned = quay if heading is None or abs((quay - heading + 180) % 360 - 180) <= 90 else (quay + 180) % 360
    # out from the quay, the side the water's on
    at = edge.interpolate(along)
    for normal in ((math.cos(math.radians(quay)), -math.sin(math.radians(quay))),
                   (-math.cos(math.radians(quay)), math.sin(math.radians(quay)))):
        if not land.contains(shapely.Point(at.x + 2 * normal[0], at.y + 2 * normal[1])):
            break
    else:
        return None
    # off the nearest point of the quay, by half a beam and more until it's clear
    for out in np.arange(beam / 2 + GAP, FURTHEST * beam + GAP, STEP):
        x, y = at.x + out * normal[0], at.y + out * normal[1]
        if not hull(length, beam, turned, x, y).intersects(land):
            return x, y, turned
    return None


def adjust(vessels: list) -> dict:
    """For each vessel that needs it, where to draw it: {mmsi: {lng, lat, hdg}}."""
    if not vessels:
        return {}
    lngs, lats = [v["lng"] for v in vessels], [v["lat"] for v in vessels]
    reach = max(v["length"] for v in vessels) * FURTHEST / METRES
    area = shapely.box(min(lngs) - reach, min(lats) - reach, max(lngs) + reach, max(lats) + reach)
    land = land_near(area)
    if land.is_empty:
        return {}
    shapely.prepare(land)
    found = {}
    for v in vessels:
        lng, lat = v["lng"], v["lat"]
        across = METRES * math.cos(math.radians(lat))
        local = affinity.affine_transform(land, [across, 0, 0, METRES, -lng * across, -lat * METRES])
        near = local.intersection(shapely.Point(0, 0).buffer(v["length"] * FURTHEST))
        if near.is_empty:
            continue
        moved = alongside(near, v["length"], v["beam"], v.get("hdg"))
        if moved:
            x, y, heading = moved
            found[v["mmsi"]] = {"lng": round(lng + x / across, 7), "lat": round(lat + y / METRES, 7), "hdg": round(heading, 1)}
    return found
