import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { CURRENTS_ZOOM, OBJECTS_ZOOM, currentArrows, objectMeshes, vesselMesh } from './models'
import { CRESTS, WIND_RGB, WeatherCanvas, directionAt, indexWeather, unpackLand, weatherAt } from './weather'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { VectorTile } from '@mapbox/vector-tile'
import * as maplibregl from 'maplibre-gl'
import maplibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { PbfReader } from 'pbf'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY, SOFTWARE, daylightAt, fromOutline, onOutline, overlaps, rhumb, sunAt, tileAt, tileToLat, tileToLng } from './geo'
import { AIDS, AIS, PLEASURE, VESSEL_CATEGORIES, VESSEL_DOT, VESSEL_FOUND_ZOOM, VESSEL_REFRESH, vesselAt, vesselCategory, vesselLengthAt, vesselShape, vesselTiles } from './vessels'
import { ROMAN, WARNING_AGES, WARNING_CATEGORIES, WARNING_DOT, WARNING_DOT_PICKED, WARNING_EDGE, WARNING_FILL, WARNING_FILL_PICKED, cutFeeds, warningShapes, warningsAt } from './warnings'
import { Charts, modelLayer, unpack } from './meshes'
import { ICONS, Section, SideMenu, Toggle } from './menu'
import { FleetView } from './fleet'
import { LoadingScreen, SearchBar, TIDE_HOURS, TidePanel, VesselCard, syncMessage } from './panels'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const OCEAN = '#081e42'
const TIER_ZOOMS = [8.5, 11, 13, 15] // the zoom each finer band of charts comes in at
const CHARTS_KEPT = 160 // charts held, hidden, beyond those showing: memory, but nothing to draw
const VIEW_MARGIN = 0.25 // of the view's size, fetched round it
const GLOBE_ZOOM = 5 // further out, the earth's a globe
const GLOBE_LAND = 'rgb(47, 53, 64)' // backend/charts.py's LAND_RGB
const CHARTS_ZOOM = 4 // further out than this, there's just the world's land: charts would be specks
const POLL = 5000 // ms
const TIDE_REFRESH = 600000 // ms
const LAND_TOP = 15 // m: backend/charts.py's LAND_HEIGHT
const BUILDING_HEIGHT = 8 // m, for ones that have none on record
const BUILDINGS_ZOOM = 12 // further out, the map's tiles hold only a few stubs, so those come from...
const SKYLINE_ZOOM = 10 // ...tiles of this zoom's, read here, from this far out
const SKYLINE_TILE_ZOOM = 12
const SKYLINE_TILES = 64 // at most at once, nearest first
const SKYLINE_KEPT = 400 // tiles held in memory
const OVERVIEW_ASPECT = 13 / 8 // the general map's shape
const OVERVIEW_NARROWEST = 40 // degrees across: it stays a general map, however far in you go
const CUBE_FACES = [
  ['top', 'Top', 'Look straight down', { pitch: 0 }],
  ['n', 'N', 'Turn north up', { bearing: 0 }],
  ['e', 'E', 'Turn east up', { bearing: 90 }],
  ['s', 'S', 'Turn south up', { bearing: 180 }],
  ['w', 'W', 'Turn west up', { bearing: -90 }],
]
const NO_ENC_ZOOM = 5 // from here in, a view with no ENC at all says so
const SEARCH_ZOOM = 14 // a place found is shown no closer than this
const CLOCK = 60000 // ms: how often the sun moves
const WARNINGS_REFRESH = 3600000 // ms
const WARNINGS_LAG = 180000 // ms after the hour
const WARNINGS_RETRY = 15000 // ms: while the first ever look through the feeds is going on
const GREY_AFTER = 250 // ms of loading before the screen greys, or every small pan would flash
const UNGREY_AFTER = 150 // ms of quiet before it clears, as one thing's end can come just before the next one's start
const LIGHT_DOT = 3 // px
const ALIVE_EVERY = 10000 // ms: how often a window tells the server it's open (backend/launch.py)
const TRACK_GAP = 12 * 3600 // s: reports further apart than this aren't joined up on the map
const BERTH_ZOOM = 15 // closer than this, vessels are drawn about true to size, and alongside quays they're set clear of them
const STOPPED = 0.5 // knots
const CURRENT_LABELS_ZOOM = 12 // further out, the arrows go without their speeds
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const compass = (degrees) => COMPASS[Math.round(degrees / 45) % 8]
const MEASURE_RGB = [253, 224, 71]
// distances as a chart gives them, and short ones in metres too; bearings true, in three figures
const miles = (nm) => (nm < 1 ? `${nm.toFixed(2)} nm (${Math.round(nm * 1852)} m)` : `${nm.toLocaleString([], { maximumFractionDigits: nm < 100 ? 2 : 1 })} nm`)
const trueBearing = (degrees) => `${String(Math.round(degrees) % 360).padStart(3, '0')}°T`
// how each shows on the map, as the key beside its switch
const mark = (path, rgb, width) => (
  <svg viewBox="0 0 24 12" className="h-3 w-6 shrink-0" aria-hidden="true">
    <path d={path} fill="none" stroke={`rgb(${rgb})`} strokeWidth={width} strokeLinecap="round" />
  </svg>
)
const WEATHER_KINDS = [
  ['wind', 'Wind', mark('M2 3h12 M8 9h14', WIND_RGB, 1)],
  ['waves', 'Waves', mark('M3 9q4-7 8 0 M13 9q4-7 8 0', CRESTS.waves.rgb, 1.8)],
  ['swell', 'Swell', mark('M2 9q10-6 20 0', CRESTS.swell.rgb, 2.4)],
]
const allOf = (names) => Object.fromEntries(names.map((name) => [name, true]))

// MapLibre finds its worker next to its own file, which bundling moves
maplibregl.setWorkerUrl(maplibreWorker)
// the charts and the world's land take over from these, and the big fills cost a CPU more than all the charts together
const HEAVY_BASEMAP = /^(tunnel|road|bridge|rail|aeroway|building|poi|housenumber|landuse|landcover|park|waterway|water$|water_shadow)/

// from the basemap's own tiles, so they cost no waiting on anyone. In order, it goes charts, buildings, labels
const BUILDING_RGB = SOFTWARE ? [75, 98, 122] : [127, 182, 230]
const BUILDING_NIGHT = 0.4 // of their daytime colour
const BUILDING_LOOK = {
  type: 'fill-extrusion',
  paint: {
    // see-through takes twice the drawing, so a CPU gets the colour that it comes to over the land
    'fill-extrusion-color': `rgb(${BUILDING_RGB})`,
    'fill-extrusion-opacity': SOFTWARE ? 1 : 0.35,
    'fill-extrusion-base': ['+', LAND_TOP, ['coalesce', ['get', 'min_height'], 0]],
    'fill-extrusion-height': ['+', LAND_TOP, ['coalesce', ['get', 'height'], BUILDING_HEIGHT]],
  },
}
// OpenStreetMap's coast stops at river mouths, so its land runs over harbours and rivers. Painted on top of it, beyond
// the charts, as those have their own. It's flat, at a harbour's sort of depth by the charts' colours, as no depth comes with it
const INLAND_WATER = {
  id: 'inland-water',
  type: 'fill',
  source: 'protomaps',
  'source-layer': 'water',
  minzoom: 9,
  filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!=', ['get', 'kind'], 'ocean']],
  paint: { 'fill-color': 'rgb(78, 150, 176)' },
}
const SKYLINE = { ...BUILDING_LOOK, id: 'skyline', source: 'skyline', minzoom: SKYLINE_ZOOM, maxzoom: BUILDINGS_ZOOM }
const BUILDINGS = {
  ...BUILDING_LOOK,
  id: 'buildings',
  source: 'protomaps',
  'source-layer': 'buildings',
  minzoom: BUILDINGS_ZOOM,
}

// vessels' traffic, warm on the blue of the sea: the map's own heatmap, which only shows further out than this
const HEATMAP_ZOOM = 9
const TRAFFIC = {
  id: 'traffic',
  type: 'heatmap',
  source: 'traffic',
  maxzoom: HEATMAP_ZOOM,
  paint: {
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, HEATMAP_ZOOM, 20],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 0.5, HEATMAP_ZOOM, 1.5],
    'heatmap-opacity': 0.85,
    'heatmap-color': [
      'interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(0, 0, 0, 0)',
      0.1, 'rgba(254, 224, 139, 0.35)',
      0.4, 'rgba(253, 174, 97, 0.7)',
      0.7, 'rgb(244, 109, 67)',
      1, 'rgb(255, 240, 225)',
    ],
  },
}

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
const tierStart = (tier) => (tier === 0 ? 0 : tier === 2 ? CHARTS_ZOOM : TIER_ZOOMS[tier - 3]) // the zoom it comes in at


export default function App() {
  const mapBox = useRef(null)
  const map = useRef(null)
  const overlay = useRef(null)
  const refresh = useRef(null)
  const cube = useRef(null)
  const overview = useRef(null)
  const footprint = useRef(null)
  const [kept, setKept] = useState([]) // every chart loaded, showing or not
  const [showing, setShowing] = useState(new Set()) // keys of the ones showing
  const [standby, setStandby] = useState(new Set()) // and of those fetched ahead, for the levels of detail either side
  const shown = useMemo(() => kept.filter((chart) => showing.has(chart.id)), [kept, showing]) // the charts in view
  const [objects, setObjects] = useState([]) // their buoys, landmarks and the like, when close enough in: { id, things }
  const [charts, setCharts] = useState([]) // the ones uploaded
  const [loading, setLoading] = useState(false)
  const [tideAsked, setTideAsked] = useState(false) // only the first time: after that the last levels stand meanwhile
  const [skylineLoading, setSkylineLoading] = useState(false)
  const [grey, setGrey] = useState(false)
  const [sync, setSync] = useState(null)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(0)
  const [globe, setGlobe] = useState(false) // zoomed out far enough for the map's own globe, and none of our meshes
  const [show, setShow] = useState({
    depare: true,
    lndare: true,
    buildings: true,
    objects: true,
    tide: true,
    contours: false,
    ecdis: true,
    daylight: true,
    currents: true,
    wind: false,
    waves: false,
    swell: false,
    warnings: false,
    vessels: true,
  })
  const [contourDepths, setContourDepths] = useState({ shallow: '2', safety: '10', deep: '30' })
  const [outline, setOutline] = useState('')
  const [charted, setCharted] = useState(true) // is any ENC in view?
  const [detailed, setDetailed] = useState(true) // is any in view fine enough to stand buildings on?
  const [tide, setTide] = useState(null)
  const [tab, setTab] = useState('map') // the map, or the Fleet tab over it
  const [fleetTrack, setFleetTrack] = useState(null) // a fleet vessel's track to show on the map: { name, path }
  const [view, setView] = useState(null) // the map's bounds, as of the last move
  const [currents, setCurrents] = useState([]) // NOAA's current stations in view
  const [weather, setWeather] = useState(null) // wind and waves on a grid over the view
  const [weatherFailed, setWeatherFailed] = useState(false)
  const [land, setLand] = useState(null) // where the land is in view, to keep waves and swell off it
  const [hour, setHour] = useState(0) // the tide being shown, from now
  const [compiling, setCompiling] = useState('')
  const [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now())
  const [warnings, setWarnings] = useState(null)
  const [warningCategories, setWarningCategories] = useState(allOf(Object.keys(WARNING_CATEGORIES)))
  const [vessels, setVessels] = useState([])
  const [vesselsAsked, setVesselsAsked] = useState(false)
  const [vesselsFailed, setVesselsFailed] = useState(false)
  const [vesselCategories, setVesselCategories] = useState({ ...allOf(Object.keys(VESSEL_CATEGORIES)), [PLEASURE]: false })
  const [pickedVessel, setPickedVessel] = useState(null)
  const [vesselDetail, setVesselDetail] = useState(null)
  const [vesselTrack, setVesselTrack] = useState(null)
  const [vesselRoute, setVesselRoute] = useState(null) // backend/route.py's prediction, for the picked vessel
  const [warningSource, setWarningSource] = useState('')
  const [warningAge, setWarningAge] = useState(0)
  const [pickedWarnings, setPickedWarnings] = useState([]) // what's under the last click
  const [pickedTurn, setPickedTurn] = useState(0) // which of them is showing
  const warningsOnMap = useRef({ boxes: [], dots: [] }) // for the map's own handlers
  const vesselsOnMap = useRef([])
  const trafficNow = useRef(EMPTY) // for the heatmap, when the map's style has loaded
  const [measuring, setMeasuring] = useState(false) // clicks on the map add points to measure between
  const [measured, setMeasured] = useState([]) // [lng, lat] of each point
  const [aim, setAim] = useState(null) // where the cursor is, while measuring: the next leg runs to it
  const measuringNow = useRef(false)
  measuringNow.current = measuring
  const loadVessels = useRef(null)
  const vesselsOn = useRef(true)
  const overWarning = useRef(false)
  const sunNow = useRef(null)
  const lightBuildings = useRef(null)

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!show.warnings) return
    let timer
    async function load() {
      // the backend reads the feeds on the hour, and takes a minute or two
      let wait = WARNINGS_REFRESH - (Date.now() % WARNINGS_REFRESH) + WARNINGS_LAG
      try {
        const answer = await (await fetch('/api/warnings')).json()
        setWarnings(answer)
        if (answer.loading) wait = WARNINGS_RETRY
      } catch {
        wait = WARNINGS_RETRY // the last ones stand until the next try
      }
      timer = setTimeout(load, wait)
    }
    load()
    return () => clearTimeout(timer)
  }, [show.warnings])

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
    // ponytail: deck.gl 9.4 still reads map.transform, which MapLibre 6 moved to the camera; drop once deck.gl catches up
    Object.defineProperty(m, 'transform', { get: () => m._camera.transform })
    // and deck.gl knows a globe or a flat map, not the blend between: it takes whichever the map is nearer to
    m.getProjection = () => ({ type: m.getZoom() < GLOBE_ZOOM - 0.5 ? 'globe' : 'mercator' })
    const layers = (style) => {
      const kept = style.layers
        .filter((l) => !HEAVY_BASEMAP.test(l.id) || l.id === 'water')
        .map((l) => {
          // on the globe, the map's own land and sea: big flat triangles, as the charts' and the world's land are
          // made of, would cut through the sphere as chords and lie under it
          if (l.type === 'background') return { ...l, paint: { 'background-color': ['step', ['zoom'], GLOBE_LAND, GLOBE_ZOOM, OCEAN] } }
          if (l.id === 'water') return { ...l, maxzoom: GLOBE_ZOOM, paint: { 'fill-color': OCEAN } }
          return l
        })
      kept.splice(kept.findIndex((l) => l.type === 'symbol'), 0, INLAND_WATER, SKYLINE, BUILDINGS, TRAFFIC)
      return kept
    }
    m.setStyle(BASEMAP, {
      transformStyle: (_, style) => ({
        ...style,
        sources: { ...style.sources, skyline: { type: 'geojson', data: EMPTY }, traffic: { type: 'geojson', data: trafficNow.current } },
        // zoomed out, the earth as a globe, flattening to the charts' Mercator over the zoom before GLOBE_ZOOM
        projection: { type: ['interpolate', ['linear'], ['zoom'], GLOBE_ZOOM - 1, 'vertical-perspective', GLOBE_ZOOM, 'mercator'] },
        layers: layers(style),
      }),
    })
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    // interleaved: one canvas and one graphics context, so the map and charts can't drift apart as they move
    overlay.current = new MapboxOverlay({
      interleaved: true,
      getCursor: ({ isDragging }) => (isDragging ? 'grabbing' : measuringNow.current ? 'crosshair' : overWarning.current ? 'pointer' : 'grab'),
    })
    m.addControl(overlay.current)
    map.current = m

    const have = new Map() // key: chart, the most lately used last
    const tiers = new Map() // tier: the charts it needs and the area they're for, as last fetched
    let showing = new Set() // keys of the charts showing
    let shownTier = null
    const haveObjects = new Map() // key: its objects
    let request = null

    // ponytail: keeps every chart's objects seen this visit; a few kB each, so drop old ones if a long session grows
    async function loadObjects(want, signal) {
      if (m.getZoom() < OBJECTS_ZOOM) return
      const enc = want.filter((c) => !/^(WORLD|COAST_|SEA_)/.test(c.name))
      await Promise.all(
        enc
          .filter((c) => !haveObjects.has(c.key))
          .map(async (c) => {
            const res = await fetch(`/api/objects/${c.name}/${c.tier}?key=${c.key}`, { signal })
            if (res.ok) haveObjects.set(c.key, await res.json())
          }),
      )
      setObjects(enc.filter((c) => haveObjects.has(c.key)).map((c) => ({ id: c.key, things: haveObjects.get(c.key) })))
    }

    let tideRequest = null

    async function loadTide() {
      tideRequest?.abort() // a slow answer for the last place mustn't land on top of this one
      tideRequest = new AbortController()
      const { signal } = tideRequest
      const { lat, lng } = m.getCenter().wrap()
      try {
        const res = await fetch(`/api/tide?lat=${lat}&lon=${lng}`, { signal })
        if (res.ok) setTide(await res.json())
      } catch {
        // the last levels stand until the next try
      }
      if (!signal.aborted) setTideAsked(true)
    }
    const tideTimer = setInterval(loadTide, TIDE_REFRESH)

    const skyline = new Map() // tile: its buildings
    let skylineRequest = null
    let skylineDrawn = '' // redrawing unchanged buildings would leave the map loading after every small pan

    async function loadSkyline(detailed) {
      skylineRequest?.abort()
      setSkylineLoading(false)
      const zoom = m.getZoom()
      if (zoom < SKYLINE_ZOOM || zoom >= BUILDINGS_ZOOM) return
      skylineRequest = new AbortController()
      const { signal } = skylineRequest
      const tiles = skylineTiles(m, detailed)
      const url = m.getSource('protomaps')?.tiles?.[0]
      const names = tiles.map(({ x, y }) => `${x}/${y}`).join()
      if (!url || names === skylineDrawn) return
      setSkylineLoading(true)
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
      skylineDrawn = names
      setSkylineLoading(false)
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

    let vesselRequest = null
    let vesselsShowing = ''

    // what's showing stays until all of this view has arrived, so nothing blinks out in between
    loadVessels.current = async (again = false) => {
      if (!vesselsOn.current) return
      const { tiles, query } = vesselTiles(m)
      const wanted = tiles.join() + query
      if (wanted === vesselsShowing && !again) return
      vesselRequest?.abort()
      vesselRequest = new AbortController()
      const { signal } = vesselRequest
      const found = new Map()
      const answers = await Promise.allSettled(
        tiles.map(async (tile) => {
          const res = await fetch(`${AIS}/tiles/${tile}${query}`, { signal })
          if (!res.ok) throw new Error(res.status)
          const data = await res.arrayBuffer()
          const layer = data.byteLength ? new VectorTile(new PbfReader(data)).layers.vessels : null
          const [z, x, y] = tile.split('/').map(Number)
          for (let i = 0; i < (layer?.length ?? 0); i++) {
            const feature = layer.feature(i)
            const [lng, lat] = feature.toGeoJSON(x, y, z).geometry.coordinates
            found.set(feature.properties.mmsi, { ...feature.properties, lng, lat })
          }
        }),
      )
      if (signal.aborted) return // a newer view took over
      const failed = answers.every(({ status }) => status === 'rejected')
      setVesselsFailed(failed)
      setVesselsAsked(true)
      if (failed) return // the last ones stand until the next try
      vesselsShowing = wanted
      setVessels([...found.values()])
    }
    const vesselTimer = setInterval(() => loadVessels.current(true), VESSEL_REFRESH)

    // Charts stack up rather than come and go: those seen lately are kept, hidden, ready to show again at once, and the
    // levels of detail either side of this one are fetched ahead, so zooming across one switches without a wait
    const stacked = () => setKept([...have.values()])
    const showOnly = (keys) => {
      showing = new Set(keys)
      setShowing(showing)
    }
    const use = (key) => {
      const chart = have.get(key)
      have.delete(key) // (to the end of the line: the most lately used are kept longest)
      have.set(key, chart)
    }
    const evict = () => {
      for (const key of have.keys()) {
        if (have.size <= CHARTS_KEPT) break
        if (!showing.has(key)) have.delete(key)
      }
    }
    // the charts a tier needs for an area, and as many of them as can be fetched
    async function fetchTier(tier, bounds, zoom, signal) {
      const [west, south, east, north] = bounds
      const corners = [west, north, east, north, east, south, west, south]
      const query = new URLSearchParams({ west, south, east, north, tier, zoom, corners })
      const answer = await (await fetch(`/api/view?${query}`, { signal })).json()
      await Promise.all(
        answer.pieces
          .filter((c) => !have.has(c.key))
          .map(async (c) => {
            const res = await fetch(`/api/chart/${c.name}/${c.tier}?key=${c.key}`, { signal })
            if (res.ok) have.set(c.key, { id: c.key, ...unpack(await res.arrayBuffer()) }) // (mid-update, say: asked again)
          }),
      )
      answer.pieces.forEach((c) => have.has(c.key) && use(c.key))
      tiers.set(tier, { bounds, want: answer.pieces })
      return answer
    }

    refresh.current = async () => {
      request?.abort()
      request = new AbortController()
      const { signal } = request
      const [[west, south], [east, north]] = m.getBounds().toArray()
      const zoom = m.getZoom()
      setZoom(zoom)
      setView({ west, south, east, north })
      const { clientWidth: width, clientHeight: height } = m.getCanvas()
      const corners = [[0, 0], [width, 0], [width, height], [0, height]].flatMap((p) => m.unproject(p).toArray())
      const tier = tierAt(zoom)
      shownTier = tier
      // a margin round the view, so a pan doesn't open up gaps at its edge
      const [padX, padY] = [(east - west) * VIEW_MARGIN, (north - south) * VIEW_MARGIN]
      const area = [west - padX, Math.max(south - padY, -85), east + padX, Math.min(north + padY, 85)]
      const query = new URLSearchParams({ west: area[0], south: area[1], east: area[2], north: area[3], tier, zoom, corners })
      loadTide()
      try {
        const { charted: noaa, detailed: fine, pieces: want } = await (await fetch(`/api/view?${query}`, { signal })).json()
        setCharted(noaa)
        setDetailed(fine.length > 0)
        loadSkyline(fine)
        const missing = want.filter((c) => !have.has(c.key))
        // grey only with nothing at all to show meanwhile: what's showing stays till this view has all arrived
        setLoading(missing.length > 0 && showing.size === 0)
        await Promise.all(
          missing.map(async (c) => {
            const res = await fetch(`/api/chart/${c.name}/${c.tier}?key=${c.key}`, { signal })
            if (!res.ok) return // mid-update, say: the next refresh asks again
            have.set(c.key, { id: c.key, ...unpack(await res.arrayBuffer()) })
            stacked()
            showOnly([...showing, c.key])
          }),
        )
        want.forEach((c) => have.has(c.key) && use(c.key))
        tiers.set(tier, { bounds: area, want })
        showOnly(want.filter((c) => have.has(c.key)).map((c) => c.key))
        evict()
        stacked()
        setLoading(false)
        await loadObjects(want, signal)
        // then, hidden, the levels either side: finer for the view as it is, coarser for the wider view zooming out
        const finer = tier === 0 ? 2 : tier + 1
        const coarser = tier === 2 ? 0 : tier - 1
        if (finer <= 6) await fetchTier(finer, area, tierStart(finer), signal)
        if (coarser >= 0) {
          const wider = 2 ** Math.min(Math.max(zoom - (tierStart(tier) - 0.5), 0.5), 1.5) // (one zoom out, about: further, it waits)
          const [midX, midY] = [(west + east) / 2, (south + north) / 2]
          const [halfX, halfY] = [((east - west) / 2) * wider * (1 + VIEW_MARGIN), ((north - south) / 2) * wider * (1 + VIEW_MARGIN)]
          await fetchTier(coarser, [midX - halfX, Math.max(midY - halfY, -85), midX + halfX, Math.min(midY + halfY, 85)], tierStart(tier) - 0.5, signal)
        }
        evict()
        stacked()
        setStandby(new Set([finer, coarser].flatMap((t) => tiers.get(t)?.want ?? []).map((c) => c.key).filter((key) => have.has(key))))
      } catch (e) {
        if (e.name !== 'AbortError') setLoading(false) // (a newer refresh has taken over otherwise)
      }
    }

    // mid-zoom, the moment the level of detail changes, show the one fetched ahead if it covers the view
    let zooming = null
    m.on('zoom', () => {
      if (zooming) return
      zooming = requestAnimationFrame(() => {
        zooming = null
        setGlobe(m.getZoom() < GLOBE_ZOOM)
        const tier = tierAt(m.getZoom())
        const ahead = tiers.get(tier)
        if (tier === shownTier || !ahead) return
        const [[west, south], [east, north]] = m.getBounds().toArray()
        const [w, s, e, n] = ahead.bounds
        if (west < w || south < s || east > e || north > n || !ahead.want.every((c) => have.has(c.key))) return
        shownTier = tier
        showOnly(ahead.want.map((c) => c.key))
      })
    })

    // buildings are the map's own, so they can't be lit per point: they take the light at the middle of the view
    lightBuildings.current = () => {
      const sun = sunNow.current
      const { lng, lat } = m.getCenter()
      const light = sun?.lit ? BUILDING_NIGHT + (1 - BUILDING_NIGHT) * daylightAt(lng, lat, sun) : 1
      const colour = `rgb(${BUILDING_RGB.map((c) => Math.round(c * light))})`
      for (const { id } of [SKYLINE, BUILDINGS]) {
        if (m.getLayer(id)) m.setPaintProperty(id, 'fill-extrusion-color', colour)
      }
    }
    m.once('load', () => lightBuildings.current())

    m.on('click', ({ point: { x, y }, lngLat }) => {
      if (measuringNow.current) {
        setMeasured((points) => [...points, [lngLat.lng, lngLat.lat]])
        return
      }
      const vessel = vesselAt(m, vesselsOnMap.current, x, y)
      setPickedVessel(vessel)
      setPickedWarnings(vessel ? [] : warningsAt(m, warningsOnMap.current, x, y))
      setPickedTurn(0)
    })
    let hovering = null
    m.on('mousemove', ({ point, lngLat }) => {
      if (hovering) return
      hovering = requestAnimationFrame(() => {
        hovering = null
        if (measuringNow.current) {
          setAim([lngLat.lng, lngLat.lat])
          m.getCanvas().style.cursor = 'crosshair'
          return
        }
        const { x, y } = point
        overWarning.current = !!vesselAt(m, vesselsOnMap.current, x, y) || warningsAt(m, warningsOnMap.current, x, y).length > 0
        m.getCanvas().style.cursor = overWarning.current ? 'pointer' : 'grab'
      })
    })

    m.on('moveend', () => {
      lightBuildings.current()
      refresh.current()
      loadVessels.current()
    })
    refresh.current()
    return () => {
      clearInterval(tideTimer)
      clearInterval(vesselTimer)
      vesselRequest?.abort()
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

  function goTo({ bounds, vessel }) {
    const camera = { pitch: map.current.getPitch(), bearing: map.current.getBearing() }
    if (vessel) {
      map.current.jumpTo({ ...camera, center: [vessel.lng, vessel.lat], zoom: VESSEL_FOUND_ZOOM })
      setPickedVessel(vessel)
      return
    }
    const [w, s, e, n] = bounds
    map.current.fitBounds([[w, s], [e, n]], { ...camera, maxZoom: SEARCH_ZOOM, padding: 60, animate: false })
  }

  function showFleetTrack(track) {
    // in pieces where reports were far apart: a straight line across the gap would cross whatever lay between
    const pieces = [[]]
    track.path.forEach((point, i) => {
      if (i && point[2] - track.path[i - 1][2] > TRACK_GAP) pieces.push([])
      pieces.at(-1).push(point)
    })
    setFleetTrack({ ...track, pieces: pieces.filter((piece) => piece.length > 1) })
    setTab('map')
    // to where it's been lately: a year of a tanker's trading is the whole world
    const latest = pieces.filter((piece) => piece.length > 1).at(-1) ?? track.path
    const lngs = latest.map(([lng]) => lng)
    const lats = latest.map(([, lat]) => lat)
    map.current.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 80, maxZoom: 12, animate: false })
  }

  function overviewClicked(e) {
    const svg = overview.current
    const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse())
    map.current.jumpTo({ center: fromOutline(x, y) })
  }

  // tells the server this window's open, and that it's closing: started from the desktop, the server stops once the
  // last window is closed (backend/launch.py)
  useEffect(() => {
    const alive = () => fetch('/api/alive', { method: 'POST', keepalive: true }).catch(() => {})
    const bye = () => navigator.sendBeacon('/api/bye')
    alive()
    const timer = setInterval(alive, ALIVE_EVERY)
    window.addEventListener('pagehide', bye)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', bye)
    }
  }, [])

  // a chart has been updated
  useEffect(() => {
    refresh.current?.()
  }, [sync?.revision])

  useEffect(() => {
    vesselsOn.current = show.vessels
    loadVessels.current?.()
  }, [show.vessels, ready])

  // currents and weather for the view: what's showing stays until the new arrives, and they never grey the screen
  const wantCurrents = show.currents && zoom >= CURRENTS_ZOOM
  useEffect(() => {
    if (!view || !wantCurrents) return
    const request = new AbortController()
    fetch(`/api/currents?${new URLSearchParams(view)}`, { signal: request.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((answer) => answer && setCurrents(answer.stations))
      .catch(() => {})
    return () => request.abort()
  }, [view, wantCurrents])

  const wantWeather = show.wind || show.waves || show.swell
  const wantLand = show.waves || show.swell
  useEffect(() => {
    if (!view || !wantWeather) return
    const request = new AbortController()
    fetch(`/api/weather?${new URLSearchParams(view)}`, { signal: request.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.status))))
      .then((answer) => {
        setWeather(indexWeather(answer))
        setWeatherFailed(false)
      })
      .catch((e) => e.name !== 'AbortError' && setWeatherFailed(true))
    return () => request.abort()
  }, [view, wantWeather])

  useEffect(() => {
    if (!view || !wantLand) return
    setLand(null) // (the last view's would be in the wrong place)
    const request = new AbortController()
    fetch(`/api/landmask?${new URLSearchParams(view)}`, { signal: request.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((answer) => answer && setLand(unpackLand(answer)))
      .catch(() => {})
    return () => request.abort()
  }, [view, wantLand])

  // the legs measured, and while measuring, one more to the cursor
  const legs = useMemo(() => {
    const points = measuring && aim ? [...measured, aim] : measured
    return points.slice(1).map((to, i) => ({ from: points[i], to, ...rhumb(points[i], to), live: measuring && !!aim && i === points.length - 2 }))
  }, [measured, aim, measuring])
  const measuredTotal = legs.filter((leg) => !leg.live).reduce((sum, leg) => sum + leg.nm, 0)
  const stopMeasuring = () => {
    setMeasuring(false)
    setAim(null)
  }
  useEffect(() => {
    if (!measuring) return
    const stop = (e) => {
      if (e.key !== 'Escape') return
      setMeasuring(false)
      setAim(null)
    }
    window.addEventListener('keydown', stop)
    return () => window.removeEventListener('keydown', stop)
  }, [measuring])

  // the tide bar's hour, as the arrays of hours from currents and weather count them
  const hourIndex = (show.tide ? hour : 0) + TIDE_HOURS
  const currentSet = useMemo(
    () => currentArrows(wantCurrents ? currents : [], hourIndex, Math.round(zoom * 4) / 4, (show.tide && tide?.levels?.[hourIndex]) || 0),
    [currents, wantCurrents, hourIndex, zoom, show.tide, tide],
  )

  // the weather at the middle of the view, at the tide bar's hour
  let weatherHere = null
  if (weather && view) {
    const [lng, lat] = [(view.west + view.east) / 2, (view.south + view.north) / 2]
    const knots = weatherAt(weather, 'wind', hourIndex, lng, lat)
    const windFrom = directionAt(weather, 'windFrom', hourIndex, lng, lat)
    const sea = (height, from, period) => {
      const metres = weatherAt(weather, height, hourIndex, lng, lat)
      const way = directionAt(weather, from, hourIndex, lng, lat)
      const seconds = period && weatherAt(weather, period, hourIndex, lng, lat)
      return metres === null || way === null ? null : `${metres.toFixed(1)} m from ${compass(way)}${seconds ? `, ${Math.round(seconds)} s` : ''}`
    }
    weatherHere = {
      wind: knots !== null && windFrom !== null ? `${Math.round(knots)} kn from ${compass(windFrom)}` : null,
      waves: sea('sea', 'seaFrom'),
      swell: sea('swell', 'swellFrom', 'swellPeriod'),
    }
  }

  const warningsLoading = show.warnings && (!warnings || warnings.loading)
  const firstLoads = (show.tide && !tideAsked) || (show.vessels && !vesselsAsked)
  const busy = loading || skylineLoading || warningsLoading || firstLoads || !!compiling
  useEffect(() => {
    const timer = setTimeout(() => setGrey(busy), busy ? GREY_AFTER : UNGREY_AFTER)
    return () => clearTimeout(timer)
  }, [busy])

  // with the tide bar off, the water stands at chart datum, as on a paper chart
  const level = (show.tide && tide?.levels?.[hour + TIDE_HOURS]) || 0

  // in depth order, whatever's been typed: 0 no contours, 1 their lines, 2 lines and an ECDIS's depth colours, 3 colours
  const [shallow, safety, deep] = Object.values(contourDepths)
    .map((depth) => parseFloat(depth) || 0)
    .sort((a, b) => a - b)
  const contourMode = show.contours ? (show.ecdis ? 2 : 1) : 0

  // the sun goes with the tide bar's clock, so scrubbing through the hours brings day and night with them
  const { sunLat, sunLon } = sunAt(clock + (show.tide ? hour : 0) * 3600000)
  const lit = show.daylight ? 1 : 0

  useEffect(() => {
    sunNow.current = { sunLat, sunLon, lit }
    lightBuildings.current?.()
  }, [sunLat, sunLon, lit])

  const oldestWarning = warningAge ? clock / 1000 - warningAge * 86400 : 0
  const filteredWarnings = useMemo(
    () =>
      (warnings?.warnings ?? []).filter(
        (w) =>
          warningCategories[w.category] &&
          (!warningSource || w.source === warningSource) &&
          (w.issued ?? 0) >= oldestWarning,
      ),
    [warnings, warningCategories, warningSource, oldestWarning],
  )
  const warningsDrawn = show.warnings ? filteredWarnings : []
  const picks = pickedWarnings.filter((w) => warningsDrawn.includes(w))
  const picked = picks[Math.min(pickedTurn, picks.length - 1)] ?? null
  const warningSources = useMemo(() => {
    const names = [...new Set((warnings?.warnings ?? []).map((w) => w.source))]
    return names.sort((a, b) => ROMAN.indexOf(a.split(' ')[1]) - ROMAN.indexOf(b.split(' ')[1]))
  }, [warnings])

  const smallestVessel = vesselLengthAt(zoom)
  const filteredVessels = useMemo(
    () => vessels.filter((v) => vesselCategories[vesselCategory(v)] && (v.length || 0) >= smallestVessel),
    [vessels, vesselCategories, smallestVessel],
  )
  // one picked from a search shows even if the live tiles don't have it (heard too long ago, say) or it's filtered out
  const searched = pickedVessel && !filteredVessels.some((v) => v.mmsi === pickedVessel.mmsi) ? [pickedVessel] : []
  // further out, a heatmap of them all rather than a jumble of ships
  const heatmap = zoom < HEATMAP_ZOOM
  const vesselsDrawn = show.vessels ? [...(heatmap ? [] : filteredVessels), ...searched] : []
  const traffic = useMemo(
    () => (show.vessels ? vessels.filter((v) => v.kind === 'vessel' && vesselCategories[vesselCategory(v)]) : []),
    [vessels, vesselCategories, show.vessels],
  )
  useEffect(() => {
    trafficNow.current = { ...EMPTY, features: traffic.map((v) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lng, v.lat] }, properties: {} })) }
    map.current?.getSource('traffic')?.setData(trafficNow.current)
  }, [traffic])
  const reportedShapes = useMemo(() => {
    const middle = map.current?.getCenter().lng ?? 0
    // beyond the charts, harbours are painted on the land's top, not cut from it
    const base = charted ? level : LAND_TOP
    return vesselsDrawn.filter((v) => v.kind === 'vessel').map((v) => vesselShape(v, zoom, base, middle))
  }, [filteredVessels, show.vessels, zoom, level, charted, searched[0], heatmap])

  // close in, stopped vessels that'd be drawn into a pier or quay are laid alongside it instead (backend/berths.py)
  const [berths, setBerths] = useState({})
  const berthing = zoom >= BERTH_ZOOM
  // (as text, so the tide moving the shapes up and down doesn't ask again)
  const stopped = useMemo(
    () =>
      JSON.stringify(
        reportedShapes
          .filter(({ vessel }) => vessel.nav_status === 5 || (vessel.sog ?? 0) < STOPPED)
          .slice(0, 500)
          .map(({ vessel, centre: [lng, lat], length, beam }) => ({ mmsi: vessel.mmsi, lng, lat, length, beam, hdg: vessel.hdg ?? null })),
      ),
    [reportedShapes],
  )
  useEffect(() => {
    if (!berthing || stopped === '[]') return
    const request = new AbortController()
    fetch('/api/berths', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stopped, signal: request.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((found) => found && setBerths(found))
      .catch(() => {})
    return () => request.abort()
  }, [stopped, berthing])
  const vesselShapes = useMemo(
    () =>
      reportedShapes.map((shape) => {
        const berth = berthing && berths[shape.vessel.mmsi]
        // (round the same copy of the world as the one it was sent from)
        return berth ? { ...shape, centre: [berth.lng, berth.lat], vessel: { ...shape.vessel, hdg: berth.hdg } } : shape
      }),
    [reportedShapes, berths, berthing],
  )
  const vesselDots = vesselsDrawn.filter((v) => v.kind !== 'vessel')
  const vesselModels = useMemo(() => vesselMesh(vesselShapes, pickedVessel?.mmsi, zoom), [vesselShapes, pickedVessel, zoom])

  // rebuilt as the zoom changes, as each is kept big enough on screen to see; what floats, as the tide changes too
  const objectZoom = Math.round(zoom * 4) / 4
  const objectsDrawn = useMemo(() => (show.objects && objectZoom >= OBJECTS_ZOOM ? objects : []), [objects, show.objects, objectZoom])
  const standing = useMemo(
    () => objectsDrawn.map(({ id, things }) => ({ id, ...objectMeshes(things, objectZoom, 0, false) })),
    [objectsDrawn, objectZoom],
  )
  const afloat = useMemo(
    () => objectsDrawn.map(({ id, things }) => ({ id, ...objectMeshes(things, objectZoom, level, true) })),
    [objectsDrawn, objectZoom, level],
  )

  useEffect(() => {
    setVesselDetail(null)
    setVesselTrack(null)
    if (!pickedVessel) return
    const request = new AbortController()
    const { signal } = request
    const read = async (path, use) => {
      try {
        const res = await fetch(`${AIS}/${pickedVessel.mmsi}${path}`, { signal })
        if (res.ok) use(await res.json())
      } catch {
        // what the map knows of it stands
      }
    }
    read('', setVesselDetail)
    read('/track?interval=5m', (track) => setVesselTrack(track.geometry?.type === 'LineString' ? track.geometry.coordinates : null))
    return () => request.abort()
  }, [pickedVessel])

  // where it's going, once its own record has said: the route there, and when it'll arrive with the weather on the way
  useEffect(() => {
    setVesselRoute(null)
    const said = { ...pickedVessel, ...vesselDetail?.properties }
    if (!pickedVessel || !vesselDetail || !said.destination) return
    const request = new AbortController()
    const query = { lng: pickedVessel.lng, lat: pickedVessel.lat, destination: said.destination }
    for (const key of ['sog', 'cog', 'type', 'length', 'eta', 'seen']) if (said[key] !== undefined && said[key] !== null) query[key] = said[key]
    fetch(`/api/route?${new URLSearchParams(query)}`, { signal: request.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then(setVesselRoute)
      .catch(() => {})
    return () => request.abort()
  }, [pickedVessel, vesselDetail])

  useEffect(() => {
    const data = kept
    const contours = { contours: contourMode, shallow, safety, deep }
    const sun = { sunLat, sunLon, lit }
    const { boxes, dots } = warningShapes(warningsDrawn, zoom)
    warningsOnMap.current = { boxes, dots }
    const colourOf = ({ warning }) => WARNING_CATEGORIES[warning.category]
    const boxLayer = new PolygonLayer({
      id: 'warning-boxes',
      beforeId: SKYLINE.id,
      data: boxes,
      visible: boxes.length > 0 && !globe, // (on the globe, the dots alone: big boxes would sink into it too)
      extruded: true,
      wireframe: true,
      material: false,
      getPolygon: (box) => box.ring,
      getElevation: (box) => box.height,
      getFillColor: (box) => [...colourOf(box), box.warning === picked ? WARNING_FILL_PICKED : WARNING_FILL],
      getLineColor: (box) => [...colourOf(box), WARNING_EDGE],
      // see-through boxes mustn't hide what's behind them from each other
      parameters: { depthWriteEnabled: false },
    })
    const dotLayer = new ScatterplotLayer({
      id: 'warning-dots',
      beforeId: SKYLINE.id,
      data: dots,
      visible: dots.length > 0,
      billboard: true,
      stroked: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: (dot) => dot.position,
      getRadius: (dot) => (dot.warning === picked ? WARNING_DOT_PICKED : WARNING_DOT),
      getFillColor: colourOf,
      getLineColor: [255, 255, 255, 220],
      getLineWidth: 1,
      // on a coast, or the land's height would cut them in half
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    vesselsOnMap.current = vesselShapes
    const vesselLayer = modelLayer('vessels', vesselModels, level, sun, SKYLINE.id)
    const currentLayer = new PathLayer({
      id: 'currents',
      beforeId: SKYLINE.id,
      data: currentSet.lines,
      visible: currentSet.lines.length > 0,
      widthUnits: 'pixels',
      getPath: (line) => line.path,
      getWidth: 1.5,
      getColor: (line) => line.color,
      capRounded: true,
      jointRounded: true,
    })
    const currentDots = new ScatterplotLayer({
      id: 'current-slack',
      beforeId: SKYLINE.id,
      data: currentSet.dots,
      visible: currentSet.dots.length > 0,
      radiusUnits: 'pixels',
      getPosition: (dot) => dot.position,
      getRadius: 2,
      getFillColor: (dot) => dot.color,
    })
    const currentLabels = new TextLayer({
      id: 'current-labels',
      beforeId: SKYLINE.id,
      data: currentSet.labels,
      visible: zoom >= CURRENT_LABELS_ZOOM && currentSet.labels.length > 0,
      getPosition: (label) => label.position,
      getText: (label) => label.text,
      getSize: 10,
      getColor: [203, 213, 225, 200],
      getPixelOffset: [0, 12],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const objectLayers = [...standing, ...afloat].map((set, i) => modelLayer(`objects-${i < standing.length ? 'standing' : 'afloat'}-${set.id}`, set, level, sun, SKYLINE.id))
    // lights shine at night only, and stay bright: they're not lit by the sun but their own
    const lights = lit ? [...standing, ...afloat].flatMap((set) => set.lights).filter(({ position: [lng, lat] }) => daylightAt(lng, lat, sun) < 0.5) : []
    const lightLayer = new ScatterplotLayer({
      id: 'lights',
      beforeId: SKYLINE.id,
      data: lights,
      visible: lights.length > 0,
      billboard: true,
      radiusUnits: 'pixels',
      getPosition: (light) => light.position,
      getRadius: LIGHT_DOT,
      getFillColor: (light) => light.color,
      parameters: { depthWriteEnabled: false },
    })
    const vesselDotLayer = new ScatterplotLayer({
      id: 'vessel-dots',
      beforeId: SKYLINE.id,
      data: vesselDots,
      visible: vesselDots.length > 0,
      radiusUnits: 'pixels',
      getPosition: (dot) => [dot.lng, dot.lat],
      getRadius: VESSEL_DOT,
      getFillColor: VESSEL_CATEGORIES[AIDS],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const trackLayer = new PathLayer({
      id: 'vessel-track',
      beforeId: SKYLINE.id,
      data: vesselTrack ? [vesselTrack] : [],
      visible: !!vesselTrack,
      widthUnits: 'pixels',
      getPath: (path) => path,
      getWidth: 2,
      getColor: [255, 255, 255, 170],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    // the predicted route ahead, in the colour of the track behind but fainter, with a mark every so many hours
    const ahead = vesselRoute?.path ? [vesselRoute.path] : []
    const routeLayer = new PathLayer({
      id: 'vessel-route',
      beforeId: SKYLINE.id,
      data: ahead,
      visible: ahead.length > 0,
      widthUnits: 'pixels',
      getPath: (path) => path,
      getWidth: 2,
      getColor: [103, 232, 249, 150],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const ticks = vesselRoute?.ticks ?? []
    const tickLayer = new ScatterplotLayer({
      id: 'vessel-route-ticks',
      beforeId: SKYLINE.id,
      data: ticks,
      visible: ticks.length > 0,
      radiusUnits: 'pixels',
      getPosition: (tick) => tick.position,
      getRadius: 3,
      getFillColor: [103, 232, 249, 220],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const tickLabels = new TextLayer({
      id: 'vessel-route-labels',
      beforeId: SKYLINE.id,
      data: ticks,
      visible: ticks.length > 0,
      getPosition: (tick) => tick.position,
      getText: (tick) => (tick.hours % 24 ? `+${tick.hours} h` : `day ${tick.hours / 24}`),
      getSize: 11,
      getColor: [207, 250, 254],
      getPixelOffset: [0, -12],
      background: true,
      getBackgroundColor: [15, 23, 42, 190],
      backgroundPadding: [3, 1],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const measureLegs = new PathLayer({
      id: 'measure-legs',
      data: legs,
      visible: legs.length > 0,
      widthUnits: 'pixels',
      getPath: (leg) => [leg.from, leg.to],
      getWidth: 2,
      getColor: (leg) => [...MEASURE_RGB, leg.live ? 150 : 255],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const measurePoints = new ScatterplotLayer({
      id: 'measure-points',
      data: measured,
      visible: measured.length > 0,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      getPosition: (point) => point,
      getRadius: 4,
      getFillColor: MEASURE_RGB,
      getLineColor: [15, 23, 42],
      getLineWidth: 1.5,
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    const measureLabels = new TextLayer({
      id: 'measure-labels',
      data: legs,
      visible: legs.length > 0,
      getPosition: (leg) => [(leg.from[0] + leg.to[0]) / 2, (leg.from[1] + leg.to[1]) / 2],
      getText: (leg) => `${miles(leg.nm)}  ${trueBearing(leg.bearing)}`,
      characterSet: 'auto', // (its default letters have no degree sign)
      getSize: 12,
      getColor: [254, 249, 195],
      background: true,
      getBackgroundColor: [15, 23, 42, 210],
      backgroundPadding: [4, 2],
      getPixelOffset: [0, -12],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    // a fleet vessel's recorded track, from the Fleet tab
    const fleetTrackLayer = new PathLayer({
      id: 'fleet-track',
      beforeId: SKYLINE.id,
      data: fleetTrack?.pieces ?? [],
      visible: !!fleetTrack,
      widthUnits: 'pixels',
      getPath: (piece) => piece.map(([lng, lat]) => [lng, lat]),
      getWidth: 2,
      getColor: [196, 181, 253, 220],
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    })
    overlay.current?.setProps({
      layers: [
        new Charts({ id: 'charts', beforeId: INLAND_WATER.id, visible: !globe, data, showing, standby, show, zoom, level, contours, sun }),
        boxLayer,
        dotLayer,
        ...objectLayers,
        lightLayer,
        currentLayer,
        currentDots,
        currentLabels,
        trackLayer,
        routeLayer,
        tickLayer,
        tickLabels,
        vesselLayer,
        vesselDotLayer,
        fleetTrackLayer,
        measureLegs,
        measurePoints,
        measureLabels,
      ].filter(Boolean),
    })
  }, [kept, showing, standby, show, zoom, level, contourMode, shallow, safety, deep, sunLat, sunLon, lit, filteredWarnings, picked, ready, vesselShapes, vesselModels, standing, afloat, vesselTrack, currentSet, vesselRoute, legs, measured, globe, fleetTrack])

  useEffect(() => {
    if (map.current?.getLayer(INLAND_WATER.id)) {
      map.current.setLayoutProperty(INLAND_WATER.id, 'visibility', show.lndare && !charted ? 'visible' : 'none')
    }
  }, [show.lndare, charted])

  useEffect(() => {
    // they're only there to go with charts, and a coarse chart's coast would leave them standing in the water
    const visibility = show.buildings && detailed ? 'visible' : 'none'
    for (const { id } of [SKYLINE, BUILDINGS]) {
      if (map.current?.getLayer(id)) map.current.setLayoutProperty(id, 'visibility', visibility)
    }
  }, [show.buildings, detailed])

  useEffect(() => {
    fetch('/api/uploads')
      .then((res) => res.json())
      .then(setCharts)
      .catch(() => {}) // the list stays empty; the charts themselves still show
  }, [])

  async function upload(files) {
    setError('')
    for (const file of files) {
      setCompiling(file.name)
      try {
        const body = new FormData()
        body.append('file', file)
        const res = await fetch('/api/uploads', { method: 'POST', body })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `${file.name} failed to compile`)
        const chart = await res.json()
        setCharts((list) => [...list.filter((c) => c.name !== chart.name), chart].sort((a, b) => b.scale - a.scale))
        const [w, s, e, n] = chart.bounds
        map.current.fitBounds([[w, s], [e, n]], { pitch: 50, padding: { top: 60, bottom: 60, left: 320, right: 60 } })
        refresh.current()
      } catch (e) {
        setError(e.message)
      }
    }
    setCompiling('')
  }

  async function removeUpload(name) {
    setError('')
    const res = await fetch(`/api/uploads/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) return setError(`${name} couldn't be removed`)
    setCharts((list) => list.filter((c) => c.name !== name))
    refresh.current()
  }

  if (!ready) return <LoadingScreen sync={sync} />

  const enc = shown.filter((piece) => !/^(WORLD|COAST_|SEA_)/.test(piece.id))

  const shows = (key) => (on) => setShow({ ...show, [key]: on })
  const note = 'text-xs text-slate-400'
  const link = 'underline hover:text-cyan-300'
  // each later phase adds a menu here, or a section to one: 3D models to Chart and Vessels, weather and currents to
  // Conditions, range and bearing as Tools
  const menus = [
    {
      id: 'chart',
      label: 'Chart',
      title: 'Chart',
      icon: ICONS.chart,
      alert: !!(sync?.problem || error),
      body: (
        <>
          <div role="status" className="flex flex-col gap-1">
            <p className="text-slate-300">{syncMessage(sync)}</p>
            {sync?.problem && <p className="text-amber-300">{sync.problem}</p>}
            <p className="flex items-center gap-2 text-slate-400">
              {loading && <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />}
              {loading ? 'Loading charts in view' : `${enc.length} ${enc.length === 1 ? 'ENC' : 'ENCs'} in view`}
            </p>
          </div>

          <Section title="Layers">
            <Toggle checked={show.depare} onChange={shows('depare')}>Depth areas</Toggle>
            <Toggle checked={show.lndare} onChange={shows('lndare')}>Land</Toggle>
            <Toggle checked={show.buildings} onChange={shows('buildings')}>Buildings</Toggle>
            <Toggle checked={show.objects} onChange={shows('objects')}>Buoys, lights and landmarks</Toggle>
            {show.objects && zoom < OBJECTS_ZOOM && <p className={note}>Zoom in further to see these</p>}
          </Section>

          <Section title="Depth contours" className="gap-2">
            <Toggle checked={show.contours} onChange={shows('contours')}>Show contours</Toggle>
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
            <Toggle checked={show.ecdis} disabled={!show.contours} onChange={shows('ecdis')}>ECDIS depth colours</Toggle>
          </Section>

          <Section title="Your charts" className="gap-2">
            <label
              className={`relative block rounded-lg border border-dashed border-slate-500 p-4 text-center focus-within:ring-2 focus-within:ring-cyan-400 ${
                compiling ? 'opacity-60' : 'hover:border-cyan-400'
              }`}
            >
              <span>Drop .000 cells here, or click to choose</span>
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
            {charts.length > 0 && (
              <ul className="flex flex-col gap-1">
                {charts.map((c) => (
                  <li key={c.name} className="flex items-center gap-2">
                    <span className="grow break-all">{c.name}</span>
                    <span className="text-slate-400">1:{c.scale.toLocaleString()}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => removeUpload(c.name)}
                      className="rounded px-1 text-slate-400 hover:text-red-400"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ),
    },
    {
      id: 'vessels',
      label: 'Vessels',
      title: 'Vessels (AIS)',
      icon: ICONS.vessels,
      off: !show.vessels,
      alert: show.vessels && vesselsFailed,
      body: (
        <>
          <Toggle checked={show.vessels} onChange={shows('vessels')}>Show vessels</Toggle>
          {show.vessels && (
            <Section title="Filters">
              <p role="status" className="text-slate-300">
                {vesselsFailed ? 'No AIS data just now' : `${filteredVessels.length} of ${vessels.length} in view`}
              </p>
              {Object.entries(VESSEL_CATEGORIES).map(([name, rgb]) => (
                <Toggle key={name} checked={vesselCategories[name]} onChange={(on) => setVesselCategories({ ...vesselCategories, [name]: on })}>
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: `rgb(${rgb})` }} aria-hidden="true" />
                  {name}
                </Toggle>
              ))}
              {heatmap ? (
                <p className={`mt-2 ${note}`}>Zoomed out this far, they show as a heatmap of traffic: closer in, the vessels themselves.</p>
              ) : (
                smallestVessel > 0 && <p className={`mt-2 ${note}`}>{smallestVessel} m and longer at this zoom: closer in, smaller ones show.</p>
              )}
            </Section>
          )}
          <p className={note}>
            From{' '}
            <a href="https://openwaters.io/ais/" target="_blank" rel="noreferrer" className={link}>
              Open Waters AIS
            </a>{' '}
            and its sources, among them{' '}
            <a href="https://www.aishub.net" target="_blank" rel="noreferrer" className={link}>
              AISHub
            </a>
            . It doesn't reach every vessel, and little of the open ocean.
          </p>
        </>
      ),
    },
    {
      id: 'warnings',
      label: 'Warnings',
      title: 'Nav warnings',
      icon: ICONS.warnings,
      off: !show.warnings,
      body: (
        <>
          <Toggle checked={show.warnings} onChange={shows('warnings')}>Show nav warnings</Toggle>
          {show.warnings && (
            <Section title="Filters">
              <p role="status" className="text-slate-300">
                {!warnings || warnings.loading
                  ? 'Collecting warnings: the first time takes a minute or two'
                  : `${filteredWarnings.length} of ${warnings.warnings.length} showing`}
              </p>
              {Object.entries(WARNING_CATEGORIES).map(([name, rgb]) => (
                <Toggle key={name} checked={warningCategories[name]} onChange={(on) => setWarningCategories({ ...warningCategories, [name]: on })}>
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: `rgb(${rgb})` }} aria-hidden="true" />
                  {name}
                </Toggle>
              ))}
              <label className={`mt-2 flex flex-col gap-1 ${note}`}>
                From
                <select
                  value={warningSource}
                  onChange={(e) => setWarningSource(e.target.value)}
                  className="rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-sm text-slate-100"
                >
                  <option value="">Everywhere</option>
                  {warningSources.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`mt-2 flex flex-col gap-1 ${note}`}>
                Issued
                <select
                  value={warningAge}
                  onChange={(e) => setWarningAge(Number(e.target.value))}
                  className="rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-sm text-slate-100"
                >
                  {WARNING_AGES.map(([label, days]) => (
                    <option key={days} value={days}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {warnings?.cut?.length > 0 && (
                <p className="mt-2 text-xs text-amber-300">
                  Some warnings are missing: {cutFeeds(warnings.cut)} reached SeaLagom's limit of 100, so their oldest are left out.
                </p>
              )}
              {warnings?.unplaced > 0 && <p className={`mt-2 ${note}`}>{warnings.unplaced} more give no position, so aren't on the map.</p>}
            </Section>
          )}
          <p className={note}>
            From{' '}
            <a href="https://www.sealagom.com/" target="_blank" rel="noreferrer" className={link}>
              SeaLagom
            </a>{' '}
            and the UK Hydrographic Office,{warnings?.checked ? ` checked ${new Date(warnings.checked * 1000).toLocaleTimeString()}` : ' hourly'}
          </p>
        </>
      ),
    },
    {
      id: 'conditions',
      label: 'Conditions',
      title: 'Conditions',
      icon: ICONS.conditions,
      body: (
        <>
          <Section title="Shown">
            <Toggle checked={show.tide} onChange={shows('tide')}>Tide bar</Toggle>
            <Toggle checked={show.daylight} onChange={shows('daylight')}>Day and night</Toggle>
          </Section>
          <Section title="Tidal currents">
            <Toggle checked={show.currents} onChange={shows('currents')}>Current arrows</Toggle>
            <p className={note}>
              {zoom < CURRENTS_ZOOM
                ? 'Zoom in further to see them.'
                : 'Predicted at NOAA stations, US waters only. Warmer and longer the stronger they run; a ring is slack.'}
            </p>
          </Section>
          <Section title="Weather">
            {WEATHER_KINDS.map(([key, label, mark]) => (
              <Toggle key={key} checked={show[key]} onChange={shows(key)}>
                {mark}
                <span>{label}</span>
                {show[key] && (
                  <span className="ml-auto text-xs text-slate-300 tabular-nums">
                    {weatherFailed ? 'none just now' : !weatherHere ? '…' : (weatherHere[key] ?? 'none here')}
                  </span>
                )}
              </Toggle>
            ))}
            {wantWeather && <p className={note}>Values at the middle of the view.</p>}
            <p className={note}>
              Forecast and recent hours from{' '}
              <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className={link}>Open-Meteo</a>, CC BY 4.0,
              moving with the tide bar's clock.
            </p>
          </Section>
        </>
      ),
    },
    {
      id: 'tools',
      label: 'Tools',
      title: 'Tools',
      icon: ICONS.tools,
      body: (
        <Section title="Range and bearing" className="gap-2">
          <button
            type="button"
            aria-pressed={measuring}
            onClick={() => (measuring ? stopMeasuring() : setMeasuring(true))}
            className={`rounded-lg px-3 py-1.5 font-medium ${measuring ? 'bg-yellow-300 text-slate-900' : 'bg-slate-800 text-yellow-200 hover:bg-slate-700'}`}
          >
            {measuring ? 'Stop measuring' : measured.length ? 'Measure on from here' : 'Measure'}
          </button>
          <p className={note}>
            Click points on the map. Each leg is along the rhumb line, the straight line on the chart, with its true
            bearing. Esc stops.
          </p>
          {legs.some((leg) => !leg.live) && (
            <ol className="flex flex-col gap-0.5 text-xs tabular-nums">
              {legs
                .filter((leg) => !leg.live)
                .map((leg, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-slate-400">Leg {i + 1}</span>
                    <span>
                      {miles(leg.nm)}, {trueBearing(leg.bearing)}
                    </span>
                  </li>
                ))}
              {legs.filter((leg) => !leg.live).length > 1 && (
                <li className="mt-1 flex justify-between gap-3 border-t border-slate-700 pt-1 font-medium">
                  <span>Total</span>
                  <span>{miles(measuredTotal)}</span>
                </li>
              )}
            </ol>
          )}
          {measured.length > 0 && (
            <button type="button" onClick={() => setMeasured([])} className="self-start rounded px-1 text-xs text-slate-300 underline hover:text-yellow-200">
              Clear
            </button>
          )}
        </Section>
      ),
    },
    {
      id: 'about',
      label: 'About',
      title: 'ENC 3D',
      icon: ICONS.about,
      apart: true,
      body: (
        <>
          <p className="font-medium text-amber-300">Not for navigation.</p>
          <p className="text-slate-300">
            NOAA's electronic navigational charts in 3D, kept up to date, with live tides, vessels and nav warnings.
          </p>
          <p className={note}>
            Beyond the charts: seabed, GEBCO_2026 Grid; coast and buildings, © OpenStreetMap contributors. Basemap ©
            CARTO. Tides and currents, NOAA CO-OPS. Vessels, warnings and weather are credited in their own menus.
          </p>
        </>
      ),
    },
  ]

  return (
    <div className="fixed inset-0 bg-slate-950">
      <div ref={mapBox} className="h-full" />
      <SideMenu menus={menus} />
      {ready && <WeatherCanvas map={map.current} weather={weather} land={land} hour={hourIndex} wind={show.wind} waves={show.waves} swell={show.swell} />}
      {/* the two views, along the top: the map, and the fleets' histories over it */}
      <div role="tablist" aria-label="Views" className="absolute top-3 right-4 z-30 flex rounded-lg border border-slate-700 bg-slate-900/95 p-0.5 text-sm shadow-xl">
        {['map', 'fleet'].map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 ${tab === id ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-300 hover:text-cyan-300'}`}
          >
            {id === 'map' ? 'Map' : 'Fleet'}
          </button>
        ))}
      </div>
      {tab === 'fleet' && <FleetView showTrack={showFleetTrack} />}
      <SearchBar go={goTo} />
      {measuring && (
        <p role="status" className="absolute top-16 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-yellow-300/40 bg-slate-900/95 px-3 py-1.5 text-sm text-yellow-100 shadow-xl">
          Measuring: click to add points{legs.length > 0 && `, ${miles(measuredTotal + (legs.at(-1).live ? legs.at(-1).nm : 0))} so far`}
          <button type="button" onClick={stopMeasuring} className="rounded bg-yellow-300 px-2 py-0.5 text-xs font-medium text-slate-900">
            Done
          </button>
        </p>
      )}
      <p
        role="status"
        aria-hidden={charted || zoom < NO_ENC_ZOOM}
        className={`absolute top-0 left-1/2 -translate-x-1/2 rounded-b-lg bg-red-700 px-5 py-2 text-sm font-semibold text-white shadow-xl transition-transform duration-300 ${
          !charted && zoom >= NO_ENC_ZOOM ? 'translate-y-14' : '-translate-y-full'
        }`}
      >
        No ENCs Loaded
      </p>
      {picked && (
        <section
          aria-label={`Nav warning ${picked.id}`}
          className="absolute top-4 right-4 flex max-h-[60%] w-80 max-w-[calc(100%-2rem)] flex-col gap-2 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 [scrollbar-color:#475569_transparent] [scrollbar-width:thin] p-4 text-sm text-slate-100 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-semibold">{picked.id}</h2>
            <button
              type="button"
              aria-label="Close this warning"
              onClick={() => setPickedWarnings([])}
              className="rounded px-1.5 text-slate-300 hover:text-cyan-300"
            >
              ×
            </button>
          </div>
          <p className="flex items-center gap-2 text-slate-300">
            <span
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: `rgb(${WARNING_CATEGORIES[picked.category]})` }}
              aria-hidden="true"
            />
            {picked.category}
            {picked.issued && `, issued ${new Date(picked.issued * 1000).toLocaleDateString()}`}
            {picked.ends && `, ends ${new Date(picked.ends * 1000).toLocaleDateString()}`}
          </p>
          {picked.placedBy && (
            <p className="text-xs text-amber-300">It gives no position: shown roughly, at {picked.placedBy}, a place it names.</p>
          )}
          {picks.length > 1 && (
            <div className="flex items-center justify-between gap-2 text-slate-300">
              <button
                type="button"
                aria-label="Previous warning here"
                onClick={() => setPickedTurn((picks.indexOf(picked) + picks.length - 1) % picks.length)}
                className="rounded border border-slate-600 px-2 hover:text-cyan-300"
              >
                ‹
              </button>
              {picks.indexOf(picked) + 1} of {picks.length} here
              <button
                type="button"
                aria-label="Next warning here"
                onClick={() => setPickedTurn((picks.indexOf(picked) + 1) % picks.length)}
                className="rounded border border-slate-600 px-2 hover:text-cyan-300"
              >
                ›
              </button>
            </div>
          )}
          <p className="break-words whitespace-pre-wrap text-slate-200">{picked.text}</p>
          <a href={picked.url} target="_blank" rel="noreferrer" className="text-cyan-300 underline">
            See it on {picked.url.includes('sealagom') ? 'SeaLagom' : 'the UKHO site'}
          </a>
        </section>
      )}
      {pickedVessel && <VesselCard vessel={pickedVessel} detail={vesselDetail} route={vesselRoute} close={() => setPickedVessel(null)} />}
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
      <div
        role="status"
        className={`pointer-events-none absolute inset-0 z-20 grid place-items-center bg-slate-900/50 transition-opacity duration-150 ${
          grey ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {grey && <p className="text-xl font-semibold text-slate-100">Loading Items</p>}
      </div>
    </div>
  )
}
