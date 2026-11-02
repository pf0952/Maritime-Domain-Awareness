"""Reading warnings' words, on real wording: backend/.venv/Scripts/python backend/test_navwarnings.py"""
import datetime
import math
import time

import navwarnings as nw

assert nw.positions("LIGHT 20-03-44N 072-58-02W UNLIT") == [[-(72 + 58 / 60 + 2 / 3600), 20 + 3 / 60 + 44 / 3600]]
assert nw.positions("MAST 12-30.5S 045-00.0E") == [[45.0, -12.508333333333333]]

# one spot, and a list of them
assert nw.shapes("ROCA PARTIDA LIGHT 18-42-17N 095-11-18W UNLIT.") == [{"point": [-95.1883, 18.7047]}]
rigs = "POSITIONS:\n   A. AGOSTO 12 19-23.0N 092-03.1W.\n   B. ARGOS 27-10.4N 090-22.1W."
assert [list(s) for s in nw.shapes(rigs)] == [["point"], ["point"]]

# a circle: it reaches as far as it says, a mile being a nautical one, and is narrower in degrees of latitude
ring = nw.shapes("MINES REPORTED IN AREA WITHIN FIVE MILES OF 45-07.10N 030-09.70E.")[0]["ring"]
lons, lats = zip(*ring)
assert abs((max(lats) - min(lats)) / 2 * 111_320 - 5 * 1852) < 100
assert abs((max(lons) - min(lons)) / 2 * 111_320 * math.cos(math.radians(45.1)) - 5 * 1852) < 300
assert nw.reach("WITHIN 400 METERS OF") == 400

# an area, and two of them
bounded = "HAZARDOUS OPERATIONS IN AREA BOUNDED BY 30-00N 075-00W, 31-00N 075-00W, 31-00N 074-00W, 30-00N 074-00W."
assert nw.shapes(bounded) == [{"ring": [[-75.0, 30.0], [-75.0, 31.0], [-74.0, 31.0], [-74.0, 30.0], [-75.0, 30.0]]}]
two = "IN AREAS BOUNDED BY:\n A. 30-00N 075-00W, 31-00N 075-00W, 31-00N 074-00W."
two += "\n B. 10-00N 075-00W, 11-00N 075-00W, 11-00N 074-00W."
assert len(nw.shapes(two)) == 2
listed = "AREA BOUNDED BY:\n A. 30-00N 075-00W.\n B. 31-00N 075-00W.\n C. 31-00N 074-00W."
assert len(nw.shapes(listed)) == 1, "lettered corners are one area, not three spots"
crossed = "AREA BOUNDED BY 30-00N 075-00W, 30-00N 074-00W, 31-00N 075-00W, 31-00N 074-00W."
assert len(nw.shapes(crossed)[0]["ring"]) == 5, "corners out of order still make an area"

# a line has width
assert "ring" in nw.shapes("CABLE OPERATIONS ALONG TRACKLINE JOINING 30-00N 075-00W, 31-00N 074-00W.")[0]
# and a shape over the date line stays in one piece
assert max(abs(a[0] - b[0]) for a, b in zip(ring, ring[1:])) < 1
wide = nw.area([[179.5, 10], [-179.5, 10], [-179.5, 11]])
assert max(lon for lon, _ in wide) - min(lon for lon, _ in wide) == 1

assert nw.category("BARGE SANK. TWO PERSONS REMAIN MISSING.") == "Search and rescue"
assert nw.category("TONALA LIGHT UNLIT.") == "Aids to navigation"
assert nw.category("BUOY 12 MISSING.") == "Aids to navigation", "not a search: it mustn't expire like one"
assert nw.category("WRECK. VESSELS KEEP A SHARP LOOKOUT TO AVOID COLLISION.") == "Hazards"
assert nw.category("FISHING VESSEL ANA OVERDUE. ASSIST IF POSSIBLE.") == nw.SEARCH
assert nw.category("BRIDGE NEED NOT OPEN EXCEPT FOR VESSELS IN DISTRESS.") == "Other"
assert nw.category("DERELICT BUOY. VESSELS REQUESTED TO SEARCH, SIGHT AND REPORT.") == "Hazards"
assert nw.category("GUNNERY EXERCISES IN AREA") == "Military"
assert nw.category("NOTICE OF SERVICE CHANGE.") == "Other", "ICE is a word, not part of one"
# the other ways authorities write a position
assert nw.positions("56° 32'N - 010° 26'E") == [[10 + 26 / 60, 56 + 32 / 60]]
assert nw.positions("38 - 49.8 N 020 - 30.2 E") == [[20 + 30.2 / 60, 38 + 49.8 / 60]]
assert nw.positions("12-30.5S. 045-00.0E") == [[45.0, -12.508333333333333]]
assert nw.positions("POINT 1 54-21.0N 006-11.5E") == [[6 + 11.5 / 60, 54.35]], "a list number isn't degrees"
assert nw.positions("99-30.0N 200-00.0E") == [], "nowhere on Earth"

assert nw.positions("37 50 39N – 020 46 46E") == [[20 + 46 / 60 + 46 / 3600, 37 + 50 / 60 + 39 / 3600]]
assert nw.positions("37 50.5 N 020 46.0 E") == [[20 + 46 / 60, 37 + 50.5 / 60]]
assert nw.positions("69-15-05С 033-35-00В") == [[33 + 35 / 60, 69 + 15 / 60 + 5 / 3600]], "Russian notices"
assert nw.positions("10–30.0S 045–00.0E") == [[45.0, -10.5]]

# end dates, in the ways they're written
utc = lambda *when: datetime.datetime(*when, tzinfo=datetime.UTC).timestamp()
late = (23, 59, 59)
issued = utc(2026, 10, 20)
for words, end in [
    ("CANCEL THIS MSG 301600Z NOV 26.", utc(2026, 11, 30, 16)),
    ("CANCEL THIS WARNING 032059 UTC JAN 27.", utc(2027, 1, 3, 20, 59)),
    ("CANCEL NAVAREA III 0128/26 AND THIS MSG 202359 NOV26.", utc(2026, 11, 20, 23, 59)),
    ("OPERATIONS 301100Z TO 301600Z OCT", utc(2026, 10, 30, 16)),
    ("280301 UTC OCT 26 TO 050301 UTC NOV 26", utc(2026, 11, 5, 3, 1)),
    ("130300 UTC AGO 26 A 090300 UTC JAN 27", utc(2027, 1, 9, 3)),
    ("IN PROGRESS UNTIL\n  30 NOV", utc(2026, 11, 30, *late)),
    ("ALSO SEEN 12 OCT 26, UNTIL 30 OCT 26. DATED 05 NOV 26.", utc(2026, 11, 5, *late)),
    ("THRU 15 NOV BY M/V ARGOS", utc(2026, 11, 15, *late)),
    ("RIG STATIONED TILL 01 DEC 27", utc(2027, 12, 1, *late)),
    ("VALID FROM 29 OCT 2026 00:00 UTC TO 01 NOV 2026 13:00 UTC", utc(2026, 11, 1, 13)),
    ("VALID 2026-10-01 TO 2026-11-05.", utc(2026, 11, 5, *late)),
    ("FROM SEPTEMBER 23, 2026, TO OCTOBER 30, 2026.", utc(2026, 10, 30, *late)),
    ("FROM 290001 TO 292359 UTC OCT 26. CANCEL THIS MSG 310100 UTC OCT 26.", utc(2026, 10, 31, 1)),
    ("UNTIL 30 NOV 12-30N 045-00E", utc(2026, 11, 30, *late)),
    ("26 OCT 0800-2300, 27 OCT TO 29 OCT 0800-1800, 30 OCT 0800-1900, 01 NOV 0800-1200.", utc(2026, 11, 1, *late)),
    ("REGATTA 10-11 OCT 2026, 1000-1800 EACH DAY.", utc(2026, 10, 11, *late)),
]:
    assert nw.ends(words, issued) == end, words
assert nw.ends("UNTIL 31 JAN", issued) == utc(2027, 1, 31, *late), "a date with no year comes next"
for words in ["UNTIL FURTHER NOTICE", "CANCEL NAVAREA I 233/26.", "DAILY FROM 0200 TO 1700 UTC", "TO 5 DECK", "UNTIL 31 FEB"]:
    assert nw.ends(words, issued) is None, words

now = time.time()
day = 86400
now_item = {"feed": "navarea/4", "title": "X", "issued": now - day}
live = lambda text, issued=now - day: len(nw.read([{**now_item, "url": "a", "text": text, "issued": issued}])["warnings"])
spot = "18-12-45N 094-08-00W."
assert live(f"LIGHT {spot} UNLIT.") == 1, "says nothing, so it stands"
assert live(f"LIGHT {spot} UNLIT. CANCEL THIS MSG 010000Z JAN 26.") == 0
assert live(f"PERSON OVERBOARD {spot}", now - 95 * 3600) == 1
assert live(f"PERSON OVERBOARD {spot}", now - 97 * 3600) == 0, "96 hours at most for a search"
assert live(f"PERSON OVERBOARD {spot} CANCEL THIS MSG 010000Z JAN 40.", now - 97 * 3600) == 0, "however long it says"

item = {"feed": "navarea/4", "title": "NAVAREA IV 5/26", "url": "a", "issued": 1}
item["text"] = "LIGHT 18-12-45N 094-08-00W UNLIT."
answer = nw.read([
    item,
    {**item, "feed": "coastal/14"},  # carried by two feeds
    {**item, "url": "b", "text": "WARNINGS IN FORCE: 496/26."},
    {**item, "url": "c", "feed": "coastal/14", "title": "Denmark NW-1"},
])
assert answer["unplaced"] == 1 and [w["source"] for w in answer["warnings"]] == ["NAVAREA IV", "Coastal"]

# the UKHO's page, as it writes a row and the row that opens from it
page = """<td id="Reference_5" class="td-1">
    WZ 683/26
</td><td id="DateTimeGroupRnwFormat_5" class="td-2">
    291325 UTC Oct 26
</td><td id="Description_5">DOVER.</td>
<tr id="collapse_5"><td><pre>DOVER. LIGHT UNLIT.&#xA;51-04.5N 001-11.8E.</pre></td></tr>"""
item = nw.ukho_items(page)[0]
assert item["title"] == "WZ 683/26" and item["url"].endswith("#WZ683/26") and "\n51-04.5N" in item["text"]
assert item["issued"] == datetime.datetime(2026, 10, 29, 13, 25, tzinfo=datetime.UTC).timestamp()
assert nw.source(item) == "UK coastal" and nw.source({**item, "title": "NAVAREA I 237/26"}) == "NAVAREA I"

# its word goes over SeaLagom's copies, but those stay if it couldn't be read
copy = {"feed": "navarea/1", "title": "NAVAREA I 61/26"}
coastal_copy = {"feed": "coastal/40", "title": "WZ 683/26"}
other = {"feed": "navarea/9", "title": "NAVAREA IX 5/26"}
assert nw.official_first([item, copy, coastal_copy, other]) == [item, other]
assert nw.official_first([copy, coastal_copy, other]) == [copy, coastal_copy, other]

# a feed that's come up to the limit is reported, as it's probably lost some
full = [{**now_item, "feed": "navarea/9", "url": str(n), "text": "NO POSITION"} for n in range(nw.FEED_LIMIT)]
assert nw.read(full)["cut"] == ["navarea/9"] and nw.read(full[1:])["cut"] == []

print("ok")
