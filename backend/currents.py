"""Tidal currents from NOAA CO-OPS's predictions, at its current stations: US waters only.

Each station predicts its strongest flood and ebb and the slacks between; between those, the current is taken to swell
and fade along half a cosine, as tidal streams do. Positive is flood, along the station's flood direction; negative is
ebb, along its ebb direction."""
import json
import math
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

import tides

SAVED = Path(__file__).parent.parent / "enc" / "current_stations.json"
HOURS = tides.HOURS  # either side of now, as the tide bar
FRESH = 6 * 3600  # s: how long a station's predictions are kept
MOST = 60  # stations at once, the nearest the middle of the view: each is a request to NOAA the first time
KNOTS = 1 / 51.444  # cm/s to knots

series_cache = {}  # station id and bin: (expiry time, predictions)
stations_loaded = []
pool = ThreadPoolExecutor(8)


def stations() -> list:
    if not stations_loaded:
        fresh = SAVED.exists() and time.time() - SAVED.stat().st_mtime < tides.STATIONS_FRESH
        try:
            if not fresh:
                found = tides.fetch_json(tides.STATIONS_URL + "currentpredictions")["stations"]
                keep = [{"id": s["id"], "bin": s.get("currbin"), "name": s["name"], "lat": s["lat"], "lng": s["lng"]}
                        for s in found if s.get("type") != "W"]  # (weak and variable: nothing to predict)
                SAVED.write_text(json.dumps(keep))
        except OSError:
            if not SAVED.exists():
                raise
        stations_loaded.extend(json.loads(SAVED.read_text()))
    return stations_loaded


def between(times: np.ndarray, events: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Values at these times from the events around them, along half a cosine; nan outside them."""
    i = np.searchsorted(events, times).clip(1, max(len(events) - 1, 1))
    if len(events) < 2:
        return np.full(len(times), np.nan)
    t0, t1 = events[i - 1], events[i]
    f = np.clip((times - t0) / np.maximum(t1 - t0, 1), 0, 1)
    found = values[i - 1] + (values[i] - values[i - 1]) * (1 - np.cos(math.pi * f)) / 2
    return np.where((times < events[0]) | (times > events[-1]), np.nan, found)


def series(station: dict, now: float) -> dict:
    events, values, flood, ebb = predictions(station, now)
    knots = between(now + 3600.0 * np.arange(-HOURS, HOURS + 1), events, values) if len(events) else []
    return {"flood": flood, "ebb": ebb, "knots": [None if math.isnan(k) else round(float(k), 2) for k in knots]}


def predictions(station: dict, now: float) -> tuple:
    """A station's floods, ebbs and slacks across the tide bar and a little either side: times (s) and knots."""
    key = (station["id"], station["bin"])
    cached = series_cache.get(key)
    if cached and cached[0] > time.time():
        return cached[1]
    query = urllib.parse.urlencode({
        "product": "currents_predictions",
        "station": station["id"],
        "bin": station["bin"] or 1,
        "begin_date": time.strftime("%Y%m%d %H:%M", time.gmtime(now - 3600 * (HOURS + 12))),
        "range": 2 * HOURS + 24,
        "interval": "MAX_SLACK",
        "time_zone": "gmt",
        "units": "metric",
        "format": "json",
        "application": "ENC_3D",
    })
    try:
        rows = tides.fetch_json(tides.DATA_URL + query).get("current_predictions", {}).get("cp", [])
    except urllib.error.HTTPError:
        rows = []
    events = np.array([r["Time"] for r in rows], dtype="datetime64[m]").astype(np.int64) * 60.0
    values = np.array([float(r["Velocity_Major"]) for r in rows]) * KNOTS
    found = events, values, rows[0].get("meanFloodDir") if rows else None, rows[0].get("meanEbbDir") if rows else None
    series_cache[key] = (time.time() + FRESH, found)
    return found


def in_view(west: float, south: float, east: float, north: float) -> dict:
    """The stations in an area, nearest its middle first, each with its current every hour across the tide bar."""
    lat, lng = (south + north) / 2, (west + east) / 2
    here = [s for s in stations() if south <= s["lat"] <= north and west <= s["lng"] <= east]
    here = sorted(here, key=lambda s: tides.distance(lat, lng, s))[:MOST]
    now = time.time()
    found = pool.map(lambda s: series(s, now), here)
    return {
        "now": now,
        "stations": [{"name": s["name"], "lat": s["lat"], "lng": s["lng"], **f} for s, f in zip(here, found) if f["knots"]],
    }
