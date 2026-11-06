"""History for fleet vessels from free sources, beyond what Open Waters keeps.

- Global Fishing Watch: every vessel's port visits, worldwide, back to 2017, from its free API (non-commercial use,
  CC BY-NC 4.0). It needs the user's own token, from globalfishingwatch.org/our-apis/tokens. No draught.
- US MarineCadastre (NOAA/BOEM, CC0): every AIS report in US waters a minute apart, a file a day, 2009 to 2025. Each
  day is read as it downloads and all but the fleet's vessels thrown away, so nothing big is kept: about 230 MB a day
  to download, some 420 GB for 2021 to 2025, a day or more. With draught.
- Danish Maritime Authority: every AIS report heard in Danish waters, a zip a day (500 to 800 MB), 2006 to now, with
  draught, destination and ETA. Each is downloaded, read for the fleet's vessels and deleted.

The archive runs are long, so they're started by the user, one at a time, and pick up where they left off if the
server stops. Each keeps a report every SAMPLE seconds for each vessel, and every report where its draught or status
changed, so a day of minute-by-minute AIS becomes about a hundred rows a vessel."""
import calendar
import csv
import datetime
import io
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import fleet

GFW = "https://gateway.api.globalfishingwatch.org/v3/"
GFW_FROM = "2017-01-01"
US_URL = "https://noaaocm.blob.core.windows.net/ais/csv2/csv{year}/ais-{day}.csv.zst"
US_YEARS = (2021, 2025)  # 2026 isn't published till about March 2027
DK_BUCKET = "http://aisdata.ais.dk.s3.eu-central-1.amazonaws.com/"
SAMPLE = 15 * 60  # s between reports kept for a vessel, unless its draught or status changes
SETTINGS = fleet.STORE.parent / "settings.json"
TIMEOUT = 120  # s

run_lock = threading.Lock()
progress = {}  # source: {"day", "done", "total", "kept", "running", "error"}
stop = threading.Event()


def settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text())
    except (OSError, ValueError):
        return {}


def set_gfw_token(token: str) -> None:
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps({**settings(), "gfw_token": token.strip()}))


def state() -> dict:
    """What the Fleet tab shows: whether there's a token (never the token), and each run's progress."""
    with fleet.db() as c:
        done = dict(c.execute("SELECT source, COUNT(*) FROM archive_days GROUP BY source").fetchall())
    return {"gfwToken": bool(settings().get("gfw_token")), "runs": progress, "daysDone": done}


# Global Fishing Watch -----------------------------------------------------------------------------------------------

def gfw(path: str, params: list) -> dict:
    token = settings().get("gfw_token")
    if not token:
        raise PermissionError("No Global Fishing Watch token set")
    request = urllib.request.Request(GFW + path + "?" + urllib.parse.urlencode(params), headers={
        "Authorization": f"Bearer {token}", "User-Agent": "ENC 3D"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as res:
        return json.load(res)


def gfw_vessel_ids(mmsi: int) -> list:
    """GFW's own ids for a vessel: one for each spell of its AIS identity, which can change over the years."""
    found = gfw("vessels/search", [("query", str(mmsi)), ("datasets[0]", "public-global-vessel-identity:latest")])
    ids = []
    for entry in found.get("entries", []):
        for info in entry.get("selfReportedInfo", []):
            if str(info.get("ssvid")) == str(mmsi) and info.get("id"):
                ids.append(info["id"])
    return list(dict.fromkeys(ids))


def gfw_port_visits(mmsi: int) -> list:
    ids = gfw_vessel_ids(mmsi)
    if not ids:
        return []
    visits, offset = [], 0
    while offset is not None:
        params = [("datasets[0]", "public-global-port-visits-events:latest"), ("start-date", GFW_FROM),
                  ("end-date", datetime.date.today().isoformat()), ("limit", "200"), ("offset", str(offset))]
        params += [(f"vessels[{i}]", vessel) for i, vessel in enumerate(ids)]
        page = gfw("events", params)
        for e in page.get("entries", []):
            visit = e.get("port_visit") or e.get("portVisit") or {}
            anchorage = visit.get("intermediateAnchorage") or visit.get("startAnchorage") or {}
            position = e.get("position") or {}
            visits.append({
                "start": fleet.seconds(e.get("start")), "end": fleet.seconds(e.get("end")),
                "lat": float(position.get("lat") or anchorage.get("lat") or 0),
                "lng": float(position.get("lon") or anchorage.get("lon") or 0),
                "name": anchorage.get("name") or anchorage.get("topDestination"),
                "flag": anchorage.get("flag"),
                "confidence": visit.get("confidence"),
            })
        offset = page.get("nextOffset")
        time.sleep(0.2)
    return [v for v in visits if v["start"] and v["end"]]


def run_gfw() -> None:
    """Every fleet vessel's port visits from GFW, kept alongside those worked out from its reports."""
    progress["gfw"] = {"running": True, "done": 0, "total": 0, "error": None}
    mmsis = sorted(fleet.tracked())
    progress["gfw"]["total"] = len(mmsis)
    try:
        for mmsi in mmsis:
            if stop.is_set():
                break
            visits = gfw_port_visits(mmsi)
            with fleet.db() as c:
                c.execute("DELETE FROM gfw_visits WHERE mmsi = ?", (mmsi,))
                c.executemany("INSERT OR IGNORE INTO gfw_visits VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                              [(mmsi, v["start"], v["end"], v["lng"], v["lat"], v["name"], v["flag"], v["confidence"]) for v in visits])
            progress["gfw"]["done"] += 1
    except PermissionError as e:
        progress["gfw"]["error"] = str(e)
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode("utf-8", "replace")
        progress["gfw"]["error"] = f"Global Fishing Watch said {e.code}: {detail}"
    except (OSError, ValueError) as e:
        progress["gfw"]["error"] = f"Global Fishing Watch couldn't be reached: {e}"
    except Exception as e:  # (an answer cut off, or not as expected: the run ends, but says why)
        progress["gfw"]["error"] = f"Global Fishing Watch's answer couldn't be read: {type(e).__name__}: {e}"
    finally:
        progress["gfw"]["running"] = False


# The archives -------------------------------------------------------------------------------------------------------

def keep(rows: list, mmsis: set) -> list:
    """The fleet's reports from a day's rows, thinned: one every SAMPLE seconds a vessel, and every change of draught
    or status. rows are (mmsi, t, lng, lat, sog, cog, status, draught, destination, eta), in time order."""
    kept, last = [], {}
    for row in rows:
        mmsi = row[0]
        if mmsi not in mmsis:
            continue
        before = last.get(mmsi)
        if before is None or row[1] - before[1] >= SAMPLE or row[7] != before[7] or row[6] != before[6]:
            kept.append(row)
            last[mmsi] = row
    return kept


def number(text):
    try:
        return float(text) if text not in ("", None) else None
    except ValueError:
        return None


def us_day(day: datetime.date, mmsis: set) -> list:
    """One day of US MarineCadastre, read as it arrives, keeping only the fleet."""
    import zstandard

    url = US_URL.format(year=day.year, day=day.isoformat())
    request = urllib.request.Request(url, headers={"User-Agent": "ENC 3D"})
    rows = []
    wanted = {str(m) for m in mmsis}
    with urllib.request.urlopen(request, timeout=TIMEOUT) as res:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(res), encoding="utf-8", errors="replace")
        head = next(csv.reader([next(text)]))
        # (the MMSI leads each line: only the fleet's lines are worth parsing, a few in millions)
        mine = (line for line in text if line[: line.find(",")] in wanted)
        for r in csv.DictReader(mine, fieldnames=head):
            t = calendar.timegm(time.strptime(r["base_date_time"], "%Y-%m-%d %H:%M:%S"))
            status = number(r.get("status"))
            rows.append((int(r["mmsi"]), t, float(r["longitude"]), float(r["latitude"]), number(r["sog"]),
                         number(r["cog"]), None if status is None else int(status), number(r.get("draft")), None, None))
    rows.sort(key=lambda row: (row[0], row[1]))
    return keep(rows, mmsis)


# its status as words, as the Danish files give it (spelt more than one way), to AIS's number
DK_STATUS = {"under way using engine": 0, "at anchor": 1, "not under command": 2, "restricted maneuverability": 3,
             "restricted manoeuverability": 3, "restricted manoeuvrability": 3, "constrained by her draught": 4, "moored": 5,
             "aground": 6, "engaged in fishing": 7, "under way sailing": 8}


def dk_keys() -> dict:
    """The Danish bucket's files: day (or month, for the months it keeps whole) to key."""
    keys, token = {}, None
    while True:
        query = {"list-type": "2", **({"continuation-token": token} if token else {})}
        with urllib.request.urlopen(DK_BUCKET + "?" + urllib.parse.urlencode(query), timeout=TIMEOUT) as res:
            page = res.read().decode()
        for key in re.findall(r"<Key>([^<]+\.zip)</Key>", page):
            found = re.search(r"aisdk-(\d{4}-\d{2}(?:-\d{2})?)\.zip$", key)
            if found:
                keys[found.group(1)] = key
        token = (re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", page) or [None, None])[1]
        if not token:
            return keys


def dk_read(path: Path, mmsis: set) -> list:
    """The fleet's reports from one of the Danish zips on disk."""
    rows = []
    wanted = {str(m) for m in mmsis}
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.lower().endswith(".csv"):
                continue
            with z.open(name) as f:
                text = io.TextIOWrapper(f, encoding="utf-8", errors="replace")
                head = [h.strip().lstrip("#").strip() for h in next(csv.reader([next(text)]))]
                col = {h: i for i, h in enumerate(head)}
                at = col["MMSI"]
                # (only the fleet's lines are worth parsing, a few in millions: the MMSI is a plain field, no quotes)
                mine = (line for line in text if line.split(",", at + 1)[at] in wanted)
                for r in csv.reader(mine):
                    if len(r) < len(head):
                        continue
                    t = calendar.timegm(time.strptime(r[col["Timestamp"]], "%d/%m/%Y %H:%M:%S"))
                    status = DK_STATUS.get(r[col["Navigational status"]].strip().lower())
                    rows.append((int(r[at]), t, number(r[col["Longitude"]]), number(r[col["Latitude"]]),
                                 number(r[col["SOG"]]), number(r[col["COG"]]), status, number(r[col["Draught"]]),
                                 r[col["Destination"]] if r[col["Destination"]] not in ("", "Unknown") else None,
                                 r[col["ETA"]] or None))
    # (AIS gives a latitude of 91 and a longitude of 181 for no position)
    rows = [r for r in rows if r[2] is not None and r[3] is not None and abs(r[3]) <= 90 and abs(r[2]) <= 180]
    rows.sort(key=lambda row: (row[0], row[1]))
    return keep(rows, mmsis)


DK_PART = fleet.STORE.parent / "dk.part"  # the Danish zip being read: always this one file, so a run cut off (the app
# closed mid-download, say) leaves nothing behind but this, written over by the next


def dk_file(key: str, mmsis: set) -> list:
    """One of the Danish zips: downloaded, read for the fleet, deleted."""
    request = urllib.request.Request(DK_BUCKET + urllib.parse.quote(key), headers={"User-Agent": "ENC 3D"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as res, open(DK_PART, "wb") as out:
            while chunk := res.read(1 << 20):
                out.write(chunk)
                if stop.is_set():
                    return []
        return dk_read(DK_PART, mmsis)
    finally:
        DK_PART.unlink(missing_ok=True)


def run_archive(source: str, years: int) -> None:
    progress[source] = {"running": True, "done": 0, "total": 0, "kept": 0, "day": None, "error": None}
    try:
        read_archive(source, years)
    except Exception as e:  # (its list of files couldn't be had, say: the run ends, but says why)
        progress[source]["error"] = f"{type(e).__name__}: {e}"
    finally:
        progress[source]["running"] = False


def read_archive(source: str, years: int) -> None:
    """Day by day through the last so many years of an archive for the fleets' vessels, newest first, so that a run
    stopped part way has the most recent history. A day already read for these vessels (or more) is skipped; adding
    vessels later means a fresh pass for the new set."""
    mmsis = set(fleet.tracked())
    key = json.dumps(sorted(mmsis))
    if source == "us":
        first = datetime.date(max(US_YEARS[0], US_YEARS[1] - years + 1), 1, 1)
        days = [first + datetime.timedelta(n) for n in range((datetime.date(US_YEARS[1], 12, 31) - first).days + 1)]
        files = [(d.isoformat(), d) for d in days]
    else:
        listed = dk_keys()
        start = (datetime.date.today() - datetime.timedelta(days=365 * years)).isoformat()[:7]
        files = sorted((stamp, k) for stamp, k in listed.items() if stamp[:7] >= start)
    files.reverse()
    progress[source]["total"] = len(files)
    with fleet.db() as c:
        read = {d for d, done in c.execute("SELECT day, mmsis FROM archive_days WHERE source = ?", (source,))
                if mmsis <= set(json.loads(done))}
    for stamp, what in files:
        if stop.is_set():
            break
        progress[source]["day"] = stamp
        if stamp not in read and mmsis:
            rows = None
            for attempt in range(3):
                try:
                    rows = us_day(what, mmsis) if source == "us" else dk_file(what, mmsis)
                    break
                except Exception as e:  # (cut off mid-download, a truncated or bad file: tried again, then let be)
                    if attempt == 2:
                        progress[source]["error"] = f"{stamp}: {type(e).__name__}: {e}"
                    else:
                        time.sleep(10)
            if rows is None:
                continue  # (tried again on the next run)
            if stop.is_set():
                break
            with fleet.db() as c:
                c.executemany("INSERT OR IGNORE INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
                c.execute("INSERT OR IGNORE INTO archive_days VALUES (?, ?, ?)", (source, stamp, key))
            progress[source]["kept"] += len(rows)
        progress[source]["done"] += 1


def start(source: str, years: int = 1) -> bool:
    """Starts a run in the background, unless one's going already."""
    if not run_lock.acquire(blocking=False):
        return False
    stop.clear()

    def go():
        try:
            run_gfw() if source == "gfw" else run_archive(source, years)
        finally:
            run_lock.release()

    threading.Thread(target=go, daemon=True).start()
    return True
