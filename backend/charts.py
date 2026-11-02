"""Compiles S-57 cells into meshes the viewer can hand straight to the graphics chip, with nothing left to work out.

A chart file is a little JSON header, then for each of its meshes: positions (float32 x, y, z: degrees from the
chart's origin, and metres), colours (RGBA bytes) and triangles (uint32 indices). Tops and walls are separate meshes,
so the viewer can leave out walls at zooms where they'd be too small to see.

The seabed is a surface, not a stack of flat bands. Every depth area's edge is a contour, so its points take their depth
from it; a smooth surface through the contours and soundings gives the depths between them, always within the area's
own band, so that the surface can't say anything the chart doesn't."""
import functools
import gzip
import json
import os
import struct
from pathlib import Path

import geopandas as gpd
import mapbox_earcut
import numpy as np
import pandas as pd
import pyogrio
import rasterio
import shapely
from numpy.lib.stride_tricks import sliding_window_view
from rasterio.windows import Window

FORMAT = 4  # raise it when these files change: browsers and backend/cache keep them for good
LAND_FORMAT = 3  # the same, for the world's land
SEA_FORMAT = 3  # the same, for the world's seabed
WIDE = 3  # degrees: a chart wider or taller than this isn't offsets from its middle, as they bend, and neighbours part
SEA_GRID = 150  # squares across a tile of it
SEA_CELLS = 240  # to the degree, in GEBCO's grid
SEA_PART = 90 * SEA_CELLS  # cells on a side of each of its files
TOLERANCE = 0.2e-3 / 111_000  # degrees per unit of chart scale: 0.2 mm on the chart, finer than it can show
LAND_HEIGHT = 15  # m: LNDARE carries no heights
LAND_RGB = np.array([47, 53, 64])
COAST_RGB = np.array([140, 199, 242])
SPLIT_BATCH = 50_000  # polygons at a time: all of OpenStreetMap's land at once would fill this machine's memory
COAST_FILE = 10  # degrees, on a side
WORLD_SIMPLIFY = 0.03  # degrees: about 3 km, under a pixel at the zooms that show the whole world as one piece
SHALLOW_RGB = np.array([126, 214, 223])
DEEP_RGB = np.array([8, 30, 66])
SKIRT = 50  # m: how far down the edge of a chart reaches, at the least, to meet whatever lies beyond it
GRID = 1e6  # coordinates are rounded to this many steps a degree, so areas' shared edges match exactly
HASH_X, HASH_Y = 0x9E3779B97F4A7C15 - (1 << 64), 0x2545F4914F6CDD1D
SURFACE_SIZE = 256  # cells across the grid a chart's seabed is worked out on
SURFACE_PASSES = 20  # relaxing passes at each of its sizes, coarse to fine
SURFACE_TENSION = 0.3  # 0 is a stiff sheet that can overshoot its points, 1 a slack one; seabeds usually take about 0.3
SURFACE_REACH = 8  # cells: as far from anything the chart says as the surface can go before it's only a guess
LATTICE = 4  # cells of that grid between the points that carry the surface between contours
SPECK = np.array([[-2, -2], [2, -2], [0, 2]]) / GRID


def polygons(path: Path, layer: str, columns: tuple = ()) -> gpd.GeoDataFrame:
    """One object class's areas: it can also hold lines and points, and a cell can lack it altogether."""
    if layer not in pyogrio.list_layers(path)[:, 0]:
        return gpd.GeoDataFrame({c: [] for c in columns}, geometry=[], crs=4326)
    found = pyogrio.read_dataframe(path, layer=layer, columns=list(columns))
    return found[found.geom_type.isin(["Polygon", "MultiPolygon"])]


class NoAreas(ValueError):
    """A cell with neither depth areas nor land: there are a few, with nothing to draw and nothing wrong."""


def read_areas(path: Path, hole: shapely.Geometry | None = None) -> tuple:
    """A cell's name, scale and areas, less any hole: where finer charts take over.

    Areas have a depth (m below datum, the middle of the band; blank for land), the band's low and high, and whether
    they're dredged."""
    dsid = pyogrio.read_dataframe(path, layer="DSID", read_geometry=False).iloc[0]
    # dredged channels are water too, or harbours' main channels would be holes
    natural = polygons(path, "DEPARE", ("DRVAL1", "DRVAL2")).assign(dredged=False)
    dug = polygons(path, "DRGARE", ("DRVAL1", "DRVAL2")).assign(dredged=True)
    water = pd.concat([natural, dug], ignore_index=True)
    depth = water[["DRVAL1", "DRVAL2"]].mean(axis=1).fillna(0).round(1)
    low, high = water["DRVAL1"].fillna(depth), water["DRVAL2"].fillna(depth)
    water = water.assign(depth=depth, low=low, high=high.where(~water["dredged"], low))
    land = polygons(path, "LNDARE")
    columns = ["depth", "low", "high", "dredged", "geometry"]
    cell = pd.concat([water[columns], land], ignore_index=True)
    if cell.empty:
        raise NoAreas(f"{dsid.DSID_DSNM} has no depth areas or land")
    # simplified together, or the coast they share would open into gaps
    shapes = shapely.coverage_simplify(cell.geometry.to_numpy(), int(dsid.DSPM_CSCL) * TOLERANCE)
    if hole is not None:
        shapes = shapely.difference(shapes, hole)
    cell = cell.set_geometry(shapely.transform(shapes, lambda xy: xy.round(6)), crs=4326)
    return Path(dsid.DSID_DSNM).stem, int(dsid.DSPM_CSCL), cell[~cell.is_empty]


def colour(depth: np.ndarray) -> np.ndarray:
    """Pale shallows to dark deeps, on a log scale: charts' depth bands are about log-spaced too; slate for land."""
    t = np.minimum(np.log10(1 + np.maximum(np.nan_to_num(depth), 0)) / 3, 1)[:, None]
    return np.where(np.isnan(depth)[:, None], LAND_RGB, SHALLOW_RGB + (DEEP_RGB - SHALLOW_RGB) * t)


def read_survey(path: Path) -> tuple:
    """Where the chart gives a depth: its soundings and contours, as points and their depths."""
    layers = pyogrio.list_layers(path)[:, 0]
    points, depths = [np.empty((0, 2))], [np.empty(0)]
    if "SOUNDG" in layers:
        found = pyogrio.read_dataframe(path, layer="SOUNDG", columns=[])
        xyz = shapely.get_coordinates(found.geometry.to_numpy(), include_z=True)
        points.append(xyz[:, :2].round(6))
        depths.append(xyz[:, 2])
    if "DEPCNT" in layers:
        found = pyogrio.read_dataframe(path, layer="DEPCNT", columns=["VALDCO"]).dropna(subset="VALDCO")
        xy, line = shapely.get_coordinates(found.geometry.to_numpy(), return_index=True)
        points.append(xy.round(6))
        depths.append(found["VALDCO"].to_numpy(dtype=float)[line])
    return np.concatenate(points), np.concatenate(depths)


def smooth(values: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fills a square grid between its known cells, as a thin sheet bent through them, as seabeds are usually gridded.

    A slack sheet would only make a pinprick at a lone sounding. Worked out coarse to fine, as relaxing on its own takes
    an age to carry a value across a big grid."""
    size = len(values)
    if size <= 8:
        guess = np.full((size, size), values[known].mean() if known.any() else 0.0)
    else:
        half = size // 2
        weight = known.reshape(half, 2, half, 2).sum(axis=(1, 3))
        total = (values * known).reshape(half, 2, half, 2).sum(axis=(1, 3))
        coarse = smooth(np.divide(total, weight, out=np.zeros_like(total), where=weight > 0), weight > 0)
        guess = coarse.repeat(2, axis=0).repeat(2, axis=1)
    for _ in range(SURFACE_PASSES):
        guess[known] = values[known]
        e = np.pad(guess, 2, mode="edge")
        beside = e[1:-3, 2:-2] + e[3:-1, 2:-2] + e[2:-2, 1:-3] + e[2:-2, 3:-1]
        diagonal = e[1:-3, 1:-3] + e[1:-3, 3:-1] + e[3:-1, 1:-3] + e[3:-1, 3:-1]
        beyond = e[:-4, 2:-2] + e[4:, 2:-2] + e[2:-2, :-4] + e[2:-2, 4:]
        bent = (1 - SURFACE_TENSION) * (8 * beside - 2 * diagonal - beyond) + SURFACE_TENSION * beside
        guess += (bent / (20 - 16 * SURFACE_TENSION) - guess) / 2
    guess[known] = values[known]
    return guess


class Surface:
    """A chart's seabed between its contours and soundings."""

    def __init__(self, points: np.ndarray, depths: np.ndarray, bounds: list):
        self.west, self.south, east, north = bounds
        self.dx = max(east - self.west, 1e-9) / (SURFACE_SIZE - 1)
        self.dy = max(north - self.south, 1e-9) / (SURFACE_SIZE - 1)
        self.corner, self.size = np.array([self.west, self.south]), np.array([self.dx, self.dy])
        i, j = self.cell(points)
        i, j = np.rint(i).astype(int), np.rint(j).astype(int)
        inside = (i >= 0) & (i < SURFACE_SIZE) & (j >= 0) & (j < SURFACE_SIZE)
        where = i[inside] + SURFACE_SIZE * j[inside]
        cells = SURFACE_SIZE**2
        count = np.bincount(where, minlength=cells).reshape(SURFACE_SIZE, SURFACE_SIZE)
        # (with no points at all, bincount gives whole numbers)
        total = np.bincount(where, depths[inside], minlength=cells).astype(float).reshape(SURFACE_SIZE, SURFACE_SIZE)
        self.known = count > 0
        self.values = np.divide(total, count, out=np.zeros_like(total), where=self.known)
        self.grid = smooth(self.values, self.known)

    def cell(self, points: np.ndarray) -> tuple:
        return (points[:, 0] - self.west) / self.dx, (points[:, 1] - self.south) / self.dy

    def steer(self, spots: np.ndarray, low: np.ndarray, high: np.ndarray) -> None:
        """Where the chart says nothing for a way around and the surface has stuck to one end of a depth band, the
        middle of the band is a better guess. A wide bay with no soundings would otherwise lie dead flat at the depth
        of its shore, and dry out all at once as the tide fell."""
        said = np.pad(self.known, SURFACE_REACH)
        said = sliding_window_view(said, (2 * SURFACE_REACH + 1, 2 * SURFACE_REACH + 1)).any(axis=(2, 3))
        i, j = [np.rint(axis).astype(int).clip(0, SURFACE_SIZE - 1) for axis in self.cell(spots)]
        found = self.depth_at(spots)
        stuck = ~said[j, i] & (np.minimum(found - low, high - found) < (high - low) / 4)
        if stuck.any():
            self.values[j[stuck], i[stuck]] = (low + high)[stuck] / 2
            self.known[j[stuck], i[stuck]] = True
            self.grid = smooth(self.values, self.known)

    def depth_at(self, points: np.ndarray) -> np.ndarray:
        x, y = self.cell(points)
        i, j = np.clip(x.astype(int), 0, SURFACE_SIZE - 2), np.clip(y.astype(int), 0, SURFACE_SIZE - 2)
        u, v = np.clip(x - i, 0, 1), np.clip(y - j, 0, 1)
        g = self.grid
        return (g[j, i] * (1 - u) + g[j, i + 1] * u) * (1 - v) + (g[j + 1, i] * (1 - u) + g[j + 1, i + 1] * u) * v


def edge_depths(polys: np.ndarray, low: np.ndarray, high: np.ndarray, dredged: np.ndarray, land: np.ndarray,
                survey: tuple, bounds: list) -> tuple:
    """The depth of every corner of the water's areas, so that areas sharing a corner agree exactly, and the surface.

    A contour gives it. Failing that: at the shore it's the shallow end of the band; between two areas, where their
    bands meet; and at the chart's edge, where nothing's known, the surface says, within the band."""
    xy, ring_of = shapely.get_coordinates(shapely.get_rings(polys), return_index=True)
    owner = shapely.get_rings(polys, return_index=True)[1][ring_of]
    unique, first, inverse = np.unique(point_keys(xy), return_index=True, return_inverse=True)
    lows, highs = np.full(len(unique), -np.inf), np.full(len(unique), np.inf)
    natural = ~dredged[owner]
    np.maximum.at(lows, inverse[natural], low[owner][natural])
    np.minimum.at(highs, inverse[natural], high[owner][natural])
    # (a ring's last corner is its first again, so count areas, not corners)
    pairs = np.unique(np.column_stack([inverse[natural], owner[natural]]), axis=0)
    areas = np.bincount(pairs[:, 0], minlength=len(unique))
    depth = np.full(len(unique), np.nan)
    between = areas >= 2
    depth[between] = (lows[between] + highs[between]) / 2
    if len(land):
        shore = np.isin(unique, point_keys(shapely.get_coordinates(shapely.get_rings(land))))
        shallowest = np.full(len(unique), np.inf)
        np.minimum.at(shallowest, inverse[natural], low[owner][natural])
        depth = np.where(shore & (areas >= 1), shallowest, depth)
    points, depths = survey
    keys = point_keys(points)
    place = np.searchsorted(unique, keys).clip(0, len(unique) - 1)
    on_contour = unique[place] == keys
    depth[place[on_contour]] = depths[on_contour]
    known = ~np.isnan(depth)
    surface = Surface(np.concatenate([points, xy[first[known]]]), np.concatenate([depths, depth[known]]), bounds)
    # the rest are the chart's edge
    unknown = ~known & (areas >= 1)
    depth[unknown] = np.clip(surface.depth_at(xy[first[unknown]]), lows[unknown], highs[unknown])
    return unique, depth, surface


def lattice(polys: np.ndarray, surface: Surface) -> tuple:
    """Evenly spaced points that lie well inside a polygon, and which one each is in."""
    cells = np.arange(LATTICE / 2, SURFACE_SIZE, LATTICE)
    x, y = (surface.west + surface.dx * cells).round(6), (surface.south + surface.dy * cells).round(6)
    points = shapely.points(*[axis.ravel() for axis in np.meshgrid(x, y)])
    which, inside = shapely.STRtree(polys).query(points, predicate="within")
    edges = shapely.boundary(polys)
    shapely.prepare(edges)
    clear = ~shapely.dwithin(edges[inside], points[which], LATTICE * min(surface.dx, surface.dy) / 3)
    return shapely.get_coordinates(points[which[clear]]), inside[clear]


def seabed(polys: np.ndarray, low: np.ndarray, high: np.ndarray, dredged: np.ndarray, unique: np.ndarray,
           edges: np.ndarray, surface: Surface) -> tuple:
    """The water's areas as one surface: their edges take their corners' depths, and a lattice follows the surface
    between them. Without it, one point out in a bay would fan long thin triangles back to the whole shore.

    Triangulating only joins up a polygon's edges, so the lattice goes in as specks of hole, which close up after."""
    points, inside = lattice(polys, surface)
    keep = high[inside] > low[inside]
    points, inside = points[keep], inside[keep]
    surface.steer(points, low[inside], high[inside])
    specks = points[:, None] + SPECK
    specks = shapely.linearrings(np.concatenate([specks, specks[:, :1]], axis=1))
    shapes = polys.copy()
    for i in np.unique(inside):
        shell, *holes = shapely.get_rings(polys[i])
        shapes[i] = shapely.Polygon(shell, [*holes, *specks[inside == i]])
    found = [triangle_corners(shape) for shape in shapes]
    xy = np.concatenate(found)
    owner = np.arange(len(shapes)).repeat([len(corners) for corners in found])
    keys = point_keys(xy)
    place = np.searchsorted(unique, keys).clip(0, len(unique) - 1)
    depth = np.where(dredged[owner], low[owner], edges[place])
    speck = unique[place] != keys
    step, start = LATTICE * surface.size, surface.corner + LATTICE / 2 * surface.size
    xy[speck] = (np.rint((xy[speck] - start) / step) * step + start).round(6)
    depth[speck] = np.clip(surface.depth_at(xy[speck]), low[owner[speck]], high[owner[speck]])
    a, b, c = xy[::3], xy[1::3], xy[2::3]
    whole = ~((a == b).all(axis=1) | (b == c).all(axis=1) | (c == a).all(axis=1)).repeat(3)
    corners = np.column_stack([xy[whole], -depth[whole]])
    first, inverse = merged(corners, colour(depth[whole]))
    return corners[first], colour(depth[whole][first]), inverse


def triangle_corners(poly: shapely.Polygon) -> np.ndarray:
    """A polygon's triangles, three corners each. Delaunay's are better shaped, but it gives up on the odd polygon."""
    try:
        triangles = shapely.constrained_delaunay_triangles(poly)
        return shapely.get_coordinates(triangles).reshape(-1, 4, 2)[:, :3].reshape(-1, 2)
    except shapely.errors.GEOSException:
        xy, triangles = earcut(poly)
        return xy[triangles]


def earcut(poly: shapely.Polygon) -> tuple:
    """A polygon's corners and its triangles, as numbers of those corners."""
    rings = [shapely.get_coordinates(ring)[:-1] for ring in shapely.get_rings(poly)]
    xy = np.concatenate(rings)
    return xy, mapbox_earcut.triangulate_float64(xy, np.cumsum([len(r) for r in rings], dtype=np.uint32))


def merged(corners: np.ndarray, rgb: np.ndarray) -> tuple:
    """Corners that match are one vertex: which to keep, and which of those each one became."""
    key = np.rint(corners[:, :2] * GRID).astype(np.int64)
    key = (key[:, 0] * HASH_X) ^ (key[:, 1] * HASH_Y) ^ (np.rint(corners[:, 2] * 10).astype(np.int64) * 0x100000001B3)
    key ^= np.rint(rgb @ [1, 1 << 8, 1 << 16]).astype(np.int64) * 0x1000193
    return np.unique(key, return_index=True, return_inverse=True)[1:]


def tops(polys: np.ndarray, height: np.ndarray, rgb: np.ndarray) -> tuple:
    """Each polygon's top, as triangles."""
    positions, colours, triangles, start = [], [], [], 0
    for poly, z, c in zip(polys, height, rgb):
        xy, found = earcut(poly)
        triangles.append(found + start)
        positions.append(np.column_stack([xy, np.full(len(xy), z)]))
        colours.append(np.tile(c, (len(xy), 1)))
        start += len(xy)
    return np.concatenate(positions), np.concatenate(colours), np.concatenate(triangles)


def walls(polys: np.ndarray, height: np.ndarray, reach: float | None = None) -> tuple:
    """The edges of areas as walls: both ends' tops and bottoms, and the polygon each belongs to.

    height is for each corner of the rings in turn. An edge two areas share gets one wall, just the step between them,
    and none where they meet level. Any other edge is a chart's: it reaches down past whatever may lie beyond, and so
    can't stand above a neighbouring chart's floor and draw the chart's edge, or by reach if that's given."""
    rings, poly_of_ring = shapely.get_rings(polys, return_index=True)
    xy, ring_of = shapely.get_coordinates(rings, return_index=True)
    same_ring = ring_of[:-1] == ring_of[1:]
    a, b = xy[:-1][same_ring], xy[1:][same_ring]
    owner = poly_of_ring[ring_of[:-1][same_ring]]
    za, zb = height[:-1][same_ring], height[1:][same_ring]
    # the same number from either end of an edge, so that both areas beside it agree
    ends = np.rint(np.concatenate([a, b]) * GRID).astype(np.int64)
    ends = (ends[:, 0] * HASH_X) ^ (ends[:, 1] * HASH_Y)
    edge = ends[: len(a)] + ends[len(a) :]
    _, inverse, counts = np.unique(edge, return_inverse=True, return_counts=True)
    shared = np.flatnonzero(counts[inverse] == 2)
    shared = shared[np.argsort(edge[shared], kind="stable")]
    one, other = shared[::2], shared[1::2]
    # the two areas run round their shared edge in opposite ways, as a rule
    same_way = (a[one] == a[other]).all(axis=1)
    other_a, other_b = np.where(same_way, za[other], zb[other]), np.where(same_way, zb[other], za[other])
    top_a, bottom_a = np.maximum(za[one], other_a), np.minimum(za[one], other_a)
    top_b, bottom_b = np.maximum(zb[one], other_b), np.minimum(zb[one], other_b)
    # (however small: you can see under the far side of a step with no wall, right through to the background)
    step = np.maximum(top_a - bottom_a, top_b - bottom_b) > 0
    swap = za[one] + zb[one] < other_a + other_b
    upper = np.where(swap, other, one)[step]
    lone = np.flatnonzero(counts[inverse] != 2)
    drop = (2 * np.abs(np.stack([za, zb])[:, lone]) + SKIRT) if reach is None else np.full((2, len(lone)), reach)
    which = np.concatenate([one[step], lone])
    return (
        a[which],
        b[which],
        np.concatenate([top_a[step], za[lone]]),
        np.concatenate([top_b[step], zb[lone]]),
        np.concatenate([bottom_a[step], za[lone] - drop[0]]),
        np.concatenate([bottom_b[step], zb[lone] - drop[1]]),
        np.concatenate([owner[upper], owner[lone]]),
    )


def wall_mesh(wall: tuple, rgb: np.ndarray | None = None) -> tuple:
    """Walls as triangles. With no rgb they're water's, coloured by depth just like the seabed, so that the little step
    where two charts meet doesn't show."""
    a, b, top_a, top_b, bottom_a, bottom_b = wall
    corners = np.concatenate([
        np.column_stack([a, top_a]),
        np.column_stack([b, top_b]),
        np.column_stack([a, bottom_a]),
        np.column_stack([b, bottom_b]),
    ])
    if rgb is None:
        rgb4 = colour(-corners[:, 2])
    else:
        d = b - a
        light = np.abs(d[:, 1] * 0.6 - d[:, 0] * 0.8) / np.maximum(np.hypot(*d.T), 1e-12)  # lit by which way they face
        rgb4 = np.tile(rgb * (np.round((0.5 + 0.4 * light) * 4) / 4)[:, None], (4, 1))  # in steps, to share corners
    first, inverse = merged(corners, rgb4)
    quads = inverse.reshape(4, len(a)).T
    return corners[first], rgb4[first], quads[:, [0, 1, 2, 1, 3, 2]].ravel()


def pack(name: str, scale: int, bounds: list, meshes: dict, centred: bool = True) -> bytes:
    west, south, east, north = bounds or [0, 0, 0, 0]
    # offsets from the middle keep small things precise; anything big bends if it's drawn that way, and has an origin of 0
    origin = [round((west + east) / 2, 3), round((south + north) / 2, 3)] if centred else None
    head = {"name": name, "scale": scale, "bounds": bounds, "origin": origin, "meshes": {}}
    body = []
    for key, (positions, colours, triangles) in meshes.items():
        head["meshes"][key] = [len(positions), len(triangles)]
        body.append((positions - [*(origin or (0, 0)), 0]).astype("<f4").tobytes())
        body.append(np.column_stack([colours, np.full(len(colours), 255)]).round().astype(np.uint8).tobytes())
        body.append(np.asarray(triangles).astype("<u4").tobytes())
    header = json.dumps(head, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    return struct.pack("<I", len(header)) + header + b"".join(body)


def compile_cell(path: Path, hole: shapely.Geometry | None = None) -> bytes:
    name, scale, cell = read_areas(path, hole)
    empty = (np.empty((0, 3)), np.empty((0, 3)), np.empty(0))
    if cell.empty:
        return pack(name, scale, None, {k: empty for k in ("water", "land", "waterWalls", "landWalls")})
    polys, of_area = shapely.get_parts(cell.geometry.to_numpy(), return_index=True)
    depth = cell.depth.to_numpy(dtype=float)[of_area]
    low, high = cell.low.to_numpy(dtype=float)[of_area], cell.high.to_numpy(dtype=float)[of_area]
    dredged = cell.dredged.eq(True).to_numpy()[of_area]
    is_land = np.isnan(depth)
    bounds = cell.total_bounds.tolist()
    meshes = {"water": empty, "land": empty}
    if is_land.any():
        meshes["land"] = tops(polys[is_land], np.full(is_land.sum(), float(LAND_HEIGHT)), colour(depth[is_land]))
    water = ~is_land
    # every corner of every ring, in order: land stands at its height, and water's come from its edges
    rings, poly_of_ring = shapely.get_rings(polys, return_index=True)
    xy, ring_of = shapely.get_coordinates(rings, return_index=True)
    corner_owner = poly_of_ring[ring_of]
    height = np.full(len(xy), float(LAND_HEIGHT))
    if water.any():
        args = polys[water], low[water], high[water], dredged[water]
        unique, corners, surface = edge_depths(*args, polys[is_land], read_survey(path), bounds)
        meshes["water"] = seabed(*args, unique, corners, surface)
        in_water = water[corner_owner]
        place = np.searchsorted(unique, point_keys(xy[in_water])).clip(0, len(unique) - 1)
        height[in_water] = -np.where(dredged[corner_owner][in_water], low[corner_owner][in_water], corners[place])
    *wall, owner = walls(polys, height)
    for key, these, rgb in (("waterWalls", ~is_land[owner], None), ("landWalls", is_land[owner], LAND_RGB)):
        meshes[key] = wall_mesh([part[these] for part in wall], rgb) if these.any() else empty
    return pack(name, scale, bounds, meshes, centred=max(bounds[2] - bounds[0], bounds[3] - bounds[1]) <= WIDE)


def save(data: bytes, out: Path) -> None:
    """Writes to the cache. The whole file appears at once, or none of it."""
    out.parent.mkdir(exist_ok=True)
    fresh = out.with_suffix(f".{os.getpid()}")
    fresh.write_bytes(gzip.compress(data, 6))
    fresh.replace(out)


def compile_file(path: Path, hole_wkb: bytes | None, out: Path) -> None:
    try:
        data = compile_cell(path, shapely.from_wkb(hole_wkb) if hole_wkb else None)
    except NoAreas:
        data = pack(path.stem, 0, None, {})
    save(data, out)


land_loaded = {}  # source file: its polygons and their index


def load_polygons(path: Path) -> tuple:
    if path not in land_loaded:
        polys = shapely.get_parts(shapely.make_valid(pyogrio.read_dataframe(path, columns=[]).geometry.to_numpy()))
        polys = polys[shapely.get_type_id(polys) == shapely.GeometryType.POLYGON]
        land_loaded[path] = polys, shapely.STRtree(polys)
    return land_loaded[path]


@functools.cache
def world_outline(land: Path) -> str:
    """The world's land, coarsely, as an SVG path on a Web Mercator square 360 wide, for the general map."""
    polys = load_polygons(land)[0]
    rings = shapely.get_exterior_ring(shapely.simplify(polys[shapely.area(polys) > 0.3], 0.15))
    paths = []
    for ring in rings:
        lon, lat = shapely.get_coordinates(ring).T
        x = lon + 180
        y = 180 - np.degrees(np.log(np.tan(np.pi / 4 + np.radians(np.clip(lat, -85, 85)) / 2)))
        paths.append("M" + "L".join(f"{a:.1f} {b:.1f}" for a, b in zip(x, y)) + "Z")
    return "".join(paths)


def only_polygons(shapes: np.ndarray) -> np.ndarray:
    parts = shapely.get_parts(shapes)
    parts = parts[shapely.get_type_id(parts) == shapely.GeometryType.POLYGON]
    return parts[~shapely.is_empty(parts)]


def segments(polys: np.ndarray) -> tuple:
    """Every edge of some polygons, as their two ends."""
    xy, ring_of = shapely.get_coordinates(shapely.get_rings(polys), return_index=True)
    same_ring = ring_of[:-1] == ring_of[1:]
    return xy[:-1][same_ring], xy[1:][same_ring]


def point_keys(xy: np.ndarray) -> np.ndarray:
    grid = np.rint(xy * GRID).astype(np.int64)
    return (grid[:, 0] * HASH_X) ^ (grid[:, 1] * HASH_Y)


def line_mesh(a: np.ndarray, b: np.ndarray) -> tuple:
    if not len(a):
        return np.empty((0, 3)), np.empty((0, 3)), np.empty(0)
    ends = np.empty((2 * len(a), 3))
    ends[::2, :2], ends[1::2, :2] = a, b
    ends[:, 2] = LAND_HEIGHT + 0.5
    return ends, np.tile(COAST_RGB, (len(ends), 1)), np.arange(len(ends))


def split_land(source: Path, folder: Path) -> None:
    """OpenStreetMap's land, in a file for each 10 degree square: read straight from its one file, an area takes half
    a minute. The pieces are at most a degree across, so few land in more than one."""
    folder.mkdir(parents=True, exist_ok=True)
    for start in range(0, pyogrio.read_info(source)["features"], SPLIT_BATCH):
        polys = pyogrio.read_dataframe(source, columns=[], skip_features=start, max_features=SPLIT_BATCH).geometry.to_numpy()
        files = {}
        for blob, (west, south, east, north) in zip(shapely.to_wkb(polys), shapely.bounds(polys)):
            for x in range(int(west // COAST_FILE), int(east // COAST_FILE) + 1):
                for y in range(int(south // COAST_FILE), int(north // COAST_FILE) + 1):
                    files.setdefault((x, y), []).append(struct.pack("<I", len(blob)) + blob)
        for (x, y), blobs in files.items():
            with open(folder / f"{x * COAST_FILE}_{y * COAST_FILE}.wkb", "ab") as file:
                file.write(b"".join(blobs))


def coast_in(folder: Path, bounds: tuple, tolerance: float) -> np.ndarray:
    """OpenStreetMap's land in an area, as one so that its pieces' seams don't show, simplified to suit."""
    west, south, east, north = bounds
    blobs = []
    for x in range(int(west // COAST_FILE), int(np.ceil(east / COAST_FILE))):
        for y in range(int(south // COAST_FILE), int(np.ceil(north / COAST_FILE))):
            path = folder / f"{x * COAST_FILE}_{y * COAST_FILE}.wkb"
            data = path.read_bytes() if path.exists() else b""
            at = 0
            while at < len(data):
                size = struct.unpack_from("<I", data, at)[0]
                blobs.append(data[at + 4 : at + 4 + size])
                at += 4 + size
    if not blobs:
        return np.empty(0, dtype=object)
    polys = shapely.from_wkb(blobs)
    polys = polys[shapely.STRtree(polys).query(shapely.box(*bounds), "intersects")]
    if not len(polys):
        return polys
    # simplified first, as joining them whole takes minutes, and without keeping every islet, which takes as long;
    # the grid closes the hairlines this leaves at their seams
    rough = only_polygons(shapely.make_valid(shapely.simplify(polys, tolerance, preserve_topology=False)))
    joined = shapely.get_parts(shapely.union_all(rough[shapely.area(rough) > tolerance**2], grid_size=tolerance))
    return only_polygons(shapely.make_valid(shapely.clip_by_rect(joined, *bounds)))


def compile_land(land: Path, lakes: Path, bounds: tuple, hole_wkb: bytes | None, out: Path, tolerance: float = 0) -> None:
    """The world's land in one tile: a slab with its coast outlined, less any lakes and where charts cover it. land is
    a file of polygons, or a folder of OpenStreetMap's from split_land.

    "coast" is the whole outline, for when the map is too far out for the charts' own coast to show it; "outline"
    leaves out what the charts cover, where the world's coast wouldn't match the charts'."""
    lake_polys, lake_tree = load_polygons(lakes)
    west, south, east, north = bounds
    area = shapely.box(*bounds)
    empty = (np.empty((0, 3)), np.empty((0, 3)), np.empty(0))
    if land.is_dir():
        whole = coast_in(land, bounds, tolerance)
    else:
        polys, tree = load_polygons(land)
        whole = only_polygons(shapely.make_valid(shapely.clip_by_rect(polys[tree.query(area, "intersects")], *bounds)))
    in_lakes = lake_polys[lake_tree.query(area, "intersects")]
    if len(in_lakes) and len(whole):
        whole = only_polygons(shapely.make_valid(shapely.difference(whole, shapely.union_all(in_lakes))))
    if not len(whole):
        return save(pack(out.stem, 0, list(bounds), {k: empty for k in ("land", "landWalls", "coast", "outline")}), out)
    world = east - west > 90
    if world:
        whole = only_polygons(shapely.simplify(whole, WORLD_SIMPLIFY))
    whole = shapely.transform(whole, lambda xy: xy.round(6))
    a, b = segments(whole)
    on_tile_edge = ((a[:, 0] == b[:, 0]) & np.isin(a[:, 0], [west, east])) | (
        (a[:, 1] == b[:, 1]) & np.isin(a[:, 1], [south, north])
    )
    a, b = a[~on_tile_edge], b[~on_tile_edge]
    coast = point_keys(np.concatenate([a, b]))
    left = whole
    if hole_wkb:
        hole = shapely.from_wkb(hole_wkb)
        touched = shapely.intersects(left, hole)
        cut = shapely.make_valid(shapely.difference(left[touched], hole))
        left = shapely.transform(only_polygons(np.concatenate([left[~touched], cut])), lambda xy: xy.round(6))
    meshes = {"land": empty, "landWalls": empty, "coast": line_mesh(a, b), "outline": empty}
    if len(left):
        height = np.full(len(left), float(LAND_HEIGHT))
        rgb = np.tile(LAND_RGB, (len(left), 1))
        meshes["land"] = tops(left, height, rgb)
        if not world:  # (too far out for walls or a closer outline to show)
            corners = np.full(shapely.get_num_coordinates(left).sum(), float(LAND_HEIGHT))
            *wall, owner = walls(left, corners, reach=LAND_HEIGHT)
            meshes["landWalls"] = wall_mesh(wall, rgb[owner])
            a2, b2 = segments(left)
            kept = np.isin(point_keys(a2), coast) & np.isin(point_keys(b2), coast)
            meshes["outline"] = line_mesh(a2[kept], b2[kept])
    save(pack(out.stem, 0, list(bounds), meshes, centred=False), out)


def gebco_heights(folder: Path, columns: np.ndarray, rows: np.ndarray) -> np.ndarray:
    """GEBCO's heights at these cells of its world grid, counted from its north-west corner. It comes in eight files."""
    out = np.empty((len(rows), len(columns)), dtype=np.int16)
    for across in np.unique(columns // SEA_PART):
        for down in np.unique(rows // SEA_PART):
            these_columns, these_rows = columns // SEA_PART == across, rows // SEA_PART == down
            x, y = columns[these_columns] % SEA_PART, rows[these_rows] % SEA_PART
            west, north = -180 + 90 * across, 90 - 90 * down
            name = f"gebco_2026_n{north:.1f}_s{north - 90:.1f}_w{west:.1f}_e{west + 90:.1f}_geotiff.tif"
            window = Window(x.min(), y.min(), np.ptp(x) + 1, np.ptp(y) + 1)
            with rasterio.open(folder / name) as source:
                block = source.read(1, window=window)
            out[np.ix_(these_rows, these_columns)] = block[np.ix_(y - y.min(), x - x.min())]
    return out


def compile_sea(folder: Path, bounds: tuple, out: Path) -> None:
    """A tile of the world's seabed. Its corners are cells of GEBCO's grid shared with the tiles around it, so they meet
    exactly. Land stays in, at the waterline: it lies under the world's land, and shows as shallows where a finer coast
    than GEBCO's opens water there, as in docks."""
    west, south, east, north = bounds
    step = round((east - west) * SEA_CELLS / SEA_GRID)
    steps = step * np.arange(SEA_GRID + 1)
    columns = (round((west + 180) * SEA_CELLS) + steps) % (360 * SEA_CELLS)
    rows = np.minimum(round((90 - north) * SEA_CELLS) + steps, 180 * SEA_CELLS - 1)
    heights = gebco_heights(folder, columns, rows).astype(float).ravel()
    corners = np.arange((SEA_GRID + 1) ** 2).reshape(SEA_GRID + 1, SEA_GRID + 1)
    a, b, c, d = corners[:-1, :-1], corners[:-1, 1:], corners[1:, :-1], corners[1:, 1:]
    triangles = np.stack([a, c, b, b, c, d], axis=-1).reshape(-1, 3)
    used, triangles = np.unique(triangles, return_inverse=True)
    lon, lat = np.meshgrid(np.linspace(west, east, SEA_GRID + 1), np.linspace(north, south, SEA_GRID + 1))
    positions = np.column_stack([lon.ravel()[used], lat.ravel()[used], np.minimum(heights[used], 0)])
    mesh = positions, colour(-positions[:, 2]), triangles.ravel()
    # (only the finest level needs offsets, for the zooms it shows at)
    save(pack(out.stem, 0, list(bounds), {"waterBase": mesh}, centred=east - west < 1), out)
