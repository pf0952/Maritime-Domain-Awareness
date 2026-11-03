import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { VectorTile } from '@mapbox/vector-tile'
import * as maplibregl from 'maplibre-gl'
import maplibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { PbfReader } from 'pbf'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY, SOFTWARE, daylightAt, fromOutline, onOutline, overlaps, sunAt, tileAt, tileToLat, tileToLng } from './geo'
import { AIDS, AIS, PLEASURE, VESSEL_CATEGORIES, VESSEL_DOT, VESSEL_FOUND_ZOOM, VESSEL_REFRESH, vesselAt, vesselCategory, vesselLengthAt, vesselShape, vesselTiles } from './vessels'
import { ROMAN, WARNING_AGES, WARNING_CATEGORIES, WARNING_DOT, WARNING_DOT_PICKED, WARNING_EDGE, WARNING_FILL, WARNING_FILL_PICKED, cutFeeds, warningShapes, warningsAt } from './warnings'
import { Charts, unpack } from './meshes'
import { LoadingScreen, SearchBar, TIDE_HOURS, TidePanel, VesselCard, syncMessage } from './panels'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const OCEAN = '#081e42'
const TIER_ZOOMS = [8.5, 11, 13, 15] // the zoom each finer band of charts comes in at
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


export default function App() {
  const mapBox = useRef(null)
  const map = useRef(null)
  const overlay = useRef(null)
  const refresh = useRef(null)
  const cube = useRef(null)
  const overview = useRef(null)
  const footprint = useRef(null)
  const [shown, setShown] = useState([]) // the charts in view
  const [charts, setCharts] = useState([]) // the ones uploaded
  const [loading, setLoading] = useState(false)
  const [tideAsked, setTideAsked] = useState(false) // only the first time: after that the last levels stand meanwhile
  const [skylineLoading, setSkylineLoading] = useState(false)
  const [grey, setGrey] = useState(false)
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
    daylight: true,
    warnings: false,
    vessels: true,
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
  const [warningSource, setWarningSource] = useState('')
  const [warningAge, setWarningAge] = useState(0)
  const [pickedWarnings, setPickedWarnings] = useState([]) // what's under the last click
  const [pickedTurn, setPickedTurn] = useState(0) // which of them is showing
  const warningsOnMap = useRef({ boxes: [], dots: [] }) // for the map's own handlers
  const vesselsOnMap = useRef([])
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
    const layers = (style) => {
      const kept = style.layers
        .filter((l) => !HEAVY_BASEMAP.test(l.id))
        .map((l) => (l.type === 'background' ? { ...l, paint: { 'background-color': OCEAN } } : l))
      kept.splice(kept.findIndex((l) => l.type === 'symbol'), 0, INLAND_WATER, SKYLINE, BUILDINGS)
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
    overlay.current = new MapboxOverlay({
      interleaved: true,
      getCursor: ({ isDragging }) => (isDragging ? 'grabbing' : overWarning.current ? 'pointer' : 'grab'),
    })
    m.addControl(overlay.current)
    map.current = m

    const have = new Map() // key: chart
    let request = null

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
        setCharted(noaa)
        setDetailed(fine.length > 0)
        loadSkyline(fine)
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

    m.on('click', ({ point: { x, y } }) => {
      const vessel = vesselAt(m, vesselsOnMap.current, x, y)
      setPickedVessel(vessel)
      setPickedWarnings(vessel ? [] : warningsAt(m, warningsOnMap.current, x, y))
      setPickedTurn(0)
    })
    let hovering = null
    m.on('mousemove', ({ point }) => {
      if (hovering) return
      hovering = requestAnimationFrame(() => {
        hovering = null
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

  function overviewClicked(e) {
    const svg = overview.current
    const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse())
    map.current.jumpTo({ center: fromOutline(x, y) })
  }

  // a chart has been updated
  useEffect(() => {
    refresh.current?.()
  }, [sync?.revision])

  useEffect(() => {
    vesselsOn.current = show.vessels
    loadVessels.current?.()
  }, [show.vessels, ready])

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
  const vesselsDrawn = show.vessels ? [...filteredVessels, ...searched] : []
  const vesselShapes = useMemo(() => {
    const middle = map.current?.getCenter().lng ?? 0
    // beyond the charts, harbours are painted on the land's top, not cut from it
    const base = charted ? level : LAND_TOP
    return vesselsDrawn.filter((v) => v.kind === 'vessel').map((v) => vesselShape(v, zoom, base, middle))
  }, [filteredVessels, show.vessels, zoom, level, charted, searched[0]])
  const vesselDots = vesselsDrawn.filter((v) => v.kind !== 'vessel')

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

  useEffect(() => {
    const data = shown
    const contours = { contours: contourMode, shallow, safety, deep }
    const sun = { sunLat, sunLon, lit }
    const { boxes, dots } = warningShapes(warningsDrawn, zoom)
    warningsOnMap.current = { boxes, dots }
    const colourOf = ({ warning }) => WARNING_CATEGORIES[warning.category]
    const boxLayer = new PolygonLayer({
      id: 'warning-boxes',
      beforeId: SKYLINE.id,
      data: boxes,
      visible: boxes.length > 0,
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
    const vesselColour = ({ vessel }) =>
      vessel.mmsi === pickedVessel?.mmsi ? [255, 255, 255] : VESSEL_CATEGORIES[vesselCategory(vessel)]
    const vesselLayer = new PolygonLayer({
      id: 'vessels',
      beforeId: SKYLINE.id,
      data: vesselShapes,
      visible: vesselShapes.length > 0,
      extruded: true,
      material: false,
      getPolygon: (shape) => shape.ring,
      getElevation: (shape) => shape.height,
      getFillColor: vesselColour,
      updateTriggers: { getFillColor: pickedVessel?.mmsi },
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
    overlay.current?.setProps({
      layers: [
        new Charts({ id: 'charts', beforeId: INLAND_WATER.id, data, show, zoom, level, contours, sun }),
        boxLayer,
        dotLayer,
        trackLayer,
        vesselLayer,
        vesselDotLayer,
      ],
    })
  }, [shown, show, zoom, level, contourMode, shallow, safety, deep, sunLat, sunLon, lit, filteredWarnings, picked, ready, vesselShapes, pickedVessel, vesselTrack])

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
          className="flex max-h-[calc(100vh-2rem)] w-72 flex-col gap-4 overflow-y-auto rounded-xl [scrollbar-color:#475569_transparent] [scrollbar-width:thin] border border-slate-700 bg-slate-900/90 p-4 text-sm text-slate-100 shadow-xl"
        >
          <h1 className="text-base font-semibold">ENC 3D</h1>

          <div role="status" className="flex flex-col gap-1">
            <p className="text-slate-300">{syncMessage(sync)}</p>
            {sync?.problem && <p className="text-amber-300">{sync.problem}</p>}
            <p className="flex items-center gap-2 text-slate-400">
              {loading && (
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
              )}
              {loading ? 'Loading charts in view' : `${enc.length} ${enc.length === 1 ? 'ENC' : 'ENCs'} in view`}
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
              ['daylight', 'Day and night'],
              ['warnings', 'Nav warnings'],
              ['vessels', 'Vessels (AIS)'],
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

          {show.vessels && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium text-slate-400">Vessel filters</legend>
              <p role="status" className="text-slate-300">
                {vesselsFailed ? 'No AIS data just now' : `${filteredVessels.length} of ${vessels.length} in view`}
              </p>
              {Object.entries(VESSEL_CATEGORIES).map(([name, rgb]) => (
                <label key={name} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-cyan-400"
                    checked={vesselCategories[name]}
                    onChange={(e) => setVesselCategories({ ...vesselCategories, [name]: e.target.checked })}
                  />
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: `rgb(${rgb})` }} aria-hidden="true" />
                  {name}
                </label>
              ))}
              {smallestVessel > 0 && <p className="mt-2 text-xs text-slate-400">{smallestVessel} m and longer at this zoom: closer in, smaller ones show.</p>}
              <p className="mt-1 text-xs text-slate-400">
                From{' '}
                <a href="https://openwaters.io/ais/" target="_blank" rel="noreferrer" className="underline hover:text-cyan-300">
                  Open Waters AIS
                </a>{' '}
                and its sources, among them{' '}
                <a href="https://www.aishub.net" target="_blank" rel="noreferrer" className="underline hover:text-cyan-300">
                  AISHub
                </a>
                . It doesn't reach every vessel, and little of the open ocean.
              </p>
            </fieldset>
          )}

          {show.warnings && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium text-slate-400">Nav warning filters</legend>
              <p role="status" className="text-slate-300">
                {!warnings || warnings.loading
                  ? 'Collecting warnings: the first time takes a minute or two'
                  : `${filteredWarnings.length} of ${warnings.warnings.length} showing`}
              </p>
              {Object.entries(WARNING_CATEGORIES).map(([name, rgb]) => (
                <label key={name} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-cyan-400"
                    checked={warningCategories[name]}
                    onChange={(e) => setWarningCategories({ ...warningCategories, [name]: e.target.checked })}
                  />
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: `rgb(${rgb})` }} aria-hidden="true" />
                  {name}
                </label>
              ))}
              <label className="mt-2 flex flex-col gap-1 text-xs text-slate-400">
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
              <label className="mt-2 flex flex-col gap-1 text-xs text-slate-400">
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
              {warnings?.unplaced > 0 && (
                <p className="mt-2 text-xs text-slate-400">{warnings.unplaced} more give no position, so aren't on the map.</p>
              )}
              <p className="mt-1 text-xs text-slate-400">
                From{' '}
                <a href="https://www.sealagom.com/" target="_blank" rel="noreferrer" className="underline hover:text-cyan-300">
                  SeaLagom
                </a>{' '}
                and the UK Hydrographic Office,{warnings?.checked ? ` checked ${new Date(warnings.checked * 1000).toLocaleTimeString()}` : ' hourly'}
              </p>
            </fieldset>
          )}

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

          <p className="text-xs text-slate-400">Beyond the charts: seabed, GEBCO_2026 Grid; coast, © OpenStreetMap contributors. Not for navigation.</p>
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
      {pickedVessel && <VesselCard vessel={pickedVessel} detail={vesselDetail} close={() => setPickedVessel(null)} />}
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
