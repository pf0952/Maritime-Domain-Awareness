// The Fleet tab: saved fleets of up to 50 vessels, each with its own recorded history (backend/fleet.py), side by side
// and never added together: where it's called, its voyages, laden or in ballast, its loads and discharges
import { useEffect, useMemo, useState } from 'react'
import { VesselFound } from './panels'
import { AIS, vesselCategory } from './vessels'

const MOST = 50
const REFRESH = 600000 // ms: the recorder looks every 10 minutes
const day = (t) => new Date(t * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' })
const moment = (t) => new Date(t * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const portName = (port) => (port ? `${port.name} (${port.code})` : 'At sea or an unlisted port')
const tonnes = (t) => (t ? `~${t.toLocaleString()} t` : '')

// as a file to save: the user's own data, from their own server
function download(name, rows) {
  const text = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n')
  const link = document.createElement('a')
  link.href = window.URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  link.download = name
  link.click()
  window.URL.revokeObjectURL(link.href)
}

// Draught over time: one line, the vessel's own, with each load (▲) and discharge (▼) where it left port, and a
// crosshair to read it by. One series, so no legend: the card it's in names it
function DraughtChart({ draughts, calls, from, to }) {
  const [hover, setHover] = useState(null)
  const [w, h, pad] = [640, 120, { left: 34, right: 8, top: 10, bottom: 20 }]
  if (draughts.length < 2) {
    return <p className="rounded-lg border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-400">No draught recorded yet: it fills in as the recorder runs, every 10 minutes.</p>
  }
  const values = draughts.map(([, d]) => d)
  const [low, high] = [Math.floor(Math.min(...values) - 1), Math.ceil(Math.max(...values) + 1)]
  const x = (t) => pad.left + ((t - from) / Math.max(to - from, 1)) * (w - pad.left - pad.right)
  const y = (d) => pad.top + ((high - d) / (high - low)) * (h - pad.top - pad.bottom)
  const line = draughts.map(([t, d], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(d).toFixed(1)}`).join('')
  const events = calls.filter((c) => c.event && c.draughtOut)
  const ticks = [low, (low + high) / 2, high]
  const months = []
  for (let t = from; t <= to; t += 86400 * 30) months.push(t)
  const near = (px) => {
    const t = from + ((px - pad.left) / (w - pad.left - pad.right)) * (to - from)
    return draughts.reduce((best, p) => (Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best))
  }
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-32 w-full"
        role="img"
        aria-label={`Draught from ${day(draughts[0][0])} to ${day(draughts.at(-1)[0])}, ${Math.min(...values)} to ${Math.max(...values)} m`}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          setHover(near(((e.clientX - box.left) / box.width) * w))
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((d) => (
          <g key={d}>
            <line x1={pad.left} x2={w - pad.right} y1={y(d)} y2={y(d)} stroke="#334155" strokeWidth="1" />
            <text x={pad.left - 6} y={y(d) + 3} textAnchor="end" className="fill-slate-400 text-[10px]">{d} m</text>
          </g>
        ))}
        {months.map((t) => (
          <text key={t} x={x(t)} y={h - 4} textAnchor="middle" className="fill-slate-500 text-[10px]">
            {new Date(t * 1000).toLocaleDateString([], { month: 'short' })}
          </text>
        ))}
        <path d={line} fill="none" stroke="#67e8f9" strokeWidth="2" strokeLinejoin="round" />
        {events.map((c) => (
          <text key={c.depart} x={x(c.depart)} y={y(c.draughtOut) + (c.event === 'load' ? -6 : 13)} textAnchor="middle" className="fill-slate-100 text-[11px]">
            {c.event === 'load' ? '▲' : '▼'}
          </text>
        ))}
        {hover && <line x1={x(hover[0])} x2={x(hover[0])} y1={pad.top} y2={h - pad.bottom} stroke="#94a3b8" strokeWidth="1" />}
        {hover && <circle cx={x(hover[0])} cy={y(hover[1])} r="4" fill="#67e8f9" stroke="#0f172a" strokeWidth="2" />}
      </svg>
      {hover && (
        <p className="pointer-events-none absolute top-0 right-0 rounded bg-slate-800 px-2 py-1 text-xs text-slate-100 tabular-nums shadow">
          {moment(hover[0])}: {hover[1]} m
        </p>
      )}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-100 tabular-nums">{value}</dd>
    </div>
  )
}

function VesselHistory({ mmsi, history, remove, showOnMap }) {
  const [open, setOpen] = useState(null) // which table is unfolded
  if (!history) return <li className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">MMSI {mmsi}: loading</li>
  const { record, calls, voyages, gaps, draughts, track, since } = history
  const name = record.name || `MMSI ${mmsi}`
  // (unknown until there's draught enough to tell laden from ballast)
  const miles = (laden) => (voyages.some((v) => v.laden !== null) ? voyages.filter((v) => v.laden === laden).reduce((sum, v) => sum + v.miles, 0).toLocaleString() : '–')
  const anchored = calls.filter((c) => c.anchored).reduce((sum, c) => sum + c.hours, 0)
  const [loads, discharges] = ['load', 'discharge'].map((e) => calls.filter((c) => c.event === e).length)
  const now = Date.now() / 1000
  const csv = () =>
    download(`${name} history.csv`, [
      ['Port calls'],
      ['Port', 'Arrived', 'Left', 'Hours', 'At anchor', 'Draught in (m)', 'Draught out (m)', 'Event', 'Estimated cargo (t)', 'Source'],
      ...calls.map((c) => [portName(c.port), moment(c.arrive), moment(c.depart), c.hours, c.anchored ? 'yes' : '', c.draughtIn, c.draughtOut, c.event, c.tonnes, c.source]),
      [],
      ['Voyages'],
      ['From', 'To', 'Departed', 'Arrived', 'Miles', 'Days', 'Average knots', 'Laden'],
      ...voyages.map((v) => [portName(v.from), portName(v.to), moment(v.depart), moment(v.arrive), v.miles, v.days, v.knots, v.laden === null ? '' : v.laden ? 'laden' : 'ballast']),
    ])
  const table = (id, title, head, rows) => (
    <details open={open === id} onToggle={(e) => e.currentTarget.open && setOpen(id)}>
      <summary className="cursor-pointer text-xs font-medium text-slate-300 hover:text-cyan-300">
        {title} ({rows.length})
      </summary>
      {rows.length ? (
        <div className="mt-1 max-h-64 overflow-auto [scrollbar-color:#475569_transparent] [scrollbar-width:thin]">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-slate-900 text-slate-400">
              <tr>{head.map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      ) : (
        <p className="mt-1 text-xs text-slate-400">None yet.</p>
      )}
    </details>
  )
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <VesselFound vessel={{ ...record, mmsi }} />
          <p className="mt-1 text-xs text-slate-400">
            {record.sog !== undefined && `${record.sog} kn`}
            {record.destination && `, for ${record.destination}`}
            {record.draught && `, draught ${record.draught} m`}
            {record.seen && `, last heard ${moment(Date.parse(record.seen) / 1000)}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2 text-xs">
          <button type="button" disabled={!track.length} onClick={showOnMap} className="rounded bg-slate-800 px-2 py-1 text-cyan-300 hover:bg-slate-700 disabled:opacity-40">Show on map</button>
          <button type="button" onClick={csv} className="rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700">CSV</button>
          <button type="button" aria-label={`Remove ${name}`} onClick={remove} className="rounded px-1.5 text-slate-400 hover:text-red-300">×</button>
        </div>
      </header>
      <dl className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Stat label="Port calls" value={calls.filter((c) => c.port).length} />
        <Stat label="Loads / discharges" value={`${loads} / ${discharges}`} />
        <Stat label="Laden miles" value={miles(true)} />
        <Stat label="Ballast miles" value={miles(false)} />
        <Stat label="Hours at anchor" value={Math.round(anchored).toLocaleString()} />
        <Stat label="Gaps over 12 h" value={gaps.length} />
      </dl>
      <DraughtChart draughts={draughts} calls={calls} from={since ?? now} to={now} />
      {table('calls', 'Port calls', ['Port', 'Arrived', 'Left', 'Hours', 'Draught', 'Event'], [...calls].reverse().map((c) => (
        <tr key={c.arrive} className="border-t border-slate-800">
          <td className="px-2 py-1">
            {portName(c.port)}
            {c.anchored && <span className="text-slate-400"> at anchor</span>}
            <span className="ml-1 rounded bg-slate-800 px-1 text-[10px] text-slate-400" title={c.source === 'GFW' ? 'From Global Fishing Watch' : 'Worked out from AIS reports'}>{c.source ?? 'AIS'}</span>
          </td>
          <td className="px-2 py-1">{moment(c.arrive)}</td>
          <td className="px-2 py-1">{moment(c.depart)}</td>
          <td className="px-2 py-1">{c.hours}</td>
          <td className="px-2 py-1">{c.draughtIn ?? '?'} → {c.draughtOut ?? '?'} m</td>
          <td className="px-2 py-1">{c.event ? `${c.event === 'load' ? '▲ Load' : '▼ Discharge'} ${tonnes(c.tonnes)}` : ''}</td>
        </tr>
      )))}
      {table('voyages', 'Voyages', ['From', 'To', 'Departed', 'Days', 'Miles', 'Avg kn', ''], [...voyages].reverse().map((v) => (
        <tr key={v.depart} className="border-t border-slate-800">
          <td className="px-2 py-1">{portName(v.from)}</td>
          <td className="px-2 py-1">{portName(v.to)}</td>
          <td className="px-2 py-1">{day(v.depart)}</td>
          <td className="px-2 py-1">{v.days}</td>
          <td className="px-2 py-1">{v.miles.toLocaleString()}</td>
          <td className="px-2 py-1">{v.knots ?? ''}</td>
          <td className="px-2 py-1 text-slate-400">{v.laden === null ? '' : v.laden ? 'laden' : 'ballast'}</td>
        </tr>
      )))}
      <p className="text-[11px] text-slate-500">
        {history.reports.toLocaleString()} reports since {since ? day(since) : 'now'}. Tracks before recording began come with no draught.
      </p>
    </li>
  )
}

// adding a vessel: found by name or MMSI, as the map's search finds them
function AddVessel({ add, full }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(null)
  async function search(e) {
    e.preventDefault()
    if (!query.trim()) return
    setFound([])
    const answer = await fetch(`${AIS}?q=${encodeURIComponent(query.trim())}`).then((res) => (res.ok ? res.json() : null), () => null)
    setFound((answer?.features ?? []).filter((f) => f.properties.kind === 'vessel').map((f) => f.properties))
  }
  return (
    <form onSubmit={search} className="relative">
      <input
        type="search"
        disabled={full}
        aria-label="Add a vessel by name or MMSI"
        placeholder={full ? `A fleet holds ${MOST} vessels at most` : 'Add a vessel: name or MMSI, then Enter'}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setFound(null)
        }}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-cyan-400 disabled:opacity-50"
      />
      {found && (
        <ul className="absolute top-full right-0 left-0 z-10 mt-1 max-h-80 overflow-auto rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl">
          {found.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">Searching, or nothing found</li>}
          {found.map((v) => (
            <li key={v.mmsi}>
              <button
                type="button"
                onClick={() => {
                  add(v.mmsi)
                  setFound(null)
                  setQuery('')
                }}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-800"
              >
                <VesselFound vessel={v} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}


const ARCHIVES = [
  {
    id: 'us',
    name: 'US waters, 2021–2025',
    about: 'NOAA MarineCadastre: every report in US waters a minute apart, with draught. About 80 GB a year to download, read as it comes and all but your vessels thrown away.',
  },
  {
    id: 'dk',
    name: 'Danish waters, from 2021',
    about: "Danish Maritime Authority: every report in Danish waters, with draught, destination and ETA. About 220 GB a year to download, a day at a time, each deleted once it's read.",
  },
]

// where history comes from beyond the recorder: Global Fishing Watch's port visits, and the free national archives
function Sources({ hasVessels }) {
  const [state, setState] = useState(null)
  const [token, setToken] = useState('')
  const [years, setYears] = useState(1)
  const [problem, setProblem] = useState('')
  const running = state && Object.values(state.runs).some((run) => run.running)

  const ask = async (path, options) => {
    setProblem('')
    const res = await fetch(path, options)
    if (res.ok) setState(await res.json())
    else setProblem((await res.json().catch(() => null))?.detail ?? `Couldn't: ${res.status}`)
  }
  useEffect(() => {
    ask('/api/fleet/sources')
    const timer = setInterval(() => ask('/api/fleet/sources'), 5000)
    return () => clearInterval(timer)
  }, [])

  const run = (id) => state?.runs[id]
  const status = (id) => {
    const r = run(id)
    if (!r) return null
    const where = r.day ? `, at ${r.day}` : ''
    if (r.error) return <span className="text-amber-300">{r.error}</span>
    if (r.running) return `${r.done.toLocaleString()} of ${r.total.toLocaleString()} ${id === 'gfw' ? 'vessels' : 'days'}${where}${r.kept ? `, ${r.kept.toLocaleString()} reports kept` : ''}`
    return `Last run: ${r.done.toLocaleString()} of ${r.total.toLocaleString()} ${id === 'gfw' ? 'vessels' : 'days'}${r.kept ? `, ${r.kept.toLocaleString()} reports kept` : ''}`
  }
  const button = 'rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-cyan-300 hover:bg-slate-700 disabled:opacity-40'

  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <summary className="cursor-pointer text-sm font-medium text-slate-200">History sources: free, beyond the recorder</summary>
      <div className="mt-3 flex flex-col gap-4 text-sm">
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Global Fishing Watch port visits, worldwide, from 2017</h2>
          <p className="text-xs text-slate-400">
            When and where each vessel called, anywhere, for all vessel types; no draught. Free for non-commercial use (CC BY-NC
            4.0), with a token of your own from{' '}
            <a href="https://globalfishingwatch.org/our-apis/tokens" target="_blank" rel="noreferrer" className="underline hover:text-cyan-300">
              globalfishingwatch.org/our-apis/tokens
            </a>
            . It's kept on this computer only, and fills in new vessels by itself.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              ask('/api/fleet/gfw-token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
              setToken('')
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-label="Global Fishing Watch token"
              placeholder={state?.gfwToken ? 'Token saved: paste a new one to replace it' : 'Paste your token'}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 outline-none focus:border-cyan-400"
            />
            <button type="submit" disabled={!token.trim()} className={button}>Save token</button>
            <button type="button" disabled={!state?.gfwToken || running || !hasVessels} onClick={() => ask('/api/fleet/backfill/gfw', { method: 'POST' })} className={button}>
              Fill in port visits
            </button>
          </form>
          {status('gfw') && <p className="text-xs text-slate-300">{status('gfw')}</p>}
        </section>
        {ARCHIVES.map((a) => (
          <section key={a.id} className="flex flex-col gap-2">
            <h2 className="font-medium">{a.name}</h2>
            <p className="text-xs text-slate-400">{a.about} Newest first; stop any time, and it picks up where it left off.</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                Years back
                <select value={years} onChange={(e) => setYears(+e.target.value)} className="rounded border border-slate-700 bg-slate-950 px-1 py-1">
                  {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
              <button type="button" disabled={running || !hasVessels} onClick={() => ask(`/api/fleet/backfill/${a.id}?years=${years}`, { method: 'POST' })} className={button}>
                Fill in from this archive
              </button>
              {run(a.id)?.running && (
                <button type="button" onClick={() => ask('/api/fleet/backfill-stop', { method: 'POST' })} className="rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:text-red-300">
                  Stop
                </button>
              )}
            </div>
            {status(a.id) && <p className="text-xs text-slate-300">{status(a.id)}</p>}
          </section>
        ))}
        <p className="text-xs text-slate-400">
          One runs at a time. Add your vessels first: those added after a run need a run of their own. At about 1 MB/s, a year of
          the US archive takes most of a day, and of the Danish one two or three days.
        </p>
        {problem && <p className="text-xs text-amber-300">{problem}</p>}
      </div>
    </details>
  )
}

export function FleetView({ showTrack }) {
  const [fleets, setFleets] = useState([])
  const [name, setName] = useState('')
  const [histories, setHistories] = useState({}) // mmsi: its history
  const [naming, setNaming] = useState('')
  const current = fleets.find((f) => f.name === name)
  const mmsis = useMemo(() => current?.mmsis ?? [], [current])

  useEffect(() => {
    fetch('/api/fleets')
      .then((res) => res.json())
      .then((found) => {
        setFleets(found)
        setName((n) => n || found[0]?.name || '')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!mmsis.length) return
    let cancelled = false
    const load = () =>
      mmsis.forEach((mmsi) =>
        fetch(`/api/fleet/vessel/${mmsi}`)
          .then((res) => res.json())
          .then((history) => !cancelled && setHistories((all) => ({ ...all, [mmsi]: history })))
          .catch(() => {}),
      )
    load()
    const timer = setInterval(load, REFRESH)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mmsis])

  const save = async (fleetName, list) => {
    const res = await fetch(`/api/fleets/${encodeURIComponent(fleetName)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) })
    if (res.ok) {
      setFleets(await res.json())
      setName(fleetName)
    }
  }
  const remove = async () => {
    const res = await fetch(`/api/fleets/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if (res.ok) {
      const left = await res.json()
      setFleets(left)
      setName(left[0]?.name ?? '')
    }
  }

  return (
    <main className="absolute inset-0 z-20 overflow-y-auto bg-slate-950 px-4 pt-16 pb-10 text-slate-100 [scrollbar-color:#475569_transparent] [scrollbar-width:thin]">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="flex flex-wrap items-end gap-3">
          <h1 className="mr-auto text-xl font-semibold">Fleet history</h1>
          {fleets.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">Fleet</span>
              <select value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5">
                {fleets.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.mmsis.length})</option>)}
              </select>
            </label>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (naming.trim()) save(naming.trim(), [])
              setNaming('')
            }}
            className="flex gap-2 text-sm"
          >
            <input value={naming} onChange={(e) => setNaming(e.target.value)} aria-label="New fleet's name" placeholder="New fleet's name" maxLength={80} className="w-40 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 outline-none focus:border-cyan-400" />
            <button type="submit" className="rounded-lg bg-slate-800 px-3 py-1.5 text-cyan-300 hover:bg-slate-700">New fleet</button>
          </form>
          {current && <button type="button" onClick={remove} className="rounded-lg px-2 py-1.5 text-sm text-slate-400 hover:text-red-300">Delete fleet</button>}
        </header>
        <p className="text-xs text-slate-400">
          Each vessel is recorded from Open Waters every 10 minutes while the app runs, with its tracks back to about October
          2025 filled in when it's added. Those older tracks carry no draught, so loads and discharges show from when
          recording began. More history can be filled in from the free sources below. Ports, voyages and cargo are worked out
          from the reports: a guess, not the ship's papers, good for crude tankers, rougher for product tankers.
        </p>
        {current ? (
          <>
            <AddVessel full={mmsis.length >= MOST} add={(mmsi) => !mmsis.includes(mmsi) && save(name, [...mmsis, mmsi])} />
            <Sources hasVessels={mmsis.length > 0} />
            <ol className="flex flex-col gap-3">
              {mmsis.map((mmsi) => (
                <VesselHistory
                  key={mmsi}
                  mmsi={mmsi}
                  history={histories[mmsi]}
                  remove={() => save(name, mmsis.filter((m) => m !== mmsi))}
                  showOnMap={() => showTrack({ name: histories[mmsi].record.name, category: vesselCategory(histories[mmsi].record), path: histories[mmsi].track })}
                />
              ))}
            </ol>
            {!mmsis.length && <p className="text-sm text-slate-400">No vessels yet: add up to {MOST} above.</p>}
          </>
        ) : (
          <p className="text-sm text-slate-400">Start a fleet: give it a name above, then add vessels to it.</p>
        )}
      </div>
    </main>
  )
}
