// Simple models of what the charts mark, and of vessels, from a few solids: flat shaded, in muted real colours. Each set
// is built into one mesh, for meshes.js to draw like the charts, with the tide and the night on it too
import { LAND_TOP, metresPerPixel } from './geo'
import { VESSEL_CATEGORIES, vesselCategory } from './vessels'

export const OBJECTS_ZOOM = 14 // further out, a chart's objects would be a clutter of specks
const OBJECT_PX = 6 // tall on screen at the least: true to scale, a buoy would only show right in
const VESSEL_DETAIL_PX = 40 // long on screen: shorter, a vessel is its hull, deck in its type's colour, and superstructure
const SIDES = 12 // around a round thing: even stripes in twos, threes and fours
const METRES = 111320 // to a degree of latitude
const SUN = normalise([-0.4, 0.5, 0.77]) // from the north-west, high up, as maps are lit
// S-57's colours, as paint rather than signal
const COLOURS = {
  1: [228, 228, 222], 2: [40, 40, 42], 3: [172, 44, 40], 4: [40, 118, 66], 5: [46, 86, 148], 6: [218, 176, 48],
  7: [128, 130, 132], 8: [110, 82, 56], 9: [214, 138, 46], 10: [110, 74, 138], 11: [214, 110, 46], 12: [166, 54, 128],
  13: [214, 150, 158],
}
const LIGHT_COLOURS = { 1: [255, 240, 200], 3: [255, 70, 60], 4: [80, 255, 130], 6: [255, 214, 90], 11: [255, 160, 60] }
const WHITE = [226, 224, 218]
const STEEL = [128, 130, 134]
const WOOD = [112, 92, 70]
const STONE = [178, 172, 160]
const CONCRETE = [150, 148, 142]
const GLASS = [56, 66, 78]
const DARK = [52, 52, 56]
const DARK_RED = [118, 42, 38]
const RUST = [92, 72, 58]

function normalise(v) {
  const length = Math.hypot(...v)
  return v.map((c) => c / length)
}
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const plus = (a, b, k = 1) => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]]

// Triangles, each with its own corners, so every face is flat and lit as one. Corners are given in metres: x to
// starboard (east, unturned), y ahead (north) and up, from where the thing stands
class Parts {
  positions = []
  colors = []

  // where the next thing stands: degrees from the mesh's origin and its height, at its latitude; its scale, its heading
  // (degrees clockwise from north), and how far towards white to paint it
  place(dx, dy, z, lat, scale = 1, heading = 0, tint = 0) {
    const turn = (heading * Math.PI) / 180
    this.at = { dx, dy, z, scale, tint, across: 1 / (METRES * Math.cos((lat * Math.PI) / 180)), cos: Math.cos(turn), sin: Math.sin(turn) }
  }

  tri(a, b, c, rgb) {
    const { dx, dy, z, scale, tint, across, cos, sin } = this.at
    const corners = [a, b, c].map(([x, y, up]) => [scale * (x * cos + y * sin), scale * (y * cos - x * sin), scale * up])
    const normal = cross(minus(corners[1], corners[0]), minus(corners[2], corners[0]))
    const length = Math.hypot(...normal)
    if (!length) return // (where a cone comes to its point)
    const light = 0.45 + (0.55 * Math.max(0, normal[0] * SUN[0] + normal[1] * SUN[1] + normal[2] * SUN[2])) / length
    const colour = rgb.map((c) => Math.round(Math.min(255, (c + (255 - c) * tint) * light)))
    for (const [x, y, up] of corners) {
      this.positions.push(dx + x * across, dy + y / METRES, z + up)
      this.colors.push(...colour, 255)
    }
  }

  quad(a, b, c, d, rgb) {
    this.tri(a, b, c, rgb)
    this.tri(a, c, d, rgb)
  }

  // a ring of corners anticlockwise from above, stood up from z0 to z1, with its top
  prism(ring, z0, z1, side, top = side) {
    ring.forEach(([x, y], i) => {
      const [x1, y1] = ring[(i + 1) % ring.length]
      this.quad([x, y, z0], [x1, y1, z0], [x1, y1, z1], [x, y, z1], side)
    })
    if (top) for (let i = 1; i < ring.length - 1; i++) this.tri([...ring[0], z1], [...ring[i], z1], [...ring[i + 1], z1], top)
  }

  box(x, y, z, wide, long, high, rgb, top = rgb) {
    const [w, l] = [wide / 2, long / 2]
    this.prism([[x + w, y - l], [x + w, y + l], [x - w, y + l], [x - w, y - l]], z, z + high, rgb, top)
  }

  // turned about the upright, y ahead of the middle: a profile of [radius, height] from the bottom up, painted by look
  lathe(profile, look, sides = SIDES, y = 0) {
    const at = (r, z, i) => {
      const angle = (2 * Math.PI * (i + 0.5)) / sides
      return [r * Math.cos(angle), y + r * Math.sin(angle), z]
    }
    const paint = (z, i) => look.at(z, (2 * Math.PI * (i + 1)) / sides)
    const points = cut(profile, look.cuts)
    for (let k = 1; k < points.length; k++) {
      const [[r0, z0], [r1, z1]] = [points[k - 1], points[k]]
      for (let i = 0; i < sides; i++) this.quad(at(r0, z0, i), at(r0, z0, i + 1), at(r1, z1, i + 1), at(r1, z1, i), paint((z0 + z1) / 2, i))
    }
    const [r, z] = points.at(-1)
    if (r > 0) for (let i = 0; i < sides; i++) this.tri([0, y, z], at(r, z, i), at(r, z, i + 1), paint(z, i))
  }

  // a square beam from a to b, as thick as wide: masts, pipes and the like, left out when coarse
  bar(a, b, wide, rgb) {
    if (this.coarse) return
    const along = normalise(minus(b, a))
    const u = Math.abs(along[2]) < 0.9 ? normalise(cross(along, [0, 0, 1])) : [1, 0, 0]
    const v = cross(along, u)
    const off = [0, 1, 2, 3].map((k) => {
      const angle = Math.PI / 4 + (k * Math.PI) / 2
      return plus([0, 0, 0], plus(u.map((c) => c * Math.cos(angle)), v, Math.sin(angle)), wide / Math.SQRT2)
    })
    for (let k = 0; k < 4; k++) {
      const [o, o1] = [off[k], off[(k + 1) % 4]]
      this.quad(plus(a, o), plus(a, o1), plus(b, o1), plus(b, o), rgb)
    }
    this.quad(plus(b, off[0]), plus(b, off[1]), plus(b, off[2]), plus(b, off[3]), rgb)
    this.quad(plus(a, off[3]), plus(a, off[2]), plus(a, off[1]), plus(a, off[0]), rgb)
  }

  // a thin triangle seen from both sides
  sail(a, b, c, rgb) {
    this.tri(a, b, c, rgb)
    this.tri(a, c, b, rgb)
  }

  // a flat board standing across the north-south line, both faces: corners [x, up] anticlockwise from the south
  board(corners, rgb, thick = 0.08) {
    const front = corners.map(([x, up]) => [x, -thick, up])
    const back = corners.map(([x, up]) => [x, thick, up]).reverse()
    for (const face of [front, back]) for (let i = 1; i < face.length - 1; i++) this.tri(face[0], face[i], face[i + 1], rgb)
  }

  mesh() {
    if (!this.positions.length) return null
    const count = this.positions.length / 3
    return {
      attributes: {
        positions: { value: new Float32Array(this.positions), size: 3 },
        colors: { value: new Uint8Array(this.colors), size: 4, normalized: true },
      },
      indices: { value: Uint32Array.from({ length: count }, (_, i) => i), size: 1 },
    }
  }
}

// a profile with corners added at these heights, so that bands of colour have straight edges
function cut(profile, heights) {
  const out = [profile[0]]
  for (let k = 1; k < profile.length; k++) {
    const [[r0, z0], [r1, z1]] = [profile[k - 1], profile[k]]
    const between = heights.filter((z) => (z - z0) * (z - z1) < 0).sort((a, b) => (z1 > z0 ? a - b : b - a))
    for (const z of between) out.push([r0 + ((r1 - r0) * (z - z0)) / (z1 - z0), z])
    out.push(profile[k])
  }
  return out
}

// a chart's colours (COLOUR) in its pattern (COLPAT) over z0 to z1: bands from the top down, or stripes round
function paint(colours = [], pattern, z0, z1, fallback) {
  const found = colours.map((c) => COLOURS[c]).filter(Boolean)
  const n = found.length
  if (n < 2) return { at: () => found[0] ?? fallback, cuts: [] }
  if (pattern === 2 || pattern === 4) return { at: (z, angle) => found[Math.floor((angle / (2 * Math.PI)) * 2 * n - 0.01) % n], cuts: [] }
  const band = (z1 - z0) / n
  return {
    at: (z) => found[Math.min(n - 1, Math.max(0, Math.floor((z1 - z) / band)))],
    cuts: found.slice(1).map((_, i) => z1 - band * (i + 1)),
  }
}
const plain = (rgb) => ({ at: () => rgb, cuts: [] })

function sphere(r, middle, rows = 6) {
  return Array.from({ length: rows + 1 }, (_, i) => {
    const angle = (Math.PI * i) / rows
    return [r * Math.sin(angle), middle - r * Math.cos(angle)]
  })
}

// Each draws one kind of thing standing at 0, and gives the height a light or topmark on it stands at. below is how
// far down the ground is, for something standing in the water
const BUOYS = {
  1: [[0.75, -0.4], [0.9, 0], [0.9, 0.5], [0, 2.2]], // conical
  2: [[0.75, -0.4], [0.8, 0], [0.8, 1.7]], // can
  3: sphere(0.8, 0.7), // spherical
  4: [[1.1, -0.4], [1.1, 0.5], [0.45, 0.8], [0.35, 3.4], [0.5, 3.6]], // pillar
  5: [[0.22, -0.6], [0.18, 4]], // spar
  6: [[0.55, -0.3], [0.75, 0.25], [0.75, 0.6], [0.5, 1.1]], // barrel
  7: [[2.6, -0.6], [2.6, 0.9], [2.2, 1.2]], // super-buoy
}
BUOYS[8] = BUOYS[5] // ice buoy

function buoy(p, t) {
  const profile = BUOYS[t.shape] ?? BUOYS[4]
  const top = profile.at(-1)[1]
  p.lathe(profile, paint(t.colours, t.colpat, 0, top, STEEL))
  if (t.shape !== 7) return top
  p.bar([0, 0, top], [0, 0, 5], 0.25, STEEL)
  return 5
}

function beacon(p, t, below) {
  const look = (top) => paint(t.colours, t.colpat, 0, top, WOOD)
  switch (t.shape) {
    case 2: // withy
      p.bar([0, 0, below], [0, 0, 3], 0.1, WOOD)
      return 3
    case 3: // tower
      p.lathe([[1.4, below], [1.4, 0], [1, 7]], look(7))
      return 7
    case 4: // lattice
      p.lathe([[1.3, below], [1.3, 0], [0.5, 7]], look(7), 4)
      return 7
    case 5: // pile
      p.lathe([[0.35, below], [0.35, 4.5]], look(4.5), 8)
      return 4.5
    case 6: // cairn
      p.lathe([[1.6, 0], [0.2, 2.4]], plain(STONE), 7)
      return 2.4
    case 7: // buoyant
      p.lathe(BUOYS[5], look(4))
      return 4
    default: {
      // a post with a daybeacon's board: a triangle if red, as in the US, else square
      p.bar([0, 0, below], [0, 0, 4.4], 0.25, WOOD)
      const colour = COLOURS[t.colours?.[0]] ?? WHITE
      p.board(t.colours?.[0] === 3 ? [[-0.65, 3.2], [0.65, 3.2], [0, 4.4]] : [[-0.6, 3.2], [0.6, 3.2], [0.6, 4.4], [-0.6, 4.4]], colour)
      return 4.4
    }
  }
}

const cone = (z, up) => (up ? [[0.32, z], [0, z + 0.55]] : [[0, z], [0.32, z + 0.55]])
const ball = (z) => sphere(0.27, z + 0.27)
const TOPMARKS = {
  1: [cone(0.3, true)],
  2: [cone(0.3, false)],
  3: [ball(0.3)],
  4: [ball(0.3), ball(0.9)],
  5: [[[0.28, 0.3], [0.28, 0.85]]],
  10: [cone(0.3, true), cone(0.85, false)], // points together
  11: [cone(0.3, false), cone(0.85, true)], // bases together
  12: [[[0, 0.3], [0.38, 0.65], [0, 1]]],
  13: [cone(0.3, true), cone(0.95, true)],
  14: [cone(0.3, false), cone(0.95, false)],
}

function topmark(p, t) {
  const colour = (i = 0) => COLOURS[t.colours?.[i]] ?? COLOURS[t.colours?.[0]] ?? DARK
  p.bar([0, 0, 0], [0, 0, 0.3], 0.06, DARK)
  if (t.shape === 6) p.box(0, 0, 0.3, 0.6, 0.06, 0.6, colour())
  else if (t.shape === 9) p.box(0, 0, 0.3, 0.5, 0.5, 0.5, colour())
  else if (t.shape === 7) {
    p.bar([-0.3, 0, 0.3], [0.3, 0, 0.9], 0.1, colour())
    p.bar([0.3, 0, 0.3], [-0.3, 0, 0.9], 0.1, colour())
  } else if (t.shape === 8) {
    p.bar([0, 0, 0.3], [0, 0, 1], 0.1, colour())
    p.bar([-0.3, 0, 0.75], [0.3, 0, 0.75], 0.1, colour())
  } else {
    const pieces = TOPMARKS[t.shape] ?? TOPMARKS[3]
    pieces.forEach((profile, i) => p.lathe(profile, plain(colour(i)), t.shape === 12 ? 4 : 8))
  }
  return 1.4
}

function landmark(p, t, below, lit) {
  const h = t.height
  const look = (top, fallback) => paint(t.colours, t.colpat, 0, top, fallback)
  switch (t.shape) {
    case 1: case 21: // cairn, boulder
      p.lathe([[2, 0], [0.3, 2.5]], plain(STONE), 6)
      return 2.5
    case 3: // chimney
      p.lathe([[2.2, 0], [1.4, h ?? 35]], look(h ?? 35, [150, 92, 72]), 8)
      return h ?? 35
    case 4: case 16: // dish aerial, radar scanner
      p.bar([0, 0, 0], [0, 0, 8], 0.4, STEEL)
      p.box(0, 0, 8, 3, 0.6, 2.5, WHITE)
      return 10.5
    case 5: // flagstaff
      p.bar([0, 0, 0], [0, 0, h ?? 12], 0.15, WHITE)
      return h ?? 12
    case 6: // flare stack
      p.lathe([[1.2, 0], [0.9, h ?? 40]], look(h ?? 40, STEEL), 8)
      return h ?? 40
    case 7: // mast
      p.lathe([[1.4, 0], [0.2, h ?? 40]], look(h ?? 40, STEEL), 3)
      return h ?? 40
    case 9: case 10: case 12: case 13: case 14: // monument, column, obelisk, statue, cross
      p.lathe([[1.1, 0], [0.5, (h ?? 10) * 0.9], [0, h ?? 10]], look(h ?? 10, STONE), 4)
      return h ?? 10
    case 15: // dome
      p.lathe([[6, 0], [6, 5], ...sphere(6, 5, 8).slice(5)], look(11, [146, 156, 148]))
      return 11
    case 18: // windmill
      p.lathe([[3.2, 0], [2.2, 9]], plain(STONE), 8)
      p.lathe([[2.4, 9], [0, 11.5]], plain(DARK), 8)
      for (const angle of [45, 135, 225, 315]) {
        const a = (angle * Math.PI) / 180
        p.bar([0, -2.6, 9.5], [8 * Math.cos(a), -2.6, 9.5 + 8 * Math.sin(a)], 0.5, WOOD)
      }
      return 9.5
    case 19: { // wind turbine
      const tall = h ?? 80
      p.lathe([[2.2, 0], [1.4, tall]], plain(WHITE), 8)
      p.box(0, 0.8, tall - 1.3, 2.6, 7, 2.6, WHITE)
      for (const angle of [90, 210, 330]) {
        const a = (angle * Math.PI) / 180
        p.bar([0, -3, tall], [0.55 * tall * Math.cos(a), -3, tall + 0.55 * tall * Math.sin(a)], 1, WHITE)
      }
      return tall
    }
    case 20: // spire, minaret
      p.box(0, 0, 0, 6, 6, 12, STONE)
      p.lathe([[4.2, 12], [0, h ?? 30]], plain([90, 96, 104]), 4)
      return h ?? 30
    default: {
      // a tower, and with a light on it a lighthouse: a gallery, the lantern and its cap
      const tall = h ?? (lit ? 20 : 15)
      p.lathe([[3, 0], [2.2, tall]], look(tall, lit ? WHITE : STONE), lit ? SIDES : 8)
      if (!lit) return tall
      p.lathe([[3, tall], [3, tall + 0.4]], plain(DARK))
      p.lathe([[1.5, tall + 0.4], [1.5, tall + 2.4]], plain(GLASS))
      p.lathe([[1.7, tall + 2.4], [0, tall + 3.6]], plain(DARK_RED))
      return tall + 1.4
    }
  }
}

function lightship(p, t, small) {
  const [long, wide, mast] = small ? [12, 5, 7] : [26, 7, 12]
  const colour = COLOURS[t.colours?.[0]] ?? COLOURS[3]
  hull(p, long, wide, 0.12 * long, colour, colour, [150, 140, 130])
  if (!small) p.box(0, -0.15 * long, 0.12 * long, 0.6 * wide, 0.25 * long, 2.4, WHITE)
  p.bar([0, 0, 0], [0, 0, mast], 0.4, STEEL)
  p.lathe([[0.8, mast], [0.8, mast + 1.4], [0, mast + 1.9]], plain(GLASS), 8)
  return mast + 0.7
}

// wrecks, rocks and obstructions stand at their top: the depth over them, or how often the sea covers them
function hazardTop(t) {
  if (t.valsou !== undefined) return -t.valsou
  return { 1: 1.5, 2: 2.5, 3: -2, 4: 0.5, 5: 0, 6: 0, 7: 0 }[t.watlev] ?? -2
}

function wreck(p, t) {
  const long = Math.min(Math.max(t.size ?? 24, 12), 120)
  p.prism(hullRing(long, long / 5), -0.16 * long, 0, RUST, [78, 64, 54])
  if (t.shape === 5) p.bar([0, 0.1 * long, 0], [0, 0.1 * long, 6], 0.4, RUST)
  return 0
}

function mooring(p, t, below) {
  switch (t.shape) {
    case 3: // bollard
      p.lathe([[0.25, 0], [0.22, 0.7], [0.35, 0.9]], plain(DARK), 8)
      return 0.9
    case 5:
      return pile(p, t, below)
    case 7: // mooring buoy
      p.lathe([[1, -0.3], [1, 0.8]], paint(t.colours, t.colpat, 0, 0.8, WHITE))
      return 0.8
    default: // dolphin: piles bound together
      for (const angle of [0, 120, 240]) {
        const a = (angle * Math.PI) / 180
        p.bar([0.7 * Math.cos(a), 0.7 * Math.sin(a), below], [0.7 * Math.cos(a), 0.7 * Math.sin(a), 3.2], 0.5, WOOD)
      }
      p.box(0, 0, 3.2, 2.2, 2.2, 0.4, [80, 70, 58])
      return 3.6
  }
}

function pile(p, t, below) {
  p.lathe([[0.3, below], [0.28, 2.5]], plain(WOOD), 6)
  return 2.5
}

function platform(p, t, below) {
  for (const [x, y] of [[-5, -5], [5, -5], [5, 5], [-5, 5]]) p.bar([x, y, below], [x, y, 14], 0.9, STEEL)
  p.box(0, 0, 14, 14, 14, 2, [110, 110, 108])
  p.box(2, 2, 16, 7, 6, 4, [196, 190, 170])
  return 20
}

function tank(p, t) {
  const h = t.height
  switch (t.shape) {
    case 1: // silo
      p.lathe([[4, 0], [4, h ?? 25], [1, (h ?? 25) + 2]], plain([196, 194, 186]))
      return (h ?? 25) + 2
    case 3: // grain elevator
      p.box(0, 0, 0, 10, 24, h ?? 35, CONCRETE)
      return h ?? 35
    case 4: // water tower
      for (const [x, y] of [[-3, -3], [3, -3], [3, 3], [-3, 3]]) p.bar([x, y, 0], [0.4 * x, 0.4 * y, 20], 0.5, STEEL)
      p.lathe(sphere(5, 25, 8), plain([200, 200, 196]))
      return 30
    default: { // tank, as wide as its area on the chart
      const r = Math.min(Math.max((t.size ?? 24) / 2, 4), 40)
      const tall = h ?? Math.min(Math.max(0.9 * r, 8), 20)
      p.lathe([[r, 0], [r, tall], [0.6 * r, tall + 0.08 * r], [0, tall + 0.1 * r]], plain([204, 202, 194]), 16)
      return tall + 0.1 * r
    }
  }
}

function crane(p) {
  const colour = [190, 148, 56]
  p.bar([0, 0, 0], [0, 0, 32], 2.2, colour)
  p.bar([0, -10, 32], [0, 30, 32], 1.6, colour)
  p.box(0, -1, 27, 3.4, 4, 4, DARK)
  return 32
}

// a hull's deck outline, anticlockwise from its bow
function hullRing(long, wide, shoulder = 0.2, x = 0) {
  const [l, w] = [long / 2, wide / 2]
  return [[x, l], [x - w, shoulder * long], [x - w, -0.84 * l], [x - 0.8 * w, -l], [x + 0.8 * w, -l], [x + w, -0.84 * l], [x + w, shoulder * long]]
}

// sides, then a band at the top of them (a vessel's type colour), then the deck; a little of it under the water
function hull(p, long, wide, high, side, band, deck, shoulder = 0.2, x = 0) {
  const ring = hullRing(long, wide, shoulder, x)
  if (p.coarse) return p.prism(ring, 0, high, side, band)
  p.prism(ring, -0.25 * high, 0.82 * high, side, null)
  p.prism(ring, 0.82 * high, high, band, deck)
}

const BUILDERS = { buoy, beacon, landmark, wreck, mooring, pile, platform, tank, crane,
  lightship: (p, t) => lightship(p, t, false),
  lightfloat: (p, t) => lightship(p, t, true),
  rock: (p) => {
    p.lathe([[3.2, -3.5], [2.6, -1], [1.2, 0]], plain([96, 90, 80]), 5)
    return 0
  },
  obstruction: (p) => {
    p.box(0, 0, -1.6, 2.6, 2.6, 1.6, [104, 98, 88])
    return 0
  },
}
// tall about, to size each to OBJECT_PX before it's built
const NOMINAL = { buoy: 2.5, beacon: 4, landmark: 15, lightship: 12, lightfloat: 7, wreck: 4, rock: 3, obstruction: 2, mooring: 3, pile: 2.5, platform: 20, tank: 15, crane: 32 }
const FLOATS = new Set(['buoy', 'lightship', 'lightfloat', 'pontoon'])
const HAZARDS = new Set(['wreck', 'rock', 'obstruction'])
const floats = (t) => FLOATS.has(t.kind) || (t.kind === 'mooring' && t.shape === 7)
const spot = ([lng, lat]) => `${lng.toFixed(5)} ${lat.toFixed(5)}`
// a steady turn for things the chart gives no heading, so that wrecks and rocks don't all lie the same way
const turnOf = ([lng, lat]) => Math.abs(Math.round(lng * 1e5) * 7 + Math.round(lat * 1e5) * 13) % 360

const BRIDGE_DECK = 2.5 // m thick
const BRIDGE_UNCHARTED = LAND_TOP - 2 // m up, for a piece of bridge the chart gives no clearance for
// how high a bridge's underside is, above chart datum: US charts give clearances above Mean High Water
const bridgeUnder = (t, mhw) => (t.clearance != null ? mhw + t.clearance : BRIDGE_UNCHARTED)

// The piece of bridge under a point on screen, if any, tested against its deck where it's drawn, high above the water:
// project turns [lng, lat, metres up] into screen pixels
export function bridgeAt(sets, project, x, y, mhw, claimed = new Set()) {
  for (const { things } of sets) {
    for (const t of things) {
      if (t.kind !== 'bridge' || claimed.has(t)) continue
      const z = bridgeUnder(t, mhw) + BRIDGE_DECK
      const screen = []
      for (let i = 0; i < t.xy.length; i += 2) screen.push(project([t.xy[i], t.xy[i + 1], z]))
      for (let i = 0; i < t.triangles.length; i += 3) {
        const [a, b, c] = t.triangles.slice(i, i + 3).map((k) => screen[k])
        const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
        const [ab, bc, ca] = [side(a, b), side(b, c), side(c, a)]
        if ((ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0)) return t
      }
    }
  }
  return null
}

// an area of bridge or pontoon, from the chart's triangles: its top, and its edges stood up from z0
function slab(p, s, z0, z1, rgb, origin) {
  const [lng0, lat0] = s.xy
  p.place(lng0 - origin[0], lat0 - origin[1], 0, lat0)
  const across = METRES * Math.cos((lat0 * Math.PI) / 180)
  const at = (i, z) => [(s.xy[2 * i] - lng0) * across, (s.xy[2 * i + 1] - lat0) * METRES, z]
  for (let i = 0; i < s.triangles.length; i += 3) {
    const [a, b, c] = s.triangles.slice(i, i + 3).map((k) => at(k, z1))
    const turn = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (turn > 0) p.tri(a, b, c, rgb)
    else p.tri(a, c, b, rgb)
  }
  let start = 0
  for (const n of s.rings) {
    for (let i = 0; i < n; i++) {
      const j = start + ((i + 1) % n)
      p.quad(at(start + i, z0), at(j, z0), at(j, z1), at(start + i, z1), rgb)
    }
    start += n
  }
}

// A chart's objects, those afloat (which go up and down with the tide) or those that aren't, as one mesh, and its
// lights. A topmark or light goes on top of whatever stands at its spot
export function objectMeshes(things, zoom, level, afloat, mhw = 0, claimed = new Set()) {
  const p = new Parts()
  const first = things.find((t) => t.at)?.at ?? things[0]?.xy ?? [0, 0]
  const origin = [Math.round(first[0] * 100) / 100, Math.round(first[1] * 100) / 100]
  const lit = new Set(things.filter((t) => t.kind === 'light').map((t) => spot(t.at)))
  const afloatSpots = new Set(things.filter((t) => t.at && floats(t)).map((t) => spot(t.at)))
  const tops = new Map()
  const lights = []
  for (const t of things) {
    if (floats(t) !== afloat || t.kind === 'topmark' || t.kind === 'light') continue
    if (t.xy) {
      if (t.kind === 'bridge') {
        if (claimed.has(t)) continue // (drawn along the street map's line instead: bridgeDecks)
        // (true to its clearance, though its ends then dip into the land, which is only ever a slab this high)
        const under = bridgeUnder(t, mhw)
        slab(p, t, under, under + BRIDGE_DECK, CONCRETE, origin)
      } else slab(p, t, level - 0.5, level + 0.7, [128, 126, 118], origin)
      continue
    }
    const [lng, lat] = t.at
    const anchor = afloat ? level : HAZARDS.has(t.kind) ? hazardTop(t) : Math.max(t.ground, 0)
    const scale = Math.max(1, (OBJECT_PX * metresPerPixel(lat, zoom)) / NOMINAL[t.kind])
    const turn = HAZARDS.has(t.kind) || t.kind === 'landmark' ? turnOf(t.at) : 0
    p.place(lng - origin[0], lat - origin[1], anchor, lat, scale, turn)
    const top = BUILDERS[t.kind](p, t, Math.min(t.ground - anchor, 0) / scale, lit.has(spot(t.at)))
    tops.set(spot(t.at), { z: anchor + top * scale, scale })
  }
  for (const t of things) {
    if (t.kind !== 'topmark' && t.kind !== 'light') continue
    const here = spot(t.at)
    if (afloat ? !tops.has(here) : afloatSpots.has(here)) continue
    const [lng, lat] = t.at
    const scale = Math.max(1, (OBJECT_PX * metresPerPixel(lat, zoom)) / NOMINAL.beacon)
    const on = tops.get(here) ?? { z: Math.max(t.height ?? 0, Math.max(t.ground, 0) + 2), scale }
    if (t.kind === 'light') {
      lights.push({ position: [lng, lat, on.z + 0.3 * on.scale], color: LIGHT_COLOURS[t.colours?.[0]] ?? LIGHT_COLOURS[1] })
    } else {
      p.place(lng - origin[0], lat - origin[1], on.z, lat, on.scale)
      topmark(p, t)
    }
  }
  return { mesh: p.mesh(), origin, lights }
}

export const CURRENTS_ZOOM = 9 // further out, the stations would be a heap of arrows
const CURRENT_PX = [14, 6] // an arrow's length on screen: this much, and so much more a knot
const CURRENT_ALPHA = 190 // of 255: they sit lightly on the chart
const SLACK = 0.2 // knots: weaker than this, a station's at slack, and shows a ring rather than an arrow
const CURRENT_COLOURS = [[0, [150, 172, 192]], [1, [214, 190, 120]], [2, [226, 140, 64]], [3.5, [206, 72, 52]]] // by knots

function currentColour(knots) {
  const i = CURRENT_COLOURS.findIndex(([k]) => k > knots)
  if (i === -1) return CURRENT_COLOURS.at(-1)[1]
  if (i === 0) return CURRENT_COLOURS[0][1]
  const [[k0, a], [k1, b]] = [CURRENT_COLOURS[i - 1], CURRENT_COLOURS[i]]
  return a.map((c, j) => Math.round(c + ((b[j] - c) * (knots - k0)) / (k1 - k0)))
}

// Tidal currents at their stations (backend/currents.py) for one hour, as fine line arrows on the water pointing the
// way it flows, longer and warmer the stronger it runs, a dot at slack; and the labels to go with them
export function currentArrows(stations, hour, zoom, level) {
  const lines = []
  const dots = []
  const labels = []
  for (const s of stations) {
    const knots = s.knots[hour]
    if (knots === null || knots === undefined) continue
    const towards = knots >= 0 ? s.flood : s.ebb
    const strength = Math.abs(knots)
    const color = [...currentColour(strength), CURRENT_ALPHA]
    const slack = strength < SLACK || towards === null || towards === undefined
    labels.push({ position: [s.lng, s.lat], text: slack ? 'slack' : `${strength.toFixed(1)} kn`, name: s.name })
    if (slack) {
      dots.push({ position: [s.lng, s.lat, level + 0.3], color })
      continue
    }
    // in metres east and north of the station, then degrees: the shaft, centred on it, and the two sides of its head
    const long = (CURRENT_PX[0] + CURRENT_PX[1] * strength) * metresPerPixel(s.lat, zoom)
    const across = METRES * Math.cos((s.lat * Math.PI) / 180)
    const at = (ahead, side) => {
      const t = (towards * Math.PI) / 180
      return [s.lng + (ahead * Math.sin(t) + side * Math.cos(t)) / across, s.lat + (ahead * Math.cos(t) - side * Math.sin(t)) / METRES, level + 0.3]
    }
    const [tip, head] = [at(long / 2, 0), 0.3 * long]
    lines.push({ path: [at(-long / 2, 0), tip], color })
    lines.push({ path: [at(long / 2 - head, -0.6 * head), tip, at(long / 2 - head, 0.6 * head)], color })
  }
  return { lines, dots, labels }
}

// Every vessel as one mesh, each a model of its type: small on screen, without the bits too small to see, as a CPU
// drawing the whole of Rotterdam's traffic in full would fall to 10 frames a second
export function vesselMesh(shapes, pickedMmsi, zoom) {
  const p = new Parts()
  const [lng0, lat0] = shapes[0]?.centre ?? [0, 0]
  const origin = [Math.round(lng0), Math.round(lat0)]
  for (const { vessel, centre: [lng, lat], length, beam, level } of shapes) {
    p.place(lng - origin[0], lat - origin[1], level, lat, 1, vessel.hdg ?? 0, vessel.mmsi === pickedMmsi ? 0.6 : 0)
    p.coarse = length / metresPerPixel(lat, zoom) < VESSEL_DETAIL_PX
    const band = VESSEL_CATEGORIES[vesselCategory(vessel)]
    const offshore = offshoreKind(vessel)
    if (offshore) OFFSHORE[offshore](p, length, beam, band)
    else vesselModel(p, vessel.type ?? 0, length, beam, band)
  }
  return { mesh: p.mesh(), origin }
}

const TEAK = [150, 120, 90]
const DECK = [100, 94, 88]
const GREY = [112, 118, 124]

const ORANGE = [222, 108, 42]

// The small things that make a vessel read as one, left out when coarse
// a band of windows round a block, standing just proud of it
function windows(p, x, y, z, wide, long, high) {
  if (!p.coarse) p.box(x, y, z, 1.04 * wide, 1.04 * long, high, GLASS, null)
}

// a raised deck at the bow, and a mast on it
function forecastle(p, long, wide, high, side) {
  if (p.coarse) return
  p.prism([[0, 0.5 * long], [-0.25 * wide, 0.35 * long], [0.25 * wide, 0.35 * long]], high, high + 0.025 * long, side, DECK)
  p.bar([0, 0.4 * long, high + 0.025 * long], [0, 0.4 * long, high + 0.08 * long], 0.008 * long, STEEL)
}

// the house aft, for cargo ships, tankers and the rest: bridge windows and wings, a mast and the funnel
function house(p, long, wide, high) {
  const [y, tall] = [-0.4 * long, 0.16 * long]
  p.box(0, y, high, 0.86 * wide, 0.1 * long, tall, WHITE)
  windows(p, 0, y, high + 0.84 * tall, 0.86 * wide, 0.1 * long, 0.09 * tall)
  if (!p.coarse) p.box(0, y + 0.035 * long, high + 0.86 * tall, wide, 0.025 * long, 0.05 * tall, WHITE)
  p.bar([0, y + 0.02 * long, high + tall], [0, y + 0.02 * long, high + tall + 0.06 * long], 0.006 * long, STEEL)
  p.box(0, -0.45 * long, high + tall, 0.2 * wide, 0.04 * long, 0.05 * long, DARK)
}

// AIS has no type for offshore vessels: supply boats send cargo, tug, tanker or other, and rigs other. So they're
// told by size and name. ponytail: a guess, that can be wrong either way; widen the names as they turn up
const RIG_OWNERS = /^(TRANSOCEAN|VALARIS|NOBLE|SEADRILL|ENSCO|DEEPSEA|ODFJELL|COSL|DIAMOND|SAIPEM|STENA (DRILLMAX|FORTH|ICEMAX|CARRON|DON|SPEY))\b/
const SUPPLY_NAMES = /^(HOS|NORMAND|SKANDI|HAVILA|SIEM|BOURBON|OLYMPIC|REM|STRIL|EDDA|TROMS|VIKING|GSP|SEACOR|HARVEY|TIDEWATER|MAERSK (MASTER|MINDER|MARINER|MOVER|LAUNCHER|LEADER|LIMIT|LOGGER))\b/
export function offshoreKind({ name = '', type = 0, length = 0, beam = 0 }) {
  const wide = length > 0 ? beam / length : 0
  if (length >= 40 && wide >= 0.55) return wide >= 0.75 ? 'jackup' : 'semisub'
  // (a drilling firm's name is shared with tankers and bulk carriers, which send their own type)
  if (RIG_OWNERS.test(name) && (type >= 90 || !type) && length >= 150 && length <= 260) return 'drillship'
  // a supply boat's build: about four times as long as wide; river cruise ships share some names, and are much slimmer
  const build = wide >= 0.17 && wide <= 0.32
  const passenger = (type >= 60 && type <= 69) || type === 36 || type === 37
  if (SUPPLY_NAMES.test(name) && build && !passenger && length >= 40 && length <= 130) return 'supply'
  if (type >= 90 && build && length >= 50 && length <= 110) return 'supply'
  return null
}

const OFFSHORE_HULL = [52, 64, 86]
const DERRICK = [176, 168, 140]

// a derrick: a tall four-sided lattice, drawn solid
function derrick(p, high, tall, base, y = 0) {
  p.lathe([[base, high], [0.25 * base, high + tall]], plain(DERRICK), 4, y)
}

const OFFSHORE = {
  // platform supply vessel: the house right forward, a long open deck aft
  supply(p, long, wide, band) {
    const high = Math.max(0.09 * long, 0.8)
    hull(p, long, wide, high, OFFSHORE_HULL, band, [74, 70, 66], 0.3)
    forecastle(p, long, wide, high, OFFSHORE_HULL)
    p.box(0, 0.28 * long, high, 0.9 * wide, 0.2 * long, 0.12 * long, WHITE)
    p.box(0, 0.3 * long, high + 0.12 * long, 0.75 * wide, 0.12 * long, 0.06 * long, WHITE)
    windows(p, 0, 0.3 * long, high + 0.15 * long, 0.75 * wide, 0.12 * long, 0.025 * long)
    p.bar([0, 0.28 * long, high + 0.18 * long], [0, 0.28 * long, high + 0.3 * long], 0.012 * long, STEEL)
    if (!p.coarse) for (const side of [-1, 1]) p.box(side * 0.47 * wide, -0.15 * long, high, 0.03 * wide, 0.6 * long, 0.02 * long, [196, 150, 60])
  },
  // drillship: a ship with a derrick amidships and a helideck over the bow
  drillship(p, long, wide, band) {
    const high = Math.max(0.08 * long, 0.8)
    hull(p, long, wide, high, OFFSHORE_HULL, band, [96, 92, 88], 0.25)
    p.box(0, 0.36 * long, high, 0.9 * wide, 0.12 * long, 0.1 * long, WHITE)
    windows(p, 0, 0.36 * long, high + 0.07 * long, 0.9 * wide, 0.12 * long, 0.02 * long)
    if (!p.coarse) p.box(0, 0.4 * long, high + 0.1 * long, 0.7 * wide, 0.12 * long, 0.004 * long, [150, 156, 160])
    p.box(0, 0, high, 0.7 * wide, 0.12 * long, 0.04 * long, [150, 148, 142])
    derrick(p, high + 0.04 * long, 0.25 * long, 0.2 * wide)
    if (!p.coarse) for (let i = 0; i < 3; i++) p.box(0, -0.2 * long - i * 0.08 * long, high, 0.7 * wide, 0.06 * long, 0.025 * long, [120, 94, 76])
  },
  // semi-submersible rig: two pontoons, columns at the corners, a deck high up with its derrick
  semisub(p, long, wide, band) {
    const deck = 0.3 * long
    for (const side of [-1, 1]) {
      p.box(side * 0.36 * wide, 0, -0.1 * long, 0.2 * wide, long, 0.12 * long, OFFSHORE_HULL)
      for (const end of [-1, 1]) p.box(side * 0.36 * wide, end * 0.38 * long, 0.02 * long, 0.16 * wide, 0.16 * long, deck - 0.02 * long, [196, 160, 60])
    }
    p.box(0, 0, deck, 0.95 * wide, 0.95 * long, 0.08 * long, [150, 148, 142])
    p.box(0, 0, deck + 0.065 * long, 0.96 * wide, 0.96 * long, 0.015 * long, band, null)
    p.box(0, 0.32 * long, deck + 0.08 * long, 0.8 * wide, 0.2 * long, 0.08 * long, WHITE)
    windows(p, 0, 0.32 * long, deck + 0.13 * long, 0.8 * wide, 0.2 * long, 0.02 * long)
    derrick(p, deck + 0.08 * long, 0.35 * long, 0.12 * wide)
  },
  // jack-up rig: a hull stood on three legs, high above the sea, with its derrick out over the stern
  jackup(p, long, wide, band) {
    const deck = 0.25 * long
    for (const [x, y] of [[0, 0.42 * long], [-0.4 * wide, -0.35 * long], [0.4 * wide, -0.35 * long]]) {
      p.bar([x, y, -0.2 * long], [x, y, 1.1 * long], 0.06 * long, [186, 170, 120])
    }
    const ring = [[0, 0.5 * long], [-0.5 * wide, -0.1 * long], [-0.5 * wide, -0.5 * long], [0.5 * wide, -0.5 * long], [0.5 * wide, -0.1 * long]]
    p.prism(ring, deck, deck + 0.065 * long, OFFSHORE_HULL, null)
    p.prism(ring, deck + 0.065 * long, deck + 0.08 * long, band, [150, 148, 142])
    p.box(0, 0.15 * long, deck + 0.08 * long, 0.6 * wide, 0.2 * long, 0.08 * long, WHITE)
    windows(p, 0, 0.15 * long, deck + 0.13 * long, 0.6 * wide, 0.2 * long, 0.02 * long)
    p.box(0, -0.5 * long, deck + 0.08 * long, 0.25 * wide, 0.2 * long, 0.04 * long, [150, 148, 142])
    derrick(p, deck + 0.12 * long, 0.3 * long, 0.1 * wide, -0.52 * long)
  },
}

function vesselModel(p, type, long, wide, band) {
  const high = Math.max(0.065 * long, 0.8)
  if (type === 36) { // sailing: mainsail and jib
    hull(p, long, wide, high, WHITE, band, TEAK, 0.1)
    p.box(0, -0.05 * long, high, 0.5 * wide, 0.3 * long, 0.4 * high, WHITE)
    windows(p, 0, -0.05 * long, high + 0.2 * high, 0.5 * wide, 0.3 * long, 0.1 * high)
    const [mast, top, boom] = [0.12 * long, high + 1.3 * long, high + 0.15 * long]
    p.bar([0, mast, high], [0, mast, top], Math.max(0.15, 0.012 * long), STEEL)
    p.bar([0, mast, boom], [0, -0.3 * long, boom], Math.max(0.1, 0.01 * long), STEEL)
    if (!p.coarse) {
      p.sail([0, mast - 0.02 * long, boom + 0.02 * long], [0, mast - 0.02 * long, top - 0.05 * long], [0, -0.28 * long, boom + 0.02 * long], WHITE)
      p.sail([0, mast + 0.02 * long, high + 0.05 * long], [0, mast + 0.02 * long, top - 0.15 * long], [0, 0.48 * long, high + 0.05 * long], WHITE)
    }
  } else if (type === 37) { // motor yacht: a flybridge and radar arch
    hull(p, long, wide, high, WHITE, band, WHITE, 0.1)
    p.box(0, -0.08 * long, high, 0.75 * wide, 0.5 * long, 0.09 * long, WHITE)
    p.box(0, -0.02 * long, high + 0.09 * long, 0.62 * wide, 0.28 * long, 0.05 * long, GLASS)
    if (!p.coarse) p.box(0, -0.1 * long, high + 0.14 * long, 0.5 * wide, 0.16 * long, 0.015 * long, WHITE)
    for (const side of [-1, 1]) p.bar([side * 0.2 * wide, -0.14 * long, high + 0.155 * long], [0, -0.14 * long, high + 0.22 * long], 0.012 * long, WHITE)
  } else if (type >= 40 && type <= 49) { // high speed: a catamaran
    for (const side of [-1, 1]) hull(p, long, 0.24 * wide, high, WHITE, band, WHITE, 0.2, side * 0.38 * wide)
    p.box(0, -0.08 * long, 0.7 * high, wide, 0.8 * long, 0.9 * high, WHITE)
    windows(p, 0, -0.08 * long, 1.15 * high, wide, 0.8 * long, 0.25 * high)
    p.box(0, 0.12 * long, 1.6 * high, 0.8 * wide, 0.25 * long, 0.6 * high, GLASS)
    p.bar([0, 0.05 * long, 2.2 * high], [0, 0.05 * long, 2.2 * high + 0.08 * long], 0.01 * long, STEEL)
  } else if (type >= 60 && type <= 69) { // passenger: decks stacked up, rows of windows, lifeboats along the sides
    const tiers = long > 120 ? 4 : 2
    const tier = 0.03 * long
    const deck = 1.2 * high
    hull(p, long, wide, deck, WHITE, band, WHITE)
    forecastle(p, long, wide, deck, WHITE)
    for (let i = 0; i < tiers; i++) {
      const [w, l] = [(0.92 - 0.06 * i) * wide, (0.72 - 0.08 * i) * long]
      p.box(0, -0.06 * long, deck + i * tier, w, l, tier, i % 2 ? [204, 208, 212] : WHITE)
      windows(p, 0, -0.06 * long, deck + (i + 0.4) * tier, w, l, 0.3 * tier)
    }
    if (!p.coarse) {
      const boats = Math.max(2, Math.round(long / 40))
      for (let i = 0; i < boats; i++) {
        const y = -0.35 * long + ((i + 0.5) * 0.55 * long) / boats
        for (const side of [-1, 1]) p.box(side * 0.47 * wide, y, deck + tier, 0.06 * wide, 0.035 * long, 0.02 * long, ORANGE)
      }
    }
    p.box(0, -0.3 * long, deck + tiers * tier, 0.18 * wide, 0.08 * long, 0.05 * long, DARK)
  } else if (type >= 80 && type <= 89) { // tanker: pipes along a red deck, a hose crane
    hull(p, long, wide, high, [60, 62, 66], band, [132, 64, 54])
    forecastle(p, long, wide, high, [60, 62, 66])
    p.bar([0, -0.32 * long, high + 0.01 * long], [0, 0.42 * long, high + 0.01 * long], 0.05 * wide, [190, 190, 184])
    p.box(0, 0.02 * long, high, 0.6 * wide, 0.02 * long, 0.02 * long, [190, 190, 184])
    p.bar([0.25 * wide, 0.02 * long, high], [0.25 * wide, 0.02 * long, high + 0.06 * long], 0.01 * long, [196, 150, 60])
    p.bar([0.25 * wide, 0.02 * long, high + 0.06 * long], [-0.1 * wide, 0.06 * long, high + 0.05 * long], 0.006 * long, [196, 150, 60])
    house(p, long, wide, high)
  } else if (type >= 70 && type <= 79) { // cargo: hatch covers
    hull(p, long, wide, high, [66, 70, 76], band, DECK)
    forecastle(p, long, wide, high, [66, 70, 76])
    const hatches = p.coarse ? 1 : Math.min(Math.max(Math.round(long / 28), 2), 10)
    const each = (0.7 * long) / hatches
    for (let i = 0; i < hatches; i++) {
      p.box(0, -0.3 * long + (i + 0.5) * each, high, 0.78 * wide, 0.8 * each, 0.035 * long, i % 2 ? [96, 104, 112] : [120, 94, 76])
    }
    house(p, long, wide, high)
  } else if (type === 30) { // fishing: a wheelhouse forward, a gantry aft
    const deck = 1.3 * high
    hull(p, long, wide, deck, [44, 72, 104], band, DECK)
    p.box(0, 0.12 * long, deck, 0.6 * wide, 0.2 * long, 0.16 * long, WHITE)
    windows(p, 0, 0.12 * long, deck + 0.11 * long, 0.6 * wide, 0.2 * long, 0.04 * long)
    p.bar([0, 0.15 * long, deck + 0.16 * long], [0, 0.15 * long, deck + 0.3 * long], 0.02 * long, STEEL)
    for (const side of [-1, 1]) p.bar([side * 0.4 * wide, -0.42 * long, deck], [side * 0.4 * wide, -0.42 * long, 0.32 * long], 0.05 * wide, [196, 150, 60])
    p.bar([-0.4 * wide, -0.42 * long, 0.32 * long], [0.4 * wide, -0.42 * long, 0.32 * long], 0.05 * wide, [196, 150, 60])
  } else if (type === 31 || type === 32 || type === 52) { // tug: tall wheelhouse, winch aft
    const tall = 0.1 * long
    hull(p, long, wide, tall, [38, 38, 42], band, DECK, 0.1)
    p.box(0, 0.05 * long, tall, 0.7 * wide, 0.3 * long, 0.1 * long, [200, 198, 190])
    p.box(0, 0.1 * long, tall + 0.1 * long, 0.6 * wide, 0.16 * long, 0.08 * long, GLASS)
    if (!p.coarse) {
      p.box(0, 0.1 * long, tall + 0.18 * long, 0.64 * wide, 0.18 * long, 0.01 * long, [200, 198, 190])
      p.box(0, -0.3 * long, tall, 0.4 * wide, 0.1 * long, 0.05 * long, [150, 60, 48])
    }
    p.bar([0, 0.02 * long, tall + 0.18 * long], [0, 0.02 * long, tall + 0.3 * long], 0.04 * wide, STEEL)
  } else if (type === 33) { // dredger: a derrick forward
    hull(p, long, wide, high, [126, 64, 44], band, DECK)
    forecastle(p, long, wide, high, [126, 64, 44])
    p.bar([0, 0.1 * long, high], [0, 0.45 * long, high + 0.25 * long], 0.06 * wide, STEEL)
    house(p, long, wide, high)
  } else if (type === 35) { // military: grey and angular, a gun forward, a helideck aft
    const light = [124, 130, 136]
    hull(p, long, wide, high, GREY, band, GREY, 0.3)
    p.box(0, -0.05 * long, high, 0.7 * wide, 0.3 * long, 0.12 * long, light)
    p.box(0, 0, high + 0.12 * long, 0.45 * wide, 0.14 * long, 0.06 * long, light)
    windows(p, 0, 0, high + 0.15 * long, 0.45 * wide, 0.14 * long, 0.015 * long)
    p.bar([0, 0, high + 0.18 * long], [0, 0, high + 0.3 * long], 0.04 * wide, GREY)
    if (!p.coarse) p.bar([-0.12 * wide, 0, high + 0.27 * long], [0.12 * wide, 0, high + 0.27 * long], 0.008 * long, GREY)
    p.box(0, 0.3 * long, high, 0.16 * wide, 0.05 * long, 0.025 * long, light)
    p.bar([0, 0.32 * long, high + 0.015 * long], [0, 0.4 * long, high + 0.02 * long], 0.006 * long, GREY)
    if (!p.coarse) p.box(0, -0.38 * long, high, 0.8 * wide, 0.2 * long, 0.004 * long, [150, 156, 160])
  } else if (type >= 20 && type <= 29) { // wing in ground
    hull(p, long, wide, 0.6 * high, WHITE, band, WHITE)
    p.box(0, 0, 0.5 * high, 1.8 * wide, 0.25 * long, 0.15 * high, WHITE)
  } else if (type === 34 || (type >= 50 && type <= 59)) { // pilot, rescue, police and other workboats
    const side = { 51: ORANGE, 55: [44, 52, 70] }[type] ?? [40, 40, 44]
    const deck = 1.2 * high
    hull(p, long, wide, deck, side, band, DECK, 0.15)
    p.box(0, 0.05 * long, deck, 0.65 * wide, 0.35 * long, 0.14 * long, WHITE)
    windows(p, 0, 0.05 * long, deck + 0.09 * long, 0.65 * wide, 0.35 * long, 0.04 * long)
    p.bar([0, 0, deck + 0.14 * long], [0, 0, deck + 0.24 * long], 0.015 * long, STEEL)
  } else {
    hull(p, long, wide, high, [92, 98, 106], band, DECK)
    forecastle(p, long, wide, high, [92, 98, 106])
    house(p, long, wide, high)
  }
}

// Bridges as the street map has them: each road or railway marked as a bridge, near one the chart marks, becomes a deck
// along its real line. Over a charted span it stands at that span's clearance; off it, it slopes towards the land's top
// at a road's grade, so it meets the shore. Piers stand along it, but not under a span the chart gives a clearance for
const BRIDGE_NEAR = 60 // m: a road bridge this near a charted one is part of it
const BRIDGE_BESIDE = 25 // m: a charted piece this near a deck is drawn by it, not as a slab of its own
const BRIDGE_STEP = 10 // m between the heights worked out along a deck
const BRIDGE_GRADE = 0.05 // rise in a metre along an approach
const PIER_EVERY = 45 // m
const PIER_FOOT = -8 // m: below the water, as no depth is to hand here
const PARAPET = 1 // m high
const ROAD_WIDTH = { highway: 12, major_road: 10, minor_road: 7, path: 3, rail: 5 } // m, by the street map's kind
const DECK_TOP_ON_LAND = LAND_TOP + 0.3 // where a deck meets the land
const PIER_RGB = [126, 124, 118]

const ringsOf = (t) => {
  const rings = []
  let start = 0
  for (const n of t.rings) {
    const ring = []
    for (let i = start; i < start + n; i++) ring.push([t.xy[2 * i], t.xy[2 * i + 1]])
    rings.push(ring)
    start += n
  }
  return rings
}

function inside(rings, [x, y]) {
  let odd = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd
    }
  }
  return odd
}

// m from a point to a ring's edges, measured flat around the point
function metresTo(rings, [lng, lat]) {
  const across = METRES * Math.cos((lat * Math.PI) / 180)
  let best = Infinity
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = [(ring[i][0] - lng) * across, (ring[i][1] - lat) * METRES]
      const [bx, by] = [(ring[(i + 1) % ring.length][0] - lng) * across, (ring[(i + 1) % ring.length][1] - lat) * METRES]
      const [dx, dy] = [bx - ax, by - ay]
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return best
}

// a line split into points no further apart than BRIDGE_STEP, with how far along each is (m)
function densify(line) {
  const points = [line[0]]
  const along = [0]
  for (let i = 1; i < line.length; i++) {
    const [[x0, y0], [x1, y1]] = [line[i - 1], line[i]]
    const across = METRES * Math.cos((y0 * Math.PI) / 180)
    const length = Math.hypot((x1 - x0) * across, (y1 - y0) * METRES)
    const steps = Math.max(1, Math.ceil(length / BRIDGE_STEP))
    for (let k = 1; k <= steps; k++) {
      points.push([x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps])
      along.push(along.at(-1) + length / steps)
    }
  }
  return { points, along }
}

// lines: the street map's bridges, as { coords, kind, cut: whether each end is where its tile cut it short }; sets: the charts' objects. The decks' mesh, the pieces of
// charted bridge they stand for (whose slabs are then left out), and each stretch of deck's top, for clicks
export function bridgeDecks(lines, sets, mhw) {
  const pieces = sets.flatMap(({ things }) => things.filter((t) => t.kind === 'bridge')).map((t) => {
    const xs = t.xy.filter((_, i) => i % 2 === 0)
    const ys = t.xy.filter((_, i) => i % 2 === 1)
    const pad = BRIDGE_NEAR / METRES
    return { t, rings: ringsOf(t), box: [Math.min(...xs) - pad * 2, Math.min(...ys) - pad, Math.max(...xs) + pad * 2, Math.max(...ys) + pad] }
  })
  const p = new Parts()
  const claimed = new Set()
  const decks = []
  const first = lines[0]?.coords[0] ?? [0, 0]
  const origin = [Math.round(first[0] * 100) / 100, Math.round(first[1] * 100) / 100]
  for (const { coords, kind, cut = [false, false] } of lines) {
    const width = ROAD_WIDTH[kind]
    if (!width || coords.length < 2 || !pieces.length) continue
    const { points, along } = densify(coords)
    // the charted piece each point is over, or the nearest within reach
    const over = points.map((pt) => {
      let near = null
      let nearest = BRIDGE_NEAR
      for (const piece of pieces) {
        const [w, s, e, n] = piece.box
        if (pt[0] < w || pt[0] > e || pt[1] < s || pt[1] > n) continue
        if (inside(piece.rings, pt)) return { piece, within: true, away: 0 }
        const d = metresTo(piece.rings, pt)
        if (d < nearest) [near, nearest] = [piece, d]
      }
      return near && { piece: near, within: false, away: nearest }
    })
    if (!over.some(Boolean)) continue // a bridge over a road or a dry valley, not over the water
    for (const o of over) if (o && o.away < BRIDGE_BESIDE) claimed.add(o.piece.t)
    // the deck's top: set over a span with a clearance, and at the land's top at the bridge's real ends. Between two
    // such, it runs straight from one to the other; past the last, where the tile cut it short, it slopes at a road's
    // grade towards the land's top
    const set = over.map((o) => (o?.within && o.piece.t.clearance != null ? bridgeUnder(o.piece.t, mhw) + BRIDGE_DECK : null))
    const last = points.length - 1
    if (set[0] == null && !cut[0]) set[0] = DECK_TOP_ON_LAND
    if (set[last] == null && !cut[1]) set[last] = DECK_TOP_ON_LAND
    const towardsLand = (h, metres) => {
      const run = metres * BRIDGE_GRADE
      return h > DECK_TOP_ON_LAND ? Math.max(DECK_TOP_ON_LAND, h - run) : Math.min(DECK_TOP_ON_LAND, h + run)
    }
    const top = set.slice()
    let before = -1
    for (let i = 0; i <= last; i++) {
      if (set[i] != null) {
        before = i
        continue
      }
      let after = i + 1
      while (after <= last && set[after] == null) after++
      if (before >= 0 && after <= last) {
        const f = (along[i] - along[before]) / (along[after] - along[before])
        top[i] = set[before] + (set[after] - set[before]) * f
      } else if (before >= 0) top[i] = towardsLand(set[before], along[i] - along[before])
      else if (after <= last) top[i] = towardsLand(set[after], along[after] - along[i])
      else top[i] = DECK_TOP_ON_LAND
    }
    // which charted piece a click on each stretch tells of: the one it's over, or else the nearest
    const anyPiece = over.find(Boolean).piece.t
    const tells = over.map((o) => o?.piece.t ?? anyPiece)
    const [lng0, lat0] = points[0]
    const across = METRES * Math.cos((lat0 * Math.PI) / 180)
    const local = ([lng, lat]) => [(lng - lng0) * across, (lat - lat0) * METRES]
    const unlocal = ([x, y]) => [lng0 + x / across, lat0 + y / METRES]
    p.place(lng0 - origin[0], lat0 - origin[1], 0, lat0)
    let nextPier = PIER_EVERY / 2
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [local(points[i - 1]), local(points[i])]
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
      const length = Math.hypot(dx, dy) || 1
      const [sx, sy] = [(-dy / length) * (width / 2), (dx / length) * (width / 2)] // to the left
      const [za, zb] = [top[i - 1], top[i]]
      const [al, ar] = [[a[0] + sx, a[1] + sy], [a[0] - sx, a[1] - sy]]
      const [bl, br] = [[b[0] + sx, b[1] + sy], [b[0] - sx, b[1] - sy]]
      const [ua, ub] = [za - BRIDGE_DECK, zb - BRIDGE_DECK]
      p.quad([...ar, za], [...br, zb], [...bl, zb], [...al, za], CONCRETE) // top
      p.quad([...al, ua], [...bl, ub], [...br, ub], [...ar, ua], CONCRETE) // underside
      p.quad([...ar, ua], [...br, ub], [...br, zb + PARAPET], [...ar, za + PARAPET], CONCRETE) // right side, up to its parapet
      p.quad([...bl, ub], [...al, ua], [...al, za + PARAPET], [...bl, zb + PARAPET], CONCRETE) // left
      decks.push({ corners: [[...unlocal(ar), za], [...unlocal(br), zb], [...unlocal(bl), zb], [...unlocal(al), za]], t: tells[i] })
      // piers, but none in a span the chart gives a clearance for: that's the channel
      while (nextPier <= along[i]) {
        const f = (nextPier - along[i - 1]) / (along[i] - along[i - 1] || 1)
        const o = f < 0.5 ? over[i - 1] : over[i]
        const channel = o?.within && o.piece.t.charted != null
        const under = za + (zb - za) * f - BRIDGE_DECK
        if (!channel && under > PIER_FOOT + 1) {
          const [lng, lat] = unlocal([a[0] + dx * f, a[1] + dy * f])
          p.place(lng - origin[0], lat - origin[1], PIER_FOOT, lat, 1, (Math.atan2(dx, dy) * 180) / Math.PI)
          p.box(0, 0, 0, width * 0.7, 2.5, under - PIER_FOOT, PIER_RGB)
          p.place(lng0 - origin[0], lat0 - origin[1], 0, lat0)
        }
        nextPier += PIER_EVERY
      }
    }
  }
  return { mesh: p.mesh(), origin, claimed, decks }
}

// the stretch of deck under a point on screen, if any: the charted piece of bridge it tells of
export function deckAt(decks, project, x, y) {
  for (const { corners, t } of decks) {
    const s = corners.map(project)
    const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
    const turns = s.map((p, i) => side(p, s[(i + 1) % 4]))
    if (turns.every((v) => v >= 0) || turns.every((v) => v <= 0)) return t
  }
  return null
}
