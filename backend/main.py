"""ENC server: keeps NOAA's charts up to date and compiled (sync.py, charts.py), and hands the viewer the ones in view.

Run start.bat, or from the project folder:
backend/.venv/Scripts/python -m uvicorn main:app --app-dir backend
It also serves the built viewer (frontend/dist), so that's the whole app, at http://127.0.0.1:8000. start.bat runs it
through launch.py instead, which finds a free port and opens it in a window of its own."""
import json
import re
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import shapely
from starlette.concurrency import run_in_threadpool
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pyogrio.errors import DataLayerError, DataSourceError

import archives
import berths
import charts
import currents
import fleet
import navwarnings
import route
import routes
import vessel_docs
import sync
import tides
import weather

MAX_BYTES = 64 * 1024 * 1024  # S-57 cells are 5 MB at most
UNREADABLE = (DataSourceError, DataLayerError, ValueError)
SEARCH_URL = "https://nominatim.openstreetmap.org/search?"  # OpenStreetMap's: one search a second, by its rules
SEARCH_RESULTS = 5
search_turn = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=sync.run, daemon=True).start()
    threading.Thread(target=navwarnings.run, daemon=True).start()
    threading.Thread(target=fleet.run, daemon=True).start()
    yield


app = FastAPI(title="Mariner Domain Awareness", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
# only asked for by name as this computer: a web page elsewhere that had its own name pointed here (DNS rebinding)
# would pass the same-site check, as its Origin and Host would match
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "*.localhost"])


def upload_summary(chart: sync.Chart) -> dict:
    return {"name": chart.name, "scale": chart.scale, "bounds": chart.cover.bounds}


def same_site(origin: str | None = Header(None), host: str | None = Header(None)) -> None:
    """Any web page open in the browser can send to this address, so only our own may change what's stored."""
    if origin and urllib.parse.urlparse(origin).netloc != host:
        raise HTTPException(403, "Changes are accepted only from this app")


# when the viewer's windows last said they were open, and when one last said it was closing: launch.py stops the
# server once none is left
windows = {"alive": None, "bye": None}


@app.post("/api/alive", dependencies=[Depends(same_site)])
def post_alive():
    windows["alive"] = time.time()


@app.post("/api/bye", dependencies=[Depends(same_site)])
def post_bye():
    windows["bye"] = time.time()


@app.get("/api/uploads")
def get_uploads():
    return [upload_summary(c) for c in sync.catalog.charts if c.url is None]


@app.post("/api/uploads", dependencies=[Depends(same_site)])
def add_upload(file: UploadFile):
    name = Path(file.filename or "").name
    if not name.lower().endswith(".000"):
        raise HTTPException(415, f"{name or 'File'} is not an S-57 cell (.000)")
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"{name} exceeds the maximum size for an S-57 cell")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cell.000"
        path.write_bytes(data)
        try:
            return upload_summary(sync.add_upload(path))
        except UNREADABLE:
            raise HTTPException(422, f"{name} could not be read as an S-57 cell")


@app.delete("/api/uploads/{name}", dependencies=[Depends(same_site)])
def delete_upload(name: str):
    chart = sync.catalog.by_name.get(name)
    if chart is None or chart.url is not None:
        raise HTTPException(404, f"Uploaded chart not found: {name}")
    sync.remove_upload(name)
    return {"name": name}


@app.get("/api/warnings")
def get_warnings():
    return navwarnings.current()


@app.get("/api/status")
def get_status():
    status = {**sync.status, "charts": len(sync.on_disk)}
    if status["ready"] and not navwarnings.ready():  # the nav warnings are placed as part of opening, too
        status.update(ready=False, phase="warnings")
    return status


@app.get("/api/view")
def get_view(west: float, south: float, east: float, north: float, tier: int, corners: str, zoom: float = 6):
    """What to show in that area: the world's land, then charts, coarsest first; whether any ENC is in sight; and
    the bounds of where to stand buildings, as coarse charts draw the coast too roughly for them.

    corners are the four corners of the screen on the map, lng,lat,...: a tilted view is no rectangle, and the area
    around it reaches well past what's on screen."""
    catalog = sync.catalog
    area = sync.on_the_map(shapely.box(west, south, east, north))
    try:
        screen = shapely.Polygon(np.array(corners.split(","), dtype=float).reshape(-1, 2))
    except ValueError:
        raise HTTPException(422, "Corners must be four or more lng,lat pairs")
    in_sight = sync.on_the_map(shapely.make_valid(screen))
    land = [(name, tier, sync.land_file(name, tier, catalog)) for name in sync.land_view(area, zoom, catalog)]
    chosen = catalog.pick(area, tier)
    picked = [(c.name, tier, sync.chart_file(c, tier, catalog)) for c in reversed(chosen)]
    covered = shapely.union_all([c.cover for c in chosen])
    # last, as charts hide it and hidden costs less, and none at all of what they hide completely
    sea = [(name, 0, sync.sea_file(name)) for name in sync.sea_view(area, zoom, covered)]
    # (objects: the key for its objects, which change with the way they're worked out as well as with the chart)
    pieces = [{"name": name, "tier": t, "key": file.stem, "objects": f"{file.stem}-{charts.OBJECT_FORMAT}"}
              for name, t, file in land + picked + sea]
    detailed = []
    if zoom >= sync.BUILDINGS_ZOOM:  # (from further out it's thousands of charts, for no buildings to stand)
        charts_here = catalog.over(in_sight)
        detailed = [c.cover.bounds for c in charts_here if c.band >= sync.COASTAL_BAND]
        # beyond the charts OpenStreetMap draws both the coast and the buildings, so they agree
        uncharted = in_sight.difference(shapely.union_all([c.cover for c in charts_here]))
        detailed += [part.bounds for part in shapely.get_parts(uncharted) if not part.is_empty]
    return {"charted": sync.charted(in_sight, catalog), "detailed": detailed, "pieces": pieces}


@app.get("/api/tide")
def get_tide(lat: float, lon: float):
    """The nearest station's water levels, or no station if none is near."""
    try:
        km, station = tides.nearest(lat, lon)
        if station is None:
            return {"station": None}
        return {"station": {**station, "km": round(km, 1)}, **tides.series(station)}
    except (OSError, ValueError) as e:  # (a half-sent answer doesn't parse)
        raise HTTPException(503, f"Tide data unavailable: {e}")


def places_from(rows: list) -> list:
    """Nominatim's answers, with its boxes (south, north, west, east, as text) the way the map wants them."""
    places = []
    for row in rows:
        south, north, west, east = map(float, row["boundingbox"])
        places.append({"name": row["display_name"], "bounds": [west, south, east, north]})
    return places


@app.get("/api/currents")
def get_currents(west: float, south: float, east: float, north: float):
    """Tidal currents at NOAA's stations in an area, hour by hour across the tide bar."""
    try:
        return currents.in_view(west, south, east, north)
    except (OSError, ValueError) as e:
        raise HTTPException(503, f"Current predictions unavailable: {e}")


@app.get("/api/weather")
def get_weather(west: float, south: float, east: float, north: float):
    """Wind and waves on a grid over an area, hour by hour across the tide bar."""
    try:
        return weather.in_view(west, south, east, north)
    except (OSError, ValueError, KeyError) as e:
        raise HTTPException(503, f"Weather data unavailable: {e}")


@app.get("/api/landmask")
def get_land_mask(west: float, south: float, east: float, north: float):
    """Where the land is in an area, so waves and swell can be kept off it."""
    if east - west > 400 or north - south > 180:
        raise HTTPException(422, "Requested area is too large")
    try:
        return weather.land_mask(west, south, east, north)
    except (OSError, ValueError) as e:
        raise HTTPException(503, f"Land data unavailable: {e}")


@app.post("/api/berths")
def post_berths(vessels: list[dict] = Body(..., max_length=500)):
    """Stopped vessels' positions, headings and sizes: where to draw any that'd lie in the land, alongside it."""
    try:
        clean = [{"mmsi": v["mmsi"], "lng": float(v["lng"]), "lat": float(v["lat"]), "length": float(v["length"]),
                  "beam": float(v["beam"]), "hdg": None if v.get("hdg") is None else float(v["hdg"])} for v in vessels]
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "Each vessel requires MMSI, lng, lat, length and beam")
    try:
        return berths.adjust([v for v in clean if 0 < v["length"] < 500 and 0 < v["beam"] < 100])
    except (OSError, ValueError, UNREADABLE) as e:
        raise HTTPException(503, f"Berth positions unavailable: {e}")


@app.get("/api/fleets")
def get_fleets():
    return fleet.fleets()


@app.put("/api/fleets/{name}", dependencies=[Depends(same_site)])
def put_fleet(name: str, mmsis: list[int] = Body(..., max_length=fleet.MOST)):
    """Saves a fleet, up to fleet.MOST vessels by MMSI, and starts recording any that are new."""
    if not name.strip() or len(name) > 80:
        raise HTTPException(422, "Fleet name required, 80 characters maximum")
    fleet.save_fleet(name.strip(), [m for m in dict.fromkeys(mmsis) if 0 < m < 1_000_000_000])
    if archives.settings().get("gfw_token"):
        archives.start("gfw")  # (port visits for any new vessels; skipped if a run's going)
    return fleet.fleets()


@app.get("/api/routes")
def get_routes():
    """The routes kept, by name."""
    return routes.load()


@app.put("/api/routes/{name}", dependencies=[Depends(same_site)])
def put_route(name: str, route_: dict = Body(...)):
    if not name.strip() or len(name) > 120:
        raise HTTPException(422, "Route name required, 120 characters maximum")
    if len(route_.get("waypoints") or []) > 500:
        raise HTTPException(422, "Maximum 500 waypoints per route")
    return routes.save(name.strip(), route_)


@app.delete("/api/routes/{name}", dependencies=[Depends(same_site)])
def delete_route(name: str):
    return routes.delete(name)


@app.get("/api/ports")
def get_ports(q: str = Query(min_length=1, max_length=80)):
    """Ports by name or code."""
    return routes.find_ports(q)


@app.get("/api/ports/approach")
def get_port_approach(lng: float = Query(ge=-180, le=180), lat: float = Query(ge=-90, le=90)):
    """Where a voyage to or from a port begins at sea: its pilot boarding place or fairway buoy, from the charts."""
    try:
        return routes.approach(lng, lat)
    except UNREADABLE:
        raise HTTPException(503, "Chart near the port could not be read")


@app.post("/api/routes/voyage", dependencies=[Depends(same_site)])
def post_route_voyage(route_: dict = Body(..., alias="route"), vessel: dict = Body(default={})):
    """The route sailed through the forecast: each leg's speed, slowed by waves and helped or held back by the
    current, and its times."""
    waypoints = route_.get("waypoints")
    if not isinstance(waypoints, list) or not 2 <= len(waypoints) <= 500:
        raise HTTPException(422, "Route must have 2 to 500 waypoints")
    return routes.voyage(route_, vessel)


@app.post("/api/routes/weather", dependencies=[Depends(same_site)])
def post_route_weather(route_: dict = Body(..., alias="route"), my: dict = Body(default={})):
    """Weather routing: the fastest, the most comfortable and the planned way from the route's first waypoint to its
    last, through the forecast, with her motions along each. Takes a little while: isochrones, forecast fetched."""
    waypoints = route_.get("waypoints")
    if not isinstance(waypoints, list) or not 2 <= len(waypoints) <= 500:
        raise HTTPException(422, "Route must have 2 to 500 waypoints")
    try:
        return routes.weather_routes(route_, my or None)
    except (OSError, ValueError) as e:
        raise HTTPException(503, f"Weather routing unavailable: {e}")


@app.post("/api/routes/plan", dependencies=[Depends(same_site)])
def post_route_plan(start: list[float] = Body(..., min_length=2, max_length=2), end: list[float] = Body(..., min_length=2, max_length=2),
                    vessel: dict = Body(default={}), xtd: float = Body(default=routes.XTD, gt=0, le=5)):
    """A first route between two points, through water deep enough for the vessel: a start to edit, not a passage plan."""
    try:
        return routes.plan(start, end, vessel, xtd)
    except UNREADABLE:
        raise HTTPException(503, "Chart along the route could not be read")


@app.post("/api/routes/check", dependencies=[Depends(same_site)])
def post_route_check(route_: dict = Body(...)):
    """What each leg runs into, from the charts and the tides."""
    waypoints = route_.get("waypoints")
    if not isinstance(waypoints, list) or len(waypoints) > 500 or not all(
            isinstance(w, dict) and isinstance(w.get("lng"), (int, float)) and isinstance(w.get("lat"), (int, float))
            and abs(w["lat"]) <= 90 for w in waypoints):
        raise HTTPException(422, "Each waypoint requires lng and lat; maximum 500 waypoints")
    try:
        xtd = float(route_.get("xtd") or routes.XTD)
    except (TypeError, ValueError):
        xtd = -1
    if not 0 < xtd <= 5:
        raise HTTPException(422, "Cross-track distance must be greater than 0 and at most 5 nm")
    try:
        return routes.check(route_)
    except UNREADABLE:
        raise HTTPException(503, "Chart along the route could not be read")


@app.get("/api/vessels")
def get_vessels():
    """The vessels kept for "My vessel", read from their documents: id and name."""
    return vessel_docs.vessels()


@app.get("/api/vessels/{vessel_id}")
def get_vessel(vessel_id: str):
    try:
        return vessel_docs.load(vessel_id)
    except (OSError, ValueError):
        raise HTTPException(404, f"Vessel not found: {vessel_id}")


@app.post("/api/vessels/pdf", dependencies=[Depends(same_site)])
async def post_vessel_pdf(file: UploadFile, kind: str = Query("capacity", pattern="^(capacity|report|stow)$")):
    """A document's pages as text, to pick its tables from; and what it says read off it: a stability report's figures,
    tanks and weights; a stow plan's units, from its tables or placed off its drawing."""
    data = await file.read(vessel_docs.PDF_MOST + 1)
    if len(data) > vessel_docs.PDF_MOST:
        raise HTTPException(413, "PDF exceeds 60 MB")
    try:
        pages = vessel_docs.pdf_pages(data)
    except Exception as e:  # (pypdf raises its own kinds for a damaged or encrypted file)
        raise HTTPException(422, f"PDF could not be read: {e}")
    out = {"pages": pages, "drawn_only": not any(p.strip() for p in pages)}
    try:
        if kind == "report":
            out.update(vessel_docs.read_report(pages))
        elif kind == "stow" and not out["drawn_only"]:
            out["drawing"] = vessel_docs.read_drawing(data)
        elif kind == "capacity":
            # (a drawn plan's words read by OCR, a minute or two: off the server's loop, so the rest of the app runs on)
            if out["drawn_only"]:
                words = await run_in_threadpool(vessel_docs.drawn_words, data)
            else:
                words = [(ln["x"], ln["y"], 1.0, ln["text"]) for ln in vessel_docs.text_runs(data)]
            out["capacity"] = {**vessel_docs.read_capacity(words), "ocr": out["drawn_only"], "words": len(words)}
            if out["drawn_only"] and not words:
                out["problem"] = "No text read: OCR is not installed (see backend/requirements.txt)"
    except Exception as e:  # (a reading that trips on an odd layout leaves the pages to read by hand)
        out["problem"] = f"Document only partly read: {e}"
    return out


@app.put("/api/vessels", dependencies=[Depends(same_site)])
def put_vessel(vessel: dict = Body(...)):
    """A vessel kept as read from her documents."""
    try:
        return {"id": vessel_docs.save(vessel)}
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(422, str(e))


@app.delete("/api/vessels/{vessel_id}", dependencies=[Depends(same_site)])
def delete_vessel(vessel_id: str):
    vessel_docs.delete(vessel_id)
    return vessel_docs.vessels()


@app.delete("/api/fleets/{name}", dependencies=[Depends(same_site)])
def delete_fleet(name: str):
    fleet.delete_fleet(name)
    return fleet.fleets()


@app.get("/api/fleet/sources")
def get_fleet_sources():
    """Whether a Global Fishing Watch token is set (never the token itself), and how each history run is going."""
    return archives.state()


@app.put("/api/fleet/gfw-token", dependencies=[Depends(same_site)])
def put_gfw_token(token: str = Body(..., embed=True, max_length=4000)):
    archives.set_gfw_token(token)
    if token.strip():
        archives.start("gfw")
    return archives.state()


@app.post("/api/fleet/backfill/{source}", dependencies=[Depends(same_site)])
def post_backfill(source: str, years: int = Query(1, ge=1, le=5)):
    """Starts filling in history from a free source: gfw (port visits), us (MarineCadastre) or dk (Danish)."""
    if source not in ("gfw", "us", "dk"):
        raise HTTPException(404, f"Unknown source: {source}")
    if not archives.start(source, years):
        raise HTTPException(409, "History import already running: stop it or wait for it to finish")
    return archives.state()


@app.post("/api/fleet/backfill-stop", dependencies=[Depends(same_site)])
def post_backfill_stop():
    archives.stop.set()
    return archives.state()


@app.get("/api/fleet/vessel/{mmsi}")
def get_fleet_vessel(mmsi: int):
    """One vessel's recorded history, worked out: port calls, voyages, loads and discharges, gaps."""
    return fleet.analyse(mmsi)


@app.get("/api/route")
def get_route(lng: float, lat: float, destination: str = Query("", max_length=100), sog: float | None = None,
              type: int | None = None, length: float | None = None, eta: str | None = Query(None, max_length=20),
              cog: float | None = None, seen: str | None = Query(None, max_length=40)):
    """A vessel's likely route to its AIS destination, and when it'll get there with the forecast weather on the way."""
    try:
        return route.predict(lng, lat, destination, sog, type, length, eta, cog, seen)
    except (OSError, ValueError, KeyError) as e:
        raise HTTPException(503, f"Route prediction unavailable: {e}")


@app.get("/api/search")
def get_search(q: str = Query(min_length=1, max_length=200)):
    """Places by name, best first."""
    query = urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": SEARCH_RESULTS})
    request = urllib.request.Request(SEARCH_URL + query, headers={"User-Agent": "Mariner Domain Awareness"})
    try:
        with search_turn:
            with urllib.request.urlopen(request, timeout=sync.TIMEOUT) as res:
                rows = json.load(res)
            time.sleep(1)
    except (OSError, ValueError) as e:
        raise HTTPException(503, f"Search unavailable: {e}")
    return places_from(rows)


@app.get("/api/outline")
def get_outline():
    """The world's land for the general map, as an SVG path."""
    source = sync.land_source("overview")
    if not source.exists():
        raise HTTPException(404, "World land data not yet downloaded")
    return Response(charts.world_outline(source), media_type="text/plain")


@app.get("/api/chart/{name}/{tier}")
def get_chart(name: str, tier: int):
    catalog = sync.catalog
    if name.startswith("SEA_"):
        if not re.fullmatch(r"SEA_\d+_\d+_\d+", name):  # (a name, before it goes into a path)
            raise HTTPException(404, f"Tile not found: {name}")
        path = sync.sea_file(name)
        if not path.exists():
            try:
                charts.compile_sea(sync.SEA, sync.sea_bounds(name), path)
            except (ValueError, IndexError):
                raise HTTPException(404, f"Tile not found: {name}")
            except OSError:
                raise HTTPException(503, "Seabed data could not be read")
        return chart_response(path)
    if name == "WORLD" or name.startswith("COAST_"):
        try:
            path = sync.land_file(name, tier, catalog)
            if not path.exists():
                function, *args = sync.land_job(name, tier, path, catalog)
                function(*args)
        except (ValueError, IndexError):
            raise HTTPException(404, f"Tile not found: {name}")
        return chart_response(path)
    chart = catalog.by_name.get(name)
    if chart is None or name not in sync.on_disk:
        raise HTTPException(404, f"Chart not found: {name}")
    path = sync.chart_file(chart, tier, catalog)
    if not path.exists():  # compiling hasn't got to it yet
        try:
            charts.compile_file(sync.cell_path(chart), sync.cut_out(chart, tier, catalog), path)
        except UNREADABLE:
            raise HTTPException(503, f"Chart {name} could not be read")
    return chart_response(path)


@app.get("/api/objects/{name}/{tier}")
def get_objects(name: str, tier: int):
    """A chart's buoys, beacons, landmarks and the like, less what finer charts show."""
    chart = sync.catalog.by_name.get(name)
    if chart is None or name not in sync.on_disk:
        raise HTTPException(404, f"Chart not found: {name}")
    path = sync.objects_file(chart, tier, sync.catalog)
    if not path.exists():
        try:
            charts.compile_objects(sync.cell_path(chart), sync.cut_out(chart, tier, sync.catalog), path)
        except UNREADABLE:
            raise HTTPException(503, f"Chart {name} could not be read")
    return chart_response(path, "application/json")


def chart_response(path: Path, media_type: str = "application/octet-stream") -> FileResponse:
    return FileResponse(path, media_type=media_type, headers={
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
