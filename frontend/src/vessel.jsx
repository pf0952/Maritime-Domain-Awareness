// The Vessel tab: "Own vessel", read from her documents (backend/vessel_docs.py). The ship, read once: her capacity
// plan (hull lines, particulars, deck heights) and GA. Her loading conditions, each from a stability report (drafts,
// trim, list, GM, as the ship's own approved software printed them) and a stow or load plan, one of them current.
// Nothing here works out stability: the hull is shown floating in the current condition, moving in a sea.
//
// Frame: x m from the aft perpendicular (+ forward), y m from the centreline (+ starboard), z m above the baseline.
import { COORDINATE_SYSTEM, Deck, Layer, OrbitView, project32 } from '@deck.gl/core'
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers'
import { Geometry, Model } from '@luma.gl/engine'
import { useEffect, useMemo, useRef, useState } from 'react'

const DEFAULT_UNIT = [6.1, 2.44, 2.59] // m, a block with no size given: a twenty-foot box
const FIGURES = [
  ['displacement', 'Displacement', 't'], ['deadweight', 'Deadweight', 't'], ['draught_aft', 'Draught aft', 'm'], ['draught_mid', 'Draught mid', 'm'],
  ['draught_fwd', 'Draught fwd', 'm'], ['trim', 'Trim', 'm'], ['list', 'List', '°'], ['gm', 'GM, corrected', 'm'], ['kg', 'KG, corrected', 'm'],
  ['km', 'KM', 'm'], ['lcg', 'LCG', 'm'], ['tcg', 'TCG', 'm'], ['roll_period', 'Roll period', 's'], ['air_draught', 'Air draught', 'm'],
]
const STOW_COLUMNS = [['', '—'], ['weight', 'Weight, t'], ['lcg', 'LCG'], ['tcg', 'TCG'], ['vcg', 'VCG'], ['l', 'Length, m'], ['b', 'Breadth, m'], ['h', 'Height, m']]
// a deck as the stow plan names it given the capacity plan's height for it ("Tween" is the "Tween deck"; the weather
// deck, the main deck), where it has none of its own yet
const deckKey = (name) => name.toLowerCase().replace('weather', 'main').replace(/[^a-z0-9]/g, '').replace(/deck$/, '')
const matchDecks = (v) => ({
  ...v,
  decks: Object.fromEntries(
    Object.entries(v.decks ?? {}).map(([k, h]) => [k, h !== '' && h != null ? h : (Object.entries(v.decks).find(([o, x]) => o !== k && deckKey(o) === deckKey(k) && x !== '' && x != null)?.[1] ?? '')]),
  ),
})
const titled = (name) => name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

const input = 'rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-slate-100 focus:border-cyan-400'
const button = 'rounded-lg bg-slate-800 px-2.5 py-1.5 font-medium text-cyan-200 hover:bg-slate-700 disabled:opacity-40'
const fmt = (v, digits = 2) => (v == null || Number.isNaN(v) ? '–' : (+v).toFixed(digits))
const NUMERIC = /^[-+]?\d+(?:[.,]\d+)?$/

// each line of a table as its name (the words before its first number) and its numbers (a decimal comma too)
export const rowsOf = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => {
      const words = line.trim().split(/\s+/)
      const first = words.findIndex((w) => NUMERIC.test(w))
      if (first < 0) return null
      return { name: words.slice(0, first).join(' '), numbers: words.slice(first).filter((w) => NUMERIC.test(w)).map((w) => +w.replace(',', '.')) }
    })
    .filter((r) => r && r.numbers.length >= 2)

// a length as the document gives it, measured from the aft perpendicular
const fromAp = (v, ref, lbp) => (ref === 'mid_fwd' ? lbp / 2 + v : ref === 'mid_aft' ? lbp / 2 - v : v)

// --- the 3D view: her hull, solid, floating at the stability report's drafts, trim and list, and moving in the sea
// set in the Sea state panel (the waves drawn about her, her roll, pitch and heave from the motions estimate)

const SUN = [-0.4, 0.5, 0.77]
const HULL_RGB = [176, 184, 196]
const SEA_RGB = [12, 52, 82]
const FRAME_MS = 50 // ms between frames drawn: 20 a second, light enough for software rendering
const LIVE_MS = 250 // ms between the live readouts' updates
const CREASE = Math.cos((35 * Math.PI) / 180) // faces meeting more sharply than this keep the edge between them crisp
// a mesh's triangles, shaded smooth over its curves and crisp at its corners: each corner of a face lit by the
// average facing of the faces round that point that meet it at less than the crease angle. As arrays for the
// graphics chip: { attributes, indices }
function solidMesh(mesh, rgb) {
  if (!mesh?.points?.length) return null
  const p = mesh.points
  const t = mesh.triangles
  const nf = t.length / 3
  // each face's normal (its winding may run either way: facing is taken both ways)
  const normals = new Float64Array(nf * 3)
  for (let f = 0; f < nf; f++) {
    const [i, j, k] = [t[3 * f], t[3 * f + 1], t[3 * f + 2]]
    const u = [p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2]]
    const v = [p[3 * k] - p[3 * i], p[3 * k + 1] - p[3 * i + 1], p[3 * k + 2] - p[3 * i + 2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(...n) || 1
    normals.set([n[0] / len, n[1] / len, n[2] / len], 3 * f)
  }
  // the faces round each point (points at the same place counted as one)
  const id = new Map()
  const at = (i) => {
    const key = `${p[3 * i].toFixed(2)},${p[3 * i + 1].toFixed(2)},${p[3 * i + 2].toFixed(2)}`
    if (!id.has(key)) id.set(key, id.size)
    return id.get(key)
  }
  const ids = Array.from({ length: p.length / 3 }, (_, i) => at(i))
  const round = Array.from({ length: id.size }, () => [])
  for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) round[ids[t[3 * f + c]]].push(f)
  const positions = new Float32Array(t.length * 3)
  const colors = new Uint8Array(t.length * 4)
  for (let f = 0; f < nf; f++) {
    const n0 = [normals[3 * f], normals[3 * f + 1], normals[3 * f + 2]]
    for (let c = 0; c < 3; c++) {
      const i = t[3 * f + c]
      const sum = [0, 0, 0]
      for (const g of round[ids[i]]) {
        const d = n0[0] * normals[3 * g] + n0[1] * normals[3 * g + 1] + n0[2] * normals[3 * g + 2]
        if (Math.abs(d) < CREASE) continue // (across a corner: not blended)
        const s = d < 0 ? -1 : 1
        sum[0] += s * normals[3 * g]
        sum[1] += s * normals[3 * g + 1]
        sum[2] += s * normals[3 * g + 2]
      }
      const len = Math.hypot(...sum) || 1
      const light = 0.42 + 0.58 * Math.abs((sum[0] * SUN[0] + sum[1] * SUN[1] + sum[2] * SUN[2]) / len)
      positions.set([p[3 * i], p[3 * i + 1], p[3 * i + 2]], (3 * f + c) * 3)
      colors.set([...rgb.map((x) => Math.round(x * light)), 255], (3 * f + c) * 4)
    }
  }
  return {
    attributes: { positions: { value: positions, size: 3 }, colors: { value: colors, size: 4, normalized: true } },
    indices: { value: Uint32Array.from({ length: t.length }, (_, i) => i), size: 1 },
  }
}

const MESH_VS = `#version 300 es
in vec3 positions;
in vec4 colors;
out vec4 color;
void main() {
  color = colors;
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0));
}`
const MESH_FS = `#version 300 es
precision highp float;
in vec4 color;
out vec4 fragColor;
void main() { fragColor = color; }`

// a solid mesh, colours baked in, moved by its modelMatrix (her pose each frame costs only that)
class SolidMesh extends Layer {
  initializeState() {}

  updateState({ props, oldProps }) {
    if (props.mesh === oldProps.mesh) return
    this.state.model?.destroy()
    this.state.model = props.mesh && new Model(this.context.device, {
      ...this.getShaders({ vs: MESH_VS, fs: MESH_FS, modules: [project32] }),
      id: props.id,
      geometry: new Geometry({ topology: 'triangle-list', ...props.mesh }),
      bufferLayout: this.getAttributeManager().getBufferLayouts(),
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal', cullMode: 'none' },
    })
  }

  draw() {
    this.state.model?.draw(this.context.renderPass)
  }

  finalizeState(context) {
    super.finalizeState(context)
    this.state.model?.destroy()
  }
}
SolidMesh.layerName = 'SolidMesh'

// column-major 4×4 matrices, as deck.gl takes them
const mul = (a, b) => {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
const move = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const aboutY = (t) => [Math.cos(t), 0, -Math.sin(t), 0, 0, 1, 0, 0, Math.sin(t), 0, Math.cos(t), 0, 0, 0, 0, 1] // (+ bow up)
const aboutX = (t) => [1, 0, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, 0, Math.sin(t), Math.cos(t), 0, 0, 0, 0, 1] // (+ starboard down)

// where she floats: the waterline amidships at the sea's level, trimmed and listed as the report gives her, then
// heaved, pitched and rolled
function pose(vessel, mid, heave = 0, pitch = 0, roll = 0) {
  const f = vessel.report.figures
  const lbp = vessel.principal.lbp
  const aft = f.draught_aft ?? f.draught_mid ?? 0
  const fwd = f.draught_fwd ?? f.draught_mid ?? aft
  const draught = f.draught_mid ?? (aft + fwd) / 2
  const trim = Math.atan2(aft - fwd, lbp) // (+ by the stern: her bow up)
  const list = ((f.list ?? 0) * Math.PI) / 180
  return [move(mid, 0, heave), aboutY(trim + pitch), aboutX(list + roll), move(-mid, 0, -draught)].reduce(mul)
}

// her motions and the sea's surface at a time, from the waves the server split the sea into, each with a phase
function motionAt(waves, t) {
  let heave = 0
  let pitch = 0
  let roll = 0
  for (const w of waves) {
    const a = w.phase - w.omega_e * t
    const mu = (w.mu * Math.PI) / 180
    heave += w.heave * Math.cos(a)
    pitch += w.pitch * Math.sin(a) * Math.sign(Math.cos(mu) || 1)
    roll += w.roll * Math.sin(a) * Math.sign(Math.sin(mu) || 1)
  }
  return { heave, pitch, roll }
}
const surface = (waves, x, y, t) => waves.reduce((z, w) => z + w.amp * Math.cos(w.k * (x * w.cx + y * w.sy) - w.omega_e * t + w.phase), 0)

function VesselView({ vessel, sea, active, onLive }) {
  const box = useRef(null)
  const deck = useRef(null)
  const { lbp, breadth: beam } = vessel.principal
  const depth = vessel.principal.depth || beam * 0.6
  const [aft, fore] = useMemo(() => {
    const xs = vessel.hull?.points?.filter((_, i) => i % 3 === 0)
    return xs?.length ? [Math.min(...xs), Math.max(...xs)] : [0, lbp]
  }, [vessel])
  const mid = lbp / 2
  // her hull as read off the capacity plan, solid; else a box of her particulars
  const hull = useMemo(() => solidMesh(vessel.hull, HULL_RGB), [vessel])
  const blockHull = useMemo(() => [{ polygon: [[0, -beam / 2, 0], [lbp * 0.85, -beam / 2, 0], [lbp, 0, 0], [lbp * 0.85, beam / 2, 0], [0, beam / 2, 0]] }], [vessel])
  // the waves with phases of their own (random, as a sea's are), relative to her
  const waves = useMemo(
    () => (sea?.components ?? []).map((w) => ({ ...w, phase: Math.random() * 2 * Math.PI, cx: Math.cos((w.mu * Math.PI) / 180), sy: Math.sin((w.mu * Math.PI) / 180) })),
    [sea],
  )
  useEffect(() => {
    const width = box.current.clientWidth || 800
    deck.current = new Deck({
      parent: box.current,
      views: new OrbitView({ orbitAxis: 'Z', fovy: 35 }),
      initialViewState: { target: [(aft + fore) / 2, 0, 2], rotationOrbit: -35, rotationX: 18, zoom: Math.log2(width / ((fore - aft) * 1.5)), minZoom: -4, maxZoom: 6 },
      controller: true,
    })
    return () => deck.current?.finalize()
  }, [vessel])
  useEffect(() => {
    const span = [aft - 70, fore + 70]
    const reach = Math.max(70, beam * 3)
    const draw = (t) => {
      const m = waves.length ? motionAt(waves, t) : { heave: 0, pitch: 0, roll: 0 }
      const lines = []
      if (waves.length) {
        for (let y = -reach; y <= reach; y += 10) {
          const path = []
          for (let x = span[0]; x <= span[1]; x += 4) path.push([x, y, surface(waves, x - mid, y, t)])
          lines.push(path)
        }
        for (let x = span[0]; x <= span[1]; x += 15) {
          const path = []
          for (let y = -reach; y <= reach; y += 4) path.push([x, y, surface(waves, x - mid, y, t)])
          lines.push(path)
        }
      }
      deck.current?.setProps({
        layers: [
          new SolidPolygonLayer({
            id: 'sea',
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            data: [{ polygon: [[span[0], -reach, 0], [span[1], -reach, 0], [span[1], reach, 0], [span[0], reach, 0]] }],
            getPolygon: (d) => d.polygon,
            getFillColor: [...SEA_RGB, 235],
          }),
          hull
            ? new SolidMesh({ id: 'hull', coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, modelMatrix: pose(vessel, mid, m.heave, m.pitch, m.roll), mesh: hull })
            : new SolidPolygonLayer({
                id: 'hull-box',
                coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
                modelMatrix: pose(vessel, mid, m.heave, m.pitch, m.roll),
                data: blockHull,
                extruded: true,
                getElevation: depth,
                getPolygon: (d) => d.polygon,
                getFillColor: HULL_RGB,
              }),
          new PathLayer({
            id: 'waves',
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            data: lines,
            getPath: (d) => d,
            getColor: [148, 197, 230, 150],
            getWidth: 1,
            widthUnits: 'pixels',
          }),
        ],
      })
      return m
    }
    if (!active || !waves.length) {
      draw(0)
      return
    }
    let frame
    let last = 0
    let told = 0
    const start = performance.now()
    const tick = (now) => {
      frame = requestAnimationFrame(tick)
      if (now - last < FRAME_MS) return
      last = now
      const m = draw((now - start) / 1000)
      if (now - told > LIVE_MS) {
        told = now
        onLive?.({ roll: (m.roll * 180) / Math.PI, pitch: (m.pitch * 180) / Math.PI, heave: m.heave })
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [vessel, waves, active, hull])
  return <div ref={box} className="relative h-full min-h-80 w-full" aria-label="3D view of the vessel in the sea. Drag to rotate, scroll to zoom." />
}

// the sea she's in: the forecast now at a place (the map's centre, say), or one set by hand; her heading and speed
function SeaPanel({ vessel, sea, setSea, live }) {
  const [where, setWhere] = useState(() => {
    const c = window.mdaMapCentre?.()
    return c ? { lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3) } : { lat: '', lng: '' }
  })
  const [heading, setHeading] = useState(0)
  const [speed, setSpeed] = useState(12)
  const [manual, setManual] = useState(false)
  const [set, setSet] = useState({ hs: 2.5, period: 8, from: 0 })
  const [state, setState] = useState('')
  const asked = useRef(0)
  const ask = async () => {
    const mine = ++asked.current
    setState('Loading sea state…')
    const body = { heading: +heading, speed: +speed, ...(manual ? { sea: [[+set.hs, +set.period, +set.from]] } : { lat: +where.lat, lng: +where.lng }) }
    const res = await fetch(`/api/vessels/${vessel.id}/sea`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const answer = res ? await res.json().catch(() => ({})) : { detail: 'Server could not be reached.' }
    if (mine !== asked.current) return // (a later request's answer counts, not this one)
    if (!res?.ok) return setState(answer.detail ?? 'Sea state could not be loaded.')
    setState('')
    setSea(answer)
  }
  useEffect(() => {
    if (manual || (where.lat !== '' && where.lng !== '')) ask()
  }, [vessel.id])
  const num = (label, value, change, props = {}) => (
    <label className="flex flex-col gap-0.5 text-slate-400">
      {label}
      <input type="number" step="any" value={value} onChange={(e) => change(e.target.value)} className={input} {...props} />
    </label>
  )
  const f = sea?.forecast
  const m = sea?.motion
  return (
    <section aria-label="Sea state" className="flex flex-col gap-2 text-sm">
      <h2 className="font-medium">Sea state</h2>
      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1"><input type="radio" checked={!manual} onChange={() => setManual(false)} /> Forecast now</label>
        <label className="flex items-center gap-1"><input type="radio" checked={manual} onChange={() => setManual(true)} /> Set manually</label>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        {manual ? (
          <>
            {num('Wave height Hs, m', set.hs, (x) => setSet({ ...set, hs: x }), { min: 0, max: 20 })}
            {num('Period, s', set.period, (x) => setSet({ ...set, period: x }), { min: 2, max: 25 })}
            {num('From, °T', set.from, (x) => setSet({ ...set, from: x }), { min: 0, max: 360 })}
          </>
        ) : (
          <>
            {num('Latitude', where.lat, (x) => setWhere({ ...where, lat: x }))}
            {num('Longitude', where.lng, (x) => setWhere({ ...where, lng: x }))}
            <button type="button" className={`${button} col-span-2`} onClick={() => { const c = window.mdaMapCentre?.(); if (c) setWhere({ lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3) }) }}>
              Use map centre
            </button>
          </>
        )}
        {num('Heading, °T', heading, setHeading, { min: 0, max: 360 })}
        {num('Speed, kn', speed, setSpeed, { min: 0, max: 30 })}
      </div>
      <button type="button" className={button} onClick={ask}>Apply</button>
      {state && <p className="text-xs text-amber-200">{state}</p>}
      {sea && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs tabular-nums">
          {f && (
            <>
              <dt className="text-slate-400">Waves (total)</dt>
              <dd className="text-right">{fmt(f.wave, 1)} m, {fmt(f.period, 1)} s, from {fmt(f.waveFrom, 0)}°</dd>
              {f.swell != null && (
                <>
                  <dt className="text-slate-400">Swell</dt>
                  <dd className="text-right">{fmt(f.swell, 1)} m, {fmt(f.swellPeriod, 1)} s, from {fmt(f.swellFrom, 0)}°</dd>
                </>
              )}
              {f.wind != null && (
                <>
                  <dt className="text-slate-400">Wind</dt>
                  <dd className="text-right">{fmt(f.wind, 0)} kn from {fmt(f.windFrom, 0)}°</dd>
                </>
              )}
            </>
          )}
          <dt className="text-slate-400">Roll, significant</dt>
          <dd className="text-right">{fmt(m.roll, 1)}°</dd>
          <dt className="text-slate-400">Pitch, significant</dt>
          <dd className="text-right">{fmt(m.pitch, 1)}°</dd>
          <dt className="text-slate-400">Heave, significant</dt>
          <dd className="text-right">{fmt(m.heave, 2)} m</dd>
          <dt className="text-slate-400">Roll period</dt>
          <dd className="text-right">{fmt(m.roll_period, 1)} s</dd>
          {live && (
            <>
              <dt className="text-slate-400">Now: roll / pitch / heave</dt>
              <dd className="text-right">{fmt(live.roll, 1)}° / {fmt(live.pitch, 1)}° / {fmt(live.heave, 2)} m</dd>
            </>
          )}
        </dl>
      )}
      {m?.warnings?.map((w) => (
        <p key={w} className="text-xs text-amber-200">⚠ {w}</p>
      ))}
      <p className="text-xs text-slate-500">Motions estimated from the report's GM and roll period and the sea state, not from vessel seakeeping data. Planning aid only. Not for navigation.</p>
    </section>
  )
}

// --- reading the documents

// a document read: what was found (or why not), and its pages one at a time, with a button to send a page's text on
function Pages({ doc, send }) {
  const [page, setPage] = useState(0)
  const a = doc?.answer
  if (!doc) return <p className="text-slate-500">Not loaded. Add it above.</p>
  if (doc.reading) return <p className="text-cyan-200">Reading {doc.name}…</p>
  if (doc.error) return <p className="text-amber-200">{doc.name}: {doc.error}</p>
  const pages = a.pages ?? []
  const note = a.drawn_only
    ? a.capacity?.words
      ? `Text is drawn as vector lines (CAD export). ${a.capacity.words} words read by OCR; check the results below.`
      : (a.problem ?? 'This PDF has no text layer (vector drawing or scan). Enter the required figures below.')
    : (a.problem ?? '')
  return (
    <div className="flex flex-col gap-1">
      <p className="text-slate-400">{doc.name}</p>
      {note && <p className="text-amber-200">{note}</p>}
      {pages.some((t) => t.trim()) && (
        <>
          <div className="flex items-center gap-2 text-slate-400">
            <label>
              Page <input type="number" min="1" max={pages.length} value={page + 1} onChange={(e) => setPage(Math.min(pages.length, Math.max(1, +e.target.value)) - 1)} className={`${input} w-16`} />
            </label>
            <span>of {pages.length}</span>
            {send && (
              <button type="button" className={`${button} ml-auto`} onClick={() => send(pages[page] ?? '')}>
                Use this page ↓
              </button>
            )}
          </div>
          <pre className="max-h-40 overflow-auto rounded bg-slate-950 p-2 text-[10px] leading-tight text-slate-300 [scrollbar-width:thin]">{pages[page] || '(No text on this page)'}</pre>
        </>
      )}
    </div>
  )
}

// the documents dropped or chosen, all at once: each read in the background (the map can be used meanwhile), what it
// was taken for (changeable), how long it's taking
const READ_TIME = { capacity: 'about 3 min if drawn (text by OCR, then hull lines traced)', ga: 'about 2 min if drawn (text by OCR)', report: 'a few seconds', stow: 'a few seconds' }
function Uploads({ queue, add, retake, now, scope }) {
  const [over, setOver] = useState(false)
  const pick = useRef(null)
  const reading = queue.filter((q) => q.reading)
  return (
    <section aria-label="Documents to read" className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => pick.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          add([...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name)))
        }}
        className={`flex flex-col items-center gap-1 rounded-lg border-2 border-dashed px-3 py-4 text-center ${over ? 'border-cyan-400 bg-cyan-400/10' : 'border-slate-700 hover:border-slate-500'}`}
      >
        <span className="font-medium text-slate-200">Drop PDFs here or click to select</span>
        <span className="text-slate-400">{scope === 'ship' ? 'Capacity plan and general arrangement (GA)' : 'Stability report and stow or load plan'}, together or one at a time. Each is identified automatically.</span>
      </button>
      <input ref={pick} type="file" accept=".pdf" multiple className="hidden" aria-label="Vessel documents (PDF)" onChange={(e) => { add([...e.target.files]); e.target.value = '' }} />
      {queue.length > 0 && (
        <ul className="flex flex-col gap-1">
          {queue.map((q) => (
            <li key={q.id} className="flex items-center gap-2 rounded border border-slate-800 px-2 py-1">
              {q.reading ? (
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-cyan-300 border-t-transparent" aria-hidden="true" />
              ) : (
                <span className={`shrink-0 ${q.error ? 'text-amber-300' : 'text-emerald-300'}`} aria-hidden="true">{q.error ? '!' : '✓'}</span>
              )}
              <span className="min-w-0 flex-1 truncate" title={q.name}>{q.name}</span>
              {q.reading ? (
                <span className="shrink-0 tabular-nums text-slate-400">{Math.round((now - q.started) / 1000)} s</span>
              ) : q.error ? (
                <span className="shrink-0 text-amber-200" title={q.error}>Failed</span>
              ) : (
                <select value={q.kind} onChange={(e) => retake(q, e.target.value)} className={`shrink-0 bg-slate-950 ${q.wrong ? 'text-amber-200' : ''}`} aria-label={`${q.name}: document type`}
                  title={q.wrong ? `A ${KIND_LABEL[q.kind]?.toLowerCase()}: add it to ${OTHER_PLACE[scope]} instead` : undefined}>
                  {Object.entries(KIND_LABEL).map(([k, label]) => (
                    <option key={k} value={k} disabled={q.drawn && !['capacity', 'ga'].includes(k)}>{label}</option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}
      {queue.filter((q) => q.wrong).map((q) => (
        <p key={q.id} className="text-amber-200">{q.name} reads as a {KIND_LABEL[q.kind]?.toLowerCase()}: not used here. Add it to {OTHER_PLACE[scope]}.</p>
      ))}
      {reading.length > 0 && (
        <p className="text-cyan-200">
          Reading {reading.length} document{reading.length > 1 ? 's' : ''}: {READ_TIME[reading[0].kind] ?? 'up to 3 min if a drawn plan is read (text by OCR, then hull lines traced)'}. The map and other tabs can be used meanwhile.
        </p>
      )}
    </section>
  )
}

// a table's rows, pasted or sent from a page, each numeric column said to be what it is; added to the list
function Table({ text, setText, columns, lbp, add, children, label }) {
  const [map, setMap] = useState({})
  const [ref, setRef] = useState('ap')
  const [port, setPort] = useState(false)
  // (the table's own rows: those with as many numbers as most have, not a heading's or a total's)
  const all = rowsOf(text)
  const counts = all.reduce((c, r) => ({ ...c, [r.numbers.length]: (c[r.numbers.length] ?? 0) + 1 }), {})
  const width = +(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0)
  const rows = all.filter((r) => r.numbers.length === width)
  const take = () => {
    const at = Object.fromEntries(Object.entries(map).filter(([, q]) => q).map(([i, q]) => [q, +i]))
    add(
      rows.map((r) => {
        const v = (q) => (at[q] != null ? r.numbers[at[q]] : null)
        return {
          name: r.name,
          ...Object.fromEntries(['capacity', 'weight', 'vcg'].map((q) => [q, v(q)])),
          lcg: v('lcg') == null ? null : fromAp(v('lcg'), ref, lbp),
          tcg: v('tcg') == null ? null : port ? -v('tcg') : v('tcg'),
          size: v('l') && v('b') && v('h') ? [v('l'), v('b'), v('h')] : null,
        }
      }),
    )
    setText('')
  }
  return (
    <div className="flex flex-col gap-1">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Paste table rows, or use a page above" className={`${input} font-mono`} aria-label={label} />
      {width > 0 && (
        <>
          <p className="text-slate-400">{rows.length} rows read. Assign each column:</p>
          <div className="overflow-x-auto [scrollbar-width:thin]">
            <table className="tabular-nums">
              <thead>
                <tr>
                  <th className="px-0.5 text-left font-normal text-slate-400">Name</th>
                  {Array.from({ length: width }, (_, i) => (
                    <th key={i} className="px-0.5 font-normal">
                      <select value={map[i] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [i]: e.target.value }))} className="bg-slate-950 text-[10px]" aria-label={`${label}, column ${i + 1}`}>
                        {columns.map(([v, l]) => (
                          <option key={v} value={v}>{l}</option>
                        ))}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 4).map((r, k) => (
                  <tr key={k} className="text-slate-300">
                    <td className="max-w-24 truncate px-1">{r.name}</td>
                    {Array.from({ length: width }, (_, i) => (
                      <td key={i} className="px-1 text-right">{r.numbers[i] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-slate-400">
            <select value={ref} onChange={(e) => setRef(e.target.value)} className="bg-slate-950" aria-label={`${label}, LCG reference`}>
              <option value="ap">LCG from AP, + fwd</option>
              <option value="mid_fwd">LCG from midships, + fwd</option>
              <option value="mid_aft">LCG from midships, + aft</option>
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={port} onChange={(e) => setPort(e.target.checked)} /> TCG + to port
            </label>
            {children}
            <button type="button" className={`${button} ml-auto`} disabled={!lbp && ref !== 'ap'} onClick={take}>
              Add {rows.length} rows
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function StowList({ v, setV }) {
  const set = (i, change) => setV((d) => ({ ...d, stow: d.stow.map((u, k) => (k === i ? { ...u, ...change, unplaced: false } : u)) }))
  const decks = Object.keys(v.decks ?? {})
  const cell = 'w-full min-w-0 rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-right text-slate-100'
  return (
    <div className="flex flex-col gap-2">
      <p className="text-slate-400">
        {v.stow.length} units, {fmt(v.stow.reduce((t, u) => t + (u.weight || 0), 0), 1)} t as read. Check before saving.{' '}
        <button type="button" className="text-red-300 underline" onClick={() => setV({ ...v, stow: [] })}>Clear</button>
      </p>
      <div className="overflow-x-auto [scrollbar-width:thin]">
        <table className="w-full tabular-nums">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left font-normal">Unit</th>
              <th className="font-normal">t</th>
              <th className="font-normal" title="From AP, + forward">LCG</th>
              <th className="font-normal" title="+ to starboard">TCG</th>
              <th className="text-left font-normal">Deck</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {v.stow.map((u, i) => (
              <tr key={i} className={u.unplaced ? 'text-amber-200' : ''}>
                <td className="max-w-28 truncate pr-1" title={`${u.name}${u.size ? `, ${u.size.join(' × ')} m` : ''}${u.unplaced ? ': listed in the plan key but not drawn. Enter its position.' : ''}`}>{u.name}</td>
                {['weight', 'lcg', 'tcg'].map((k) => (
                  <td key={k} className="w-14">
                    <input type="number" step="any" value={u[k] ?? ''} onChange={(e) => set(i, { [k]: e.target.value === '' ? null : +e.target.value })} className={cell} aria-label={`${u.name}, ${k}`} />
                  </td>
                ))}
                <td>
                  <select value={u.deck ?? ''} onChange={(e) => set(i, { deck: e.target.value || null })} className="bg-slate-950" aria-label={`${u.name}, deck`}>
                    <option value="">VCG {u.vcg ?? '?'}</option>
                    {decks.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button type="button" aria-label={`Remove ${u.name}`} className="px-1 text-slate-400 hover:text-red-300" onClick={() => setV((d) => ({ ...d, stow: d.stow.filter((_, k) => k !== i) }))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-slate-500">VCG = deck height (from the capacity plan) + half the unit height. LCG from the drawing scale; TCG estimated about the centreline where units are drawn side by side.</p>
    </div>
  )
}

// what a document read holds, for any field still empty: the ship's name and particulars, the decks' heights, a
// tank table. (The condition's figures come from the stability report only, the units from the stow plan only.)
const DOC_NAMES = { capacity: 'capacity plan', ga: 'general arrangement', report: 'stability report', stow: 'stow plan' }
const blank = (x) => x === '' || x == null
const LBP_OF_LOA = 0.95 // LBP as a share of LOA, about, for a cargo ship: an estimate where no document states the LBP
const ESTIMATED = 'Estimated'
function absorb(d, a, kind) {
  const read = a.particulars ?? {}
  // (an estimate gives way to any document that states the figure)
  const open = (k) => blank(d.principal[k]) || d.principalSource?.[k]?.startsWith(ESTIMATED)
  const filled = Object.keys(read).filter((k) => k in d.principal && open(k))
  const v = {
    ...d,
    name: d.name || titled(a.name ?? ''),
    principal: { ...d.principal, ...Object.fromEntries(filled.map((k) => [k, read[k]])) },
    principalSource: { ...d.principalSource, ...Object.fromEntries(filled.map((k) => [k, `From the ${DOC_NAMES[kind]}${a.particulars_source?.[k] ? `, ${a.particulars_source[k]}` : ''}`])) },
    decks: { ...d.decks, ...Object.fromEntries(Object.entries(a.decks ?? {}).filter(([k]) => blank(d.decks?.[k])).map(([k, h]) => [k, h])) },
    hull: kind === 'capacity' && a.hull?.points ? a.hull : (d.hull ?? null), // (only a capacity plan gives her hull, and a new one replaces it)
  }
  // no breadth or length printed: measured off the hull read from the capacity plan (twice its widest half-breadth,
  // its length overall)
  const pts = v.hull?.points
  if (pts?.length) {
    let ymax = 0
    let xmin = Infinity
    let xmax = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      ymax = Math.max(ymax, Math.abs(pts[i + 1]))
      xmin = Math.min(xmin, pts[i])
      xmax = Math.max(xmax, pts[i])
    }
    const fromHull = { breadth: Math.round(ymax * 20) / 10, loa: Math.round((xmax - xmin) * 10) / 10 }
    for (const [k, value] of Object.entries(fromHull)) {
      if (blank(v.principal[k]) && value > 0) {
        v.principal = { ...v.principal, [k]: value }
        v.principalSource = { ...v.principalSource, [k]: 'Measured off the hull lines read from the capacity plan' }
      }
    }
  }
  // no LBP stated anywhere yet, but an LOA: the LBP estimated from it, marked so, rather than holding the vessel up
  if (blank(v.principal.lbp) && +v.principal.loa > 0) {
    v.principal = { ...v.principal, lbp: Math.round(v.principal.loa * LBP_OF_LOA * 10) / 10 }
    v.principalSource = { ...v.principalSource, lbp: `${ESTIMATED} as ${LBP_OF_LOA} × LOA: not stated in the documents read. Replace it if known.` }
  }
  // no depth stated: the moulded depth is the main (or upper) deck's height above base, as a capacity plan gives it
  const deck = Object.entries(v.decks ?? {}).find(([k, h]) => /^(main|upper) deck$/i.test(k) && +h > 0)
  if (blank(v.principal.depth) && deck) {
    v.principal = { ...v.principal, depth: +deck[1] }
    v.principalSource = { ...v.principalSource, depth: `${deck[0]} height above base, from the deck heights read` }
  }
  return matchDecks(v)
}

// the documents each builder takes: the ship's (as built, read once) and a loading condition's (each voyage's)
const SCOPE_KINDS = { ship: ['capacity', 'ga'], condition: ['report', 'stow'] }
const KIND_LABEL = { capacity: 'Capacity plan', ga: 'General arrangement', report: 'Stability report', stow: 'Stow / load plan' }
const OTHER_PLACE = { ship: 'a loading condition', condition: 'the ship (Edit ship)' }

function Builder({ scope, start, vessel, saved, cancel }) {
  const [v, setV] = useState(start)
  const [docs, setDocs] = useState({}) // kind: { name, answer }
  const [queue, setQueue] = useState([]) // each file read: { id, name, kind, reading, started, error, drawn, wrong }
  const [now, setNow] = useState(Date.now())
  const reading = queue.some((q) => q.reading)
  const kinds = SCOPE_KINDS[scope]
  // (a clock for the elapsed times, while anything's being read; and the map told, for its progress chip)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('vessel-reading', { detail: { reading: queue.filter((q) => q.reading).map((q) => q.name), done: queue.length > 0 && !reading } }))
    if (!reading) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [queue, reading])
  // a document read, put to use as the kind given (if it's one this builder takes)
  const apply = (kind, name, a) => {
    if (!kinds.includes(kind)) return
    setDocs((all) => ({ ...all, [kind]: { name, answer: a } }))
    setV((d) => {
      const base = { ...d, documents: { ...d.documents, [kind]: name }, found: { ...(a.particulars ?? {}), ...(d.found ?? {}) } }
      if (kind === 'report') return { ...base, name: d.name || name.replace(/\.pdf$/i, ''), report: { figures: { ...a.figures }, source: { ...a.source }, items: a.items ?? [] } }
      if (kind === 'stow') {
        const drawn = a.drawing?.units ?? []
        return matchDecks({
          ...base,
          stow: drawn.length ? drawn.map((u) => ({ ...u, size: u.size ?? (u.height ? [...DEFAULT_UNIT.slice(0, 2), u.height] : null) })) : d.stow,
          decks: { ...Object.fromEntries(drawn.filter((u) => u.deck).map((u) => [u.deck, ''])), ...d.decks },
        })
      }
      return absorb(base, a, kind)
    })
  }
  const add = (files) => {
    for (const file of files) {
      const id = `${file.name}-${Date.now()}-${Math.random()}`
      setQueue((q) => [...q, { id, name: file.name, kind: null, reading: true, started: Date.now() }])
      const body = new FormData()
      body.append('file', file)
      fetch('/api/vessels/pdf?kind=auto', { method: 'POST', body })
        .then(async (res) => {
          const a = await res.json()
          if (!res.ok) throw new Error(a.detail ?? `Request failed (${res.status})`)
          const wrong = !kinds.includes(a.kind)
          setQueue((q) => q.map((x) => (x.id === id ? { ...x, reading: false, kind: a.kind, drawn: a.drawn_only, answer: a, wrong } : x)))
          apply(a.kind, file.name, a)
        })
        .catch((e) => setQueue((q) => q.map((x) => (x.id === id ? { ...x, reading: false, error: e.message === 'Failed to fetch' ? 'Server could not be reached.' : e.message } : x))))
    }
  }
  // a document taken for the wrong one: put to use as the one chosen
  const retake = (q, kind) => {
    setQueue((all) => all.map((x) => (x.id === q.id ? { ...x, kind, wrong: !kinds.includes(kind) } : x)))
    apply(kind, q.name, q.answer)
  }
  const [stowText, setStowText] = useState('')
  const [problem, setProblem] = useState('')
  const lbp = +(scope === 'ship' ? v.principal?.lbp : vessel?.principal?.lbp)
  const save = async () => {
    setProblem('')
    let body
    if (scope === 'ship') {
      const { principalSource, ...ship } = v
      body = { ...(vessel ?? { conditions: [] }), ...ship }
    } else {
      const stow = v.stow.map((u) => {
        const deck = v.decks?.[u.deck]
        const high = u.size?.[2] ?? u.height ?? DEFAULT_UNIT[2]
        return { ...u, vcg: deck !== undefined && deck !== '' ? +deck + high / 2 : u.vcg }
      })
      const cond = { id: v.id, name: v.name.trim() || 'Loading condition', report: v.report, stow, documents: v.documents, saved: new Date().toISOString() }
      const others = (vessel.conditions ?? []).filter((c) => c.id !== cond.id)
      // the ship's particulars left blank filled from what this condition's documents print (a stow plan's LOA and
      // beam, say), and her LBP estimated from an LOA if still not known
      const principal = { ...vessel.principal }
      for (const k of ['lbp', 'loa', 'breadth', 'depth']) if (blank(principal[k]) && v.found?.[k]) principal[k] = v.found[k]
      if (blank(principal.lbp) && +principal.loa > 0) principal.lbp = Math.round(principal.loa * LBP_OF_LOA * 10) / 10
      body = { ...vessel, principal, conditions: [...others, cond], current: cond.id }
    }
    const res = await fetch('/api/vessels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    if (!res) return setProblem('Could not be saved: server could not be reached. Restart the app from its shortcut.')
    const answer = await res.json().catch(() => ({}))
    if (!res.ok) return setProblem(`Could not be saved: ${answer.detail ?? `request failed (${res.status})`}`)
    saved(answer.id)
  }
  const field = (label, value, set) => (
    <label className="flex flex-col gap-0.5 text-slate-400">
      {label}
      <input type="number" step="any" value={value ?? ''} onChange={(e) => set(e.target.value)} className={input} />
    </label>
  )
  return (
    <div className="flex flex-col gap-4 text-xs">
      <h2 className="text-sm font-medium text-slate-200">{scope === 'ship' ? 'Ship' : 'Loading condition'}</h2>
      <label className="flex flex-col gap-0.5 text-slate-400">
        {scope === 'ship' ? 'Vessel name' : 'Condition name'}
        <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={input} />
      </label>

      <Uploads queue={queue} add={add} retake={retake} now={now} scope={scope} />

      {scope === 'ship' ? (
        <>
          <section className="flex flex-col gap-2" aria-label="Capacity plan">
            <h3 className="font-medium text-slate-200">Capacity plan</h3>
            <Pages doc={docs.capacity} />
            <p className="text-slate-500">{v.hull?.points?.length ? 'Hull lines read from the capacity plan.' : 'Hull lines come from the capacity plan’s frame sections and profile.'}</p>
          </section>
          <section className="flex flex-col gap-2" aria-label="General arrangement">
            <h3 className="font-medium text-slate-200">General arrangement</h3>
            <Pages doc={docs.ga} />
            <p className="text-slate-500">Kept with the ship; its particulars and deck heights fill any left empty.</p>
          </section>
          <section className="flex flex-col gap-2" aria-label="Particulars">
            <h3 className="font-medium text-slate-200">Particulars and decks</h3>
            <div className="grid grid-cols-4 gap-1.5">
              {[['LBP, m', 'lbp'], ['LOA, m', 'loa'], ['Breadth, m', 'breadth'], ['Depth, m', 'depth']].map(([label, key]) => (
                <div key={key} title={v.principalSource?.[key] ?? 'Not found in the documents. Enter manually.'}>
                  {field(label, v.principal[key], (x) => setV((d) => ({ ...d, principal: { ...d.principal, [key]: x }, principalSource: { ...d.principalSource, [key]: 'Entered manually' } })))}
                </div>
              ))}
            </div>
            {Object.keys(v.decks ?? {}).length > 0 && (
              <div className="grid grid-cols-3 gap-1.5">
                {Object.entries(v.decks).map(([d, h]) => (
                  <label key={d} className="flex flex-col gap-0.5 text-slate-400">
                    {d} above baseline, m
                    <input type="number" step="any" value={h} onChange={(e) => setV((x) => matchDecks({ ...x, decks: { ...x.decks, [d]: e.target.value } }))} className={input} />
                  </label>
                ))}
              </div>
            )}
            {!v.principal.lbp && <p className="text-amber-200">LBP required: not found in the documents read. See the capacity plan or GA.</p>}
            {v.principalSource?.lbp?.startsWith(ESTIMATED) && <p className="text-amber-200">LBP estimated as {LBP_OF_LOA} × LOA: not stated in the documents read. Replace it if known.</p>}
            <p className="text-slate-500">Filled from whichever document states them. Hover over a field to see its source.</p>
          </section>
        </>
      ) : (
        <>
          <section className="flex flex-col gap-2" aria-label="Stability report">
            <h3 className="font-medium text-slate-200">Stability report</h3>
            <Pages doc={docs.report} />
            <div className="grid grid-cols-3 gap-1.5">
              {FIGURES.map(([key, label, unit]) => (
                <div key={key} title={v.report.source?.[key] ?? 'Not found in the report. Enter manually.'}>
                  {field(`${label}, ${unit}`, v.report.figures?.[key], (x) => setV((d) => ({ ...d, report: { ...d.report, figures: { ...d.report.figures, [key]: x === '' ? undefined : +x }, source: { ...d.report.source, [key]: 'Entered manually' } } })))}
                </div>
              ))}
            </div>
            <p className="text-slate-500">As printed in the report. Hover over a field to see its source.</p>
          </section>
          <section className="flex flex-col gap-2" aria-label="Stow plan">
            <h3 className="font-medium text-slate-200">Stow / load plan</h3>
            <Pages doc={docs.stow} send={setStowText} />
            {v.stow.length > 0 && <StowList v={v} setV={setV} />}
            <Table text={stowText} setText={setStowText} columns={STOW_COLUMNS} lbp={lbp} label="Cargo" add={(rows) => setV((d) => ({ ...d, stow: [...d.stow, ...rows.map((r) => ({ name: r.name, weight: r.weight, lcg: r.lcg, tcg: r.tcg, vcg: r.vcg, ...(r.size ? { size: r.size } : {}) }))] }))} />
          </section>
        </>
      )}

      {problem && <p className="text-amber-200">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" className={button} onClick={save} disabled={reading} title={reading ? 'Wait for the documents to be read' : undefined}>
          {scope === 'ship' ? 'Save ship' : 'Save condition'}
        </button>
        <button type="button" className="text-slate-400 underline" onClick={cancel}>Cancel</button>
      </div>
    </div>
  )
}

function Figures({ vessel }) {
  const f = vessel.report.figures ?? {}
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section aria-label="Report figures">
        <h2 className="font-medium">Stability report</h2>
        <p className="text-xs text-slate-500">{vessel.documents.report ?? 'No report loaded'}</p>
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
          {FIGURES.filter(([key]) => f[key] != null).map(([key, label, unit]) => (
            <div key={key} className="contents" title={vessel.report.source?.[key]}>
              <dt className="text-slate-400">{label}</dt>
              <dd className="text-right">{fmt(f[key], key === 'displacement' || key === 'deadweight' ? 0 : 2)} {unit}</dd>
            </div>
          ))}
        </dl>
      </section>
      {vessel.report.items?.length > 0 && (
        <section aria-label="Weights">
          <h2 className="font-medium">Weights</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
            {vessel.report.items.map((i) => (
              <div key={i.name} className="contents" title={`LCG ${fmt(i.lcg)} m, VCG ${fmt(i.vcg)} m, TCG ${fmt(i.tcg)} m`}>
                <dt className="text-slate-400">{i.name}</dt>
                <dd className="text-right">{fmt(i.weight, 1)} t</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section aria-label="Cargo">
        <h2 className="font-medium">Stow / load plan</h2>
        <p className="tabular-nums text-slate-300">{vessel.stow.length} units, {fmt(vessel.stow.reduce((t, u) => t + (u.weight || 0), 0), 1)} t</p>
      </section>
      <p className="text-xs text-slate-500">Figures as printed in the stability report. This app does not calculate stability.</p>
    </div>
  )
}

// --- the tab

const EMPTY_SHIP = { name: '', principal: { lbp: '', loa: '', breadth: '', depth: '' }, decks: {}, documents: {}, hull: null, conditions: [] }
const emptyCondition = () => ({ id: `c${Date.now().toString(36)}`, name: '', report: { figures: {}, source: {}, items: [] }, stow: [], documents: {} })
// her condition shown: the one marked current, else the latest
export const currentCondition = (v) => v?.conditions?.find((c) => c.id === v.current) ?? v?.conditions?.at(-1) ?? null

export function VesselTab({ hidden }) {
  const [list, setList] = useState([])
  const [vesselId, setVesselId] = useState('')
  const [vessel, setVessel] = useState(null)
  const [editing, setEditing] = useState(null) // { scope: 'ship' | 'condition', start }, or null
  const [problem, setProblem] = useState('')
  const [sea, setSea] = useState(null) // the sea state she's shown in (POST /api/vessels/{id}/sea)
  const [live, setLive] = useState(null) // her roll, pitch and heave this moment, as drawn
  useEffect(() => {
    setSea(null)
    setLive(null)
  }, [vesselId, vessel?.current])
  const refresh = () =>
    fetch('/api/vessels')
      .then((res) => res.json())
      .then((found) => {
        setList(found)
        window.dispatchEvent(new Event('vessels-changed')) // (the Routes panel's own-vessel list follows)
        setVesselId((id) => (found.some((v) => v.id === id) ? id : found[0]?.id || ''))
        if (!found.length) setVessel(null)
      })
      .catch(() => setProblem('Vessels could not be loaded.'))
  const open = (id) =>
    fetch(`/api/vessels/${id}`)
      .then((r) => r.json())
      .then(setVessel)
      .catch(() => setProblem('Vessel could not be opened.'))
  useEffect(() => {
    refresh()
  }, [])
  useEffect(() => {
    if (vesselId) open(vesselId)
  }, [vesselId])
  const put = async (v) => {
    const res = await fetch('/api/vessels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).catch(() => null)
    if (res?.ok) {
      await open(vesselId)
      window.dispatchEvent(new Event('vessels-changed'))
    } else setProblem('Change could not be saved.')
  }
  const remove = async () => {
    const res = await fetch(`/api/vessels/${vesselId}`, { method: 'DELETE' })
    if (res.ok) {
      setVesselId('')
      setVessel(null)
      refresh()
    }
  }
  const cond = currentCondition(vessel)
  // what's shown: the ship, in her current condition
  const view = useMemo(
    () => vessel && { ...vessel, report: cond?.report ?? { figures: {}, source: {}, items: [] }, stow: cond?.stow ?? [], documents: { ...vessel.documents, ...(cond?.documents ?? {}) } },
    [vessel, cond],
  )
  const saved = async (id) => {
    setEditing(null)
    await refresh()
    setVesselId(id)
    open(id)
  }

  return (
    <main className={`absolute inset-0 z-20 ${hidden ? 'hidden' : 'flex'} flex-col gap-3 overflow-y-auto bg-slate-950 px-4 pt-16 pb-4 text-slate-100 lg:flex-row lg:overflow-hidden [scrollbar-color:#475569_transparent] [scrollbar-width:thin]`}>
      <aside aria-label="Documents" className="flex shrink-0 flex-col gap-3 text-sm lg:w-96 lg:overflow-y-auto lg:pr-1 [scrollbar-width:thin]">
        <h1 className="text-xl font-semibold">Own vessel</h1>
        {editing ? (
          <Builder
            key={editing.scope + (editing.start.id ?? '')}
            scope={editing.scope}
            start={editing.start}
            vessel={editing.scope === 'ship' ? (editing.start.conditions ? editing.start : vessel) : vessel}
            cancel={() => setEditing(null)}
            saved={saved}
          />
        ) : (
          <>
            <div className="flex gap-2">
              <select value={vesselId} onChange={(e) => setVesselId(e.target.value)} aria-label="Vessel" className={`${input} min-w-0 flex-1`}>
                {list.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <button type="button" className={button} onClick={() => setEditing({ scope: 'ship', start: EMPTY_SHIP })}>New vessel</button>
            </div>
            {vessel && (
              <>
                <section aria-label="Ship" className="flex flex-col gap-1.5 rounded-lg border border-slate-800 p-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-medium">Ship</h2>
                    <div className="flex gap-3 text-xs">
                      <button type="button" className="text-cyan-200 underline" onClick={() => setEditing({ scope: 'ship', start: { ...vessel } })}>Edit ship</button>
                      <button type="button" className="text-red-300 underline" onClick={() => window.confirm(`Delete ${vessel.name}, her hull and all her loading conditions? This cannot be undone.`) && remove()}>Delete vessel</button>
                    </div>
                  </div>
                  <p className="text-xs tabular-nums text-slate-300">
                    LBP {fmt(vessel.principal.lbp, 1)} m · LOA {fmt(vessel.principal.loa, 1)} m · B {fmt(vessel.principal.breadth, 1)} m · D {fmt(vessel.principal.depth, 1)} m
                  </p>
                  <p className="text-xs text-slate-400">Capacity plan: {vessel.documents.capacity ?? '–'}{vessel.hull?.points?.length ? ' (hull lines read)' : ''}</p>
                  <p className="text-xs text-slate-400">General arrangement: {vessel.documents.ga ?? '–'}</p>
                </section>
                <section aria-label="Loading conditions" className="flex flex-col gap-1.5 rounded-lg border border-slate-800 p-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-medium">Loading conditions</h2>
                    <button type="button" className="text-xs text-cyan-200 underline" onClick={() => setEditing({ scope: 'condition', start: { ...emptyCondition(), decks: vessel.decks } })}>
                      New condition
                    </button>
                  </div>
                  {vessel.conditions?.length ? (
                    <ul className="flex flex-col gap-1 text-xs">
                      {[...vessel.conditions].reverse().map((c) => (
                        <li key={c.id} className={`flex items-center gap-2 rounded px-1.5 py-1 ${c.id === cond?.id ? 'bg-cyan-400/10' : ''}`}>
                          <input type="radio" checked={c.id === cond?.id} onChange={() => put({ ...vessel, current: c.id })} aria-label={`Show ${c.name}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-slate-200" title={c.name}>{c.name}</span>
                            <span className="block truncate text-slate-500" title={[c.documents?.report, c.documents?.stow].filter(Boolean).join(', ')}>
                              GM {fmt(c.report?.figures?.gm)} m · T {fmt(c.report?.figures?.draught_mid)} m · {c.stow?.length ?? 0} units
                            </span>
                          </span>
                          <button type="button" className="text-cyan-200 underline" onClick={() => setEditing({ scope: 'condition', start: { ...c, decks: vessel.decks } })}>Edit</button>
                          <button type="button" className="text-red-300 underline" onClick={() => window.confirm(`Delete the loading condition ${c.name}?`) && put({ ...vessel, conditions: vessel.conditions.filter((x) => x.id !== c.id) })}>Delete</button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400">No loading condition yet. Add one from a stability report and a stow or load plan.</p>
                  )}
                </section>
              </>
            )}
            <p className="text-xs text-slate-500">The ship is read once from her capacity plan (hull lines, particulars) and GA. Each loading condition comes from a stability report (drafts, trim, list, GM) and a stow or load plan.</p>
          </>
        )}
        {problem && <p className="text-xs text-amber-200">{problem}</p>}
      </aside>
      <section aria-label="The vessel" className="relative min-h-96 flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        {view ? <VesselView vessel={view} sea={sea} active={!hidden} onLive={setLive} /> : <p className="p-4 text-sm text-slate-400">No vessel loaded. Select New vessel to add one.</p>}
      </section>
      <aside aria-label="Figures" className="shrink-0 lg:w-72 lg:overflow-y-auto lg:pl-1 [scrollbar-width:thin]">
        {view && (
          <div className="flex flex-col gap-4">
            <SeaPanel key={view.id + (cond?.id ?? '')} vessel={view} sea={sea} setSea={setSea} live={live} />
            {cond ? <Figures vessel={view} /> : <p className="text-sm text-slate-400">No loading condition: shown at no draught. Add one for her drafts and motions.</p>}
          </div>
        )}
      </aside>
    </main>
  )
}
