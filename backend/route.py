"""A vessel's likely route to its AIS destination, and when it'll get there with the weather on the way.

The destination is a port code (UN/LOCODE, "NLRTM", "NL RTM") or a port's name, looked up in searoute's ports; the
route follows searoute's network of shipping lanes (Eurostat's, Apache-2.0); and along it the vessel loses speed in
the waves forecast for where it'll be when it gets there, more in head seas, less with them behind it."""
import calendar
import csv
import functools
import io
import json
import math
import re
import time
import urllib.request
import zipfile
from importlib import resources
from pathlib import Path

import numpy as np
import searoute

import weather

UN_URL = "https://unlocode.unece.org/downloads/unlocode-latest.zip"
UN_PORTS = Path(__file__).parent.parent / "enc" / "unlocode" / "ports.json"
KNOTS_BY_TYPE =[(60, 69, 18), (70, 79, 14), (80, 89, 13), (30, 30, 9), (40, 49, 28), (36, 37, 7)]  # when stopped or silent
KNOTS_OTHER = 11
MOVING = 2  # knots: slower than this, a vessel's own speed says nothing of its passage speed
STEP = 3  # hours of steaming between looks at the weather
TICKS = 12  # hours between the marks along the route
GRID = 0.5  # degrees: weather looked up on this grid, so neighbouring steps share points
FORECAST_HOURS = 7 * 24  # Open-Meteo's forecast reaches about this far; calm assumed beyond
AT_SEA = re.compile(r"\b(FOR ORDERS?|ORDERS|AT SEA|FISHING|DRIFTING|TBA|TBN|N/?A|NONE)\b")


def degrees(text: str) -> tuple | None:
    """UN/LOCODE's "3859N 11742E": degrees and minutes. Lng, lat."""
    found = re.match(r"(\d\d)(\d\d)([NS]) (\d\d\d)(\d\d)([EW])", text or "")
    if not found:
        return None
    lat = (int(found.group(1)) + int(found.group(2)) / 60) * (1 if found.group(3) == "N" else -1)
    lng = (int(found.group(4)) + int(found.group(5)) / 60) * (1 if found.group(6) == "E" else -1)
    return lng, lat


def un_ports() -> list:
    """Every place UNECE's UN/LOCODE list marks as a port and gives a position for: fetched once, about 13 MB, and
    kept as a small list of its own. None if it can't be had: searoute's ports still serve."""
    if not UN_PORTS.exists():
        try:
            UN_PORTS.parent.mkdir(parents=True, exist_ok=True)
            packed = UN_PORTS.with_name("unlocode-latest.zip")
            if not packed.exists():
                request = urllib.request.Request(UN_URL, headers={"User-Agent": "ENC 3D"})
                with urllib.request.urlopen(request, timeout=120) as res:
                    packed.write_bytes(res.read())
            found = []
            with zipfile.ZipFile(packed) as z:
                for name in z.namelist():
                    if not re.search(r"csv/UNLOCODE CodeListPart\d\.csv$", name):
                        continue
                    for row in csv.reader(io.StringIO(z.read(name).decode("utf-8", "replace"))):
                        at = degrees(row[10]) if len(row) > 10 else None
                        if at and row[2] and row[6].startswith("1") and row[0] != "X":  # a port, not marked for removal
                            found.append({"code": row[1] + row[2], "name": row[4] or row[3], "lng": at[0], "lat": at[1]})
            UN_PORTS.write_text(json.dumps(found, separators=(",", ":")))
            packed.unlink()
        except (OSError, zipfile.BadZipFile):
            return []
    return json.loads(UN_PORTS.read_text())


@functools.cache
def ports() -> tuple:
    """Ports by code and by name: searoute's first, as they're on its network, then UNECE's for the rest."""
    features = json.loads(resources.files("searoute.data").joinpath("ports.geojson").read_text())["features"]
    ports = [{"code": f["properties"]["port"], "name": f["properties"]["name"].replace("_", " "),
              "lng": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1]} for f in features]
    by_code, by_name = {p["code"]: p for p in ports}, {p["name"].upper(): p for p in ports}
    for p in un_ports():
        p = {**p, "un": True}  # (a few of its positions are wrong: searoute's are checked)
        by_code.setdefault(p["code"], p)
        by_name.setdefault(p["name"].upper(), p)
    return by_code, by_name


def destination(text: str) -> dict | None:
    """The port a destination means. The last leg of "JP NGO>JP HKT"; a code with or without its gap or dash; or a name."""
    said = (text or "").upper().split(">")[-1].strip()
    if not said or AT_SEA.search(said):
        return None
    by_code, by_name = ports()
    for country, place in re.findall(r"\b([A-Z]{2})[\s\-]?([A-Z2-9]{3})\b", said):
        if country + place in by_code:
            return by_code[country + place]
    words = re.sub(r"[^A-Z ]", " ", said).split()
    for n in range(len(words), 0, -1):  # the longest run of words that names a port: "PORT OF ANTWERP", "ANTWERP"
        for i in range(len(words) - n + 1):
            name = " ".join(words[i : i + n])
            if name in by_name:
                return by_name[name]
    return None


def passage_knots(sog: float | None, type_: int | None) -> float:
    if sog and sog >= MOVING:
        return float(sog)
    return next((k for low, high, k in KNOTS_BY_TYPE if low <= (type_ or 0) <= high), KNOTS_OTHER)


def speed_lost(wave: float, wave_from: float, heading: float, length: float) -> float:
    """The share of its speed a vessel loses in these waves. ponytail: a rule of thumb, not a ship's own figures: grows
    with the square of the height, less for a long ship, and less as the seas come round from ahead to astern"""
    ahead = abs((wave_from - heading + 180) % 360 - 180)  # 0: head seas, 180: following
    facing = 1 - 0.7 * ahead / 180
    return min(0.6, 0.02 * wave**2 * math.sqrt(100 / max(length, 15)) * facing)


def bearing(a: list, b: list) -> float:
    x = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.degrees(math.atan2(x, math.radians(b[1] - a[1]))) % 360


def nm(a: list, b: list) -> float:
    x = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    return 3440.065 * math.hypot(x, math.radians(b[1] - a[1]))


def ais_eta(text: str | None, now: float) -> float | None:
    """AIS gives "MM-DD HH:MM" in UTC with no year: the nearest such time to now."""
    found = re.match(r"(\d\d)-(\d\d) (\d\d):(\d\d)", text or "")
    if not found or found.group(1) == "00":
        return None
    month, day, hour, minute = map(int, found.groups())
    year = time.gmtime(now).tm_year
    if not (1 <= month <= 12 and 1 <= day <= 31 and hour < 24 and minute < 60):  # (24:60 means not given)
        return None
    options = [calendar.timegm((y, month, day, hour, minute, 0)) for y in (year - 1, year, year + 1)]
    return min(options, key=lambda t: abs(t - now))


def waves_along(points: list, hours: list, now: float) -> list:
    """The forecast wave height and direction at each place, at the hour the vessel is there: None past the forecast,
    or over land, where there are no waves to give."""
    snapped = [(round(round(lat / GRID) * GRID, 3), round(round(lng / GRID) * GRID, 3)) for lng, lat in points]
    missing = sorted({p for p, h in zip(snapped, hours) if h < FORECAST_HOURS
                      and not (p in weather.point_cache and weather.point_cache[p][0] > time.time())})
    for i in range(0, len(missing), weather.BATCH):
        weather.fetch(missing[i : i + weather.BATCH])
    found = []
    for p, h in zip(snapped, hours):
        cached = weather.point_cache.get(p)
        if h >= FORECAST_HOURS or not cached:
            found.append(None)
            continue
        _, start, values = cached
        at = int((now + h * 3600 - start) // 3600)
        if not 0 <= at < len(values["wave"]):  # (the forecast ends a little short; a report a week old starts too early)
            found.append(None)
            continue
        wave, wave_from = values["wave"][at], values["waveFrom"][at]
        found.append(None if wave is None or wave_from is None else (wave, wave_from))
    return found


def predict(lng: float, lat: float, destination_text: str, sog: float | None, type_: int | None,
            length: float | None, eta_text: str | None, cog: float | None = None, seen: str | None = None) -> dict:
    # the voyage starts from where and when it last reported, which can be days ago
    now = time.time()
    try:
        start = min(now, calendar.timegm(time.strptime((seen or '')[:19], '%Y-%m-%dT%H:%M:%S')))
    except ValueError:
        start = now
    port = destination(destination_text)
    if port is None:
        return {"port": None, "said": destination_text}
    line = searoute.searoute([lng, lat], [port["lng"], port["lat"]], units="naut", append_orig_dest=True)
    coords = line["geometry"]["coordinates"]
    # the lanes' nearest point can lie behind a vessel under way: it carries on from where it's heading instead
    while cog is not None and len(coords) > 3 and abs((bearing(coords[0], coords[1]) - cog + 180) % 360 - 180) > 90:
        coords.pop(1)
    knots = passage_knots(sog, type_)
    # steps of about STEP hours' steaming along the route, each with its own weather
    legs = [(a, b, nm(a, b)) for a, b in zip(coords, coords[1:]) if nm(a, b) > 0]
    stride = knots * STEP
    marks, at, gone = [], [], 0.0
    for a, b, miles in legs:
        for f in np.arange(0, miles, stride):
            t = f / miles
            marks.append(([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing(a, b), stride if f + stride <= miles else miles - f))
            at.append(gone + f)
        gone += miles
    calm_hours = [m / knots for m in at]
    seas = waves_along([m[0] for m in marks], calm_hours, start)
    hours, worst, ticks = 0.0, 0.0, []
    for (place, heading, miles), sea in zip(marks, seas):
        lost = speed_lost(sea[0], sea[1], heading, length or 100) if sea else 0
        worst = max(worst, sea[0] if sea else 0)
        before = hours
        hours += miles / (knots * (1 - lost))
        if math.floor(hours / TICKS) > math.floor(before / TICKS):
            ticks.append({"position": place, "hours": math.floor(hours / TICKS) * TICKS})
    arrive = start + hours * 3600
    return {
        "port": port,
        "path": coords,
        "miles": round(gone),
        "knots": round(knots, 1),
        "arrive": arrive,
        "calmArrive": start + gone / knots * 3600,
        "from": start,
        "aisEta": ais_eta(eta_text, now),
        "worstWaves": round(worst, 1),
        "ticks": ticks,
    }
