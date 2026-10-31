"""Tide check, with made-up readings so it needs no network: backend/.venv/Scripts/python backend/test_tides.py"""
import time

import numpy as np

import tides

STATIONS = [
    {"id": "1", "name": "Live, 30 km", "lat": 40.27, "lng": -70.0, "live": True},
    {"id": "2", "name": "Harmonic, 5 km", "lat": 40.05, "lng": -70.0, "live": False},
    {"id": "3", "name": "Live, 110 km", "lat": 41.0, "lng": -70.0, "live": True},
]
tides.stations_loaded[:] = STATIONS

# a live gauge wins if it's close, or else the nearest of any kind, or nothing if they're all far away
km, station = tides.nearest(40.0, -70.0)
assert station["id"] == "1" and 29 < km < 31
km, station = tides.nearest(40.9, -70.0)
assert station["id"] == "3"
tides.stations_loaded[:] = STATIONS[1:]
assert tides.nearest(40.0, -70.0)[1]["id"] == "2"
assert tides.nearest(10.0, -30.0) == (None, None)

GAUGE, LAKE = {"id": "g", "name": "Gauge", "live": True}, {"id": "l", "name": "Lake", "live": True, "greatlakes": True}


def fake_readings(product, station, begin, end):
    times = np.arange(begin, end + 1, 360.0)
    if product == "predictions":
        return (np.empty(0), np.empty(0)) if station is LAKE else (times, np.full(len(times), 1.0))
    # the gauge reads 2 m, but was out for a day, from 48 to 24 hours ago
    out = (times > time.time() - 48 * 3600) & (times < time.time() - 24 * 3600)
    return times[~out], np.full((~out).sum(), 2.0)


tides.readings = fake_readings
result = tides.series(GAUGE)
levels, observed = np.array(result["levels"]), np.array(result["observed"])
assert len(levels) == len(observed) == 2 * tides.HOURS + 1
now = tides.HOURS
assert observed[now - 60] and levels[now - 60] == 2, "measured, so the measurement shows"
assert not observed[now - 36] and levels[now - 36] == 1, "the gauge was out, so the prediction fills in"
assert not observed[now + 1] and levels[now + 1] == 1 and levels[-1] == 1, "no measurements of the future"
assert result["predicted"] and result["datum"] == "MLLW"
assert tides.series(GAUGE) is result, "kept for a while, to go easy on NOAA"

lake = tides.series(LAKE)
assert not lake["predicted"] and lake["datum"] == "Low Water Datum"
assert lake["levels"][-1] == 2, "a lake's level holds at its last reading"
print("ok")
