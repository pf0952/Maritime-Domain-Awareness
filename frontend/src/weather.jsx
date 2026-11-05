// Wind and waves (backend/weather.py) as streaks moving over the map: a canvas of its own on top, so animating them
// never makes the map itself draw again, which would cost a CPU every frame
import { useEffect, useRef } from 'react'

const FPS = 30
const WIND_PER_PX = 2500 // px² of screen to each wind streak
const PX_PER_KNOT = 0.12 // a frame: a streak's speed on screen, whatever the zoom; 20 kn is 72 px a second
const LIFE = 90 // frames a streak lasts before starting again somewhere else
const FADE = 0.9 // of a trail left after each frame
// Wind is fine white streaks with trails; the sea, arcs with none, so the two can't be taken for each other. Waves
// the wind is raising are short, quick, bright and many; swell is long, slow, broad and few. Each crest is drawn
// longer and thicker the higher it is, up to full (m)
export const WIND_RGB = '241, 245, 249'
export const CRESTS = {
  waves: { height: 'sea', from: 'seaFrom', rgb: '103, 232, 249', alpha: 0.85, perPx: 5000, speed: 0.8, life: 60, full: 2.5, size: [5, 9], width: [1.5, 1.5], bow: 0.35 },
  swell: { height: 'swell', from: 'swellFrom', rgb: '196, 181, 253', alpha: 0.75, perPx: 11000, speed: 0.4, life: 140, full: 4, size: [14, 22], width: [2, 2.5], bow: 0.15 },
}

// the value of a field at a point, between those of the grid's four points around it that have one: the sea's have
// none over land, and a coast would otherwise blank the water beside it
export function weatherAt(weather, key, hour, lng, lat) {
  if (!weather) return null
  const { step, index } = weather
  const x = lng / step
  const y = lat / step
  const [x0, y0] = [Math.floor(x), Math.floor(y)]
  let [total, weight] = [0, 0]
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const value = index.get(`${y0 + dy} ${x0 + dx}`)?.[key][hour]
    if (value === null || value === undefined) continue
    const w = (dx ? x - x0 : 1 - (x - x0)) * (dy ? y - y0 : 1 - (y - y0))
    total += value * w
    weight += w
  }
  return weight > 0.05 ? total / weight : null
}

// a direction's own field: averaging degrees would send 350 and 10 round to 180
export function directionAt(weather, key, hour, lng, lat) {
  if (!weather) return null
  const { step, index } = weather
  const [x0, y0] = [Math.floor(lng / step), Math.floor(lat / step)]
  let [east, north, found] = [0, 0, 0]
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const from = index.get(`${y0 + dy} ${x0 + dx}`)?.[key][hour]
    if (from === null || from === undefined) continue
    const w = (dx ? lng / step - x0 : 1 - (lng / step - x0)) * (dy ? lat / step - y0 : 1 - (lat / step - y0))
    east += w * Math.sin((from * Math.PI) / 180)
    north += w * Math.cos((from * Math.PI) / 180)
    found++
  }
  return found ? ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360 : null
}

// the backend's points, looked up by where they sit on the grid
export function indexWeather(answer) {
  const index = new Map(answer.points.map((p) => [`${Math.round(p.lat / answer.step)} ${Math.round(p.lng / answer.step)}`, p]))
  return { ...answer, index }
}

// backend/weather.py's land mask, unpacked; and whether a point is on land by it (not where it doesn't reach)
export function unpackLand(answer) {
  return { ...answer, bits: Uint8Array.from(window.atob(answer.land), (c) => c.charCodeAt(0)) }
}
function onLand(land, { lng, lat }) {
  if (!land) return false
  const col = Math.floor(((lng - land.west) / (land.east - land.west)) * land.cols)
  const row = Math.floor(((land.north - lat) / (land.north - land.south)) * land.rows)
  if (col < 0 || row < 0 || col >= land.cols || row >= land.rows) return false
  const i = row * land.cols + col
  return ((land.bits[i >> 3] >> (7 - (i & 7))) & 1) === 1
}

// metres a degree east and north, at a latitude
const across = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)

export function WeatherCanvas({ map, weather, land, hour, wind, waves, swell }) {
  const canvas = useRef(null) // wind, with its trails
  const waveCanvas = useRef(null) // waves, drawn afresh each frame
  const now = useRef({ weather, land, hour, wind, waves, swell })
  now.current = { weather, land, hour, wind, waves, swell }

  useEffect(() => {
    if (!map || !(wind || waves || swell) || !weather) return
    const c = canvas.current
    const ctx = c.getContext('2d')
    const sea = waveCanvas.current.getContext('2d')
    let streaks = []
    let waveCrests = []
    let swellCrests = []
    let frame = null
    let last = 0

    const size = () => {
      for (const each of [c, waveCanvas.current]) {
        each.width = c.clientWidth
        each.height = c.clientHeight
      }
    }
    const somewhere = () => {
      const { lng, lat } = map.unproject([Math.random() * c.width, Math.random() * c.height])
      return { lng, lat, age: Math.floor(Math.random() * LIFE) }
    }
    // on a globe, what's round the back is still somewhere on screen: those are left out
    const seen = (p) => {
      if (map.getProjection().type !== 'globe') return true
      const { lng, lat } = map.getCenter()
      const r = Math.PI / 180
      return Math.sin(lat * r) * Math.sin(p.lat * r) + Math.cos(lat * r) * Math.cos(p.lat * r) * Math.cos((p.lng - lng) * r) > 0.1
    }
    const reset = () => {
      size()
      ctx.clearRect(0, 0, c.width, c.height)
      streaks = Array.from({ length: Math.round((c.width * c.height) / WIND_PER_PX) }, somewhere)
      waveCrests = Array.from({ length: Math.round((c.width * c.height) / CRESTS.waves.perPx) }, somewhere)
      swellCrests = Array.from({ length: Math.round((c.width * c.height) / CRESTS.swell.perPx) }, somewhere)
    }

    // a step of so many px on screen, towards a bearing, from a point
    const moved = (p, towards, px) => {
      const metres = px * (40075016 * Math.cos((p.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom())
      const t = (towards * Math.PI) / 180
      return { lng: p.lng + (metres * Math.sin(t)) / across(p.lat), lat: p.lat + (metres * Math.cos(t)) / 111320 }
    }

    const draw = (time) => {
      frame = requestAnimationFrame(draw)
      if (time - last < 1000 / FPS) return
      last = time
      const { weather: w, hour: h, wind: showWind, waves: showWaves, swell: showSwell } = now.current
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fillStyle = `rgba(0, 0, 0, ${FADE})`
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.globalCompositeOperation = 'source-over'
      if (showWind) {
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const s of streaks) {
          const knots = weatherAt(w, 'wind', h, s.lng, s.lat)
          const from = directionAt(w, 'windFrom', h, s.lng, s.lat)
          if (knots === null || from === null || ++s.age > LIFE || !seen(s)) {
            Object.assign(s, somewhere(), { age: 0 })
            continue
          }
          const next = moved(s, from + 180, Math.max(knots, 1) * PX_PER_KNOT)
          const a = map.project([s.lng, s.lat])
          const b = map.project([next.lng, next.lat])
          if (a.x < 0 || a.y < 0 || a.x > c.width || a.y > c.height) s.age = LIFE
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          Object.assign(s, next)
        }
        ctx.strokeStyle = `rgba(${WIND_RGB}, 0.65)`
        ctx.stroke()
      }
      // crests leave no trail, which would sweep out a block as they move broadside; each fades in and out over its
      // life, as one popping in or out of sight reads as flicker
      sea.clearRect(0, 0, c.width, c.height)
      if (showWaves) drawCrests(waveCrests, CRESTS.waves, w, h)
      if (showSwell) drawCrests(swellCrests, CRESTS.swell, w, h)
    }

    // each crest an arc across the way it travels, bowed forward like a breaking wave's
    const drawCrests = (crests, look, w, h) => {
      if (!now.current.land) return // (until it's known where the land is)
      for (const s of crests) {
        const high = weatherAt(w, look.height, h, s.lng, s.lat)
        const from = directionAt(w, look.from, h, s.lng, s.lat)
        if (high === null || from === null || ++s.age > look.life || !seen(s)) {
          Object.assign(s, somewhere(), { age: 0 })
          // calm seas show fewer crests: the rest sit out this life
          s.calm = high === null || Math.random() > 0.2 + high / look.full
          continue
        }
        Object.assign(s, moved(s, from + 180, look.speed))
        if (s.calm) continue
        const rough = Math.min(1, high / look.full)
        const half = look.size[0] + look.size[1] * rough
        const ends = [moved(s, from - 90, half), moved(s, from + 90, half)]
        const bow = moved(s, from + 180, half * look.bow)
        if ([s, ...ends].some((p) => onLand(now.current.land, p))) continue // the sea's values reach past the coast
        const [a, b, mid] = [...ends, bow].map((p) => map.project([p.lng, p.lat]))
        sea.strokeStyle = `rgba(${look.rgb}, ${(look.alpha * Math.sin((Math.PI * s.age) / look.life)).toFixed(2)})`
        sea.lineWidth = look.width[0] + look.width[1] * rough
        sea.beginPath()
        sea.moveTo(a.x, a.y)
        sea.quadraticCurveTo(2 * mid.x - (a.x + b.x) / 2, 2 * mid.y - (a.y + b.y) / 2, b.x, b.y)
        sea.stroke()
      }
    }

    reset()
    // trails left on the screen would smear as the map moves
    const clear = () => ctx.clearRect(0, 0, c.width, c.height)
    map.on('move', clear)
    map.on('moveend', reset)
    window.addEventListener('resize', reset)
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      map.off('move', clear)
      map.off('moveend', reset)
      window.removeEventListener('resize', reset)
      ctx.clearRect(0, 0, c.width, c.height)
      sea.clearRect(0, 0, c.width, c.height)
    }
  }, [map, weather, wind, waves, swell])

  return (
    <>
      <canvas ref={waveCanvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
      <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
    </>
  )
}
