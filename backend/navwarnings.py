"""Navigational warnings in force worldwide, from SeaLagom's free feeds, one for each NAVAREA and coastal authority,
and from the UK Hydrographic Office itself for its own waters.

A warning is plain text, written for a radio operator: where it applies has to be read out of the words. So each one
becomes a category, by what it talks about, and shapes: areas, as rings of [lon, lat], and points. The feeds take a
minute or so to go through, so that happens in the background, and the last warnings stand meanwhile."""
import collections
import datetime
import email.utils
import html
import json
import math
import re
import threading
import time
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import pyogrio
import shapely

SITE = "https://www.sealagom.com"
UKHO = "https://msi.admiralty.co.uk/RadioNavigationalWarnings"  # all of NAVAREA I and its coastal WZ warnings in force
FEED_LIMIT = 100  # SeaLagom's feeds stop here, newest first, so one this long has probably lost its oldest warnings
SAVED = Path(__file__).parent.parent / "enc" / "nav_warnings.json"
FRESH = 3600  # s: they come out through the day, but not by the minute. Read again every hour on the hour
TIMEOUT = 30  # s
PAUSE = 0.25  # s between feeds: one person runs this site
NAVAREAS = range(1, 21)
ROMAN = "I II III IV V VI VII VIII IX X XI XII XIII XIV XV XVI XVII XVIII XIX XX".split()
NM = 1852  # m
METRES = {"MILE": NM, "NM": NM, "METER": 1, "METRE": 1, "YARD": 0.9144, "CABLE": 185.2, "KILOMETER": 1000}
WORDS = "ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE".split()
CORRIDOR = NM  # m either side of a line, when a warning doesn't say
CIRCLE_SIDES = 8  # to a quarter
METRES_PER_DEGREE = 111_320
SAR_LIFE = 96 * 3600  # s after it's issued: a search ends, whatever the words say
SEARCH = "Search and rescue"
HALF_YEAR = 182 * 86400  # s
PLACES = Path(__file__).parent.parent / "enc" / "land"  # (fetched with the land, by sync.py)
PLACE_FILES = (
    ("ne_10m_geography_marine_polys.zip", ("name", "namealt", "name_en", "name_es", "name_fr", "name_pt", "name_ru",
                                           "name_tr", "name_zh")),
    ("ne_10m_lakes.zip", ("name", "name_alt", "name_en")),
    ("ne_10m_ports.zip", ("name",)),
    ("ne_10m_populated_places_simple.zip", ("name", "nameascii")),
)
TOWN_SIZE = 50_000  # people: smaller towns' names are too often plain words as well
SHORTEST_NAME = 4  # letters
WIDEST_PLACE = 25  # square degrees: a warning placed over all of the Black Sea says nothing
PLACE_SIMPLIFY = 0.01  # degrees
FEED_MARGIN = 5  # degrees around where a feed's other warnings are
NOT_PLACES = {"MOBILE", "SPLIT", "READING", "SALE", "ORDER", "UNION", "INDEPENDENCE", "PROGRESO", "LIBERTAD", "CENTRAL",
              "VICTORIA", "SANTA", "SAN", "PORT", "LAKE", "BAY", "SEA", "NORTH", "SOUTH", "EAST", "WEST"}

CATEGORIES = (
    ("Military", r"FIRING|GUNNERY|MISSILE|ROCKET|EXERCISE|MILITARY|NAVAL|MINES?|SUBMARINE OPERATIONS"),
    (
        SEARCH,
        r"OVERDUE|SEARCH AND RESCUE|SAR OPERATIONS?|SAR INCIDENT|DISTRESS (?:CALL|SIGNAL|ALERT|RELAY|BEACON)|MAYDAY|EPIRB"
        r"|OVERBOARD|TAKING ON WATER|ASSIST IF POSSIBLE"
        r"|(?:PERSONS?|CREW|PEOPLE|FISHERM[AE]N|DIVERS?|BOAT|VESSEL|YACHT|CRAFT|CANOE|KAYAK)(?:\s+[A-Z]+){0,2}\s+MISSING"
        r"|MISSING\s+(?:[A-Z]+\s+){0,2}(?:PERSONS?|CREW|PEOPLE|FISHERM[AE]N|DIVERS?|BOAT|VESSEL|YACHT|CRAFT|CANOE|KAYAK)",
    ),
    ("Ice", r"ICE|ICEBERGS?"),
    (
        "Hazards",
        r"WRECK|ADRIFT|DRIFTING|DERELICT|SANK|SUNK|OBSTRUCTION|SHOALS?|ROCKS?|DEBRIS|VOLCANIC|DANGEROUS|SUBMERGED"
        r"|OBJECT",
    ),
    (
        "Operations",
        r"OPERATIONS|CABLES?|PIPELINES?|SURVEY|SCIENTIFIC|SEISMIC|DRILL\w*|DREDG\w*|ROV|TOWS?|TOWING|RIGS?|MOORINGS?"
        r"|UNDERWATER",
    ),
    (
        "Aids to navigation",
        r"LIGHTS?|BUOYS?|RACON|BEACON|UNLIT|AIS|LANBY|FOG SIGNAL|GPS|NAVTEX|INOPERATIVE|UNRELIABLE|NAVIGATIONAL AIDS",
    ),
)
ANGLE = (
    r"(\d{1,3})\s*[-°º]\s*(\d{1,2}(?:[.,]\d+)?)(?:\s*['′’]?\s*-?\s*(\d{2}(?:[.,]\d+)?)\s*[\"″”])?"
    r"(?:-(\d{2}(?:\.\d+)?))?\s*['′’]?\s*"
)
# (not \b after the E or W: Chinese runs straight on, and its characters count as letters to \b)
POSITION = re.compile(rf"(?<!\d)(?<!\d\.){ANGLE}([NS])[\s.,/-]*(?:AND\s+)?(?:LONG(?:ITUDE)?[.:]?\s*)?{ANGLE}([EW])(?![A-Z])")
RUSSIAN = {"С": "N", "Ю": "S", "В": "E", "З": "W"}
TURKISH = {"K": "N", "G": "S", "D": "E", "B": "W"}  # kuzey, güney, doğu, batı
REACH = re.compile(rf"WITHIN\s+(\d+(?:\.\d+)?|{'|'.join(WORDS)})\s+(?:NAUTICAL\s+)?({'|'.join(METRES)})S?\b")
LETTERED = re.compile(r"\n\s*[A-Z]{1,2}[.)]\s")
AREA = re.compile(r"\bBOUNDED\b|\bBOUNDARY\b|\bAREAS?\b")
LINE = re.compile(r"\bTRACKLINES?\b|\bALONG\b|\bJOINING\b|\bROUTES?\b|\bCABLES?\b|\bPIPELINES?\b")
MONTHS = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
FOREIGN = {"ENE": "JAN", "FEV": "FEB", "ABR": "APR", "MAI": "MAY", "AGO": "AUG", "SET": "SEP", "OUT": "OCT", "DEZ": "DEC",
           "DIC": "DEC"}
FULL = "JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER"
WHEN = (
    rf"(?<![\d/-])(?P<day>\d{{1,2}})(?P<time>\d{{4}})?Z?(?:\s*UTC)?\s*-?\s*"
    rf"(?P<month>{FULL}|SEPT|{'|'.join(MONTHS)}|{'|'.join(FOREIGN)})(?![A-Z])\.?,?\s*"
    r"(?P<year>20[2-9]\d|\d\d(?!\d|\.\d|[°-]))?(?:,?\s*(?P<clock>\d\d:?\d\d)(?![\d-]))?"
)
DATE = re.compile(WHEN)
CANCELLED = re.compile(rf"CANCEL\b[^.]{{0,70}}?THIS (?:MSG|MESSAGE|WARNING|PARAGRAPH|PARA)\b\D{{0,12}}{WHEN}")
RUNS_TO = re.compile(rf"(?:\bTO|\bA|\bUNTILL?|\bTILL|\bTHRU|\bTHROUGH)\s+{WHEN}")

WARNING_ROW = re.compile(
    r'id="Reference_(\d+)"[^>]*>\s*(.*?)\s*</td>.*?id="DateTimeGroupRnwFormat_\1"[^>]*>\s*(.*?)\s*</td>.*?<pre[^>]*>(.*?)</pre>',
    re.DOTALL,
)

refreshing = threading.Lock()
found = {"items": None, "checked": 0.0}
latest = {"items": None, "answer": None}
places = {"names": None, "longest": 0, "joined": []}


def seconds(whole: str, minutes: str, marked: str, dashed: str) -> float:
    """An angle in degrees, from its parts: seconds come either marked with a quote or after a second dash."""
    second = (marked or dashed or "0").replace(",", ".")
    return int(whole) + float(minutes.replace(",", ".")) / 60 + float(second) / 3600


def tidied(text: str) -> str:
    """The many ways authorities write a position, brought round to 56-32.5N, or 56-32-30N."""
    text = re.sub(r"[–—−]", "-", text).replace("〫", "°")
    text = re.sub(r"(\d)\s*([СЮВЗ])(?![А-Я])", lambda found: found[1] + RUSSIAN[found[2]], text)
    text = re.sub(r"(\d)=(\d)", r"\1-\2", text)  # (a slip for a dash, now and then)
    minutes = r"(\d{2}(?:[.,]\d+)?)"
    text = re.sub(  # Turkish: 36 38.88 K - 028 03.69 D
        rf"(?<![\d.-])(\d{{1,3}} +{minutes}) *([KG])( *[-,] *)(\d{{1,3}} +{minutes}) *([DB])(?![A-ZÇĞİÖŞÜ])",
        lambda f: f"{f[1]}{TURKISH[f[3]]}{f[4]}{f[5]}{TURKISH[f[7]]}",
        text,
    )
    # (after a dash only when it follows a latitude: 34 40.7N-033 15.4E)
    start = r"(?<![\d.])(?<!\d-)(?<![\d.]-)"
    text = re.sub(rf"{start}(\d{{1,3}}) +{minutes} +{minutes}\s*([NSEW])(?![A-Z])", r"\1-\2-\3\4", text)
    return re.sub(rf"{start}(\d{{1,3}}) +{minutes}\s*([NSEW])(?![A-Z])", r"\1-\2\3", text)


def positions(text: str) -> list:
    """Every position in some text, as [lon, lat]."""
    out = []
    for parts in POSITION.findall(tidied(text)):
        lat, lon = seconds(*parts[:4]), seconds(*parts[5:9])
        if lat <= 90 and lon <= 180:
            out.append([-lon if parts[9] == "W" else lon, -lat if parts[4] == "S" else lat])
    return out


def reach(text: str) -> float | None:
    """How far a warning reaches around its position, in metres, if it says."""
    match = REACH.search(text)
    if not match:
        return None
    number, unit = match.groups()
    return (WORDS.index(number) + 1 if number in WORDS else float(number)) * METRES[unit]


def unwrapped(points: list) -> list:
    """Keeps a shape across the date line in one piece, running on past 180."""
    out = [points[0]]
    for lon, lat in points[1:]:
        out.append([lon + 360 * round((out[-1][0] - lon) / 360), lat])
    return out


def area(points: list) -> list:
    points = unwrapped(points)
    shape = shapely.Polygon(points)
    if not shape.is_valid:  # the corners weren't listed in order round it
        shape = shapely.MultiPoint(points).convex_hull
    return shapely.get_coordinates(shape).round(4).tolist()


def ring_around(points: list, metres: float) -> list:
    """The ring around a point or a line, this far from it. Degrees of longitude shrink away from the equator."""
    points = unwrapped(points)
    across = max(math.cos(math.radians(sum(lat for _, lat in points) / len(points))), 0.05)
    flat = [[lon * across, lat] for lon, lat in points]
    shape = shapely.Point(flat[0]) if len(flat) == 1 else shapely.LineString(flat)
    ring = shape.buffer(metres / METRES_PER_DEGREE, quad_segs=CIRCLE_SIDES).exterior
    return [[round(lon / across, 4), round(lat, 4)] for lon, lat in shapely.get_coordinates(ring)]


def shapes(text: str) -> list:
    """Where a warning applies: {"ring": [...]} for an area, {"point": [...]} for a spot."""
    every = positions(text)
    if not every:
        return []
    around = reach(text)
    groups = [found for found in map(positions, LETTERED.split(text)[1:]) if found]
    if AREA.search(text) and not around and len(every) >= 3:
        return [{"ring": area(group)} for group in [g for g in groups if len(g) >= 3] or [every]]
    if LINE.search(text) and len(every) >= 2:
        lines = [g for g in groups if len(g) >= 2] or [every]
        return [{"ring": ring_around(line, around or CORRIDOR)} for line in lines]
    if around:
        return [{"ring": ring_around([point], around)} for point in every]
    return [{"point": [round(lon, 4), round(lat, 4)]} for lon, lat in every]


def plain(text: str) -> str:
    """Upper case letters and digits, single spaced, accents gone: how names and warnings are matched."""
    text = unicodedata.normalize("NFKD", text.upper()).replace("İ", "I")
    return " ".join(re.sub(r"[^\w]+", " ", "".join(c for c in text if not unicodedata.combining(c))).split())


def gazetteer() -> dict:
    """Natural Earth's named seas, bays, straits, lakes, ports and towns: plain name: (shape, area in square degrees)."""
    names = {}
    for file, fields in PLACE_FILES:
        path = PLACES / file
        if not path.exists():
            continue
        table = pyogrio.read_dataframe(path, columns=[*fields, *(["pop_max"] if "places" in file else [])])
        for row in table.itertuples():
            shape = shapely.make_valid(row.geometry)
            if shape.is_empty or "places" in file and (row.pop_max or 0) < TOWN_SIZE:
                continue
            for field in fields:
                value = getattr(row, field)
                name = plain(value) if isinstance(value, str) else ""  # (an empty one comes as NaN)
                if len(name) >= (SHORTEST_NAME if name.isascii() else 2) and name not in NOT_PLACES and shape.area <= WIDEST_PLACE:
                    if name not in names or shape.area < names[name][1]:
                        names[name] = (shape, shape.area)
    return names


def named_place(text: str, near: tuple | None) -> tuple | None:
    """The smallest place a warning names, as (name, shape), from words alone: when it gives no position. Only one
    near where the rest of its feed's warnings are, if they say, as many names are found the world over."""
    if not places["names"]:  # (and again until sync.py has fetched the files, the first time)
        places["names"] = gazetteer()
        places["longest"] = max((n.count(" ") + 1 for n in places["names"]), default=0)
        places["joined"] = [n for n in places["names"] if not n.isascii()]  # Chinese and such: no spaces to go by
    names, spaced = places["names"], f" {plain(text)} "
    words = spaced.split()
    found = {" ".join(words[i : i + n]) for n in range(1, places["longest"] + 1) for i in range(len(words) - n + 1)}
    found = {n for n in found if n in names} | {n for n in places["joined"] if n in text}
    if near:
        found = {n for n in found if names[n][0].intersects(shapely.box(*near))}
    # the smallest, and of the same size the last named: warnings start with the sea and end with the harbour
    last = lambda n: max(spaced.rfind(f" {n} "), text.rfind(n))  # noqa: E731
    best = min(found, key=lambda n: (names[n][1], -last(n)), default=None)
    return (best, names[best][0]) if best else None


def place_shape(shape: shapely.Geometry) -> dict:
    if shape.area == 0:
        point = shape.representative_point()
        return {"point": [round(point.x, 4), round(point.y, 4)]}
    biggest = max(shapely.get_parts(shape), key=lambda part: part.area)
    return {"ring": shapely.get_coordinates(biggest.exterior.simplify(PLACE_SIMPLIFY)).round(4).tolist()}


def category(text: str) -> str:
    for name, words in CATEGORIES:
        if re.search(rf"\b(?:{words})\b", text):
            return name
    return "Other"


def moment(found: re.Match, issued: float) -> float | None:
    """A date as seconds, or None if there's no such day. A day with no time runs to its end, and a date with no year
    is the one nearest the issue."""
    month = found["month"][:3]
    month = MONTHS.index(FOREIGN.get(month, month)) + 1
    year = found["year"] or datetime.datetime.fromtimestamp(issued, datetime.UTC).year
    year = int(year) + (2000 if found["year"] and len(found["year"]) == 2 else 0)
    clock = (found["time"] or found["clock"] or "2359:59").replace(":", "")
    try:
        date = datetime.datetime(year, month, int(found["day"]), tzinfo=datetime.UTC)
    except ValueError:
        return None
    date = date.timestamp() + int(clock[:2]) * 3600 + int(clock[2:4]) * 60 + (59 if len(clock) > 4 else 0)
    if not found["year"] and date < issued - HALF_YEAR:
        date += 365 * 86400
    return date


def ends(text: str, issued: float) -> float | None:
    """When a warning stops applying, in seconds, if it says. Its own cancel date wins; otherwise the last date from
    the first thing it runs up to on, as a list of days goes on after its first range. With neither it stands: better
    an old warning than a missing one."""
    text = " ".join(text.split())
    text = re.sub(
        r"\b(20[2-9]\d)-(0[1-9]|1[0-2])-(\d\d)\b", lambda found: f"{found[3]} {MONTHS[int(found[2]) - 1]} {found[1]}", text
    )
    text = re.sub(rf"\b({FULL}) (\d{{1,2}})(?:ST|ND|RD|TH)?\b,? ?", r"\2 \1 ", text)
    text = re.sub(rf"\b(\d{{1,2}}) ?- ?(\d{{1,2}} (?:{FULL}|{'|'.join(MONTHS)})(?![A-Z]))", r"\1 TO \2", text)
    found = list(CANCELLED.finditer(text))
    if not found and (start := RUNS_TO.search(text)):
        found = DATE.finditer(text, start.start())
    return max(filter(None, (moment(date, issued) for date in found)), default=None)


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "ENC 3D nav warning viewer"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as res:
        return res.read()


def feed_items(name: str) -> list:
    """A feed's warnings, as they came."""
    items = []
    for item in ET.fromstring(get(f"{SITE}/feeds/{name}.xml")).findall(".//item"):
        published = email.utils.parsedate_to_datetime(item.findtext("pubDate"))
        items.append({
            "feed": name,
            "title": item.findtext("title"),
            "url": item.findtext("link"),
            "text": html.unescape(re.sub(r"<br\s*/?>\s*", "\n", item.findtext("description") or "")).strip(),
            "issued": published.timestamp(),
        })
    return items


def ukho_items(page: str) -> list:
    """The warnings on the UKHO's page, shaped like a feed's."""
    items = []
    for _, reference, issued, text in WARNING_ROW.findall(page):
        issued = datetime.datetime.strptime(issued, "%d%H%M UTC %b %y").replace(tzinfo=datetime.UTC)
        items.append({
            "feed": "ukho",
            "title": reference,
            "url": f"{UKHO}#{reference.replace(' ', '')}",  # (one page for all, and warnings are told apart by URL)
            "text": html.unescape(text).strip(),
            "issued": issued.timestamp(),
        })
    return items


def official_first(items: list) -> list:
    """The UKHO's word over SeaLagom's copies of its warnings, so that one it has cancelled goes at once."""
    if not any(item["feed"] == "ukho" for item in items):
        return items
    return [item for item in items if item["feed"] == "ukho" or not (item["feed"] == "navarea/1" or item["title"].startswith("WZ "))]


def refresh() -> None:
    """Goes through every feed. One that fails keeps the warnings it had."""
    try:
        listing = get(f"{SITE}/coastal/").decode("utf-8", "replace")
        coastal = sorted({int(n) for n in re.findall(r"/coastal/(\d+)/", listing)})
        feeds = ["ukho"] + [f"navarea/{n}" for n in NAVAREAS] + [f"coastal/{n}" for n in coastal]
        items, failed = [], set()
        for feed in feeds:
            time.sleep(PAUSE)
            try:
                items += ukho_items(get(UKHO).decode("utf-8", "replace")) if feed == "ukho" else feed_items(feed)
            except (OSError, ET.ParseError, ValueError, TypeError):
                failed.add(feed)
        items = official_first(items + [item for item in found["items"] or [] if item["feed"] in failed])
        if len(failed) < len(feeds) / 2:  # or the site's away: keep what we have
            SAVED.write_text(json.dumps(items), encoding="utf-8")
            found.update(items=items, checked=time.time())
    except OSError:
        pass  # the next ask tries again
    finally:
        refreshing.release()


def source(item: dict) -> str:
    if item["feed"] == "ukho":
        return "NAVAREA I" if item["title"].startswith("NAVAREA") else "UK coastal"
    kind, number = item["feed"].split("/")
    return f"NAVAREA {ROMAN[int(number) - 1]}" if kind == "navarea" else "Coastal"


def read(items: list) -> dict:
    """Saved warnings still in force, as the viewer wants them: each one once, however many feeds carried it."""
    warnings, by_name, spread = {}, [], collections.defaultdict(list)
    now = time.time()
    for item in items:
        if item["url"] in warnings:
            continue
        text = item["text"].upper()
        kind = category(text)
        end = ends(text, item["issued"])
        if kind == SEARCH:
            end = min(end or math.inf, item["issued"] + SAR_LIFE)
        if end and end < now:
            continue
        warnings[item["url"]] = warning = {
            "id": item["title"],
            "url": item["url"],
            "source": source(item),
            "category": kind,
            "issued": item["issued"],
            "ends": end,
            "text": item["text"],
            "shapes": shapes(text),
        }
        if warning["shapes"]:
            spread[item["feed"]] += [p for s in warning["shapes"] for p in s.get("ring", [s.get("point")])]
        else:
            by_name.append((item["feed"], warning))
    # then those with no position, by the places they name
    unplaced = 0
    for feed, warning in by_name:
        near = None
        if len(spread[feed]) >= 3:
            lons, lats = zip(*spread[feed])
            near = (min(lons) - FEED_MARGIN, min(lats) - FEED_MARGIN, max(lons) + FEED_MARGIN, max(lats) + FEED_MARGIN)
        place = named_place(warning["text"].upper(), near)
        if place:
            warning.update(shapes=[place_shape(place[1])], placedBy=place[0].title())
        else:
            del warnings[warning["url"]]
            unplaced += 1
    counts = collections.Counter(item["feed"] for item in items)
    full = [feed for feed, count in counts.items() if count >= FEED_LIMIT and feed != "ukho"]
    return {"warnings": list(warnings.values()), "unplaced": unplaced, "cut": full}


def read_found() -> None:
    if found["items"] is not None and latest["items"] is not found["items"]:
        latest.update(items=found["items"], answer=read(found["items"]))


def run() -> None:
    """At startup, the saved warnings are placed, and the feeds read if those are old; then the feeds are read again
    every hour, on the hour."""
    if SAVED.exists():
        found.update(items=json.loads(SAVED.read_text(encoding="utf-8")), checked=SAVED.stat().st_mtime)
        read_found()
    due = time.time() - found["checked"] > FRESH
    while True:
        try:
            if due and refreshing.acquire(blocking=False):
                refresh()
            read_found()
        except Exception:  # whatever it was, the warnings we have stand, and the next hour tries again
            pass
        found["tried"] = True
        time.sleep(FRESH - time.time() % FRESH)  # (an hour's seconds go evenly into a day's, so this is :00)
        due = True


def ready() -> bool:
    """Placed, or tried: the viewer opens with them, or without them if the feeds can't be reached."""
    return latest["answer"] is not None or found.get("tried", False)


def current() -> dict:
    """What we have now, less any that have run out since."""
    if latest["answer"] is None:
        return {"warnings": [], "unplaced": 0, "cut": [], "checked": None, "loading": not found.get("tried")}
    now = time.time()
    warnings = [w for w in latest["answer"]["warnings"] if not w["ends"] or w["ends"] >= now]
    return {**latest["answer"], "warnings": warnings, "checked": found["checked"], "loading": False}
