import { COORDINATE_SYSTEM, CompositeLayer, Layer, project32 } from '@deck.gl/core'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { Geometry, Model } from '@luma.gl/engine'
import { VectorTile } from '@mapbox/vector-tile'
import maplibregl from 'maplibre-gl'
import { PbfReader } from 'pbf'
import { useEffect, useRef, useState } from 'react'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const OCEAN = '#081e42'
const TIER_ZOOMS = [8.5, 11, 13, 15] // the zoom each finer band of charts comes in at
const CHARTS_ZOOM = 4 // further out than this, there's just the world's land: charts would be specks
const POLL = 5000 // ms
const TIDE_REFRESH = 600000 // ms
const TIDE_HOURS = 120 // either side of now
const LAND_TOP = 15 // m: backend/charts.py's LAND_HEIGHT
const BUILDING_HEIGHT = 8 // m, for ones that have none on record
const BUILDINGS_ZOOM = 12 // further out, the map's tiles hold only a few stubs, so those come from...
const SKYLINE_ZOOM = 10 // ...tiles of this zoom's, read here, from this far out
const SKYLINE_TILE_ZOOM = 12
const SKYLINE_TILES = 64 // at most at once, nearest first
const SKYLINE_KEPT = 400 // tiles held in memory
const OVERVIEW_ASPECT = 13 / 8 // the general map's shape
const OVERVIEW_NARROWEST = 40 // degrees across: it stays a general map, however far in you go
const EMPTY = { type: 'FeatureCollection', features: [] }
const CUBE_FACES = [
  ['top', 'Top', 'Look straight down', { pitch: 0 }],
  ['n', 'N', 'Turn north up', { bearing: 0 }],
  ['e', 'E', 'Turn east up', { bearing: 90 }],
  ['s', 'S', 'Turn south up', { bearing: 180 }],
  ['w', 'W', 'Turn west up', { bearing: -90 }],
]
const OUTLINE_ZOOM = 8 // closer than this, the charts' coasts take over from the world's outline
const NO_ENC_ZOOM = 5 // from here in, a view with no ENC at all says so
const SEARCH_ZOOM = 14 // a place found is shown no closer than this

// with hardware acceleration off in the browser, the CPU draws everything, and every point of every shape costs it
function drawnInSoftware() {
  const gl = document.createElement('canvas').getContext('webgl2')
  const info = gl?.getExtension('WEBGL_debug_renderer_info')
  return /basic render|swiftshader|llvmpipe|software/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '')
}
const SOFTWARE = drawnInSoftware()

// true to scale, walls are too small to see from further out than this
const LAND_WALLS_ZOOM = SOFTWARE ? 11.5 : 10
// the charts and the world's land take over from these, and the big fills cost a CPU more than all the charts together
const HEAVY_BASEMAP = /^(tunnel|road|bridge|rail|aeroway|building|poi|housenumber|landuse|landcover|park|waterway|water$|water_shadow)/

// from the basemap's own tiles, so they cost no waiting on anyone. In order, it goes charts, buildings, labels
const BUILDING_LOOK = {
  type: 'fill-extrusion',
  paint: {
    // see-through takes twice the drawing, so a CPU gets the colour that it comes to over the land
    'fill-extrusion-color': SOFTWARE ? '#4b627a' : '#7fb6e6',
    'fill-extrusion-opacity': SOFTWARE ? 1 : 0.35,
    'fill-extrusion-base': ['+', LAND_TOP, ['coalesce', ['get', 'min_height'], 0]],
    'fill-extrusion-height': ['+', LAND_TOP, ['coalesce', ['get', 'height'], BUILDING_HEIGHT]],
  },
}
const SKYLINE = { ...BUILDING_LOOK, id: 'skyline', source: 'skyline', minzoom: SKYLINE_ZOOM, maxzoom: BUILDINGS_ZOOM }
const BUILDINGS = {
  ...BUILDING_LOOK,
  id: 'buildings',
  source: 'protomaps',
  'source-layer': 'buildings',
  minzoom: BUILDINGS_ZOOM,
}

// Web Mercator: as a tile number at some zoom, and on the 360 wide square of the general map's outline
const mercator = (lat) => Math.asinh(Math.tan((lat * Math.PI) / 180))
const tileAt = (lng, lat, zoom) => ({
  x: ((lng + 180) / 360) * 2 ** zoom,
  y: ((1 - mercator(lat) / Math.PI) / 2) * 2 ** zoom,
})
const onOutline = ({ lng, lat }) => [lng + 180, 180 - (mercator(Math.max(-85, Math.min(85, lat))) * 180) / Math.PI]
const tileToLat = (y, zoom) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI
const tileToLng = (x, zoom) => (x / 2 ** zoom) * 360 - 180
const fromOutline = (x, y) => ({
  lng: x - 180,
  lat: (Math.atan(Math.sinh(((180 - y) * Math.PI) / 180)) * 180) / Math.PI,
})

const overlaps = (w, s, e, n) => ([west, south, east, north]) => w < east && e > west && s < north && n > south

// the tiles of the skyline in view that a detailed chart reaches, nearest the middle first
function skylineTiles(m, detailed) {
  const bounds = m.getBounds() // (past 180 on later copies of the world; tile numbers come back round)
  const from = tileAt(bounds.getWest(), bounds.getNorth(), SKYLINE_TILE_ZOOM)
  const to = tileAt(bounds.getEast(), bounds.getSouth(), SKYLINE_TILE_ZOOM)
  const { lng, lat } = m.getCenter()
  const middle = tileAt(lng, lat, SKYLINE_TILE_ZOOM)
  const tiles = []
  const z = SKYLINE_TILE_ZOOM
  for (let across = Math.floor(from.x); across <= to.x; across++) {
    const x = ((across % 2 ** z) + 2 ** z) % 2 ** z
    for (let y = Math.max(Math.floor(from.y), 0); y <= to.y; y++) {
      const here = overlaps(tileToLng(x, z), tileToLat(y + 1, z), tileToLng(x + 1, z), tileToLat(y, z))
      if (detailed.some(here)) tiles.push({ x, y, away: (across - middle.x) ** 2 + (y - middle.y) ** 2 })
    }
  }
  return tiles.sort((a, b) => a.away - b.away).slice(0, SKYLINE_TILES)
}

const tierAt = (zoom) => (zoom < CHARTS_ZOOM ? 0 : 2 + TIER_ZOOMS.filter((z) => zoom >= z).length)

// a compiled chart (backend/charts.py): the arrays go straight to the graphics chip as they are
function unpack(buffer) {
  const size = new DataView(buffer).getUint32(0, true)
  const chart = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)))
  let at = 4 + size
  const take = (Type, length) => {
    const array = new Type(buffer, at, length)
    at += array.byteLength
    return array
  }
  for (const [key, [vertices, indices]] of Object.entries(chart.meshes)) {
    const positions = { value: take(Float32Array, vertices * 3), size: 3 }
    const colors = { value: take(Uint8Array, vertices * 4), size: 4, normalized: true }
    const value = take(Uint32Array, indices)
    chart.meshes[key] = vertices && { attributes: { positions, colors }, indices: { value, size: 1 } }
  }
  return chart
}

// The tide is just one number for the shader, so scrubbing through it costs next to nothing, and there's no sheet of
// water over everything to fight the seabed for pixels. Seabed above the water dries out; land below it gets wet.
const TIDE_UNIFORMS = `layout(std140) uniform tideUniforms {
  float level;
  float seabed;
  float contours;
  float shallow;
  float safety;
  float deep;
} tide;`
const tideModule = {
  name: 'tide',
  vs: TIDE_UNIFORMS,
  fs: TIDE_UNIFORMS,
  uniformTypes: { level: 'f32', seabed: 'f32', contours: 'f32', shallow: 'f32', safety: 'f32', deep: 'f32' },
}

// the least a mesh can cost to draw: colours are baked in, so there's no lighting to work out for each point and pixel
const VERTEX_SHADER = `#version 300 es
in vec3 positions;
in vec4 colors;
out vec3 color;
out float height;
void main() {
  color = colors.rgb;
  height = positions.z;
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0));
}`
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 color;
in float height;
out vec4 fragColor;
const vec3 DRY = vec3(0.52, 0.46, 0.33);
const vec3 WET = vec3(0.12, 0.38, 0.50);
// an ECDIS's daytime depth colours, and its contour lines
const vec3 DRYING = vec3(0.60, 0.68, 0.47);
const vec3 VERY_SHALLOW = vec3(0.45, 0.71, 0.94);
const vec3 MEDIUM_SHALLOW = vec3(0.60, 0.77, 0.95);
const vec3 MEDIUM_DEEP = vec3(0.73, 0.84, 0.88);
const vec3 DEEP = vec3(0.83, 0.92, 0.93);
const vec3 LINE = vec3(0.30, 0.36, 0.42);
const vec3 SAFETY_LINE = vec3(0.07, 0.10, 0.14);
// how much of a pixel a contour line covers: soft-edged, or a line this thin would sparkle as the view turns
float line(float depth, float contour, float pixel, float width) {
  return clamp(width + 0.5 - abs(depth - contour) / pixel, 0.0, 1.0);
}
void main() {
  vec3 c = color;
  if (tide.seabed > 0.5) {
    if (tide.contours > 0.5) {
      // (a hair off: seabed lying flat at exactly a contour's depth would otherwise be all line)
      float depth = -height - 0.01;
      if (tide.contours > 1.5) {
        c = height > 0.0 ? DRYING
          : depth < tide.shallow ? VERY_SHALLOW
          : depth < tide.safety ? MEDIUM_SHALLOW
          : depth < tide.deep ? MEDIUM_DEEP
          : DEEP;
      }
      if (tide.contours < 2.5) {
        float pixel = max(fwidth(depth), 0.0001);
        c = mix(c, LINE, max(line(depth, tide.shallow, pixel, 0.5), line(depth, tide.deep, pixel, 0.5)));
        c = mix(c, SAFETY_LINE, line(depth, tide.safety, pixel, 1.0));
      }
    }
    if (height > tide.level) c = mix(c, DRY, 0.85);
  } else if (height < tide.level) {
    c = mix(c, WET, 0.75);
  }
  fragColor = vec4(c, 1.0);
}`

class Mesh extends Layer {
  initializeState() {}

  updateState({ props, oldProps }) {
    if (props.mesh === oldProps.mesh) return
    this.state.model?.destroy()
    this.state.model = new Model(this.context.device, {
      ...this.getShaders({ vs: VERTEX_SHADER, fs: FRAGMENT_SHADER, modules: [project32, tideModule] }),
      id: props.id,
      geometry: new Geometry({ topology: props.topology, ...props.mesh }),
      bufferLayout: this.getAttributeManager().getBufferLayouts(),
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
    })
  }

  draw() {
    const { model } = this.state
    const { level, seabed, contours } = this.props
    model.shaderInputs.setProps({ tide: { level, seabed: seabed ? 1 : 0, ...contours } })
    model.draw(this.context.renderPass)
  }

  finalizeState(context) {
    super.finalizeState(context)
    this.state.model?.destroy()
  }
}
Mesh.layerName = 'Mesh'

const ONE = [{}]
// tucked away below the screen, all but its first line, until the pointer's on it
const TIDE_CARD =
  'absolute bottom-0 left-1/2 w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 translate-y-[calc(100%-2.25rem)] rounded-t-xl border border-b-0 border-slate-700 bg-slate-900/90 px-4 pt-2.5 pb-4 text-slate-100 shadow-xl transition-transform duration-200 hover:translate-y-0 focus-within:translate-y-0'

function chartLayers(chart, show, zoom, level, contours) {
  const mesh = (key, visible, topology = 'triangle-list') =>
    chart.meshes[key] &&
    new Mesh({
      id: `${chart.id}-${key}`,
      data: ONE,
      mesh: chart.meshes[key],
      visible,
      topology,
      level,
      // walls take the depth colours but no lines: a chart's edge hangs through every depth, and would draw them all
      contours: key === 'water' ? contours : { ...contours, contours: contours.contours === 2 ? 3 : 0 },
      seabed: key.startsWith('water'),
      // (the world as a whole is too big to be offsets from anywhere)
      coordinateSystem: chart.origin ? COORDINATE_SYSTEM.LNGLAT_OFFSETS : COORDINATE_SYSTEM.LNGLAT,
      coordinateOrigin: chart.origin ? [...chart.origin, 0] : [0, 0, 0],
      // later charts win any tie while they swap, but only just: a big offset would lift them through neighbours
      getPolygonOffset: ({ layerIndex }) => [0, -layerIndex],
    })
  return [
    mesh('water', show.depare),
    mesh('waterWalls', show.depare),
    mesh('land', show.lndare),
    mesh('landWalls', show.lndare && zoom >= LAND_WALLS_ZOOM),
    mesh('coast', show.lndare && zoom < OUTLINE_ZOOM, 'line-list'),
    mesh('outline', show.lndare && zoom >= OUTLINE_ZOOM, 'line-list'),
  ]
}

// one layer to MapLibre, however many charts are showing
class Charts extends CompositeLayer {
  renderLayers() {
    const { data, show, zoom, level, contours } = this.props
    return data.flatMap((chart) => chartLayers(chart, show, zoom, level, contours))
  }
}
Charts.layerName = 'Charts'

function syncMessage(sync) {
  if (!sync) return 'Connecting'
  const { phase, done, total, charts, problem } = sync
  if (phase === 'downloading' && total > 0) return `Downloading charts: ${done.toLocaleString()} of ${total.toLocaleString()}`
  if (phase === 'compiling' && total > 0) return `Preparing charts: ${done.toLocaleString()} of ${total.toLocaleString()}`
  if (phase === 'checking' || phase === 'starting') return 'Checking NOAA for updates'
  return `${charts.toLocaleString()} charts${problem ? '' : ', up to date'}`
}

function TidePanel({ tide, hour, setHour }) {
  if (!tide) return null
  if (!tide.station) {
    return <p className={`${TIDE_CARD} text-sm text-slate-300`}>No tide station near here</p>
  }
  const level = tide.levels[hour + TIDE_HOURS]
  const low = Math.min(...tide.levels)
  const high = Math.max(...tide.levels)
  const curve = tide.levels.map((l, i) => `${i},${40 - (36 * (l - low)) / (high - low || 1)}`).join(' ')
  const when = new Date((tide.now + hour * 3600) * 1000).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
  const source = tide.observed[hour + TIDE_HOURS] ? 'measured' : tide.predicted ? 'predicted' : 'last reading'
  const offset = hour === 0 ? 'Now' : `${hour > 0 ? '+' : '−'}${Math.abs(hour)} h`
  return (
    <section aria-label="Tide" className={`${TIDE_CARD} flex flex-col gap-1 text-sm`}>
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-medium text-cyan-300 tabular-nums">
          {level.toFixed(2)} m <span className="font-normal text-slate-400">above {tide.datum}, {source}</span>
        </p>
        <p className="text-slate-300 tabular-nums">{offset}: {when}</p>
      </div>
      <svg viewBox={`0 0 ${2 * TIDE_HOURS} 40`} preserveAspectRatio="none" className="h-8 w-full" aria-hidden="true">
        <polyline points={curve} fill="none" stroke="#67e8f9" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1={TIDE_HOURS} x2={TIDE_HOURS} y1="0" y2="40" stroke="#475569" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1={hour + TIDE_HOURS} x2={hour + TIDE_HOURS} y1="0" y2="40" stroke="#f8fafc" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <input
        type="range"
        aria-label="Hours from now"
        min={-TIDE_HOURS}
        max={TIDE_HOURS}
        value={hour}
        onChange={(e) => setHour(+e.target.value)}
        // focus holds the card up through a drag, however far the pointer strays; letting go lets it tuck away again
        onPointerUp={(e) => e.currentTarget.blur()}
        className="w-full accent-cyan-400"
      />
      <div className="flex items-center justify-between gap-4 text-xs text-slate-400">
        <span>5 days ago</span>
        <span className="truncate">{tide.station.name}, {tide.station.state}, {tide.station.km} km away</span>
        <button type="button" onClick={() => setHour(0)} className="rounded px-1 text-cyan-300 hover:underline">Now</button>
        <span>In 5 days</span>
      </div>
    </section>
  )
}

function SearchBar({ go }) {
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState([])
  const [note, setNote] = useState('')

  async function search(e) {
    e.preventDefault()
    if (!query.trim()) return
    setNote('Searching')
    setPlaces([])
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`)
      const found = res.ok ? await res.json() : null
      setNote(found ? (found.length ? '' : 'Nothing found') : "Search isn't available just now")
      setPlaces(found ?? [])
      if (found?.length) go(found[0])
    } catch {
      setNote("Search isn't available just now")
    }
  }

  return (
    <form
      role="search"
      onSubmit={search}
      className="absolute top-3 left-1/2 z-10 w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 text-sm text-slate-100"
    >
      <input
        type="search"
        aria-label="Search for a place"
        placeholder="Search for a place, then press Enter"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setPlaces([])
          setNote('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPlaces([])
        }}
        className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 shadow-xl outline-none placeholder:text-slate-400 focus:border-cyan-400"
      />
      {note && <p className="mt-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">{note}</p>}
      {places.length > 1 && (
        <ul className="mt-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
          {places.map((place) => (
            <li key={place.name}>
              <button
                type="button"
                onClick={() => {
                  go(place)
                  setPlaces([])
                }}
                className="block w-full truncate px-3 py-2 text-left hover:bg-slate-800 focus:bg-slate-800"
              >
                {place.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}

function LoadingScreen({ sync }) {
  const stage = useRef(null) // when this stage began to count, to tell how long it has left
  const { phase, done = 0, total = 0, problem } = sync ?? {}
  if (!stage.current || stage.current.phase !== phase || done < stage.current.done) {
    stage.current = { phase, done, at: Date.now() }
  }
  const rate = (done - stage.current.done) / (Date.now() - stage.current.at)
  const minutes = rate > 0 ? Math.ceil((total - done) / rate / 60000) : null
  const heading = { downloading: 'Downloading charts from NOAA', compiling: 'Preparing charts' }[phase] ?? 'Checking charts'
  const counting = (phase === 'downloading' || phase === 'compiling') && total > 0
  const percent = counting ? Math.floor((100 * done) / total) : 0
  return (
    <main className="fixed inset-0 grid place-items-center bg-slate-950 p-4 text-slate-100">
      <div className="flex w-full max-w-md flex-col gap-3">
        <h1 className="text-2xl font-semibold">ENC 3D</h1>
        <p className="text-slate-300">{heading}</p>
        <div
          role="progressbar"
          aria-label={heading}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-slate-800"
        >
          <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-700" style={{ width: `${percent}%` }} />
        </div>
        <p className="flex justify-between gap-4 text-sm text-slate-400 tabular-nums">
          <span>{counting && `${done.toLocaleString()} of ${total.toLocaleString()}`}</span>
          <span>{counting && minutes !== null && `About ${minutes} min left`}</span>
        </p>
        {problem && <p className="text-sm text-amber-300">{problem}</p>}
        <p className="mt-4 text-sm text-slate-400">Every chart is prepared now, so that the map is quick once you're in. It only takes this long the first time.</p>
      </div>
    </main>
  )
}

export default function App() {
  const mapBox = useRef(null)
  const map = useRef(null)
  const overlay = useRef(null)
  const refresh = useRef(null)
  const cube = useRef(null)
  const overview = useRef(null)
  const footprint = useRef(null)
  const uploaded = useRef([]) // the same as charts, for the map's own handlers
  const [shown, setShown] = useState([]) // the charts in view
  const [charts, setCharts] = useState([]) // the ones uploaded
  const [loading, setLoading] = useState(false)
  const [sync, setSync] = useState(null)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(0)
  const [show, setShow] = useState({
    depare: true,
    lndare: true,
    buildings: true,
    tide: true,
    contours: false,
    ecdis: true,
  })
  const [contourDepths, setContourDepths] = useState({ shallow: '2', safety: '10', deep: '30' })
  const [menuOpen, setMenuOpen] = useState(true)
  const [outline, setOutline] = useState('')
  const [charted, setCharted] = useState(true) // is any ENC in view?
  const [detailed, setDetailed] = useState(true) // is any in view fine enough to stand buildings on?
  const [tide, setTide] = useState(null)
  const [hour, setHour] = useState(0) // the tide being shown, from now
  const [compiling, setCompiling] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    async function poll() {
      try {
        const status = await (await fetch('/api/status')).json()
        setSync(status)
        if (status.ready) setReady(true)
      } catch {
        setSync(null)
      }
    }
    poll()
    const timer = setInterval(poll, POLL)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!ready) return
    const m = new maplibregl.Map({
      container: mapBox.current,
      center: [-71, 42],
      zoom: 6,
      minZoom: 1,
      pitch: 45,
      attributionControl: { compact: true },
      // cliffs' edges shimmer as the camera moves without it, but it's four times the work for a CPU
      canvasContextAttributes: { antialias: !SOFTWARE },
    })
    const layers = (style) => {
      const kept = style.layers
        .filter((l) => !HEAVY_BASEMAP.test(l.id))
        .map((l) => (l.type === 'background' ? { ...l, paint: { 'background-color': OCEAN } } : l))
      kept.splice(kept.findIndex((l) => l.type === 'symbol'), 0, SKYLINE, BUILDINGS)
      return kept
    }
    m.setStyle(BASEMAP, {
      transformStyle: (_, style) => ({
        ...style,
        sources: { ...style.sources, skyline: { type: 'geojson', data: EMPTY } },
        layers: layers(style),
      }),
    })
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    // interleaved: one canvas and one graphics context, so the map and charts can't drift apart as they move
    overlay.current = new MapboxOverlay({ interleaved: true })
    m.addControl(overlay.current)
    map.current = m

    const have = new Map() // key: chart
    let request = null

    let tideRequest = null

    async function loadTide() {
      tideRequest?.abort() // a slow answer for the last place mustn't land on top of this one
      tideRequest = new AbortController()
      const { lat, lng } = m.getCenter().wrap()
      try {
        const res = await fetch(`/api/tide?lat=${lat}&lon=${lng}`, { signal: tideRequest.signal })
        if (res.ok) setTide(await res.json())
      } catch {
        // the last levels stand until the next try
      }
    }
    const tideTimer = setInterval(loadTide, TIDE_REFRESH)

    const skyline = new Map() // tile: its buildings
    let skylineRequest = null

    async function loadSkyline(detailed) {
      skylineRequest?.abort()
      const zoom = m.getZoom()
      if (zoom < SKYLINE_ZOOM || zoom >= BUILDINGS_ZOOM) return
      skylineRequest = new AbortController()
      const { signal } = skylineRequest
      const tiles = skylineTiles(m, detailed)
      const url = m.getSource('protomaps')?.tiles?.[0]
      if (!url) return
      try {
        await Promise.all(
          tiles
            .filter(({ x, y }) => !skyline.has(`${x}/${y}`))
            .map(async ({ x, y }) => {
              const path = url.replace('{z}', SKYLINE_TILE_ZOOM).replace('{x}', x).replace('{y}', y)
              const res = await fetch(path, { signal })
              if (!res.ok) return
              const { buildings } = new VectorTile(new PbfReader(await res.arrayBuffer())).layers
              const features = []
              for (let i = 0; i < (buildings?.length ?? 0); i++) {
                const { geometry, properties } = buildings.feature(i).toGeoJSON(x, y, SKYLINE_TILE_ZOOM)
                const { height = BUILDING_HEIGHT, min_height = 0 } = properties
                features.push({ type: 'Feature', geometry, properties: { height, min_height } })
              }
              skyline.set(`${x}/${y}`, features)
            }),
        )
      } catch (e) {
        if (e.name === 'AbortError') return // a newer view took over
      }
      const features = tiles.flatMap(({ x, y }) => skyline.get(`${x}/${y}`) ?? [])
      m.getSource('skyline')?.setData({ ...EMPTY, features })
      for (const key of skyline.keys()) {
        if (skyline.size > SKYLINE_KEPT) skyline.delete(key)
      }
    }

    // the cube and the general map follow the camera: no React here, they change every frame
    function followCamera() {
      const pitch = m.getPitch()
      const bearing = m.getBearing()
      if (cube.current) cube.current.style.transform = `rotateX(${pitch}deg) rotateZ(${-bearing}deg)`
      if (!overview.current) return
      const { clientWidth: width, clientHeight: height } = m.getCanvas()
      const middle = m.getCenter()
      const back = middle.wrap().lng - middle.lng // from whichever copy of the world this is, to the one on the outline
      const corners = [[0, 0], [width, 0], [width, height], [0, height]].map((p) => {
        const { lng, lat } = m.unproject(p)
        return onOutline({ lng: lng + back, lat })
      })
      footprint.current?.setAttribute('points', corners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '))
      const across = Math.min(360, Math.max(OVERVIEW_NARROWEST, (4 * 1000) / 2 ** m.getZoom()))
      const [x, y] = onOutline(middle.wrap())
      const down = across / OVERVIEW_ASPECT
      overview.current.setAttribute('viewBox', `${x - across / 2} ${y - down / 2} ${across} ${down}`)
    }
    m.on('move', followCamera)
    followCamera()

    refresh.current = async () => {
      request?.abort()
      request = new AbortController()
      const { signal } = request
      const [[west, south], [east, north]] = m.getBounds().toArray()
      setZoom(m.getZoom())
      const { clientWidth: width, clientHeight: height } = m.getCanvas()
      const corners = [[0, 0], [width, 0], [width, height], [0, height]].flatMap((p) => m.unproject(p).toArray())
      const tier = tierAt(m.getZoom())
      const query = new URLSearchParams({ west, south, east, north, tier, zoom: m.getZoom(), corners })
      loadTide()
      try {
        const { charted: noaa, detailed: fine, pieces: want } = await (await fetch(`/api/view?${query}`, { signal })).json()
        const inView = (box) => [-360, 0, 360].some((k) => overlaps(west + k, south, east + k, north)(box))
        const mine = uploaded.current.map((c) => c.bounds).filter(inView)
        setCharted(noaa || mine.length > 0)
        setDetailed(fine.length + mine.length > 0)
        loadSkyline([...fine, ...mine])
        const missing = want.filter((c) => !have.has(c.key))
        setLoading(missing.length > 0)
        await Promise.all(
          missing.map(async (c) => {
            const res = await fetch(`/api/chart/${c.name}/${c.tier}?key=${c.key}`, { signal })
            if (!res.ok) return // mid-update, say: the next refresh asks again
            have.set(c.key, { id: c.key, ...unpack(await res.arrayBuffer()) })
            setShown([...have.values()])
          }),
        )
        // what's showing stays until all of this view has arrived, so nothing blinks out in between
        const keys = new Set(want.map((c) => c.key))
        for (const key of have.keys()) if (!keys.has(key)) have.delete(key)
        setShown(want.filter((c) => have.has(c.key)).map((c) => have.get(c.key)))
        setLoading(false)
      } catch (e) {
        if (e.name !== 'AbortError') setLoading(false) // (a newer refresh has taken over otherwise)
      }
    }

    m.on('moveend', () => refresh.current())
    refresh.current()
    return () => {
      clearInterval(tideTimer)
      request?.abort()
      skylineRequest?.abort()
      m.remove()
    }
  }, [ready])

  useEffect(() => {
    if (!ready) return
    fetch('/api/outline')
      .then((res) => (res.ok ? res.text() : ''))
      .then(setOutline)
      .catch(() => {})
  }, [ready])

  function goTo({ bounds: [w, s, e, n] }) {
    const camera = { pitch: map.current.getPitch(), bearing: map.current.getBearing() }
    map.current.fitBounds([[w, s], [e, n]], { ...camera, maxZoom: SEARCH_ZOOM, padding: 60, animate: false })
  }

  function overviewClicked(e) {
    const svg = overview.current
    const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse())
    map.current.jumpTo({ center: fromOutline(x, y) })
  }

  // a chart has been updated
  useEffect(() => {
    refresh.current?.()
  }, [sync?.revision])

  // with the tide bar off, the water stands at chart datum, as on a paper chart
  const level = (show.tide && tide?.levels?.[hour + TIDE_HOURS]) || 0

  // in depth order, whatever's been typed: 0 no contours, 1 their lines, 2 lines and an ECDIS's depth colours, 3 colours
  const [shallow, safety, deep] = Object.values(contourDepths)
    .map((depth) => parseFloat(depth) || 0)
    .sort((a, b) => a - b)
  const contourMode = show.contours ? (show.ecdis ? 2 : 1) : 0

  useEffect(() => {
    const data = [...shown, ...charts]
    const contours = { contours: contourMode, shallow, safety, deep }
    overlay.current?.setProps({
      layers: [new Charts({ id: 'charts', beforeId: SKYLINE.id, data, show, zoom, level, contours })],
    })
  }, [shown, charts, show, zoom, level, contourMode, shallow, safety, deep, ready])

  useEffect(() => {
    // they're only there to go with charts, and a coarse chart's coast would leave them standing in the water
    const visibility = show.buildings && detailed ? 'visible' : 'none'
    for (const { id } of [SKYLINE, BUILDINGS]) {
      if (map.current?.getLayer(id)) map.current.setLayoutProperty(id, 'visibility', visibility)
    }
  }, [show.buildings, detailed])

  async function upload(files) {
    setError('')
    for (const file of files) {
      setCompiling(file.name)
      try {
        const body = new FormData()
        body.append('file', file)
        const res = await fetch('/api/compile', { method: 'POST', body })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `${file.name} failed to compile`)
        const chart = unpack(await res.arrayBuffer())
        // coarsest first, so finer charts draw over them
        uploaded.current = [...uploaded.current.filter((c) => c.name !== chart.name), { id: chart.name, ...chart }]
        setCharts([...uploaded.current].sort((a, b) => b.scale - a.scale))
        const [w, s, e, n] = chart.bounds
        map.current.fitBounds([[w, s], [e, n]], { pitch: 50, padding: { top: 60, bottom: 60, left: 320, right: 60 } })
      } catch (e) {
        setError(e.message)
      }
    }
    setCompiling('')
  }

  if (!ready) return <LoadingScreen sync={sync} />

  return (
    <div className="fixed inset-0 bg-slate-950">
      <div ref={mapBox} className="h-full" />
      <div
        className={`absolute top-4 left-4 max-h-[calc(100%-2rem)] transition-transform duration-200 ${
          menuOpen ? '' : '-translate-x-[calc(100%+1rem)]'
        }`}
      >
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Hide the menu' : 'Show the menu'}
          onClick={() => setMenuOpen(!menuOpen)}
          className="absolute top-3 left-full z-10 ml-px rounded-r-lg border border-l-0 border-slate-700 bg-slate-900/90 px-1.5 py-3 text-slate-200 hover:text-cyan-300"
        >
          {menuOpen ? '‹' : '›'}
        </button>
        <aside
          inert={!menuOpen}
          className="flex max-h-[calc(100vh-2rem)] w-72 flex-col gap-4 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/90 p-4 text-sm text-slate-100 shadow-xl"
        >
          <h1 className="text-base font-semibold">ENC 3D</h1>

          <div role="status" className="flex flex-col gap-1">
            <p className="text-slate-300">{syncMessage(sync)}</p>
            {sync?.problem && <p className="text-amber-300">{sync.problem}</p>}
            <p className="flex items-center gap-2 text-slate-400">
              {loading && (
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
              )}
              {loading ? 'Loading charts in view' : `${shown.length} in view`}
            </p>
          </div>

          <label
            className={`relative block rounded-lg border border-dashed border-slate-500 p-4 text-center focus-within:ring-2 focus-within:ring-cyan-400 ${
              compiling ? 'opacity-60' : 'hover:border-cyan-400'
            }`}
          >
            <span>Add your own: drop .000 cells here, or click to choose</span>
            <input
              type="file"
              accept=".000"
              multiple
              disabled={!!compiling}
              className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-wait"
              onChange={(e) => {
                upload([...e.target.files])
                e.target.value = ''
              }}
            />
          </label>

          <div role="status" className="empty:hidden">
            {compiling && (
              <p className="flex items-center gap-2 break-all text-cyan-300">
                <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-cyan-300 border-t-transparent" />
                Compiling {compiling}
              </p>
            )}
            {error && <p className="text-red-400">{error}</p>}
          </div>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium text-slate-400">Layers</legend>
            {[
              ['depare', 'Depth areas'],
              ['lndare', 'Land'],
              ['buildings', 'Buildings'],
              ['tide', 'Tide bar'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-cyan-400"
                  checked={show[key]}
                  onChange={(e) => setShow({ ...show, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-slate-400">Depth contours</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-cyan-400"
                checked={show.contours}
                onChange={(e) => setShow({ ...show, contours: e.target.checked })}
              />
              Show contours
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                ['shallow', 'Shallow'],
                ['safety', 'Safety'],
                ['deep', 'Deep'],
              ].map(([key, label]) => (
                <label key={key} className="flex min-w-0 flex-col gap-1 text-xs text-slate-300">
                  {label} (m)
                  <input
                    type="number"
                    min="0"
                    step="any"
                    disabled={!show.contours}
                    value={contourDepths[key]}
                    onChange={(e) => setContourDepths({ ...contourDepths, [key]: e.target.value })}
                    className="w-full rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-sm text-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none disabled:opacity-50"
                  />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-cyan-400"
                checked={show.ecdis}
                disabled={!show.contours}
                onChange={(e) => setShow({ ...show, ecdis: e.target.checked })}
              />
              ECDIS depth colours
            </label>
          </fieldset>

          {charts.length > 0 && (
            <ul className="flex flex-col gap-1">
              {charts.map((c) => (
                <li key={c.name} className="flex justify-between gap-2">
                  <span>{c.name}</span>
                  <span className="text-slate-400">1:{c.scale.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-slate-400">Not for navigation.</p>
        </aside>
      </div>
      <SearchBar go={goTo} />
      <p
        role="status"
        aria-hidden={charted || zoom < NO_ENC_ZOOM}
        className={`absolute top-0 left-1/2 -translate-x-1/2 rounded-b-lg bg-red-700 px-5 py-2 text-sm font-semibold text-white shadow-xl transition-transform duration-300 ${
          !charted && zoom >= NO_ENC_ZOOM ? 'translate-y-14' : '-translate-y-full'
        }`}
      >
        No ENCs Loaded
      </p>
      {show.tide && <TidePanel tide={tide} hour={hour} setHour={setHour} />}
      <div className="absolute right-13 bottom-10 hidden origin-bottom-right scale-[0.45] items-end gap-5 transition-transform duration-200 hover:scale-100 focus-within:scale-100 md:flex">
        <div className="cube-scene">
          <div ref={cube} className="cube">
            {CUBE_FACES.map(([face, label, title, camera]) => (
              <button
                key={face}
                type="button"
                data-face={face}
                className="cube-face"
                aria-label={title}
                title={title}
                onClick={() => map.current.easeTo({ ...camera, duration: 400 })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <svg
          ref={overview}
          role="img"
          aria-label="General map: click to go there"
          onClick={overviewClicked}
          preserveAspectRatio="xMidYMid slice"
          className="h-32 w-52 cursor-pointer rounded-lg border border-slate-700 bg-[#081e42]"
        >
          <path id="world" d={outline} fill="#2f3540" stroke="#8cc7f2" strokeWidth="0.75" vectorEffect="non-scaling-stroke" />
          <use href="#world" x="-360" />
          <use href="#world" x="360" />
          <polygon ref={footprint} fill="#67e8f9" fillOpacity="0.25" stroke="#67e8f9" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  )
}
