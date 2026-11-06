"""Wind and waves from Open-Meteo (free, no key, for non-commercial use; CC BY 4.0): hourly, from the tide bar's start
to its end, on a grid over the view.

The grid's points sit on round numbers of degrees, the spacing to suit the view, so that panning reuses the points
already fetched rather than asking for a new grid each time."""
import base64
import math
import time
import urllib.parse

import numpy as np
import rasterio.features
import rasterio.transform
import shapely

import charts
import sync
import tides

WIND_URL = "https://api.open-meteo.com/v1/forecast?"
SEA_URL = "https://marine-api.open-meteo.com/v1/marine?"
HOURS = tides.HOURS
ACROSS = 8  # points across the view, about
STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20]  # degrees between points
MOST = 120  # points at once
BATCH = 50  # points to a request
FRESH = 3600  # s
MASK = 320  # cells across the view, for where the land is
MASK_COAST_SPAN = 6  # degrees: a view wider than this takes Natural Earth's land
FIELDS = {
    WIND_URL: {"wind_speed_10m": "wind", "wind_direction_10m": "windFrom"},
    # the sea all told, then its two parts: waves the wind is raising here, and swell come from far off
    SEA_URL: {
        "wave_height": "wave", "wave_direction": "waveFrom", "wave_period": "period",
        "wind_wave_height": "sea", "wind_wave_direction": "seaFrom",
        "swell_wave_height": "swell", "swell_wave_direction": "swellFrom", "swell_wave_period": "swellPeriod",
    },
}

point_cache = {}  # (lat, lng): (expiry time, start hour, {field: values})


def grid(west: float, south: float, east: float, north: float) -> tuple:
    span = max(east - west, north - south)
    step = next((s for s in STEPS if span / s <= ACROSS), STEPS[-1])
    lats = np.arange(math.floor(max(south, -80) / step), math.ceil(min(north, 80) / step) + 1) * step
    lngs = np.arange(math.floor(west / step), math.ceil(east / step) + 1) * step
    points = [(round(float(a), 3), round(float(o), 3)) for a in lats for o in lngs]
    middle = ((south + north) / 2, (west + east) / 2)
    return step, sorted(points, key=lambda p: (p[0] - middle[0]) ** 2 + (p[1] - middle[1]) ** 2)[:MOST]


def fetch(points: list) -> None:
    """Every field for these points, from both of Open-Meteo's services."""
    now = time.time()
    for p in [p for p, (expires, *_) in point_cache.items() if expires <= now]:  # (stale ones would only pile up)
        del point_cache[p]
    found = {p: {} for p in points}
    start = None
    for url, fields in FIELDS.items():
        query = urllib.parse.urlencode({
            "latitude": ",".join(str(p[0]) for p in points),
            "longitude": ",".join(str((p[1] + 180) % 360 - 180) for p in points),
            "hourly": ",".join(fields),
            "past_days": 6,
            "forecast_days": 7,
            "wind_speed_unit": "kn",
            "timeformat": "unixtime",
        })
        answer = tides.fetch_json(url + query)
        for p, one in zip(points, answer if isinstance(answer, list) else [answer]):
            start = one["hourly"]["time"][0]
            for name, key in fields.items():
                found[p][key] = one["hourly"][name]
    for p in points:
        point_cache[p] = (time.time() + FRESH, start, found[p])


def land_mask(west: float, south: float, east: float, north: float) -> dict:
    """Where the land is in an area, as a grid of cells MASK across, bit-packed and base64'd, rows from the north: so
    the viewer can keep waves and swell off it. The weather's grid is far too coarse to know a coast. OpenStreetMap's
    land close in, Natural Earth's from further out, where OpenStreetMap's would take too long to gather."""
    span = max(east - west, north - south)
    across = math.cos(math.radians(max(min((south + north) / 2, 80), -80)))
    cols = MASK
    rows = max(1, min(MASK, round(MASK * (north - south) / max((east - west) * across, 1e-9))))
    if span > MASK_COAST_SPAN or not sync.COAST.exists():
        polys, tree = charts.load_polygons(sync.land_source("overview"))
        polys = polys[tree.query(shapely.box(west, south, east, north), "intersects")]
    else:
        polys = charts.coast_in(sync.COAST, (west, south, east, north), span / MASK / 2)
    land = np.zeros((rows, cols), dtype=np.uint8)
    if len(polys):
        transform = rasterio.transform.from_bounds(west, south, east, north, cols, rows)
        land = rasterio.features.rasterize(((p, 1) for p in polys), out_shape=(rows, cols), transform=transform, dtype=np.uint8)
    bits = base64.b64encode(np.packbits(land.ravel()).tobytes()).decode()
    return {"west": west, "south": south, "east": east, "north": north, "cols": cols, "rows": rows, "land": bits}


def in_view(west: float, south: float, east: float, north: float) -> dict:
    """Each point's values at every hour across the tide bar, from HOURS before now to HOURS after; null over land for
    the sea's."""
    step, points = grid(west, south, east, north)
    missing = [p for p in points if not (p in point_cache and point_cache[p][0] > time.time())]
    for i in range(0, len(missing), BATCH):
        fetch(missing[i : i + BATCH])
    first = round(time.time() / 3600) * 3600 - HOURS * 3600
    found = []
    for p in points:
        _, start, values = point_cache[p]
        at = (first - start) // 3600
        series = {k: [None if v is None else round(v, 1) for v in values[k][at : at + 2 * HOURS + 1]] for k in values}
        found.append({"lat": p[0], "lng": p[1], **series})
    return {"step": step, "first": first, "points": found}
