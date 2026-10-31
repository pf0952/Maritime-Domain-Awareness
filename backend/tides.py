"""Real water levels from NOAA CO-OPS: what the nearest station measured, and what's predicted for it.

Heights are above chart datum (MLLW, or Low Water Datum on the Great Lakes), the same zero as the charts' depths, so
they can be set against them directly. Lakes have no tides to predict: they stay at their last reading."""
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

STATIONS_URL = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type="
DATA_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?"
SAVED = Path(__file__).parent.parent / "enc" / "tide_stations.json"
HOURS = 120  # either side of now
LIVE_REACH = 50  # km: a station with a live gauge is worth preferring this far out
REACH = 150  # km: any further, and it's not this place's tide
FRESH = 600  # s: how long a station's series is kept
STATIONS_FRESH = 7 * 24 * 3600  # s
TIMEOUT = 30  # s

series_cache = {}  # station id: (expiry time, series)
stations_loaded = []


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "ENC 3D"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as res:
        return json.load(res)


def stations() -> list:
    """Stations with live gauges, then ones with harmonic predictions. Kept a week, or longer if NOAA is away."""
    if not stations_loaded:
        fresh = SAVED.exists() and time.time() - SAVED.stat().st_mtime < STATIONS_FRESH
        try:
            if not fresh:
                live = fetch_json(STATIONS_URL + "waterlevels")["stations"]
                harmonic = fetch_json(STATIONS_URL + "tidepredictions")["stations"]
                found = [{**s, "live": True} for s in live if s.get("tidal") or s.get("greatlakes")]
                found += [{**s, "live": False} for s in harmonic if s.get("type") == "R"]
                keep = ("id", "name", "state", "lat", "lng", "live", "greatlakes")
                SAVED.write_text(json.dumps([{k: s.get(k) for k in keep} for s in found]))
        except OSError:
            if not SAVED.exists():
                raise
        stations_loaded.extend(json.loads(SAVED.read_text()))
    return stations_loaded


def distance(lat: float, lon: float, station: dict) -> float:
    """Km, near enough for picking the closest."""
    x = math.radians(station["lng"] - lon) * math.cos(math.radians(lat))
    return 6371 * math.hypot(x, math.radians(station["lat"] - lat))


def nearest(lat: float, lon: float) -> tuple:
    """The station for a place, and how far it is: a live gauge if there's one close, or else any station."""
    near = sorted(((distance(lat, lon, s), s) for s in stations()), key=lambda pair: pair[0])
    live = next(((km, s) for km, s in near if s["live"] and km <= LIVE_REACH), None)
    return live or (near[0] if near and near[0][0] <= REACH else (None, None))


def readings(product: str, station: dict, begin: float, end: float) -> tuple:
    """Times (s) and heights (m). Empty if the station has none: a lake has no predictions, say."""
    query = urllib.parse.urlencode({
        "product": product,
        "station": station["id"],
        "datum": "LWD" if station.get("greatlakes") else "MLLW",
        "begin_date": time.strftime("%Y%m%d %H:%M", time.gmtime(begin)),
        "end_date": time.strftime("%Y%m%d %H:%M", time.gmtime(end)),
        "time_zone": "gmt",
        "units": "metric",
        "format": "json",
        "application": "ENC_3D",
    })
    try:
        rows = fetch_json(DATA_URL + query)
    except urllib.error.HTTPError as e:
        if e.code == 400:
            return np.empty(0), np.empty(0)
        raise
    rows = [r for r in rows.get("predictions" if product == "predictions" else "data", []) if r["v"]]
    times = np.array([r["t"] for r in rows], dtype="datetime64[m]").astype(np.int64) * 60.0
    return times, np.array([float(r["v"]) for r in rows])


def series(station: dict) -> dict:
    """A height for each hour from HOURS before now to HOURS after, and whether it was measured."""
    cached = series_cache.get(station["id"])
    if cached and cached[0] > time.time():
        return cached[1]
    now = time.time()
    hours = now + 3600.0 * np.arange(-HOURS, HOURS + 1)
    begin, end = hours[0] - 1800, hours[-1] + 1800
    predicted_at, predicted = readings("predictions", station, begin, end)
    measured_at, measured = np.empty(0), np.empty(0)
    if station["live"]:
        measured_at, measured = readings("water_level", station, begin, now)
    if not len(predicted) and not len(measured):
        raise OSError(f"no water levels from {station['name']}")
    if len(predicted):
        levels = np.interp(hours, predicted_at, predicted)
    else:
        levels = np.full(len(hours), measured[-1])  # a lake: its level holds
    observed = np.zeros(len(hours), dtype=bool)
    if len(measured):
        # only within half an hour of a real reading: gauges have gaps
        nearest_reading = np.abs(measured_at[None, :] - hours[:, None]).min(axis=1)
        observed = nearest_reading <= 1800
        levels = np.where(observed, np.interp(hours, measured_at, measured), levels)
    result = {
        "now": now,
        "levels": np.round(levels, 3).tolist(),
        "observed": observed.tolist(),
        "predicted": bool(len(predicted)),
        "datum": "Low Water Datum" if station.get("greatlakes") else "MLLW",
    }
    series_cache[station["id"]] = (now + FRESH, result)
    return result
