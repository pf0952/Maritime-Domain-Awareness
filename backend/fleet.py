"""Fleets of vessels and their history: recorded from Open Waters as it goes, and as much of the past as it keeps.

Every RECORD_EVERY, each vessel in any fleet is looked up and its report kept: where it was, how fast, its status,
draught, destination and ETA. Open Waters keeps tracks back to about October 2025, so a vessel newly added has those
filled in too, though they carry no draught: loads and discharges show from when recording began.

From the reports, worked out for each vessel on its own: its port calls, the voyages between them, laden or in
ballast, and where its draught changed in port, its loads and discharges."""
import bisect
import calendar
import json
import math
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
from pathlib import Path

import route
import tides

AIS = "https://ais.openwaters.io/v1/vessels/"
STORE = Path(__file__).parent.parent / "enc" / "fleet" / "history.sqlite"
MOST = 50  # vessels in a fleet
RECORD_EVERY = 600  # s
SPACING = 1.5  # s between reads: Open Waters allows 120 a minute from one address, and the viewer's map needs its share
BUSY_WAIT = 60  # s to hold off when Open Waters says too many requests
BACKFILL_FROM = "2025-10-01T00:00:00Z"  # about as far back as Open Waters keeps tracks
BACKFILL_WINDOW = 30 * 86400  # s of track asked for at once
STOPPED = 1.0  # knots: slower than this, a vessel's not under way
PORT_REACH = 15  # nm: a stop this near a port is a call there
CALL_MIN = 2 * 3600  # s: a shorter stop is a pause, not a call
GAP = 12 * 3600  # s: reports further apart than this at sea are a gap, the AIS off or out of anyone's hearing
DRAUGHT_NEAR = 48 * 3600  # s either side of a call that a draught given counts for it
EVENT_SHARE = 0.2  # of its range of draught: a smaller change in port is bunkers or ballast, not cargo
DRAUGHT_CHANGE = 0.8  # m: a change of draught in port bigger than this is a load or discharge
BLOCK = 0.82  # of the box of length, beam and draught a tanker's hull fills, about: for tonnes a metre of draught
SEA_WATER = 1.025  # t/m³

lock = threading.Lock()
made = threading.Event()  # set once the tables exist


def db() -> sqlite3.Connection:
    """A connection of its own for the caller: sqlite's are per thread. The tables are made on the first."""
    STORE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(STORE, timeout=30)
    if not made.is_set():
        # (write-ahead logging: the Fleet tab reads while the recorder or an archive run writes, without waiting)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE IF NOT EXISTS fleets (name TEXT PRIMARY KEY, mmsis TEXT NOT NULL)")
        # backfilled: 0 not yet, 1 done, or else the second its track has been filled in up to
        connection.execute("""CREATE TABLE IF NOT EXISTS vessels (mmsi INTEGER PRIMARY KEY, record TEXT, backfilled INTEGER DEFAULT 0)""")
        connection.execute("""CREATE TABLE IF NOT EXISTS reports (mmsi INTEGER, t INTEGER, lng REAL, lat REAL, sog REAL,
            cog REAL, status INTEGER, draught REAL, destination TEXT, eta TEXT, PRIMARY KEY (mmsi, t))""")
        # Global Fishing Watch's port visits (archives.py), and which days of each archive were read for which vessels
        connection.execute("""CREATE TABLE IF NOT EXISTS gfw_visits (mmsi INTEGER, start INTEGER, end INTEGER, lng REAL,
            lat REAL, name TEXT, flag TEXT, confidence INTEGER, PRIMARY KEY (mmsi, start))""")
        connection.execute("CREATE TABLE IF NOT EXISTS archive_days (source TEXT, day TEXT, mmsis TEXT, PRIMARY KEY (source, day, mmsis))")
        connection.commit()
        made.set()
    return connection


def read(url: str) -> dict | None:
    """Open Waters' answer as a dict, or None if it had none to give: down, cut off, not JSON, or too busy (then it's
    let be for BUSY_WAIT before the next)."""
    try:
        found = tides.fetch_json(url)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            time.sleep(BUSY_WAIT)
        return None
    except (OSError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def fleets() -> list:
    with db() as c:
        return [{"name": n, "mmsis": json.loads(m)} for n, m in c.execute("SELECT name, mmsis FROM fleets ORDER BY name")]


def save_fleet(name: str, mmsis: list) -> None:
    with db() as c:
        c.execute("INSERT OR REPLACE INTO fleets VALUES (?, ?)", (name, json.dumps(mmsis[:MOST])))
    threading.Thread(target=backfill_all, daemon=True).start()


def delete_fleet(name: str) -> None:
    with db() as c:
        c.execute("DELETE FROM fleets WHERE name = ?", (name,))


def seconds(text: str | None) -> int | None:
    """Unix seconds from "2026-11-04T03:49:07Z"."""
    try:
        return calendar.timegm(time.strptime(text[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return None


def tracked() -> set:
    return {m for f in fleets() for m in f["mmsis"]}


def record(mmsi: int) -> None:
    """A vessel's latest report, kept if it's new."""
    found = read(AIS + str(mmsi))
    if found is None:
        return
    p = found.get("properties") or {}
    lng, lat = (found.get("geometry") or {}).get("coordinates", (None, None))
    with db() as c:
        c.execute("INSERT OR REPLACE INTO vessels (mmsi, record, backfilled) VALUES (?, ?, COALESCE((SELECT backfilled "
                  "FROM vessels WHERE mmsi = ?), 0))", (mmsi, json.dumps(p), mmsi))
        t = seconds(p.get("seen"))
        if t and lng is not None:
            c.execute("INSERT OR IGNORE INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (mmsi, t, lng, lat, p.get("sog"), p.get("cog"), p.get("nav_status"), p.get("draught"),
                       p.get("destination"), p.get("eta")))


def backfill(mmsi: int, reached: int = 0) -> None:
    """Open Waters' track, a window at a time, from as far back as it keeps (or where an earlier try got to) up to now.
    No draught comes with it."""
    start = max(seconds(BACKFILL_FROM), reached)
    now = int(time.time())
    for begin in range(start, now, BACKFILL_WINDOW):
        end = min(begin + BACKFILL_WINDOW, now)
        query = urllib.parse.urlencode({
            "interval": "30m",
            "from": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(begin)),
            "to": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end)),
        })
        found = read(f"{AIS}{mmsi}/track?{query}")
        if found is None:
            return  # (tried again with the next round, from here)
        time.sleep(SPACING)
        p = found.get("properties") or {}
        geometry = found.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if geometry.get("type") == "Point":  # (a window with one report in it)
            coords = [coords]
        rows = []
        for i, when in enumerate(p.get("times") or []):
            t = seconds(when)
            if t is None or i >= len(coords):
                continue
            def pick(key):
                values = p.get(key) or []
                return values[i] if i < len(values) else None
            if isinstance(coords[i], (list, tuple)) and len(coords[i]) >= 2:
                rows.append((mmsi, t, coords[i][0], coords[i][1], pick("sog"), pick("cog"), pick("nav_status"), None, None, None))
        with db() as c:
            c.executemany("INSERT OR IGNORE INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
            c.execute("UPDATE vessels SET backfilled = ? WHERE mmsi = ?", (end, mmsi))
    with db() as c:
        c.execute("UPDATE vessels SET backfilled = 1 WHERE mmsi = ?", (mmsi,))


def backfill_all() -> None:
    with lock:  # (one at a time, however many fleets are saved at once)
        for mmsi in tracked():
            record(mmsi)
            time.sleep(SPACING)
            with db() as c:
                done = c.execute("SELECT backfilled FROM vessels WHERE mmsi = ?", (mmsi,)).fetchone()
            reached = done[0] if done else 0
            if reached != 1:
                backfill(mmsi, reached)


def run() -> None:
    """The recorder: every vessel in any fleet, every RECORD_EVERY, for as long as the server runs. Nothing that goes
    wrong in one round stops the next: it's logged, and tried again."""
    while True:
        try:
            backfill_all()
        except Exception as e:  # (a bad answer, a full disk, a locked database: the next round may fare better)
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} Fleet recording: {type(e).__name__}: {e}", flush=True)
        time.sleep(RECORD_EVERY)


def nm(a: tuple, b: tuple) -> float:
    return route.nm([a[0], a[1]], [b[0], b[1]])


def nearest_port(lng: float, lat: float) -> tuple:
    """The port within PORT_REACH: searoute's if any, as UNECE's list has a few positions wrong, a town in New Mexico
    put in New York harbour among them."""
    for checked in (True, False):
        best, miles = None, PORT_REACH
        for port in route.ports()[0].values():
            if port.get("un", False) == checked:
                continue
            if abs(port["lat"] - lat) > 0.5 or abs(port["lng"] - lng) > 0.5 / max(math.cos(math.radians(lat)), 0.2):
                continue
            d = nm((lng, lat), (port["lng"], port["lat"]))
            if d < miles:
                best, miles = port, d
        if best:
            return best, miles
    return None, PORT_REACH


def cargo(change: float, deadweight: float | None, design: float | None, light: float | None, length: float,
          beam: float) -> float | None:
    """Tonnes loaded or discharged for a change of draught (m). As the IMF's papers do, the share of the vessel's
    deadweight that the change is of its range from light to design draught; failing a deadweight, the water the hull
    displaces over that change, as a box of its length and beam filled to BLOCK."""
    if deadweight and design and light is not None and design - light > 1:
        return round(deadweight * change / (design - light), -2)
    if length and beam:
        return round(change * length * beam * BLOCK * SEA_WATER, -2)
    return None


def analyse(mmsi: int) -> dict:
    """One vessel's history: its reports thinned for drawing, draught over time, port calls, voyages, gaps."""
    with db() as c:
        row = c.execute("SELECT record FROM vessels WHERE mmsi = ?", (mmsi,)).fetchone()
        reports = c.execute("SELECT t, lng, lat, sog, status, draught, destination FROM reports WHERE mmsi = ? ORDER BY t",
                            (mmsi,)).fetchall()
        visits = c.execute("SELECT start, end, lng, lat, name FROM gfw_visits WHERE mmsi = ? ORDER BY start", (mmsi,)).fetchall()
    record_ = json.loads(row[0]) if row and row[0] else {}
    times = [r[0] for r in reports]

    def between(start: float, end: float, closed: bool = True) -> list:
        """The reports from start to end (end itself too, if closed), in order."""
        return reports[bisect.bisect_left(times, start):(bisect.bisect_right if closed else bisect.bisect_left)(times, end)]
    length, beam = record_.get("length") or 0, record_.get("beam") or 0

    # its draughts' range, light to deep: loads and discharges are judged against it, and cargo worked out from it
    observed = sorted(r[5] for r in reports if r[5])
    light = observed[len(observed) // 20] if len(observed) >= 20 else (observed[0] if observed else None)
    deep = observed[-1] if observed else None
    particulars = record_.get("particulars") or {}
    deadweight, design = particulars.get("deadweight"), particulars.get("draught") or deep
    threshold = max(DRAUGHT_CHANGE, EVENT_SHARE * (deep - light)) if observed else DRAUGHT_CHANGE

    def call(arriving: int, leaving: int, lng: float, lat: float, anchored: bool, source: str, name: str | None = None) -> dict:
        port, _ = nearest_port(lng, lat)
        # its draught coming in: the last given before it stopped, or failing that the first in port. Going out: the
        # first given after it left, as crews often set it then, or failing that the last in port. Only within
        # DRAUGHT_NEAR either side: older says nothing of this call
        draughts = [x[5] for x in between(arriving, leaving) if x[5]]
        before = next((x[5] for x in reversed(between(arriving - DRAUGHT_NEAR, arriving, closed=False)) if x[5]), None)
        after = next((x[5] for x in between(leaving + 1, leaving + DRAUGHT_NEAR) if x[5]), None)
        arrived_draught = before if before is not None else (draughts[0] if draughts else None)
        left_draught = after if after is not None else (draughts[-1] if draughts else None)
        change = None if arrived_draught is None or left_draught is None else round(left_draught - arrived_draught, 1)
        event = None
        if change is not None and abs(change) >= threshold:
            event = "load" if change > 0 else "discharge"
        return {
            "port": ({"code": port["code"], "name": port["name"]} if port else {"code": "", "name": name} if name else None),
            "at": [round(lng, 4), round(lat, 4)],
            "arrive": arriving, "depart": leaving,
            "hours": round((leaving - arriving) / 3600, 1),
            "anchored": anchored, "source": source,
            "draughtIn": arrived_draught, "draughtOut": left_draught, "change": change, "event": event,
            "tonnes": cargo(abs(change), deadweight, design, light, length, beam) if event else None,
        }

    # stops: runs of reports at under STOPPED knots; those near a port and long enough are calls there. Stops at anchor
    # count too: big tankers often load and discharge there
    calls, run_ = [], []
    for r in reports + [(None, 0, 0, 99, None, None, None)]:
        if r[0] is not None and (r[3] or 0) < STOPPED:
            run_.append(r)
            continue
        if run_ and run_[-1][0] - run_[0][0] >= CALL_MIN:
            lng = sum(x[1] for x in run_) / len(run_)
            lat = sum(x[2] for x in run_) / len(run_)
            anchored = sum(1 for x in run_ if x[4] == 1) > len(run_) / 2
            calls.append(call(run_[0][0], run_[-1][0], lng, lat, anchored, "AIS"))
        run_ = []
    # and Global Fishing Watch's, where the reports have none: far out of range of the receivers, say
    for start, end, lng, lat, name in visits:
        if not any(c["arrive"] < end and start < c["depart"] for c in calls):
            calls.append(call(start, end, lng, lat, False, "GFW", name))
    calls.sort(key=lambda c: c["arrive"])

    # voyages: from one call in port to the next, with the distance run between, and laden or in ballast by draught
    middle = (light + deep) / 2 if observed and deep - light >= DRAUGHT_CHANGE else None
    in_port = [c for c in calls if c["port"]]
    voyages = []
    for a, b in zip(in_port, in_port[1:]):
        legs = between(a["depart"], b["arrive"])
        miles = sum(nm(p[1:3], q[1:3]) for p, q in zip(legs, legs[1:]))
        hours = (b["arrive"] - a["depart"]) / 3600
        draught = a["draughtOut"]
        voyages.append({
            "from": a["port"], "to": b["port"], "depart": a["depart"], "arrive": b["arrive"],
            "miles": round(miles), "days": round(hours / 24, 1), "knots": round(miles / hours, 1) if hours else None,
            "laden": None if middle is None or draught is None else draught > middle,
        })

    gaps = [{"from": p[0], "to": q[0], "hours": round((q[0] - p[0]) / 3600)}
            for p, q in zip(reports, reports[1:]) if q[0] - p[0] > GAP and (p[3] or 0) >= STOPPED]
    step = max(1, len(reports) // 2000)
    return {
        "mmsi": mmsi,
        "record": record_,
        "reports": len(reports),
        "since": reports[0][0] if reports else None,
        "track": [[round(r[1], 4), round(r[2], 4), r[0]] for r in reports[::step]],
        "draughts": [[r[0], r[5]] for r in reports if r[5]],
        "calls": calls,
        "voyages": voyages,
        "gaps": gaps,
    }
