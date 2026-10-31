"""Keeps enc/ in step with NOAA, and knows which charts to show where.

NOAA's catalog, rebuilt daily, lists every cell's edition, update number, scale and coverage. check() fetches it and
downloads the cells that differ from enc/, then compiles whatever isn't in backend/cache, on all cores but one. The
catalog is kept next to the cells, so the app opens with what it has straight away, whatever NOAA is doing."""
import hashlib
import os
import re
import shutil
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from http.client import HTTPException
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

import numpy as np
import shapely

import charts

ENC = Path(__file__).parent.parent / "enc" / "ENC_ROOT"
CACHE = Path(__file__).parent / "cache"
LAND = Path(__file__).parent.parent / "enc" / "land"
LAND_URL = "https://naciscdn.org/naturalearth/"
LAND_FILES = {
    "detail": "10m/physical/ne_10m_land",
    "overview": "50m/physical/ne_50m_land",
    "lakes": "10m/physical/ne_10m_lakes",
}
LAND_TILE = 10  # degrees, on a side
WORLD_ZOOM = 7  # below this the whole world shows as one piece; from here, tiles of finer land
CATALOG_URL = "https://www.charts.noaa.gov/ENCs/ENCProdCat.xml"
CHECK_EVERY = 6 * 3600  # s
RETRY_AFTER = 300  # s, when the last check went wrong
DOWNLOADS = 4  # at once, to go easy on NOAA's server
TIMEOUT = 120  # s
WORKERS = max((os.cpu_count() or 2) - 1, 1)  # compiling at once
POOLS = 3  # goes at compiling in parallel, before carrying on one chart at a time
BACKLOG = 300  # charts left to compile: this many can wait behind the map; any more, and the loading screen shows
LOWEST_TIER = 2  # the viewer's, zoomed all the way out: NOAA has retired most band 1 charts
COASTAL_BAND = 3  # charts from here up are drawn for the place they cover; coarser ones just span oceans and lakes

VERSION = re.compile(rb"\.000\x1f(\d+)\x1f(\d+)\x1f")  # at the head of a base cell: its edition and update number


@dataclass(frozen=True, eq=False)
class Chart:
    name: str
    scale: int
    version: tuple  # edition, update
    url: str
    cover: shapely.Geometry
    cover_id: str

    @property
    def band(self) -> int:  # 1 overview ... 6 berthing
        return int(self.name[2])

    @property
    def rank(self) -> tuple:  # finest first
        return -self.band, self.scale, self.name


class Catalog:
    def __init__(self, charts: list):
        self.charts = sorted(charts, key=lambda c: c.rank)
        self.by_name = {c.name: c for c in charts}
        self.tree = shapely.STRtree([c.cover for c in self.charts])

    def over(self, area: shapely.Geometry) -> list:
        """The charts we hold that reach into an area, finest first."""
        hits = np.sort(self.tree.query(area, predicate="intersects"))
        return [c for c in (self.charts[i] for i in hits) if c.name in on_disk]

    def pick(self, area: shapely.Geometry, tier: int) -> list:
        """The charts that show in an area: at each spot, the finest one of band tier or coarser."""
        left, picked = area, []
        for chart in self.over(area):
            if chart.band <= tier:
                rest = left.difference(chart.cover)
                if rest.area < left.area:
                    picked.append(chart)
                    left = rest
                if left.is_empty:
                    break
        return picked

    def finer(self, chart: Chart, tier: int) -> list:
        """The charts that take over from this one at that tier."""
        return [c for c in self.over(chart.cover) if c.rank < chart.rank and c.band <= tier]


catalog = Catalog([])
on_disk = {}  # name: version
status = {"phase": "starting", "done": 0, "total": 0, "checked": None, "problem": None, "revision": 0, "ready": False}


def onto_the_map(cover: shapely.Geometry) -> shapely.Geometry:
    """NOAA goes on counting west past -180 for Guam and the like, where the map and the cells have 145 east."""
    if cover.is_empty or cover.bounds[0] >= -180:
        return cover
    beyond = cover.intersection(shapely.box(-540, -90, -180, 90))
    return shapely.union_all([
        cover.intersection(shapely.box(-180, -90, 180, 90)),
        shapely.transform(beyond, lambda xy: xy + [360, 0]),
    ])


def read_catalog(xml: bytes) -> Catalog:
    charts = []
    for cell in ElementTree.fromstring(xml).iter("cell"):
        if cell.findtext("status") != "Active":
            continue
        rings = {"E": [], "I": []}  # panels: the coverage, and holes in it
        for panel in cell.iter("panel"):
            rings[panel.findtext("type")].append(
                shapely.Polygon([(float(v.findtext("long")), float(v.findtext("lat"))) for v in panel.iter("vertex")])
            )
        cover = shapely.union_all(shapely.make_valid(np.array(rings["E"])))
        if rings["I"]:
            cover = cover.difference(shapely.union_all(shapely.make_valid(np.array(rings["I"]))))
        cover = onto_the_map(cover)
        if not cover.is_empty:
            charts.append(Chart(
                name=cell.findtext("name"),
                scale=int(cell.findtext("cscale")),
                version=(int(cell.findtext("edtn")), int(cell.findtext("updn"))),
                url=cell.findtext("zipfile_location"),
                cover=cover,
                cover_id=hashlib.sha1(cover.wkb).hexdigest()[:12],
            ))
    return Catalog(charts)


def fetch_catalog() -> bytes | None:
    """NOAA's catalog, saved next to the cells. None if it hasn't changed or can't be had."""
    saved, etag = ENC.parent / "ENCProdCat.xml", ENC.parent / "ENCProdCat.etag"
    headers = {"If-None-Match": etag.read_text()} if catalog.charts and etag.exists() else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(CATALOG_URL, headers=headers), timeout=TIMEOUT) as res:
            xml = res.read()
            ENC.mkdir(parents=True, exist_ok=True)
            saved.write_bytes(xml)
            etag.write_text(res.headers["ETag"] or "")
            return xml
    except urllib.error.HTTPError as e:
        if e.code != 304:
            status["problem"] = f"NOAA answered {e.code}"
    except OSError as e:  # (URLError is one)
        status["problem"] = f"Can't reach NOAA: {e}"
    return None


def adopt(xml: bytes) -> None:
    """Takes on a catalog, and finds out which of its cells are in enc/."""
    global catalog
    catalog = read_catalog(xml)
    with ThreadPoolExecutor(DOWNLOADS) as pool:
        found = pool.map(local_version, (c.name for c in catalog.charts))
        on_disk.update({c.name: v for c, v in zip(catalog.charts, found) if v})
    status["revision"] += 1


def local_version(name: str) -> tuple | None:
    """A cell's version in enc/: from the base cell's head, and the update files beside it."""
    folder = ENC / name
    try:
        with open(folder / f"{name}.000", "rb") as f:
            edition, update = map(int, VERSION.search(f.read(4096)).groups())
    except (OSError, AttributeError):
        return None
    return edition, max([update, *(int(p.suffix[1:]) for p in folder.glob(f"{name}.[0-9][0-9][0-9]"))])


def download(chart: Chart) -> None:
    """Swaps a cell's folder for the fresh one whole: an old edition's update files can't stay next to a new base."""
    with urllib.request.urlopen(chart.url, timeout=TIMEOUT) as res:
        data = res.read()
    new, old, folder = ENC / f".{chart.name}.new", ENC / f".{chart.name}.old", ENC / chart.name
    shutil.rmtree(new, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)
    with zipfile.ZipFile(BytesIO(data)) as z:
        z.extractall(new)
    if folder.exists():
        folder.rename(old)
    (new / "ENC_ROOT" / chart.name).rename(folder)
    shutil.rmtree(new, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)


def fetched(chart: Chart) -> bool:
    try:
        download(chart)
    except (OSError, HTTPException, zipfile.BadZipFile):  # a cell in use, or a bad download: the next check tries again
        return False
    finally:
        status["done"] += 1
    on_disk[chart.name] = local_version(chart.name)
    status["revision"] += 1
    return True


def on_the_map(area: shapely.Geometry) -> shapely.Geometry:
    """A view, which can run on past 180 as the map repeats, brought back to where the charts are."""
    world = shapely.box(-180, -90, 180, 90)
    copies = [shapely.transform(area, lambda xy, shift=shift: xy + [shift, 0]) for shift in (-720, -360, 0, 360, 720)]
    return shapely.union_all(shapely.intersection(np.array(copies), world))


def water_in(area: shapely.Geometry) -> shapely.Geometry:
    """An area less the world's land, or the whole of it until that's been fetched."""
    if not land_source("lakes").exists():
        return area
    land, land_index = charts.load_polygons(land_source("overview"))
    lakes, lake_index = charts.load_polygons(land_source("lakes"))
    dry = shapely.union_all(land[land_index.query(area, "intersects")])
    return area.difference(dry.difference(shapely.union_all(lakes[lake_index.query(area, "intersects")])))


def charted(area: shapely.Geometry, cat: Catalog) -> bool:
    """Is any ENC in sight? An overview chart's outline takes in Dallas and St Louis, so those only count over water."""
    covering = cat.over(area)
    if any(c.band >= COASTAL_BAND for c in covering):
        return True
    return bool(covering) and any(c.cover.intersects(water_in(area)) for c in covering)


def cell_path(chart: Chart) -> Path:
    return ENC / chart.name / f"{chart.name}.000"


def chart_file(chart: Chart, tier: int, catalog: Catalog) -> Path:
    """Named for the chart's version and the outlines cut from it, so a change to either is a new file and a new URL."""
    finer = "".join(c.cover_id for c in catalog.finer(chart, tier))
    key = hashlib.sha1(f"{charts.FORMAT}{on_disk.get(chart.name)}{finer}".encode()).hexdigest()[:12]
    return CACHE / f"{chart.name}-{key}.gz"


def cut_out(chart: Chart, tier: int, catalog: Catalog) -> bytes | None:
    """What finer charts take from this one at that tier."""
    finer = catalog.finer(chart, tier)
    return shapely.union_all([c.cover for c in finer]).wkb if finer else None


def all_files(catalog: Catalog) -> dict:
    """Every compiled file the viewer can ask for: file: (chart, tier)."""
    files = {}
    for chart in catalog.charts:
        if chart.name in on_disk:
            for tier in range(max(chart.band, LOWEST_TIER), 7):
                files.setdefault(chart_file(chart, tier, catalog), (chart, tier))
    return files


def land_source(key: str) -> Path:
    return LAND / (LAND_FILES[key].split("/")[-1] + ".zip")


def fetch_land() -> None:
    """Natural Earth's land and lakes, once: coasts hardly move."""
    LAND.mkdir(parents=True, exist_ok=True)
    for key, path in LAND_FILES.items():
        if not land_source(key).exists():
            with urllib.request.urlopen(f"{LAND_URL}{path}.zip", timeout=TIMEOUT) as res:
                data = res.read()
            land_source(key).with_suffix(".part").write_bytes(data)
            land_source(key).with_suffix(".part").replace(land_source(key))


def land_tiles() -> dict:
    """The world's tiles of land: name: bounds. "WORLD" is the lot, coarsely."""
    tiles = {"WORLD": (-180.0, -85.0, 180.0, 85.0)}
    for west in range(-180, 180, LAND_TILE):
        for south in range(-90, 90, LAND_TILE):
            tiles[f"LAND_{west}_{south}"] = tuple(map(float, (west, south, west + LAND_TILE, south + LAND_TILE)))
    return tiles


def land_cut(name: str, tier: int, cat: Catalog) -> list:
    """The charts that show over a tile of land at a tier. Their land takes over from it."""
    return [c for c in cat.over(shapely.box(*land_tiles()[name])) if c.band <= tier]


def land_file(name: str, tier: int, cat: Catalog) -> Path:
    """Tiers that cut the same out of a tile share a file."""
    covers = "".join(c.cover_id for c in land_cut(name, tier, cat))
    key = hashlib.sha1(f"{charts.LAND_FORMAT}{covers}".encode()).hexdigest()[:12]
    return CACHE / f"{name}-{key}.gz"


def land_job(name: str, tier: int, file: Path, cat: Catalog) -> tuple:
    """A function and what to call it with, to compile a tile of land."""
    covering = land_cut(name, tier, cat)
    hole = shapely.union_all([c.cover for c in covering]).wkb if covering else None
    source = land_source("overview" if name == "WORLD" else "detail")
    return charts.compile_land, source, land_source("lakes"), land_tiles()[name], hole, file


def land_view(area: shapely.Geometry, zoom: float, cat: Catalog) -> list:
    """The pieces of world land to show in an area."""
    if not land_source("detail").exists():
        return []
    if zoom < WORLD_ZOOM:
        return ["WORLD"]
    parts = [part.bounds for part in shapely.get_parts(area)]  # either side of the date line
    return [
        name for name, bounds in land_tiles().items()
        if name != "WORLD"
        and any(bounds[0] < e and bounds[2] > w and bounds[1] < n and bounds[3] > s for w, s, e, n in parts)
    ]


def compile_all() -> None:
    files = all_files(catalog)
    todo = [(file, *job) for file, job in files.items() if not file.exists()]
    land = {}
    if land_source("detail").exists():
        # the whole world is only seen from far out: with the coarsest charts, or none
        for name in land_tiles():
            for tier in (0, LOWEST_TIER) if name == "WORLD" else range(LOWEST_TIER, 7):
                land.setdefault(land_file(name, tier, catalog), (name, tier))
    todo_land = [(file, *job) for file, job in land.items() if not file.exists()]
    status.update(phase="compiling", done=0, total=len(todo) + len(todo_land))
    jobs = [(charts.compile_file, cell_path(c), cut_out(c, tier, catalog), file) for file, c, tier in todo]
    jobs += [land_job(name, tier, file, catalog) for file, name, tier in todo_land]
    failed, error = 0, None

    def finished(problem: BaseException | None) -> None:
        nonlocal failed, error
        status["done"] += 1
        if problem:
            failed, error = failed + 1, problem

    # A worker can die as it starts, with WinError 6 and no fault of the job's, and it takes the pool with it. Whatever
    # that loses goes round again in a new pool, and if they keep dying, one at a time here, which is slower but sure.
    for _ in range(POOLS):
        if not jobs:
            break
        lost = []
        with ProcessPoolExecutor(WORKERS) as pool:
            running = {pool.submit(*job): job for job in jobs}
            for future in as_completed(running):
                if isinstance(future.exception(), BrokenProcessPool):
                    lost.append(running[future])
                else:
                    finished(future.exception())
        jobs = lost
    for function, *args in jobs:
        try:
            function(*args)
            finished(None)
        except Exception as e:  # one bad chart mustn't stop the rest
            finished(e)
    if failed:  # each shows up as a gap, and the viewer compiles it when asked, or says it can't
        status["problem"] = f"{failed} of {status['total']} charts didn't compile: {error!r}"
    if catalog.charts:  # (with no catalog to go by, everything would look old)
        for old in CACHE.glob("*.gz"):  # older versions of charts
            if old not in files and old not in land:
                old.unlink(missing_ok=True)


def check() -> None:
    status.update(phase="checking", problem=None)
    saved = ENC.parent / "ENCProdCat.xml"
    if not catalog.charts and saved.exists():  # open with what we have: NOAA can take its time, or be away
        adopt(saved.read_bytes())
        status["ready"] = sum(not file.exists() for file in all_files(catalog)) <= BACKLOG
    xml = fetch_catalog()
    if xml:
        adopt(xml)
    stale = [c for c in reversed(catalog.charts) if on_disk.get(c.name) != c.version]
    status.update(phase="downloading", done=0, total=len(stale))
    with ThreadPoolExecutor(DOWNLOADS) as pool:
        failed = list(pool.map(fetched, stale)).count(False)
    if failed:
        status["problem"] = f"{failed} of {len(stale)} charts didn't download; retrying at the next check"
    try:
        fetch_land()
    except (OSError, HTTPException) as e:
        status["problem"] = f"Couldn't get the world's land: {e}"
    compile_all()
    status.update(phase="idle", ready=True, checked=time.time())


def run() -> None:
    while True:
        try:
            check()
        except Exception as e:  # whatever went wrong, the viewer carries on and the next check tries again
            status.update(phase="idle", problem=f"Update check failed: {e}")
        time.sleep(RETRY_AFTER if status["problem"] else CHECK_EVERY)
