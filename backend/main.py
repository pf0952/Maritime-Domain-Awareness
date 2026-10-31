"""ENC server: keeps NOAA's charts up to date and compiled (sync.py, charts.py), and hands the viewer the ones in view.

Run start.bat, or from the project folder:
backend/.venv/Scripts/python -m uvicorn main:app --app-dir backend
It also serves the built viewer (frontend/dist), so that's the whole app, at http://127.0.0.1:8000"""
import json
import os
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import shapely
from fastapi import FastAPI, HTTPException, Query, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pyogrio.errors import DataLayerError, DataSourceError

import charts
import navwarnings
import sync
import tides

MAX_BYTES = 64 * 1024 * 1024  # S-57 cells are 5 MB at most
UNREADABLE = (DataSourceError, DataLayerError, ValueError)
SEARCH_URL = "https://nominatim.openstreetmap.org/search?"  # OpenStreetMap's: one search a second, by its rules
SEARCH_RESULTS = 5
search_turn = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=sync.run, daemon=True).start()
    if os.environ.get("ENC_OPEN_BROWSER"):  # (start.bat)
        threading.Timer(1, webbrowser.open, ["http://127.0.0.1:8000"]).start()
    yield


app = FastAPI(title="ENC 3D", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


@app.post("/api/compile")
def compile_upload(file: UploadFile):
    name = Path(file.filename or "").name
    if not name.lower().endswith(".000"):
        raise HTTPException(415, f"{name or 'That file'} isn't an S-57 .000 cell")
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"{name} is too big for an S-57 cell")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cell.000"
        path.write_bytes(data)
        try:
            return Response(charts.compile_cell(path), media_type="application/octet-stream")
        except UNREADABLE:
            raise HTTPException(422, f"{name} isn't a readable S-57 cell")


@app.get("/api/warnings")
def get_warnings():
    return navwarnings.current()


@app.get("/api/status")
def get_status():
    return {**sync.status, "charts": len(sync.on_disk)}


@app.get("/api/view")
def get_view(west: float, south: float, east: float, north: float, tier: int, corners: str, zoom: float = 6):
    """What to show in that area: the world's land, then charts, coarsest first; whether any ENC is in sight; and
    the bounds of those detailed enough to stand buildings on, as coarser ones draw the coast too roughly for them.

    corners are the four corners of the screen on the map, lng,lat,...: a tilted view is no rectangle, and the area
    around it reaches well past what's on screen."""
    catalog = sync.catalog
    area = sync.on_the_map(shapely.box(west, south, east, north))
    screen = shapely.Polygon(np.array(corners.split(","), dtype=float).reshape(-1, 2))
    in_sight = sync.on_the_map(shapely.make_valid(screen))
    land = [(name, tier, sync.land_file(name, tier, catalog)) for name in sync.land_view(area, zoom, catalog)]
    picked = [(c.name, tier, sync.chart_file(c, tier, catalog)) for c in reversed(catalog.pick(area, tier))]
    pieces = [{"name": name, "tier": t, "key": file.stem} for name, t, file in land + picked]
    detailed = [c.cover.bounds for c in catalog.over(in_sight) if c.band >= sync.COASTAL_BAND]
    return {"charted": sync.charted(in_sight, catalog), "detailed": detailed, "pieces": pieces}


@app.get("/api/tide")
def get_tide(lat: float, lon: float):
    """The nearest station's water levels, or no station if none is near."""
    try:
        km, station = tides.nearest(lat, lon)
        if station is None:
            return {"station": None}
        return {"station": {**station, "km": round(km, 1)}, **tides.series(station)}
    except OSError as e:
        raise HTTPException(503, f"No tide data just now: {e}")


def places_from(rows: list) -> list:
    """Nominatim's answers, with its boxes (south, north, west, east, as text) the way the map wants them."""
    places = []
    for row in rows:
        south, north, west, east = map(float, row["boundingbox"])
        places.append({"name": row["display_name"], "bounds": [west, south, east, north]})
    return places


@app.get("/api/search")
def get_search(q: str = Query(min_length=1, max_length=200)):
    """Places by name, best first."""
    query = urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": SEARCH_RESULTS})
    request = urllib.request.Request(SEARCH_URL + query, headers={"User-Agent": "ENC 3D chart viewer"})
    try:
        with search_turn:
            with urllib.request.urlopen(request, timeout=sync.TIMEOUT) as res:
                rows = json.load(res)
            time.sleep(1)
    except OSError as e:
        raise HTTPException(503, f"Search isn't available just now: {e}")
    return places_from(rows)


@app.get("/api/outline")
def get_outline():
    """The world's land for the general map, as an SVG path."""
    source = sync.land_source("overview")
    if not source.exists():
        raise HTTPException(404, "The world's land hasn't been fetched yet")
    return Response(charts.world_outline(source), media_type="text/plain")


@app.get("/api/chart/{name}/{tier}")
def get_chart(name: str, tier: int):
    catalog = sync.catalog
    if name in sync.land_tiles():
        path = sync.land_file(name, tier, catalog)
        if not path.exists():
            function, *args = sync.land_job(name, tier, path, catalog)
            function(*args)
        return chart_response(path)
    chart = catalog.by_name.get(name)
    if chart is None or name not in sync.on_disk:
        raise HTTPException(404, f"No chart {name}")
    path = sync.chart_file(chart, tier, catalog)
    if not path.exists():  # compiling hasn't got to it yet
        try:
            charts.compile_file(sync.cell_path(chart), sync.cut_out(chart, tier, catalog), path)
        except UNREADABLE:
            raise HTTPException(503, f"{name} can't be read just now")
    return chart_response(path)


def chart_response(path: Path) -> FileResponse:
    return FileResponse(path, media_type="application/octet-stream", headers={
        "Content-Encoding": "gzip",
        "Cache-Control": "public, max-age=31536000, immutable",  # the viewer's URLs carry the key
    })


class Viewer(StaticFiles):
    """Browsers check for a newer build each time, or they can go on showing an old one."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


dist = Path(__file__).parent.parent / "frontend" / "dist"
if dist.is_dir():
    app.mount("/", Viewer(directory=dist, html=True))
