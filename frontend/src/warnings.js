// Nav warnings: their categories and ages for the filters, their shapes to draw, and which are under a click
import { inRing, metresPerPixel } from './geo'

export const WARNING_FILL = 28 // of 255: very see-through
export const WARNING_FILL_PICKED = 80
export const WARNING_EDGE = 170
const WARNING_HEIGHT = 24 // px: a box this tall stays visible from far out, where true scale would make it nothing
export const WARNING_DOT = 5 // px: the size of a warning with no size of its own, and it's bigger once picked
export const WARNING_DOT_PICKED = 8
const WARNING_DOT_BELOW = 14 // px: a box smaller than this on screen gets a dot as well, or it couldn't be seen or hit
const WARNING_REACH = 14 // px: how near a dot or a box's edge a click counts
export const WARNING_CATEGORIES = {
  Military: [239, 68, 68],
  'Search and rescue': [249, 115, 22],
  Ice: [125, 211, 252],
  Hazards: [250, 204, 21],
  Operations: [192, 132, 252],
  'Aids to navigation': [74, 222, 128],
  Other: [148, 163, 184],
}
export const WARNING_AGES = [
  ['Any time', 0],
  ['Last 7 days', 7],
  ['Last 30 days', 30],
  ['Last 90 days', 90],
  ['Last year', 365],
]
export const ROMAN = 'I II III IV V VI VII VIII IX X XI XII XIII XIV XV XVI XVII XVIII XIX XX'.split(' ')

// warnings as what to draw: an area is a box its true size on the map, and anything with no size of its own is a dot
export function warningShapes(warnings, zoom) {
  const perPixel = (lat) => metresPerPixel(lat, zoom)
  const boxes = []
  const dots = []
  for (const warning of warnings) {
    for (const { ring, point } of warning.shapes) {
      if (point) {
        dots.push({ warning, position: point })
        continue
      }
      const lons = ring.map(([lon]) => lon)
      const lats = ring.map(([, lat]) => lat)
      const west = Math.min(...lons)
      const east = Math.max(...lons)
      const south = Math.min(...lats)
      const north = Math.max(...lats)
      const scale = perPixel((south + north) / 2)
      boxes.push({ warning, ring, height: Math.max(150, WARNING_HEIGHT * scale) })
      const degreesPerPixel = (scale / 40075016) * 360
      if ((north - south) / degreesPerPixel < WARNING_DOT_BELOW && (east - west) / degreesPerPixel < WARNING_DOT_BELOW) {
        dots.push({ warning, position: [(west + east) / 2, (south + north) / 2] })
      }
    }
  }
  return { boxes, dots }
}

// the warnings under a point on the screen, the nearest and smallest first. Done here rather than by the graphics chip:
// it asks nothing of it, it can be generous, and it counts a box's top as well as its foot
export function warningsAt(m, { boxes, dots }, x, y) {
  const middle = m.getCenter().lng
  const onScreen = ([lng, lat]) => {
    const { x: px, y: py } = m.project([lng + 360 * Math.round((middle - lng) / 360), lat])
    return [px, py]
  }
  const rise = WARNING_HEIGHT * Math.sin((m.getPitch() * Math.PI) / 180)
  const hits = []
  for (const { warning, position } of dots) {
    const [px, py] = onScreen(position)
    const away = Math.hypot(px - x, py - y)
    if (away <= WARNING_REACH) hits.push({ warning, rank: away })
  }
  const nearby = [[0, 0], [WARNING_REACH / 2, 0], [-WARNING_REACH / 2, 0], [0, WARNING_REACH / 2], [0, -WARNING_REACH / 2]]
  for (const { warning, ring } of boxes) {
    const foot = ring.map(onScreen)
    const top = foot.map(([px, py]) => [px, py - rise])
    if (nearby.some(([dx, dy]) => inRing(x + dx, y + dy, foot) || inRing(x + dx, y + dy, top))) {
      const xs = foot.map(([px]) => px)
      hits.push({ warning, rank: WARNING_REACH + Math.max(...xs) - Math.min(...xs) })
    }
  }
  return [...new Set(hits.sort((a, b) => a.rank - b.rank).map((hit) => hit.warning))]
}

export function cutFeeds(feeds) {
  const areas = feeds.filter((f) => f.startsWith('navarea')).map((f) => `NAVAREA ${ROMAN[f.split('/')[1] - 1]}`)
  const coastal = feeds.length - areas.length
  return [...areas, ...(coastal ? [`${coastal} coastal ${coastal === 1 ? 'feed' : 'feeds'}`] : [])].join(' and ')
}
