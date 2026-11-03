// AIS vessels from Open Waters: which tiles to read, their categories, and their hulls as shapes to draw and click
import { tileAt } from './geo'

export const VESSEL_FOUND_ZOOM = 13 // a vessel found by search is shown at this zoom
export const VESSELS_FOUND = 8 // listed at most, of those a search finds
export const AIS = 'https://ais.openwaters.io/v1/vessels' // free worldwide, no key: reads up to 120 a minute from one address
export const VESSEL_REFRESH = 60000 // ms: its tiles change every 10 s, but a whole world of them is 64 reads
const VESSEL_TILES = 64 // at most at once, or it takes a coarser zoom
const VESSEL_TILE_LOWEST = 3 // its tiles thin out ships at random below this, big ones too
const VESSEL_ALL_ZOOM = 8 // further out, tiles of ship types that run big only, or they're thinned to mostly small craft
const VESSEL_BIG_TYPES = '?type=60-89'
const VESSEL_MIN_LENGTH = [[4, 200], [6, 100], [8, 50], [10, 20]] // below this zoom, only vessels this long, in m
const VESSEL_LENGTH_PX = [7, 16] // true to scale, unless smaller on screen than this, from all the way out to the charts' zooms
const VESSEL_BEAM = 0.5 // of the above: a ship true to scale would be nothing from far out
const VESSEL_SLIM = 6 // length to beam, for a vessel that doesn't report its beam
const VESSEL_REACH = 12 // px: how near a click counts
export const VESSEL_DOT = 3 // px, for beacons, shore stations and gear: they have no heading or size to draw
export const AIDS = 'Aids and stations'
export const PLEASURE = 'Pleasure craft'
export const VESSEL_CATEGORIES = {
  Cargo: [34, 197, 94],
  Tanker: [239, 68, 68],
  Passenger: [59, 130, 246],
  Fishing: [249, 115, 22],
  'Tugs and service': [20, 184, 166],
  'High speed': [234, 179, 8],
  [PLEASURE]: [217, 70, 239],
  Other: [167, 139, 250],
  Unknown: [148, 163, 184],
  [AIDS]: [226, 232, 240],
}
const NAV_STATUS = [
  'Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught', 'Moored',
  'Aground', 'Engaged in fishing', 'Under way sailing',
]

export function vesselCategory({ kind, type }) {
  if (kind && kind !== 'vessel') return AIDS
  if (!type) return 'Unknown'
  if (type === 30) return 'Fishing'
  if (type === 36 || type === 37) return PLEASURE
  if ((type >= 31 && type <= 33) || (type >= 50 && type <= 59)) return 'Tugs and service'
  if (type >= 40 && type <= 49) return 'High speed'
  if (type >= 60 && type <= 69) return 'Passenger'
  if (type >= 70 && type <= 79) return 'Cargo'
  if (type >= 80 && type <= 89) return 'Tanker'
  return 'Other'
}

export const vesselLengthAt = (zoom) => VESSEL_MIN_LENGTH.find(([below]) => zoom < below)?.[1] ?? 0

// the tiles of the vessels in view, and the same filter as a query: the same answer means nothing to fetch
export function vesselTiles(m) {
  const bounds = m.getBounds() // (past 180 on later copies of the world; tile numbers come back round)
  for (let z = Math.max(Math.min(Math.floor(m.getZoom()), 14), VESSEL_TILE_LOWEST); ; z--) {
    const from = tileAt(bounds.getWest(), bounds.getNorth(), z)
    const to = tileAt(bounds.getEast(), bounds.getSouth(), z)
    const tiles = new Set()
    for (let across = Math.floor(from.x); across <= to.x && tiles.size <= VESSEL_TILES; across++) {
      for (let y = Math.max(Math.floor(from.y), 0); y <= Math.min(to.y, 2 ** z - 1); y++) {
        tiles.add(`${z}/${((across % 2 ** z) + 2 ** z) % 2 ** z}/${Math.floor(y)}`)
      }
    }
    if (tiles.size <= VESSEL_TILES || z === VESSEL_TILE_LOWEST) {
      return { tiles: [...tiles], query: m.getZoom() < VESSEL_ALL_ZOOM ? VESSEL_BIG_TYPES : '' }
    }
  }
}

// where to draw a vessel and how big (models.js draws it): true length and beam, unless too small on screen to see
export function vesselShape(vessel, zoom, level, middle) {
  // its position is its GPS aerial's, which can be well aft or off to one side: the hull's middle is from that
  const { to_bow: bow, to_stern: stern, to_port: port, to_starboard: starboard } = vessel
  const ahead = bow && stern ? (bow - stern) / 2 : 0
  const aside = port && starboard ? (starboard - port) / 2 : 0
  const turn = ((vessel.hdg ?? 0) * Math.PI) / 180
  const across = 111320 * Math.cos((vessel.lat * Math.PI) / 180)
  const lat = vessel.lat + (ahead * Math.cos(turn) - aside * Math.sin(turn)) / 111320
  const lng = vessel.lng + (ahead * Math.sin(turn) + aside * Math.cos(turn)) / across + 360 * Math.round((middle - vessel.lng) / 360)
  const metresPerPixel = (40075016 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
  const [smallest, largest] = VESSEL_LENGTH_PX
  const least = (smallest + ((largest - smallest) * Math.min(zoom, VESSEL_ALL_ZOOM)) / VESSEL_ALL_ZOOM) * metresPerPixel
  const length = Math.max(vessel.length || 0, least)
  return {
    vessel,
    centre: [lng, lat],
    level,
    length,
    beam: Math.max(vessel.beam || (vessel.length || 0) / VESSEL_SLIM, least * VESSEL_BEAM),
    reach: Math.max(VESSEL_REACH, length / 2 / metresPerPixel),
  }
}

export function vesselAt(m, shapes, x, y) {
  let nearest = null
  let best = Infinity
  for (const shape of shapes) {
    const { x: px, y: py } = m.project(shape.centre)
    const away = Math.hypot(px - x, py - y)
    if (away < shape.reach && away < best) {
      nearest = shape.vessel
      best = away
    }
  }
  return nearest
}

export function aisValue(key, value) {
  if (key === 'nav_status') return NAV_STATUS[value] ?? `Status ${value}`
  if (key === 'sog') return `${value} kn`
  if (key === 'cog' || key === 'heading' || key === 'hdg') return `${value}°`
  if (['length', 'beam', 'draught', 'to_bow', 'to_stern', 'to_port', 'to_starboard'].includes(key)) return `${value} m`
  return String(value)
}
