"""Checks the route predictor's reading of AIS destinations and ETAs, and its rule for speed lost in waves.

Run from the project folder: backend/.venv/Scripts/python backend/test_route.py"""
import calendar
import time

import route

assert route.destination("NLRTM")["name"] == "Rotterdam"
assert route.destination("NL RTM")["code"] == "NLRTM"
assert route.destination("nl-rtm")["code"] == "NLRTM"
assert route.destination("JP NGO>NLRTM")["code"] == "NLRTM", "the last leg is where it's going"
assert route.destination("ROTTERDAM")["code"] == "NLRTM"
assert route.destination("PORT OF ROTTERDAM")["code"] == "NLRTM"
assert route.destination("FOR ORDERS") is None
assert route.degrees("3859N 11742E") == (117 + 42 / 60, 38 + 59 / 60)
assert route.degrees("3352S 15112W") == (-(151 + 12 / 60), -(33 + 52 / 60))
# not in searoute's own ports: from UNECE's list, once it's been fetched
tianjin = route.destination("CNTXG")
assert tianjin is None or abs(tianjin["lat"] - 38.98) < 0.1, tianjin
assert route.destination("") is None

now = calendar.timegm((2026, 12, 30, 12, 0, 0))
assert route.ais_eta("01-02 06:00", now) == calendar.timegm((2027, 1, 2, 6, 0, 0)), "early January is next year's"
assert route.ais_eta("12-28 23:30", now) == calendar.timegm((2026, 12, 28, 23, 30, 0))
assert route.ais_eta("00-00 24:60", now) is None

calm, rough = route.speed_lost(1, 0, 0, 200), route.speed_lost(4, 0, 0, 200)
assert 0 < calm < rough < 0.6
assert route.speed_lost(4, 0, 0, 30) > rough, "a small vessel loses more"
assert route.speed_lost(4, 180, 0, 200) < rough, "less with the seas astern"

found = route.predict(-74.04, 40.66, "NLRTM", 15, 70, 200, None)
assert found["port"]["code"] == "NLRTM" and 3000 < found["miles"] < 3600
assert found["arrive"] >= found["calmArrive"], "weather only ever slows it"
two_days_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 48 * 3600))
late = route.predict(-74.04, 40.66, "NLRTM", 15, 70, 200, None, seen=two_days_ago)
assert abs(late["arrive"] - found["arrive"] + 48 * 3600) < 12 * 3600, "a voyage starts from its last report"
heading_east =route.predict(-69.75, 40.43, "BEANR", 19, 70, 300, None, cog=90)
first, second = heading_east["path"][:2]
assert abs((route.bearing(first, second) - 90 + 180) % 360 - 180) <= 90, "no doubling back behind it"
print("ok")
