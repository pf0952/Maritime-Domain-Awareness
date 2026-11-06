"""Self-checks for routes.py's planning and checking pieces that need no charts. python backend/test_routes.py"""
import math

import numpy as np

import routes

# a depth band is safe, straddles or is too shallow for the depth wanted
assert routes.depth_kind(12, 20, 11) == 1
assert routes.depth_kind(9.1, 18.2, 11) == 3
assert routes.depth_kind(5, 10, 11) == 2
assert routes.depth_kind(None, None, 11) == 2

# a great circle from New York to the Lizard is shorter than the rhumb line, and bends north
gc = routes.great_circle([-74.0, 40.5], [-5.2, 49.9])
assert max(lat for _, lat in gc) > 50
assert abs(routes.rhumb_nm([0, 0], [0, 1]) - 60) < 0.1  # (a degree of latitude, near enough)

# A* goes round a wall rather than through it, and the cut keeps legs out of blocked cells
cost = np.ones((20, 20))
cost[2:20, 10] = routes.BLOCKED_COST
path = routes.astar(cost, (19, 0), (19, 19))
assert path and all(cost[p] < routes.BLOCKED_COST for p in path)
assert min(r for r, _ in path) < 2  # over the top of the wall
assert not routes.clear_line(cost, (19, 0), (19, 19))
assert routes.clear_line(cost, (0, 0), (0, 19))

# a leg's band is about twice the cross-track distance wide
line, band = routes.corridor([-74.0, 40.0], [-73.9, 40.0], 0.1, False)
wide = (band.bounds[3] - band.bounds[1]) * 60
assert math.isclose(wide, 0.2, rel_tol=0.05), wide

print("ok")
