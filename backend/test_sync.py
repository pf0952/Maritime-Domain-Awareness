"""Sync and overlap check, on NOAA's catalog and cells in enc/ plus one real download:
backend/.venv/Scripts/python backend/test_sync.py"""
import gzip
import json
import struct
import tempfile
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import numpy as np
import shapely
from fastapi.testclient import TestClient

import charts
import main
import sync

catalog = sync.catalog = sync.read_catalog((sync.ENC.parent / "ENCProdCat.xml").read_bytes())
assert len(catalog.charts) > 7000
sync.on_disk.update({c.name: c.version for c in catalog.charts})

# the finest chart of each spot shows, no finer than the tier
harbour = shapely.box(-71.02, 42.32, -70.98, 42.35)
assert [c.name for c in catalog.pick(harbour, 5)] == ["US5BOSCD"]
assert all(c.band == 4 for c in catalog.pick(harbour, 4))
assert catalog.pick(shapely.box(0, 0, 1, 1), 5) == []

# a coarser chart gives way to finer ones, so land can't poke up through their water
coarse, fine = catalog.by_name["US4MA1HC"], catalog.by_name["US5BOSCD"]
finer = catalog.finer(coarse, 5)
assert fine in finer and coarse not in catalog.finer(fine, 6)
assert shapely.union_all([c.cover for c in catalog.finer(coarse, 4)]).intersection(coarse.cover).area == 0  # neighbours
cut = shapely.from_wkb(sync.cut_out(coarse, 5, catalog))
left = shapely.union_all(charts.read_areas(sync.cell_path(coarse), cut)[2].geometry.to_numpy())
assert left.area > 0 and shapely.area(shapely.intersection(left, fine.cover)) < 1e-9

# a new version, or a change in what's cut out of it, gets a new file and so a new URL
file = sync.chart_file(coarse, 5, catalog)
assert file != sync.chart_file(coarse, 4, catalog)
sync.on_disk[coarse.name] = (0, 0)
assert file != sync.chart_file(coarse, 5, catalog)
sync.on_disk[coarse.name] = coarse.version

# every tier the viewer can ask for has a file, and tiers that cut out the same share one
files = sync.all_files(catalog)
tiers = [(c, tier) for c in catalog.charts[::97] for tier in range(max(c.band, 2), 7)]
assert all(sync.chart_file(c, tier, catalog) in files for c, tier in tiers)
assert len(catalog.charts) < len(files) < 2 * len(catalog.charts)



def view(west: float, south: float, east: float, north: float, corners: str | None = None) -> dict:
    corners = corners or f"{west},{north},{east},{north},{east},{south},{west},{south}"
    params = {"west": west, "south": south, "east": east, "north": north, "tier": 5, "corners": corners, "zoom": 9}
    return TestClient(main.app).get("/api/view", params=params).json()


# a view knows whether it holds any ENC: Boston does, Denver doesn't
assert view(-71.1, 42.3, -70.9, 42.4)["charted"]
assert not view(-105.1, 39.6, -104.8, 39.8)["charted"]
# an overview chart's outline reaches Dallas and St Louis, but it's only an ENC for them over water
assert not view(-96.9, 32.7, -96.7, 32.85)["charted"] and sync.catalog.over(shapely.box(-96.9, 32.7, -96.7, 32.85))
assert not view(-90.3, 38.55, -90.1, 38.7)["charted"]
assert view(-68.0, 41.0, -67.5, 41.3)["charted"], "open water that only coarse charts cover"
# NOAA has Guam at -215 and the map has it at 145: its charts have to land there, and any past the date line too
guam = catalog.over(shapely.box(144.7, 13.4, 144.8, 13.5))
assert guam and view(144.7, 13.4, 144.8, 13.5)["detailed"]
assert all(c.cover.bounds[0] >= -180 and c.cover.bounds[2] <= 180 for c in catalog.charts)
across = sync.onto_the_map(shapely.box(-185, 50, -175, 52))
assert across.bounds == (-180, 50, 180, 52) and abs(across.area - 20) < 1e-9
# the map repeats, so a view can run past 180: it still finds what's there, whichever copy of the world it's on
assert view(-71.1 + 360, 42.3, -70.9 + 360, 42.4)["charted"]
assert view(-71.1 - 720, 42.3, -70.9 - 720, 42.4)["charted"]
across = view(175, 50, 190, 54)  # the Aleutians, from one side of the date line to the other
tiles = {p["name"] for p in across["pieces"]}
assert {"LAND_170_50", "LAND_-180_50"} <= tiles and across["charted"]

# search answers arrive as south, north, west, east, in text
assert main.places_from([{"display_name": "Freeport", "boundingbox": ["26.4", "26.6", "-78.8", "-78.6"]}]) == [
    {"name": "Freeport", "bounds": [-78.8, 26.4, -78.6, 26.6]}
]
long_query = TestClient(main.app).get("/api/search", params={"q": "x" * 201})
assert long_query.status_code == 422

# Freeport's only chart is at 1:700,000: an ENC, but its coast is too rough to stand buildings on; Victoria's will do
freeport = view(-78.75, 26.49, -78.65, 26.55)
assert freeport["charted"] and not freeport["detailed"]
assert view(-123.4, 48.4, -123.34, 48.44)["detailed"]
# and it's what's on screen that counts: a tilted view's bounding box can reach a chart that isn't in sight
inland = "-105.1,39.8,-104.9,39.8,-104.9,39.6,-105.1,39.6"
assert not view(-105.1, 39.6, -70.9, 42.4, corners=inland)["charted"]

# the world's land only gives way to charts that are showing, or a coarser view would have holes in it
assert sync.land_file("LAND_-80_40", 5, catalog) != sync.land_file("LAND_-80_40", 2, catalog)
assert len(sync.land_cut("WORLD", 0, catalog)) == 0

# the general map's outline stays on its 360 wide square, and small enough to send
outline = charts.world_outline(sync.land_source("overview"))
numbers = [float(n) for n in outline.replace("M", " ").replace("L", " ").replace("Z", " ").split()]
assert 2000 < len(numbers) and 0 <= min(numbers) and max(numbers) <= 360 and len(outline) < 300_000

# it shows as one piece from far out, then as the tiles in view
assert sync.land_view(shapely.box(-120, 20, -60, 50), 3, catalog) == ["WORLD"]
assert sync.land_view(harbour, 9, catalog) == ["LAND_-80_40"]
assert len(sync.land_tiles()) == 36 * 18 + 1


class DeadPool:
    """Every job lost, as when a worker dies with WinError 6."""

    def __init__(self, workers):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def submit(self, function, *args):
        future = Future()
        future.set_exception(BrokenProcessPool())
        return future


with tempfile.TemporaryDirectory() as tmp:
    sync.CACHE = Path(tmp) / "cache"

    # and it stops where charts begin: their land is the better drawn
    file = sync.CACHE / "land.gz"
    function, *args = sync.land_job("LAND_-80_40", 5, file, catalog)
    function(*args)
    data = gzip.decompress(file.read_bytes())
    size = struct.unpack("<I", data[:4])[0]
    head = json.loads(data[4 : 4 + size])
    vertices = head["meshes"]["land"][0]
    assert vertices and all(head["meshes"][key][0] for key in ("landWalls", "coast", "outline"))
    xy = np.frombuffer(data, "<f4", vertices * 3, 4 + size).reshape(-1, 3)[:, :2] + head["origin"]
    assert (np.abs(xy[:, 0] + 75) <= 5.01).all() and (np.abs(xy[:, 1] - 45) <= 5.01).all()
    assert not shapely.contains_xy(shapely.buffer(fine.cover, -1e-3), xy).any()

    # (from here on the world's land would just be hundreds of tiles compiled for nothing)
    sync.land_tiles = lambda: {}

    # a pool that dies loses nothing: the jobs finish one at a time
    lost = sync.chart_file(fine, 5, catalog)
    pool_kind, all_files = sync.ProcessPoolExecutor, sync.all_files
    sync.ProcessPoolExecutor, sync.all_files = DeadPool, lambda _: {lost: (fine, 5)}
    sync.compile_all()
    sync.ProcessPoolExecutor, sync.all_files = pool_kind, all_files
    assert lost.exists() and sync.status["done"] == 1

    out = sync.chart_file(coarse, 5, catalog)
    charts.compile_file(sync.cell_path(coarse), sync.cut_out(coarse, 5, catalog), out)
    assert gzip.decompress(out.read_bytes())[4:6] == b'{"'

    # sweeping up removes old versions of charts, but never the lot when it has no catalog to go by
    old = sync.CACHE / "US4MA1HC-000000000000.gz"
    old.touch()
    sync.catalog = sync.Catalog([])
    sync.compile_all()
    assert old.exists() and out.exists()
    sync.catalog = catalog
    all_files, sync.all_files = sync.all_files, lambda _: {out: (coarse, 5)}
    sync.compile_all()
    sync.all_files = all_files
    assert not old.exists() and out.exists()

with tempfile.TemporaryDirectory() as tmp:
    sync.ENC, sync.CACHE = Path(tmp), Path(tmp) / "cache"
    assert sync.local_version(fine.name) is None
    assert sync.fetched(fine)
    assert sync.on_disk[fine.name] == fine.version == sync.local_version(fine.name)
    # an older edition's update files don't survive it: they'd be applied to the new base cell
    leftover = sync.ENC / fine.name / f"{fine.name}.099"
    leftover.touch()
    assert sync.local_version(fine.name)[1] == 99
    assert sync.fetched(fine)
    assert not leftover.exists() and sync.local_version(fine.name) == fine.version
    assert [p.name for p in sync.ENC.iterdir()] == [fine.name], "left temporary folders behind"

    # with NOAA out of reach: a failed download is reported and retried, not fatal
    sync.CATALOG_URL = "https://127.0.0.1:9/ENCProdCat.xml"
    sync.TIMEOUT = 2
    stale = sync.Chart(fine.name, fine.scale, (99, 0), sync.CATALOG_URL, fine.cover, fine.cover_id)
    assert not sync.fetched(stale)
    assert sync.on_disk[fine.name] == fine.version and sync.local_version(fine.name) == fine.version

# and a first run with nothing saved says so, while one with a saved catalog opens with that
ONE_CELL = """<EncProductCatalog><cell><name>US5TEST1</name><cscale>12000</cscale><status>Active</status>
<zipfile_location>https://127.0.0.1:9/US5TEST1.zip</zipfile_location><edtn>1</edtn><updn>0</updn>
<cov><panel><type>E</type><vertex><lat>0</lat><long>0</long></vertex><vertex><lat>0</lat><long>1</long></vertex>
<vertex><lat>1</lat><long>1</long></vertex><vertex><lat>0</lat><long>0</long></vertex></panel></cov>
</cell></EncProductCatalog>"""
with tempfile.TemporaryDirectory() as tmp:
    sync.ENC, sync.CACHE = Path(tmp) / "ENC_ROOT", Path(tmp) / "cache"
    sync.catalog = sync.Catalog([])
    sync.on_disk.clear()
    sync.check()
    assert "Can't reach NOAA" in sync.status["problem"] and sync.status["phase"] == "idle"
    assert sync.catalog.charts == [] and sync.status["ready"], "stuck on the loading screen"
    (Path(tmp) / "ENCProdCat.xml").write_text(ONE_CELL)
    sync.check()
    assert [c.name for c in sync.catalog.charts] == ["US5TEST1"] and sync.status["problem"]
print("ok")
