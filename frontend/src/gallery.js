// Every model side by side, true to scale, drawn just as the map draws them: open /gallery.html under `npm run dev`
import { Deck, MapView } from '@deck.gl/core'
import { TextLayer } from '@deck.gl/layers'
import { modelLayer } from './meshes'
import { objectMeshes, vesselMesh } from './models'

const water = { ground: -0.5 } // (shallow, or posts down to the seabed would hide the rest)
const land = { ground: 0 }
const buoy = (name, shape, colours, more = {}) => [name, { kind: 'buoy', shape, colours, ...water, ...more }]
const topmark = (name, shape, colours) => [name, { kind: 'beacon', shape: 5, colours: [2], ...water }, { kind: 'topmark', shape, colours }]
const vessel = (label, type, length, beam, name = '') => [label, { type, length, beam, name }]
const GROUPS = {
  buoys: [
    buoy('Conical (nun)', 1, [3]), buoy('Can', 2, [4]), buoy('Spherical', 3, [3, 1], { colpat: 2 }),
    buoy('Pillar', 4, [3]), buoy('Pillar, banded', 4, [3, 4, 3]), buoy('Pillar, cardinal', 4, [2, 6]),
    buoy('Spar', 5, [6]), buoy('Barrel', 6, [6]), buoy('Super-buoy', 7, [6]), buoy('Unknown shape', 0, []),
    ['Mooring buoy', { kind: 'mooring', shape: 7, colours: [1], ...water }],
  ],
  beacons: [
    ['Daybeacon, red', { kind: 'beacon', shape: 1, colours: [3], ...water }],
    ['Daybeacon, green', { kind: 'beacon', shape: 1, colours: [4], ...water }],
    ['Withy', { kind: 'beacon', shape: 2, colours: [], ...water }],
    ['Beacon tower', { kind: 'beacon', shape: 3, colours: [1, 3], ...water }],
    ['Lattice beacon', { kind: 'beacon', shape: 4, colours: [3], ...water }],
    ['Pile beacon', { kind: 'beacon', shape: 5, colours: [4], ...water }],
    ['Cairn', { kind: 'beacon', shape: 6, colours: [], ...land }],
    ['Buoyant beacon', { kind: 'beacon', shape: 7, colours: [3], ...water }],
  ],
  topmarks: [
    topmark('Cone up', 1, [4]), topmark('Cone down', 2, [3]), topmark('Sphere', 3, [3]), topmark('2 spheres', 4, [2]),
    topmark('Cylinder', 5, [3]), topmark('Board', 6, [6]), topmark('X', 7, [6]), topmark('Cross', 8, [6]),
    topmark('Cube', 9, [6]), topmark('Points together (W)', 10, [2]), topmark('Bases together (E)', 11, [2]),
    topmark('Rhombus', 12, [6]), topmark('2 cones up (N)', 13, [2]), topmark('2 cones down (S)', 14, [2]),
  ],
  landmarks: [
    ['Lighthouse', { kind: 'landmark', shape: 17, colours: [], ...land }, { kind: 'light', colours: [1], ...land }],
    ['Lighthouse, banded', { kind: 'landmark', shape: 17, colours: [1, 3], colpat: 1, ...land }, { kind: 'light', colours: [1], ...land }],
    ['Tower', { kind: 'landmark', shape: 17, colours: [], ...land }],
    ['Chimney', { kind: 'landmark', shape: 3, colours: [], ...land }],
    ['Mast', { kind: 'landmark', shape: 7, colours: [], ...land }],
    ['Flagstaff', { kind: 'landmark', shape: 5, colours: [], ...land }],
    ['Flare stack', { kind: 'landmark', shape: 6, colours: [], ...land }],
    ['Monument', { kind: 'landmark', shape: 9, colours: [], ...land }],
    ['Dome', { kind: 'landmark', shape: 15, colours: [], ...land }],
    ['Spire', { kind: 'landmark', shape: 20, colours: [], ...land }],
    ['Windmill', { kind: 'landmark', shape: 18, colours: [], ...land }],
    ['Wind turbine', { kind: 'landmark', shape: 19, colours: [], ...land }],
    ['Radar, dish', { kind: 'landmark', shape: 16, colours: [], ...land }],
    ['Cairn, boulder', { kind: 'landmark', shape: 1, colours: [], ...land }],
  ],
  structures: [
    ['Light vessel', { kind: 'lightship', colours: [3], ...water }],
    ['Light float', { kind: 'lightfloat', colours: [3], ...water }],
    ['Platform', { kind: 'platform', colours: [], ...water }],
    ['Tank', { kind: 'tank', shape: 2, colours: [], ...land }],
    ['Silo', { kind: 'tank', shape: 1, colours: [], ...land }],
    ['Grain elevator', { kind: 'tank', shape: 3, colours: [], ...land }],
    ['Water tower', { kind: 'tank', shape: 4, colours: [], ...land }],
    ['Crane', { kind: 'crane', colours: [], ...land }],
    ['Dolphin', { kind: 'mooring', shape: 1, colours: [], ...water }],
    ['Bollard', { kind: 'mooring', shape: 3, colours: [], ...land }],
    ['Pile', { kind: 'pile', colours: [], ...water }],
    ['Wreck, hull showing', { kind: 'wreck', shape: 4, watlev: 2, colours: [], ...water }],
    ['Wreck, mast showing', { kind: 'wreck', shape: 5, watlev: 3, colours: [], ...water }],
    ['Rock, awash', { kind: 'rock', watlev: 5, colours: [], ...water }],
    ['Obstruction, dries', { kind: 'obstruction', watlev: 4, colours: [], ...water }],
  ],
  ships: [
    vessel('Cargo', 70, 190, 32), vessel('Tanker', 80, 250, 44), vessel('Passenger', 60, 290, 36),
    vessel('Ferry', 60, 90, 18), vessel('Dredger', 33, 90, 18), vessel('Military', 35, 150, 18), vessel('Other / unknown', 0, 60, 12),
  ],
  offshore: [
    vessel('Supply vessel', 90, 90, 20, 'NORMAND SIGMA'), vessel('Drillship', 90, 228, 42, 'VALARIS DS-12'),
    vessel('Semi-submersible rig', 99, 120, 77, 'TRANSOCEAN BARENTS'), vessel('Jack-up rig', 90, 113, 94, 'TRANSOCEAN ENCOURAGE'),
  ],
  craft: [
    vessel('Fishing', 30, 30, 8), vessel('Tug', 52, 30, 10), vessel('Pilot', 50, 18, 5), vessel('Search and rescue', 51, 16, 5),
    vessel('Law enforcement', 55, 25, 6), vessel('High speed', 40, 40, 11), vessel('Sailing', 36, 12, 4),
    vessel('Motor yacht', 37, 20, 5), vessel('Wing in ground', 20, 20, 8),
  ],
}
const METRES = 111320
const SUN = { sunLat: 0, sunLon: 0, lit: 0 }

function layers(name) {
  const items = GROUPS[name]
  const ships = ['ships', 'craft', 'offshore'].includes(name)
  const each = { landmarks: 30, structures: 45, buoys: 5, beacons: 6, topmarks: 3 }[name]
  const gap = ships ? 0.15 * Math.max(...items.map(([, v]) => v.length)) : 0.3 * each
  // small things in two rows, so they come out bigger
  const across = ships || items.length < 8 ? items.length : Math.ceil(items.length / 2)
  let x = 0
  const placed = items.map(([label, first, ...more], i) => {
    const wide = ships ? first.length : each
    if (i % across === 0) x = 0
    const lng = (x + wide / 2) / METRES
    const lat = (-Math.floor(i / across) * 2.4 * each || 0) / METRES
    x += wide + gap
    return { label, lng, lat, things: [first, ...more].map((t) => ({ ...t, at: [lng, lat] })), ship: first }
  })
  const width = ships ? x : across * (each + gap)
  const rows = Math.ceil(items.length / across)
  let mesh
  if (ships) {
    const shapes = placed.map(({ lng, ship }) => ({ vessel: { ...ship, hdg: 90, mmsi: 0 }, centre: [lng, 0], length: ship.length, beam: ship.beam, level: 0 }))
    mesh = [modelLayer('ships', vesselMesh(shapes, null, 22), 0, SUN)]
  } else {
    const things = placed.flatMap((p) => p.things)
    mesh = [
      modelLayer('standing', objectMeshes(things, 22, 0, false), 0, SUN),
      modelLayer('afloat', objectMeshes(things, 22, 0, true), 0, SUN),
    ]
  }
  const labels = new TextLayer({
    id: 'labels',
    data: placed,
    getPosition: (p) => [p.lng, p.lat + (ships ? -3 * Math.max(...items.map(([, v]) => v.beam)) : -0.9 * each) / METRES],
    getText: (p) => p.label,
    getSize: 12,
    maxWidth: 8,
    wordBreak: 'break-word',
    getColor: [226, 232, 240],
    getAngle: 0,
    billboard: true,
  })
  return { layers: [...mesh, labels], width, placed, middle: ships ? 0 : (-(rows - 1) * 1.2 * each) / METRES }
}

// ?item=2 looks closely at the third of the group, from off its bow
const item = new URLSearchParams(location.search).get('item')
function camera({ width, placed, middle }) {
  const close = placed[item]
  if (!close) return { longitude: width / 2 / METRES, latitude: middle, zoom: Math.log2((40075016 * window.innerWidth * 0.85) / (512 * width)), pitch: 50, bearing: 0 }
  const size = close.ship.length ?? 30
  return { longitude: close.lng, latitude: close.lat ?? 0, zoom: Math.log2((40075016 * window.innerWidth * 0.6) / (512 * size)), pitch: 60, bearing: -35 }
}

const name = location.hash.slice(1) in GROUPS ? location.hash.slice(1) : 'buoys'
document.querySelector('nav').innerHTML = Object.keys(GROUPS)
  .map((g) => `<a href="#${g}" class="${g === name ? 'on' : ''}">${g}</a>`)
  .join('')
window.addEventListener('hashchange', () => location.reload())
const set = layers(name)
const drawn = set.layers
new Deck({
  parent: document.body,
  views: new MapView({ repeat: false }),
  initialViewState: { ...camera(set), maxZoom: 25 },
  controller: true,
  layers: drawn,
})
