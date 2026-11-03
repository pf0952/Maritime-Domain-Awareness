// Map and sky maths shared by the viewer's parts, and whether the CPU is doing the drawing
export const EMPTY = { type: 'FeatureCollection', features: [] }

// with hardware acceleration off in the browser, the CPU draws everything, and every point of every shape costs it
function drawnInSoftware() {
  const gl = document.createElement('canvas').getContext('webgl2')
  const info = gl?.getExtension('WEBGL_debug_renderer_info')
  return /basic render|swiftshader|llvmpipe|software/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '')
}
export const SOFTWARE = drawnInSoftware()

// Web Mercator: as a tile number at some zoom, and on the 360 wide square of the general map's outline
const mercator = (lat) => Math.asinh(Math.tan((lat * Math.PI) / 180))
export const tileAt = (lng, lat, zoom) => ({
  x: ((lng + 180) / 360) * 2 ** zoom,
  y: ((1 - mercator(lat) / Math.PI) / 2) * 2 ** zoom,
})
export const onOutline = ({ lng, lat }) => [lng + 180, 180 - (mercator(Math.max(-85, Math.min(85, lat))) * 180) / Math.PI]
export const tileToLat = (y, zoom) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI
export const tileToLng = (x, zoom) => (x / 2 ** zoom) * 360 - 180
export const fromOutline = (x, y) => ({
  lng: x - 180,
  lat: (Math.atan(Math.sinh(((180 - y) * Math.PI) / 180)) * 180) / Math.PI,
})

// From one point to the next along the rhumb line, the straight line on a Mercator chart that a course holds: nautical
// miles, and the true bearing in degrees
export function rhumb([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180
  const [p1, p2] = [lat1 * r, lat2 * r]
  const across = ((((lng2 - lng1) * r + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) // the short way round
  const stretched = mercator(lat2) - mercator(lat1)
  const q = Math.abs(stretched) > 1e-12 ? (p2 - p1) / stretched : Math.cos(p1) // (due east or west)
  return {
    nm: 3440.065 * Math.hypot(p2 - p1, q * across),
    bearing: ((Math.atan2(across, stretched) / r) % 360 + 360) % 360,
  }
}

export const overlaps = (w, s, e, n) => ([west, south, east, north]) => w < east && e > west && s < north && n > south

// where the sun is overhead at some moment: near enough to a tenth of a degree for centuries either side of 2000
export function sunAt(ms) {
  const radians = Math.PI / 180
  const days = ms / 86400000 - 10957.5
  const anomaly = (357.529 + 0.98560028 * days) * radians
  const mean = 280.459 + 0.98564736 * days
  const longitude = (mean + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * radians
  const tilt = (23.439 - 0.00000036 * days) * radians
  const rightAscension = Math.atan2(Math.cos(tilt) * Math.sin(longitude), Math.cos(longitude)) / radians
  const siderealDegrees = 280.46061837 + 360.98564736629 * days
  const lon = ((((rightAscension - siderealDegrees) % 360) + 540) % 360) - 180
  return { sunLat: Math.asin(Math.sin(tilt) * Math.sin(longitude)) / radians, sunLon: lon }
}

// 0 at night to 1 by day, through twilight: the same as the vertex shader's
export function daylightAt(lng, lat, { sunLat, sunLon }) {
  const r = Math.PI / 180
  const up = Math.sin(lat * r) * Math.sin(sunLat * r) + Math.cos(lat * r) * Math.cos(sunLat * r) * Math.cos((lng - sunLon) * r)
  const t = Math.min(1, Math.max(0, (up + 0.21) / 0.26))
  return t * t * (3 - 2 * t)
}

export function inRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
