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
    "overview": "50m/physical/ne_50m_land",
    "lakes": "10m/physical/ne_10m_lakes",
}
WORLD_ZOOM = 7  # below this the whole world shows as one piece; from here, tiles of OpenStreetMap's coast
COAST = LAND / "coast"
COAST_URL = "https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip"
COAST_SIZES = (10, 2.5, 0.625)  # degrees on a side of a tile of it, at each level of detail
COAST_ZOOMS = (8.5, 10.5)  # the zoom each finer level comes in at
COAST_SIMPLIFY = (0.003, 0.0006, 0.00012)  # degrees: under a pixel at each level, or islands turn angular
SEA = ENC.parent / "gebco"
SEA_URL = "https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2026/ice_surface_elevation/geotiff/gebco_2026_geotiff.zip"
SEA_FILES = 8
SEA_SIZES = (30, 10, 2.5, 0.625)  # degrees on a side of a tile of the world's seabed, at each level of detail
SEA_ZOOMS = (5.5, 7.5, 9.5)  # the zoom each finer level comes in at
SEA_TILES = 16  # at most in a view, or it takes a coarser level
SEA_CHUNK = 1024 * 1024
UPLOADS = ENC.parent / "uploads"
BAND_SCALES = (1_500_000, 600_000, 150_000, 30_000, 8_000)  # coarser than these: bands 1 to 5, for cells not named by band
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
        if self.name[2:3].isdigit():
            return int(self.name[2])
        return 1 + sum(self.scale < coarser for coarser in BAND_SCALES)

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
noaa = []  # the catalog's charts before any uploads take over
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
    global noaa
    noaa = read_catalog(xml).charts
    with ThreadPoolExecutor(DOWNLOADS) as pool:
        found = pool.map(local_version, (c.name for c in noaa))
        on_disk.update({c.name: v for c, v in zip(noaa, found) if v})
    take_uploads()


def uploaded_chart(path: Path) -> Chart:
    """A cell of the user's own as a chart. Its contents decide its version, as nobody issues it one."""
    data = path.read_bytes()
    name, scale, cell = charts.read_areas(path)
    covered = charts.polygons(path, "M_COVR", ("CATCOV",))
    covered = covered[covered["CATCOV"] == 1].geometry.to_numpy()
    cover = shapely.union_all(shapely.make_valid(covered)) if len(covered) else shapely.box(*cell.total_bounds)
    cover = onto_the_map(cover)
    return Chart(name, scale, hashlib.sha1(data).hexdigest()[:12], None, cover, hashlib.sha1(cover.wkb).hexdigest()[:12])


def take_uploads() -> None:
    """Puts the user's charts in with NOAA's. They go through all the same machinery, and win if they share a name."""
    global catalog
    mine = [uploaded_chart(path) for path in sorted(UPLOADS.glob("*.000"))]
    on_disk.update({c.name: c.version for c in mine})
    names = {c.name for c in mine}
    catalog = Catalog([c for c in noaa if c.name not in names] + mine)
    status["revision"] += 1


def add_upload(cell: Path) -> Chart:
    """Keeps a cell the user has sent. An unreadable one raises what charts.read_areas does, and isn't kept."""
    chart = uploaded_chart(cell)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(cell, UPLOADS / f"{chart.name}.000")
    take_uploads()
    return catalog.by_name[chart.name]


def remove_upload(name: str) -> None:
    (UPLOADS / f"{name}.000").unlink(missing_ok=True)
    on_disk.pop(name, None)
    if version := local_version(name):  # NOAA's chart of that name comes back
        on_disk[name] = version
    take_uploads()


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
    return ENC / chart.name / f"{chart.name}.000" if chart.url else UPLOADS / f"{chart.name}.000"


def chart_file(chart: Chart, tier: int, catalog: Catalog) -> Path:
    """Named for the chart's version and the outlines cut from it, so a change to either is a new file and a new URL."""
    finer = "".join(c.cover_id for c in catalog.finer(chart, tier))
    west, south, east, north = chart.cover.bounds
    wide = "wide" if max(east - west, north - south) > charts.WIDE else ""
    key = hashlib.sha1(f"{charts.FORMAT}{wide}{on_disk.get(chart.name)}{finer}".encode()).hexdigest()[:12]
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


def land_bounds(name: str) -> tuple:
    return (-180.0, -85.0, 180.0, 85.0) if name == "WORLD" else tile_bounds(name, COAST_SIZES)


def land_cut(name: str, tier: int, cat: Catalog) -> list:
    """The charts that show over a tile of land at a tier. Their land takes over from it."""
    return [c for c in cat.over(shapely.box(*land_bounds(name))) if c.band <= tier]


def land_file(name: str, tier: int, cat: Catalog) -> Path:
    """Tiers that cut the same out of a tile share a file."""
    covers = "".join(c.cover_id for c in land_cut(name, tier, cat))
    key = hashlib.sha1(f"{charts.LAND_FORMAT}{covers}".encode()).hexdigest()[:12]
    return CACHE / f"{name}-{key}.gz"


def land_job(name: str, tier: int, file: Path, cat: Catalog) -> tuple:
    """A function and what to call it with, to compile a tile of land."""
    covering = land_cut(name, tier, cat)
    hole = shapely.union_all([c.cover for c in covering]).wkb if covering else None
    lakes = land_source("lakes")
    if name == "WORLD":
        return charts.compile_land, land_source("overview"), lakes, land_bounds(name), hole, file
    return charts.compile_land, COAST, lakes, land_bounds(name), hole, file, COAST_SIMPLIFY[int(name.split("_")[1])]


def land_view(area: shapely.Geometry, zoom: float, cat: Catalog) -> list:
    """The pieces of world land to show in an area."""
    if not land_source("overview").exists():
        return []
    if zoom < WORLD_ZOOM or not COAST.exists():
        return ["WORLD"]
    return tiles_in(area, zoom, "COAST", COAST_SIZES, COAST_ZOOMS)


def fetch_big(url: str, path: Path) -> None:
    """A big file: a broken download carries on where it stopped."""
    part = path.with_suffix(".zip.part")
    done = part.stat().st_size if part.exists() else 0
    request = urllib.request.Request(url, headers={"Range": f"bytes={done}-"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as res, open(part, "ab" if res.status == 206 else "wb") as file:
        shutil.copyfileobj(res, file, SEA_CHUNK)
    part.replace(path)


def fetch_coast() -> None:
    """OpenStreetMap's land, split up for reading by area. Coasts hardly move, so once is enough."""
    packed = LAND / "land-polygons-split-4326.zip"
    if not packed.exists():
        fetch_big(COAST_URL, packed)
    work = LAND / "coast.part"
    shutil.rmtree(work, ignore_errors=True)
    with zipfile.ZipFile(packed) as z:
        z.extractall(work / "source")
    charts.split_land(next((work / "source").rglob("*.shp")), work / "tiles")
    (work / "tiles").replace(COAST)
    shutil.rmtree(work)
    packed.unlink()


def have_sea() -> bool:
    return len(list(SEA.glob("*.tif"))) == SEA_FILES


def fetch_sea() -> None:
    """GEBCO's world grid, once a year at most: it's 4 GB, so a broken download carries on where it stopped."""
    SEA.mkdir(parents=True, exist_ok=True)
    packed = SEA / "gebco.zip"
    if not packed.exists():
        fetch_big(SEA_URL, packed)
    with zipfile.ZipFile(packed) as z:
        z.extractall(SEA, [name for name in z.namelist() if name.endswith(".tif") and "/" not in name])
    packed.unlink()


def tile_bounds(name: str, sizes: tuple) -> tuple:
    level, x, y = map(int, name.split("_")[1:])
    size = sizes[level]
    return -180 + x * size, -90 + y * size, -180 + (x + 1) * size, -90 + (y + 1) * size


def sea_bounds(name: str) -> tuple:
    return tile_bounds(name, SEA_SIZES)


def tiles_in(area: shapely.Geometry, zoom: float, kind: str, sizes: tuple, zooms: tuple, covered=None) -> list:
    """A tiled layer's tiles in an area: as fine as the zoom wants, if that's not too many of them. Tiles wholly under
    covered, the charts showing, are left out."""
    level = sum(zoom >= z for z in zooms)
    while True:
        size = sizes[level]
        names = {
            f"{kind}_{level}_{x}_{y}"
            for west, south, east, north in (part.bounds for part in shapely.get_parts(area))
            for x in range(int((west + 180) // size), int(np.ceil((east + 180) / size)))
            for y in range(int((south + 90) // size), int(np.ceil((north + 90) / size)))
        }
        if covered is not None:
            shapely.prepare(covered)
            names = {name for name in names if not covered.contains(shapely.box(*tile_bounds(name, sizes)))}
        if len(names) <= SEA_TILES or level == 0:
            return sorted(names)
        level -= 1


def sea_view(area: shapely.Geometry, zoom: float, covered: shapely.Geometry | None = None) -> list:
    """The tiles of the world's seabed to show in an area."""
    return tiles_in(area, zoom, "SEA", SEA_SIZES, SEA_ZOOMS, covered) if have_sea() else []


def sea_file(name: str) -> Path:
    return CACHE / f"{name}-{charts.SEA_FORMAT}.gz"


def compile_all() -> None:
    files = all_files(catalog)
    todo = [(file, *job) for file, job in files.items() if not file.exists()]
    land = {}
    if land_source("overview").exists():
        # the whole world is only seen from far out: with the coarsest charts, or none. The coast's tiles wait to be seen.
        for tier in (0, LOWEST_TIER):
            land.setdefault(land_file("WORLD", tier, catalog), ("WORLD", tier))
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
            name = old.stem.rsplit("-", 1)[0]
            coast = name.startswith("COAST_") and any(old == land_file(name, t, catalog) for t in range(LOWEST_TIER, 7))
            if old not in files and old not in land and old != sea_file(name) and not coast:
                old.unlink(missing_ok=True)


def check() -> None:
    status.update(phase="checking", problem=None)
    saved = ENC.parent / "ENCProdCat.xml"
    if not catalog.charts:  # open with what we have: NOAA can take its time, or be away
        if saved.exists():
            adopt(saved.read_bytes())
            status["ready"] = sum(not file.exists() for file in all_files(catalog)) <= BACKLOG
        else:
            take_uploads()
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
    status.update(ready=True)
    if not COAST.exists():  # (the map has the world's coarse land till then, so it doesn't hold anything up)
        status.update(phase="coast", done=0, total=0)
        try:
            fetch_coast()
        except (OSError, HTTPException, zipfile.BadZipFile) as e:
            status["problem"] = f"Couldn't get the world's coast: {e}"
    if not have_sea():  # (the map works without it, so it doesn't hold anything up)
        status.update(phase="seabed", done=0, total=0)
        try:
            fetch_sea()
        except (OSError, HTTPException, zipfile.BadZipFile) as e:
            status["problem"] = f"Couldn't get the world's seabed: {e}"
    status.update(phase="idle", checked=time.time())


def run() -> None:
    while True:
        try:
            check()
        except Exception as e:  # whatever went wrong, the viewer carries on and the next check tries again
            status.update(phase="idle", problem=f"Update check failed: {e}")
        time.sleep(RETRY_AFTER if status["problem"] else CHECK_EVERY)
