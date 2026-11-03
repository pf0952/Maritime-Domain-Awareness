"""Checks that a hull run into a quay is laid alongside it, clear, and that one already clear is left alone.

Run from the project folder: backend/.venv/Scripts/python backend/test_berths.py"""
import shapely

import berths

quay = shapely.box(-500, -500, 0, 500)  # land to the west of x = 0, water to the east

# 100 m by 20 m, its middle 5 m off the quay and heading a little east of north: half of it in the land
x, y, heading = berths.alongside(quay, 100, 20, 10)
assert heading in (0, 180) or abs(heading) < 1e-6 or abs(heading - 360) < 1e-6, heading
assert 10 + berths.GAP - 0.01 <= x <= 10 + berths.GAP + berths.STEP + 0.01, x
assert abs(y) < 1, y
assert not berths.hull(100, 20, heading, x, y).intersects(quay)

# heading the other way, it keeps that way, along the quay
assert abs(berths.alongside(quay, 100, 20, 185)[2] - 180) < 1e-6

assert berths.alongside(shapely.box(-500, -500, -50, 500), 100, 20, 0) is None, "clear of it: left alone"
assert berths.alongside(shapely.box(-500, -500, -50, 500), 100, 20, None) is None
# no heading, its middle in the land: laid along the quay
assert berths.alongside(quay, 100, 20, None)[0] > 10
print("ok")
