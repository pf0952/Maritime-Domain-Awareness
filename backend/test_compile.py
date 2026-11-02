"""Compiler check, on real cells from enc/: backend/.venv/Scripts/python backend/test_compile.py"""
import json
import struct
from pathlib import Path

import numpy as np
import pyogrio
import shapely
from fastapi.testclient import TestClient

import charts
import main

client = TestClient(main.app)
cells = Path(__file__).parent.parent / "enc/ENC_ROOT"
alaska, harbour = cells / "US3AK1EX/US3AK1EX.000", cells / "US5BOSCD/US5BOSCD.000"
cell = alaska.read_bytes()


def upload(name: str, data: bytes):
    return client.post("/api/uploads", files={"file": (name, data)})


def unpack(data: bytes) -> dict:
    """A chart file, read the way the viewer reads it."""
    size = struct.unpack("<I", data[:4])[0]
    chart = json.loads(data[4 : 4 + size])
    at = 4 + size
    for key, (vertices, indices) in chart["meshes"].items():
        positions = np.frombuffer(data, "<f4", vertices * 3, at).reshape(-1, 3)
        colours = np.frombuffer(data, np.uint8, vertices * 4, at + vertices * 12).reshape(-1, 4)
        triangles = np.frombuffer(data, "<u4", indices, at + vertices * 16)
        at += vertices * 16 + indices * 4
        chart["meshes"][key] = positions, colours, triangles
    assert at == len(data)
    return chart


chart = unpack(charts.compile_cell(alaska))
assert (chart["name"], chart["scale"]) == ("US3AK1EX", 180000)
west, south, east, north = chart["bounds"]
assert -180 <= west < east <= 180 and -90 <= south < north <= 90
for positions, colours, triangles in chart["meshes"].values():
    assert len(positions) and len(triangles) % 3 == 0 and triangles.max() < len(positions)
    assert (colours[:, 3] == 255).all()
    assert (np.abs(positions[:, :2] + chart["origin"] - [(west + east) / 2, (south + north) / 2]) < 5).all()

water, land = chart["meshes"]["water"][0], chart["meshes"]["land"][0]
assert (land[:, 2] == charts.LAND_HEIGHT).all()
assert water[:, 2].min() < -50 and water[:, 2].max() < charts.LAND_HEIGHT
# walls go down from the tops of areas: walls hung from the surface drew every chart's edge across the water
assert chart["meshes"]["waterWalls"][0][:, 2].max() <= water[:, 2].max() + 0.01

for path in (alaska, harbour):
    name, scale, areas = charts.read_areas(path)
    shapes = areas.geometry.to_numpy()
    assert set(areas.geom_type) <= {"Polygon", "MultiPolygon"} and shapely.is_valid(shapes).all()
    assert shapely.coverage_is_valid(shapes), "the coast came apart: areas no longer share their edges"

# an edge two areas share gets one wall, not one each
polys = shapely.get_parts(shapes)
height = np.arange(len(polys), dtype=float) * 10  # every step big enough for a wall
top = charts.walls(polys, height.repeat(shapely.get_num_coordinates(polys)))[2]
assert len(top) < 0.65 * int(shapely.get_num_coordinates(polys).sum())

# dredged channels are water, not holes
channels = pyogrio.read_dataframe(harbour, layer="DRGARE").representative_point()
water_shapes = shapes[areas.depth.notna().to_numpy()]
assert shapely.covers(shapely.union_all(water_shapes), channels.to_numpy()).all(), "a dredged channel is a hole"

# the seabed is one sloping surface: where it has no dredged channel, a point has one depth, so there's no crack to see
xy = np.rint(water[:, :2].astype(float) * 1e5).astype(np.int64)
places = np.unique(np.column_stack([xy, np.rint(water[:, 2] * 10)]), axis=0)
assert len(places) == len(np.unique(xy, axis=0)), "two areas disagree about a depth"
assert len(np.unique(np.round(water[:, 2]))) > 100, "the seabed is still in steps"
assert len(chart["meshes"]["waterWalls"][2]) < 0.01 * len(chart["meshes"]["water"][2]), "water that slopes needs no walls"

# and it says nothing the chart doesn't: inside an area, it stays in that area's depth band
in_harbour = unpack(charts.compile_cell(harbour))
points = in_harbour["meshes"]["water"][0]
at = points[:, :2].astype(float) + in_harbour["origin"]
bands = areas.dropna(subset="depth")
edges = charts.point_keys(shapely.get_coordinates(shapely.get_rings(shapely.get_parts(bands.geometry.to_numpy()))))
inside = ~np.isin(charts.point_keys(at), edges)
which, area = bands.sindex.query(shapely.points(at[inside]), predicate="within")
depths, low, high = -points[inside][which, 2], bands.low.to_numpy()[area], bands.high.to_numpy()[area]
assert len(which) > 500 and (depths >= low - 0.1).all() and (depths <= high + 0.1).all()

# a lone sounding bends the seabed around it, where a slack sheet would only make a pinprick at it
size = 64
known = np.zeros((size, size), bool)
known[[0, -1]] = known[:, [0, -1]] = True
values = np.zeros((size, size))
known[32, 32], values[32, 32] = True, 10
assert charts.smooth(values, known)[32, 20] > 2

# a wide bay with no soundings doesn't lie flat at the depth of its shore, to dry out all at once as the tide falls
surface = charts.Surface(np.array([[0.0, 0], [1, 0], [0, 1], [1, 1]]), np.zeros(4), [0, 0, 1, 1])
middle = np.array([[0.5, 0.5]])
assert abs(surface.depth_at(middle)[0]) < 0.1
surface.steer(middle, np.zeros(1), np.full(1, 5.0))
assert 2 < surface.depth_at(middle)[0] < 3
surface = charts.Surface(np.empty((0, 2)), np.empty(0), [0, 0, 1, 1])  # and an area with no depths at all can compile
surface.steer(middle, np.zeros(1), np.full(1, 5.0))
assert 2 < surface.depth_at(middle)[0] < 3

assert upload("notes.txt", cell).status_code == 415
assert upload("junk.000", b"not a chart").status_code == 422
main.MAX_BYTES = 10
assert upload("US3AK1EX.000", cell).status_code == 413
print("ok")
