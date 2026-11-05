"""Checks the fleet history's reading of a voyage: a load at one port, a passage, a discharge at the next.

Run from the project folder: backend/.venv/Scripts/python backend/test_fleet.py"""
import json
import tempfile
from pathlib import Path

import fleet
import route

fleet.STORE = Path(tempfile.mkdtemp()) / "history.sqlite"
fleet.backfill_all = lambda: None  # (no asking Open Waters about made-up vessels)
H = 3600
ROTTERDAM, NEW_YORK = [(route.ports()[0][code]["lng"], route.ports()[0][code]["lat"]) for code in ("NLRTM", "USNYC")]
mmsi = 1


def report(t, at, sog, draught=None, status=0):
    return (mmsi, t, at[0], at[1], sog, 0, status, draught, None, None)


rows = []
t = 0
rows += [report(t + i * H, ROTTERDAM, 0.1, 8.0 if i < 2 else None, 5) for i in range(12)]  # in port, loading
t += 12 * H
rows.append(report(t + H, ROTTERDAM, 12, 14.2))  # draught set on leaving
# across the Atlantic: a report every 6 h for 10 days, and a day with none
for i in range(1, 41):
    if 20 <= i < 24:
        continue
    f = i / 41
    rows.append(report(t + i * 6 * H, tuple(a + (b - a) * f for a, b in zip(ROTTERDAM, NEW_YORK)), 14))
t += 41 * 6 * H
rows += [report(t + i * H, NEW_YORK, 0.2, 14.2 if i == 0 else None, 5) for i in range(20)]  # in port, discharging
t += 20 * H
rows.append(report(t + 2 * H, NEW_YORK, 11, 8.3))

with fleet.db() as c:
    c.execute("INSERT INTO vessels (mmsi, record) VALUES (?, ?)", (mmsi, json.dumps({"name": "TEST", "length": 250, "beam": 44})))
    c.executemany("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

found = fleet.analyse(mmsi)
calls = found["calls"]
assert [c["port"]["code"] for c in calls] == ["NLRTM", "USNYC"], [c["port"] for c in calls]
assert calls[0]["event"] == "load" and calls[0]["change"] == 6.2, calls[0]
assert calls[1]["event"] == "discharge" and calls[1]["change"] == -5.9, calls[1]
assert 50000 < calls[0]["tonnes"] < 65000, calls[0]["tonnes"]  # 6.2 m of a 250 by 44 m tanker's hull: about 57,000 t
voyage, = found["voyages"]
assert voyage["laden"] is True and 3000 < voyage["miles"] < 3400 and voyage["days"] > 9, voyage
assert len(found["gaps"]) == 1 and found["gaps"][0]["hours"] == 30, found["gaps"]

# with its deadweight and design draught known, cargo is the share of deadweight the change is of its draught's range
assert fleet.cargo(6.2, 110_000, 14.5, 8.0, 250, 44) == round(110_000 * 6.2 / 6.5, -2)
assert fleet.cargo(6.2, None, None, 8.0, 250, 44) == calls[0]["tonnes"]

# Global Fishing Watch's visits join those from the reports: one far from any report is added, one overlapping isn't
SINGAPORE = (route.ports()[0]["SGSIN"]["lng"], route.ports()[0]["SGSIN"]["lat"])
with fleet.db() as c:
    c.executemany("INSERT INTO gfw_visits VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        (mmsi, t + 30 * 24 * H, t + 31 * 24 * H, *SINGAPORE, "SINGAPORE", "SGP", 4),
        (mmsi, calls[1]["arrive"] + H, calls[1]["depart"] - H, *NEW_YORK, "NEW YORK", "USA", 4),
    ])
merged = fleet.analyse(mmsi)["calls"]
assert [(c["port"]["code"], c["source"]) for c in merged] == [("NLRTM", "AIS"), ("USNYC", "AIS"), ("SGSIN", "GFW")], merged
assert merged[2]["event"] is None, "no draught round it: no load or discharge to say"

# a change smaller than a fifth of its draught's range is bunkers or ballast, not cargo
with fleet.db() as c:
    c.executemany("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  [report(t + 40 * 24 * H + i * H, SINGAPORE, 0.1, 8.3 if i == 0 else None, 5) for i in range(10)]
                  + [report(t + 40 * 24 * H + 11 * H, SINGAPORE, 10, 9.2)])
small = fleet.analyse(mmsi)["calls"][-1]
assert small["change"] == 0.9 and small["event"] is None, small

# a day of archive reads down to one report every 15 minutes a vessel, and every change of draught
import archives
day = [(1, s, 0.0, 0.0, 0.0, 0.0, 5, 9.0 if s < 3000 else 10.0, None, None) for s in range(0, 3600, 60)]
kept = archives.keep(day + [(99, 0, 0, 0, 0, 0, 0, 1.0, None, None)], {1})
assert {r[0] for r in kept} == {1}, "only the fleet's"
assert [r[1] for r in kept] == [0, 900, 1800, 2700, 3000], [r[1] for r in kept]  # (3000: its draught changed)

fleet.save_fleet("Test fleet", [1, 2])
assert fleet.fleets() == [{"name": "Test fleet", "mmsis": [1, 2]}]
fleet.delete_fleet("Test fleet")
assert fleet.fleets() == []
print("ok")
