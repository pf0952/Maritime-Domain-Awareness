// The Vessel tab: "My vessel", read from her documents (backend/vessel_docs.py). Her capacity plan gives her
// particulars and compartments, her stow plan the cargo, and her stability report the condition's figures, as the
// ship's own approved software printed them. Nothing here works out stability: it shows the documents' figures in 3D
// and hands them to the motions along a route.
//
// Frame: x m from the aft perpendicular (+ forward), y m from the centreline (+ starboard), z m above the baseline.
import { COORDINATE_SYSTEM, Deck, OrbitView } from '@deck.gl/core'
import { SolidPolygonLayer } from '@deck.gl/layers'
import { useEffect, useRef, useState } from 'react'

const KIND_RGB = { Hold: [148, 163, 184], Ballast: [56, 189, 248], Fuel: [244, 114, 182], 'Fresh water': [125, 211, 252], Other: [167, 139, 250] }
const CARGO_RGB = [217, 119, 6]
const DEFAULT_UNIT = [6.1, 2.44, 2.59] // m, a block with no size given: a twenty-foot box
const FIGURES = [
  ['displacement', 'Displacement', 't'], ['deadweight', 'Deadweight', 't'], ['draught_aft', 'Draught aft', 'm'], ['draught_mid', 'Draught mid', 'm'],
  ['draught_fwd', 'Draught fwd', 'm'], ['trim', 'Trim', 'm'], ['list', 'List', '°'], ['gm', 'GM, corrected', 'm'], ['kg', 'KG, corrected', 'm'],
  ['km', 'KM', 'm'], ['lcg', 'LCG', 'm'], ['tcg', 'TCG', 'm'], ['roll_period', 'Roll period', 's'], ['air_draught', 'Air draught', 'm'],
]
const CAPACITY_COLUMNS = [['', '—'], ['capacity', 'Capacity, m³'], ['lcg', 'LCG'], ['tcg', 'TCG'], ['vcg', 'VCG']]
const STOW_COLUMNS = [['', '—'], ['weight', 'Weight, t'], ['lcg', 'LCG'], ['tcg', 'TCG'], ['vcg', 'VCG'], ['l', 'Length, m'], ['b', 'Breadth, m'], ['h', 'Height, m']]
const EMPTY = { name: '', principal: { lbp: '', loa: '', breadth: '', depth: '' }, decks: {}, report: { figures: {}, source: {}, items: [] }, compartments: [], stow: [], documents: {} }
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

// --- the 3D view: her hull as a box with a bow, the waterline at the report's drafts, compartments and cargo as blocks

function block(x, y, z, [l, b, h]) {
  return { polygon: [[x - l / 2, y - b / 2, z], [x + l / 2, y - b / 2, z], [x + l / 2, y + b / 2, z], [x - l / 2, y + b / 2, z]], h }
}

function VesselView({ vessel }) {
  const box = useRef(null)
  const deck = useRef(null)
  const { lbp, breadth: beam } = vessel.principal
  const depth = vessel.principal.depth || beam * 0.6
  useEffect(() => {
    const width = box.current.clientWidth || 800
    deck.current = new Deck({
      parent: box.current,
      views: new OrbitView({ orbitAxis: 'Z', fovy: 35 }),
      initialViewState: { target: [lbp / 2, 0, depth / 2], rotationOrbit: -35, rotationX: 22, zoom: Math.log2(width / (lbp * 1.35)), minZoom: -4, maxZoom: 6 },
      controller: true,
      getTooltip: ({ object }) => object?.tip && { text: object.tip, style: { background: '#0f172a', color: '#e2e8f0', fontSize: '12px', borderRadius: '6px' } },
    })
    return () => deck.current?.finalize()
  }, [vessel])
  useEffect(() => {
    const f = vessel.report.figures
    const aft = f.draught_aft ?? f.draught_mid
    const fwd = f.draught_fwd ?? f.draught_mid
    const at = (x) => aft + ((fwd - aft) * x) / lbp
    const r = ((f.list ?? 0) * Math.PI) / 180 // (+ to starboard, as the report gives it: drawn so)
    const [c, s] = [Math.cos(r), Math.sin(r)]
    const pz = f.draught_mid ?? aft ?? 0
    const modelMatrix = [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, -pz * s, pz - pz * c, 1]
    const common = { coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, modelMatrix, extruded: true, getPolygon: (d) => d.polygon, getElevation: (d) => d.h, pickable: true }
    const hull = [{ polygon: [[0, -beam / 2, 0], [lbp * 0.85, -beam / 2, 0], [lbp, 0, 0], [lbp * 0.85, beam / 2, 0], [0, beam / 2, 0]], h: depth }]
    const compartments = vessel.compartments
      .filter((k) => k.lcg != null && k.vcg != null)
      .map((k) => {
        const side = Math.min(Math.max(Math.cbrt(k.capacity || k.volume || 1), 1.5), beam / 2, 14)
        return { ...block(k.lcg, k.tcg ?? 0, k.vcg - side / 2, [side, side, side]), rgb: KIND_RGB[k.kind] ?? KIND_RGB.Other, tip: `${k.name} (${k.kind})\n${fmt(k.capacity, 0)} m³` }
      })
    const cargo = vessel.stow
      .filter((u) => u.lcg != null && u.vcg != null && u.tcg != null)
      .map((u) => {
        const size = u.size ?? DEFAULT_UNIT
        return { ...block(u.lcg, u.tcg ?? 0, u.vcg - size[2] / 2, size), tip: `${u.name || 'Cargo'}\n${fmt(u.weight, 1)} t` }
      })
    deck.current?.setProps({
      layers: [
        new SolidPolygonLayer({
          id: 'water',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          data: aft != null ? [{ polygon: [[-15, -beam, at(-15)], [lbp + 25, -beam, at(lbp + 25)], [lbp + 25, beam, at(lbp + 25)], [-15, beam, at(-15)]] }] : [],
          getPolygon: (d) => d.polygon,
          getFillColor: [14, 116, 144, 90],
          parameters: { depthWriteEnabled: false },
        }),
        new SolidPolygonLayer({ id: 'compartments', ...common, data: compartments, getFillColor: (d) => [...d.rgb, 110], parameters: { depthWriteEnabled: false } }),
        new SolidPolygonLayer({ id: 'cargo', ...common, data: cargo, getFillColor: [...CARGO_RGB, 220] }),
        new SolidPolygonLayer({ id: 'hull', ...common, pickable: false, data: hull, getFillColor: [148, 163, 184, 45], parameters: { depthWriteEnabled: false } }),
      ],
    })
  }, [vessel])
  return <div ref={box} className="relative h-full min-h-80 w-full" aria-label="3D view of the vessel. Drag to rotate, scroll to zoom, hover over a block for its name." />
}

// --- reading the documents

// a PDF's pages, one at a time, with a button to send the page's text on
function Pages({ label, kind, onPages, send }) {
  const [pages, setPages] = useState([])
  const [page, setPage] = useState(0)
  const [state, setState] = useState('')
  const read = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setState(kind === 'capacity' ? 'Reading PDF… Drawn plans are read by OCR and may take 1–2 minutes.' : 'Reading PDF…')
    const body = new FormData()
    body.append('file', file)
    const res = await fetch(`/api/vessels/pdf?kind=${kind}`, { method: 'POST', body }).catch(() => null)
    const answer = res ? await res.json() : { detail: 'Server could not be reached.' }
    if (!res?.ok) return setState(answer.detail)
    setPages(answer.pages)
    setPage(0)
    setState(
      answer.drawn_only
        ? answer.capacity?.words
          ? `Text is drawn as vector lines (CAD export). ${answer.capacity.words} words read by OCR; check the results below.`
          : (answer.problem ?? 'This PDF has no text layer (vector drawing or scan). Enter the required figures below.')
        : (answer.problem ?? ''),
    )
    onPages(file.name, answer)
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-slate-400">
        {label}
        <input type="file" accept=".pdf" onChange={read} className="text-slate-300" />
      </label>
      {state && <p className="text-amber-200">{state}</p>}
      {pages.length > 0 && (
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

function Builder({ start, saved, cancel }) {
  const [v, setV] = useState(start)
  const [capText, setCapText] = useState('')
  const [kind, setKind] = useState('Ballast')
  const [stowText, setStowText] = useState('')
  const [problem, setProblem] = useState('')
  const lbp = +v.principal.lbp
  const doc = (key, name) => setV((d) => ({ ...d, documents: { ...d.documents, [key]: name } }))
  const save = async () => {
    const stow = v.stow.map((u) => {
      const deck = v.decks?.[u.deck]
      const high = u.size?.[2] ?? u.height ?? DEFAULT_UNIT[2]
      return { ...u, vcg: deck !== undefined && deck !== '' ? +deck + high / 2 : u.vcg }
    })
    const res = await fetch('/api/vessels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...v, stow }) })
    const answer = await res.json()
    if (!res.ok) return setProblem(answer.detail)
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
      <label className="flex flex-col gap-0.5 text-slate-400">
        Vessel name
        <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={input} />
      </label>

      <section className="flex flex-col gap-2" aria-label="Capacity plan">
        <h3 className="font-medium text-slate-200">1. Capacity plan</h3>
        <Pages label="Capacity plan (PDF)" kind="capacity" onPages={(name, a) => {
          doc('capacity', name)
          const got = a.capacity ?? {}
          setV((d) => matchDecks({
            ...d,
            principal: Object.fromEntries(Object.entries(d.principal).map(([k, x]) => [k, x || got.particulars?.[k] || ''])),
            decks: { ...d.decks, ...Object.fromEntries(Object.entries(got.decks ?? {}).map(([k, h]) => [k, d.decks?.[k] || h])) },
          }))
          // (her particulars, if the plan prints them as a report would)
          const read = (key) => a.pages.join('\n').match(new RegExp(key === 'lbp' ? 'L\\.?B\\.?P\\.?[^\\d\\n]{0,20}(\\d+(?:\\.\\d+)?)' : key === 'breadth' ? '(?:breadth|beam)[^\\d\\n]{0,20}(\\d+(?:\\.\\d+)?)' : 'depth[^\\d\\n]{0,20}(\\d+(?:\\.\\d+)?)', 'i'))?.[1]
          setV((d) => ({ ...d, principal: Object.fromEntries(['lbp', 'breadth', 'depth'].map((k) => [k, d.principal[k] || read(k) || ''])) }))
        }} send={setCapText} />
        <div className="grid grid-cols-3 gap-1.5">
          {[['LBP, m', 'lbp'], ['Breadth, m', 'breadth'], ['Depth, m', 'depth']].map(([label, key]) => (
            <div key={key}>{field(label, v.principal[key], (x) => setV((d) => ({ ...d, principal: { ...d.principal, [key]: x } })))}</div>
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
        {!v.principal.lbp && <p className="text-amber-200">LBP required{v.principal.loa ? ` (LOA ${v.principal.loa} m, from the stow plan)` : ''}. See the capacity plan or stability booklet.</p>}
        <Table text={capText} setText={setCapText} columns={CAPACITY_COLUMNS} lbp={lbp} label="Compartments" add={(rows) => setV((d) => ({ ...d, compartments: [...d.compartments, ...rows.map((r) => ({ name: r.name, kind, capacity: r.capacity, lcg: r.lcg, tcg: r.tcg, vcg: r.vcg }))] }))}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="bg-slate-950" aria-label="Compartment type">
            {Object.keys(KIND_RGB).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </Table>
        {v.compartments.length > 0 && (
          <p className="text-slate-400">
            {v.compartments.length} compartments. <button type="button" className="text-red-300 underline" onClick={() => setV({ ...v, compartments: [] })}>Clear</button>
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-label="Stability report">
        <h3 className="font-medium text-slate-200">2. Stability report</h3>
        <Pages label="Stability report for the loading condition (PDF)" kind="report" onPages={(name, a) => {
          doc('report', name)
          setV((d) => ({
            ...d,
            name: d.name || titled(a.name ?? ''),
            report: { figures: { ...a.figures }, source: { ...a.source }, items: a.items ?? [] },
            // (its tank table: every tank with what's in it now and where, if the capacity plan gave none)
            compartments: d.compartments.length ? d.compartments : (a.tanks ?? []),
          }))
        }} />
        {v.report.items?.length > 0 && <p className="text-slate-400">Other weights read: {v.report.items.map((i) => `${i.name} ${fmt(i.weight, 1)} t`).join(', ')}.</p>}
        <div className="grid grid-cols-3 gap-1.5">
          {FIGURES.map(([key, label, unit]) => (
            <div key={key} title={v.report.source[key] ?? 'Not found in the report. Enter manually.'}>
              {field(`${label}, ${unit}`, v.report.figures[key], (x) => setV((d) => ({ ...d, report: { figures: { ...d.report.figures, [key]: x === '' ? undefined : +x }, source: { ...d.report.source, [key]: 'Entered manually' } } })))}
            </div>
          ))}
        </div>
        <p className="text-slate-500">As printed in the report. Hover over a field to see its source. LCG from AP.</p>
      </section>

      <section className="flex flex-col gap-2" aria-label="Stow plan">
        <h3 className="font-medium text-slate-200">3. Stow plan</h3>
        <Pages label="Stow plan (PDF)" kind="stow" onPages={(name, a) => {
          doc('stow', name)
          const drawn = a.drawing?.units ?? []
          const got = a.drawing?.particulars ?? {}
          setV((d) => matchDecks({
            ...d,
            principal: { ...d.principal, breadth: d.principal.breadth || got.breadth || '', loa: d.principal.loa || got.loa || '', lbp: d.principal.lbp || got.lbp || '', depth: d.principal.depth || got.depth || '' },
            stow: drawn.length ? drawn.map((u) => ({ ...u, size: u.size ?? (u.height ? [...DEFAULT_UNIT.slice(0, 2), u.height] : null) })) : d.stow,
            decks: { ...Object.fromEntries(drawn.filter((u) => u.deck).map((u) => [u.deck, ''])), ...d.decks },
          }))
        }} send={setStowText} />
        {v.stow.length > 0 && <StowList v={v} setV={setV} />}
        <Table text={stowText} setText={setStowText} columns={STOW_COLUMNS} lbp={lbp} label="Cargo" add={(rows) => setV((d) => ({ ...d, stow: [...d.stow, ...rows.map((r) => ({ name: r.name, weight: r.weight, lcg: r.lcg, tcg: r.tcg, vcg: r.vcg, ...(r.size ? { size: r.size } : {}) }))] }))} />

      </section>

      {problem && <p className="text-amber-200">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" className={button} onClick={save}>Save vessel</button>
        <button type="button" className="text-slate-400 underline" onClick={cancel}>Cancel</button>
      </div>
    </div>
  )
}

function Figures({ vessel }) {
  const f = vessel.report.figures
  const kinds = Object.entries(Object.groupBy?.(vessel.compartments, (k) => k.kind) ?? {})
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section aria-label="Report figures">
        <h2 className="font-medium">Stability report</h2>
        <p className="text-xs text-slate-500">{vessel.documents.report ?? 'No report loaded'}</p>
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
          {FIGURES.filter(([key]) => f[key] != null).map(([key, label, unit]) => (
            <div key={key} className="contents" title={vessel.report.source[key]}>
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
        <h2 className="font-medium">Stow plan</h2>
        <p className="tabular-nums text-slate-300">{vessel.stow.length} units, {fmt(vessel.stow.reduce((t, u) => t + (u.weight || 0), 0), 1)} t</p>
      </section>
      <section aria-label="Compartments">
        <h2 className="font-medium">Tanks and compartments</h2>
        <ul className="tabular-nums text-slate-300">
          {kinds.map(([kind, list]) => (
            <li key={kind} className="flex items-center gap-2">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: `rgb(${KIND_RGB[kind] ?? KIND_RGB.Other})` }} aria-hidden="true" />
              {kind}: {list.length}, {fmt(list.reduce((t, k) => t + (k.capacity || 0), 0), 0)} m³
            </li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-slate-500">Figures as printed in the stability report. This app does not calculate stability.</p>
    </div>
  )
}

// --- the tab

export function VesselTab() {
  const [list, setList] = useState([])
  const [vesselId, setVesselId] = useState('')
  const [vessel, setVessel] = useState(null)
  const [editing, setEditing] = useState(null) // the vessel being read in, or null
  const [problem, setProblem] = useState('')
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
  useEffect(() => {
    refresh()
  }, [])
  useEffect(() => {
    if (!vesselId) return
    fetch(`/api/vessels/${vesselId}`)
      .then((r) => r.json())
      .then(setVessel)
      .catch(() => setProblem('Vessel could not be opened.'))
  }, [vesselId])
  const remove = async () => {
    const res = await fetch(`/api/vessels/${vesselId}`, { method: 'DELETE' })
    if (res.ok) {
      setVesselId('')
      setVessel(null)
      refresh()
    }
  }

  return (
    <main className="absolute inset-0 z-20 flex flex-col gap-3 overflow-y-auto bg-slate-950 px-4 pt-16 pb-4 text-slate-100 lg:flex-row lg:overflow-hidden [scrollbar-color:#475569_transparent] [scrollbar-width:thin]">
      <aside aria-label="Documents" className="flex shrink-0 flex-col gap-3 text-sm lg:w-96 lg:overflow-y-auto lg:pr-1 [scrollbar-width:thin]">
        <h1 className="text-xl font-semibold">Own vessel</h1>
        {editing ? (
          <Builder start={editing} cancel={() => setEditing(null)} saved={async (id) => { setEditing(null); await refresh(); setVesselId(id); fetch(`/api/vessels/${id}`).then((r) => r.json()).then(setVessel) }} />
        ) : (
          <>
            <div className="flex gap-2">
              <select value={vesselId} onChange={(e) => setVesselId(e.target.value)} aria-label="Vessel" className={`${input} min-w-0 flex-1`}>
                {list.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} onClick={() => setEditing(EMPTY)}>New from documents</button>
              {vessel && (
                <>
                  <button type="button" className={button} onClick={() => setEditing(vessel)}>Edit</button>
                  <button type="button" className="text-xs text-red-300 underline" onClick={remove}>Delete</button>
                </>
              )}
            </div>
            <p className="text-xs text-slate-500">Built from three PDFs: capacity plan (particulars and compartments), stability report for the loading condition (figures) and stow plan (cargo).</p>
          </>
        )}
        {problem && <p className="text-xs text-amber-200">{problem}</p>}
      </aside>
      <section aria-label="The vessel" className="relative min-h-96 flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        {vessel ? <VesselView vessel={vessel} /> : <p className="p-4 text-sm text-slate-400">No vessel loaded. Select New from documents to add one.</p>}
      </section>
      <aside aria-label="Figures" className="shrink-0 lg:w-72 lg:overflow-y-auto lg:pl-1 [scrollbar-width:thin]">
        {vessel && <Figures vessel={vessel} />}
      </aside>
    </main>
  )
}
