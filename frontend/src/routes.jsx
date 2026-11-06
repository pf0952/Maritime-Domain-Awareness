// Routes: laid on the map, planned through the charts, checked against them, kept, and read from or written to the
// files ECDIS and plotters use (RTZ, GPX, CSV). A planning aid, not for navigation.
//
// A route is { name, waypoints, speed, departure, xtd, vessel }. Each waypoint is { lng, lat, name, leg }, and, as in
// RTZ, its leg is the one that runs to it from the waypoint before: { geometry: 'rhumb' | 'great', speed, xtd }
import { useEffect, useRef, useState } from 'react'
import { rhumb } from './geo'

export const ROUTE_SPEED = 10 // knots, for a new route
export const ROUTE_XTD = 0.1 // nm either side, for a new route
const VESSEL = { draught: 5, ukc: 1, air_draught: '' }
const RTZ_NS = 'http://www.cirm.org/RTZ/1/0'
const r = Math.PI / 180

export const newRoute = (name = 'New route') => ({ name, waypoints: [], speed: ROUTE_SPEED, departure: null, xtd: ROUTE_XTD, vessel: { ...VESSEL } })

// the great circle from one point to another: nautical miles, the bearing it sets off on, and points along it
export function greatCircle([lng1, lat1], [lng2, lat2], steps = 32) {
  const [p1, p2, dl] = [lat1 * r, lat2 * r, (lng2 - lng1) * r]
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl))))
  const bearing = ((Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r) % 360 + 360) % 360
  const points = []
  for (let k = 0; k <= steps; k++) {
    if (angle < 1e-9) break
    const f = k / steps
    const [a, b] = [Math.sin((1 - f) * angle) / Math.sin(angle), Math.sin(f * angle) / Math.sin(angle)]
    const x = a * Math.cos(p1) * Math.cos(lng1 * r) + b * Math.cos(p2) * Math.cos(lng2 * r)
    const y = a * Math.cos(p1) * Math.sin(lng1 * r) + b * Math.cos(p2) * Math.sin(lng2 * r)
    const z = a * Math.sin(p1) + b * Math.sin(p2)
    points.push([Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r])
  }
  return { nm: angle * 3440.065, bearing, points: points.length ? unwrap(points) : [[lng1, lat1], [lng2, lat2]] }
}

// longitudes kept continuous across 180°, so a path drawn through them doesn't jump back round the world
function unwrap(points) {
  return points.map(([lng, lat], i) => {
    if (i === 0) return [lng, lat]
    const before = points[i - 1][0]
    return [lng + 360 * Math.round((before - lng) / 360), lat]
  })
}

// each leg: from, to, nm, course, speed, how it's sailed, and the time it's reached its end (ms), if the route has a
// departure
export function legsOf(route) {
  const legs = []
  let when = route.departure ?? null
  route.waypoints.forEach((to, i) => {
    if (i === 0) return
    const from = route.waypoints[i - 1]
    const a = [from.lng, from.lat]
    const b = [to.lng, to.lat]
    const great = to.leg?.geometry === 'great'
    const { nm, bearing } = great ? greatCircle(a, b) : rhumb(a, b)
    const speed = +(to.leg?.speed || route.speed || ROUTE_SPEED)
    if (when != null) when += (nm / speed) * 3600_000
    legs.push({ index: i, from, to, nm, bearing, speed, great, eta: when, xtd: +(to.leg?.xtd || route.xtd || ROUTE_XTD) })
  })
  return legs
}

// the route's line, a path a leg, great circles as curves
export const pathsOf = (route) => legsOf(route).map((leg) => (leg.great ? greatCircle([leg.from.lng, leg.from.lat], [leg.to.lng, leg.to.lat]).points : [[leg.from.lng, leg.from.lat], [leg.to.lng, leg.to.lat]]))

// --- files

const number = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v)
const nameOf = (file) => file.replace(/\.[^.]+$/, '')

export function readRoute(fileName, text) {
  const kind = fileName.toLowerCase().split('.').pop()
  if (kind === 'rtz' || text.includes('cirm.org/RTZ')) return readRtz(fileName, text)
  if (kind === 'gpx' || text.includes('<gpx')) return readGpx(fileName, text)
  return readCsv(fileName, text)
}

const xml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error("It isn't well-formed XML")
  return doc
}
const all = (node, name) => [...node.getElementsByTagNameNS('*', name)]

function readRtz(fileName, text) {
  const doc = xml(text)
  const info = all(doc, 'routeInfo')[0]
  const fallback = all(doc, 'defaultWaypoint')[0]
  const defaults = fallback ? all(fallback, 'leg')[0] : null
  const legOf = (leg) => {
    const get = (key) => leg?.getAttribute(key) ?? defaults?.getAttribute(key)
    const xtds = [number(get('starboardXTD')), number(get('portXTD'))].filter((v) => v != null)
    return {
      geometry: get('geometryType') === 'Orthodrome' ? 'great' : 'rhumb',
      speed: number(get('speedMax')) ?? number(get('speedMin')) ?? undefined,
      xtd: xtds.length ? Math.max(...xtds) : undefined,
    }
  }
  const waypoints = all(doc, 'waypoint')
    .filter((w) => w.parentNode?.localName === 'waypoints')
    .map((w, i) => {
      const at = all(w, 'position')[0]
      return { lng: +at.getAttribute('lon'), lat: +at.getAttribute('lat'), name: w.getAttribute('name') || `WP${i + 1}`, leg: legOf(all(w, 'leg')[0]) }
    })
  const first = all(doc, 'scheduleElement').find((e) => e.getAttribute('etd'))
  const departure = first ? Date.parse(first.getAttribute('etd')) : null
  return { ...newRoute(info?.getAttribute('routeName') || nameOf(fileName)), waypoints, departure: Number.isNaN(departure) ? null : departure }
}

function readGpx(fileName, text) {
  const doc = xml(text)
  const rte = all(doc, 'rte')[0]
  const points = rte ? all(rte, 'rtept') : all(doc, 'trkpt').length ? all(doc, 'trkpt') : all(doc, 'wpt')
  const waypoints = points.map((p, i) => ({
    lng: +p.getAttribute('lon'),
    lat: +p.getAttribute('lat'),
    name: all(p, 'name')[0]?.textContent || `WP${i + 1}`,
    leg: { geometry: 'rhumb' },
  }))
  const name = (rte && all(rte, 'name')[0]?.textContent) || nameOf(fileName)
  return { ...newRoute(name), waypoints }
}

// a header with lat and lon (or latitude and longitude) columns, and name, speed and leg as wanted; or else bare lat,
// lon pairs. Degrees as decimals, or as degrees and minutes ("40 41.5 N")
function readCsv(fileName, text) {
  const rows = text.split(/\r?\n/).map((line) => line.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"|"$/g, ''))).filter((row) => row.some(Boolean))
  if (!rows.length) throw new Error('The file is empty')
  const header = rows[0].map((h) => h.toLowerCase())
  const column = (...names) => header.findIndex((h) => names.includes(h))
  let [lat, lon, name, speed, leg] = [column('lat', 'latitude'), column('lon', 'lng', 'long', 'longitude'), column('name', 'waypoint', 'wp'), column('speed', 'sog', 'knots'), column('leg', 'geometry', 'sailing')]
  const body = lat >= 0 && lon >= 0 ? rows.slice(1) : rows
  if (lat < 0 || lon < 0) [lat, lon] = [0, 1]
  const waypoints = body.map((row, i) => {
    const point = { lat: degrees(row[lat]), lng: degrees(row[lon]) }
    if (point.lat == null || point.lng == null) throw new Error(`Row ${i + 1} has no position that can be read`)
    return { ...point, name: (name >= 0 && row[name]) || `WP${i + 1}`, leg: { geometry: /^(gc|great|orthodrome)/i.test(row[leg] ?? '') ? 'great' : 'rhumb', speed: number(row[speed]) ?? undefined } }
  })
  return { ...newRoute(nameOf(fileName)), waypoints }
}

function degrees(text = '') {
  const plain = number(text)
  if (plain != null) return plain
  const m = text.match(/^\s*(-?\d+(?:\.\d+)?)[°\s]+(\d+(?:\.\d+)?)?'?\s*([NSEW])?\s*$/i)
  if (!m) return null
  const value = +m[1] + (m[2] ? +m[2] / 60 : 0)
  return /[SW]/i.test(m[3] ?? '') ? -value : value
}

const escape = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function writeRtz(route) {
  const legs = legsOf(route)
  const points = route.waypoints
    .map((w, i) => {
      const leg = i > 0 ? legs[i - 1] : null
      const legXml = leg
        ? `\n      <leg starboardXTD="${leg.xtd.toFixed(3)}" portXTD="${leg.xtd.toFixed(3)}" geometryType="${leg.great ? 'Orthodrome' : 'Loxodrome'}" speedMax="${leg.speed}"/>`
        : ''
      return `    <waypoint id="${i + 1}" name="${escape(w.name || `WP${i + 1}`)}">
      <position lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}"/>${legXml}
    </waypoint>`
    })
    .join('\n')
  const schedule =
    route.departure != null
      ? `
  <schedules>
    <schedule id="1" name="Planned">
      <calculated>
${route.waypoints
  .map((_, i) => (i === 0 ? `        <scheduleElement waypointId="1" etd="${iso(route.departure)}"/>` : `        <scheduleElement waypointId="${i + 1}" eta="${iso(legs[i - 1].eta)}" speed="${legs[i - 1].speed}"/>`))
  .join('\n')}
      </calculated>
    </schedule>
  </schedules>`
      : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<route xmlns="${RTZ_NS}" version="1.0">
  <routeInfo routeName="${escape(route.name)}"/>
  <waypoints>
${points}
  </waypoints>${schedule}
</route>
`
}

export function writeGpx(route) {
  const points = route.waypoints.map((w, i) => `    <rtept lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}"><name>${escape(w.name || `WP${i + 1}`)}</name></rtept>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ENC 3D" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>${escape(route.name)}</name>
${points}
  </rte>
</gpx>
`
}

export function writeCsv(route) {
  const legs = legsOf(route)
  const rows = route.waypoints.map((w, i) => {
    const leg = legs[i - 1]
    return [w.name || `WP${i + 1}`, w.lat.toFixed(6), w.lng.toFixed(6), leg ? leg.nm.toFixed(2) : '', leg ? leg.bearing.toFixed(1) : '', leg ? leg.speed : '', leg ? (leg.great ? 'great circle' : 'rhumb') : '', leg?.eta ? iso(leg.eta) : i === 0 && route.departure ? iso(route.departure) : '']
  })
  return [['name', 'lat', 'lon', 'leg_nm', 'course_true', 'speed_kn', 'leg', 'eta_utc'], ...rows].map((row) => row.map((c) => (/[,"]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n'
}

function download(fileName, text, type) {
  const url = window.URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  window.URL.revokeObjectURL(url)
}

// --- the panel

const input = 'rounded border border-slate-700 bg-slate-950 px-1.5 py-1 focus:border-orange-400'
const button = 'rounded-lg bg-slate-800 px-2.5 py-1.5 font-medium text-orange-200 hover:bg-slate-700 disabled:opacity-40'
const SEVERITY = { danger: 'text-red-300', caution: 'text-amber-200', info: 'text-sky-300' }
const course = (deg) => `${String(Math.round(deg) % 360).padStart(3, '0')}°`
const localTime = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
// a datetime-local input's value, in local time
const forInput = (ms) => (ms == null ? '' : new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16))

// route and setRoute: the one open; mode and setMode: 'edit' (clicks lay waypoints), 'plan' (clicks set a start and
// end), or null; planEnds: the start and end clicked so far; findings: the last check's, and setFindings; picked: the
// waypoint picked on the map; goTo([lng, lat]): moves the map there
export function RoutesPanel({ route, setRoute, mode, setMode, planEnds, setPlanEnds, findings, setFindings, picked, setPicked, goTo, note }) {
  const [kept, setKept] = useState({})
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  const file = useRef(null)
  const legs = legsOf(route)
  const total = legs.reduce((sum, leg) => sum + leg.nm, 0)
  const set = (change) => {
    setRoute((now) => ({ ...now, ...change }))
    setFindings(null)
  }
  const setVessel = (change) => set({ vessel: { ...route.vessel, ...change } })
  const setLeg = (i, change) => set({ waypoints: route.waypoints.map((w, k) => (k === i ? { ...w, leg: { ...w.leg, ...change } } : w)) })

  useEffect(() => {
    fetch('/api/routes')
      .then((res) => (res.ok ? res.json() : {}))
      .then(setKept)
      .catch(() => {})
  }, [])

  // once both ends are clicked, ask for a route between them
  useEffect(() => {
    if (planEnds.length < 2) return
    setMode(null)
    run('Planning a route through the charts…', async () => {
      const res = await fetch('/api/routes/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: planEnds[0], end: planEnds[1], vessel: vesselFor(route.vessel), xtd: +route.xtd || ROUTE_XTD }),
      })
      if (!res.ok) throw new Error((await res.json()).detail ?? 'The plan failed')
      const { waypoints, notes } = await res.json()
      setRoute((now) => ({ ...now, waypoints: waypoints.map(([lng, lat], i) => ({ lng, lat, name: i === 0 ? 'Start' : i === waypoints.length - 1 ? 'End' : `WP${i}`, leg: { geometry: 'rhumb' } })) }))
      setFindings(null)
      setPlanEnds([])
      if (notes.length) setProblem(notes.join('. '))
    })
  }, [planEnds])

  async function run(what, job) {
    setBusy(what)
    setProblem('')
    try {
      await job()
    } catch (e) {
      setProblem(e.message)
    }
    setBusy('')
  }

  const vesselFor = (v) => ({ draught: +v.draught || 0, ukc: +v.ukc || 0, air_draught: v.air_draught === '' || v.air_draught == null ? null : +v.air_draught })
  const check = () =>
    run('Checking each leg against the charts and tides…', async () => {
      const res = await fetch('/api/routes/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...route, departure: route.departure != null ? route.departure / 1000 : null, vessel: vesselFor(route.vessel) }),
      })
      if (!res.ok) throw new Error((await res.json()).detail ?? 'The check failed')
      setFindings(await res.json())
    })
  const save = () =>
    run('Saving…', async () => {
      const res = await fetch(`/api/routes/${encodeURIComponent(route.name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route) })
      if (!res.ok) throw new Error((await res.json()).detail ?? "It couldn't be saved")
      setKept(await res.json())
    })
  const remove = (name) =>
    run('Deleting…', async () => {
      const res = await fetch(`/api/routes/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (res.ok) setKept(await res.json())
    })
  const open = (r) => {
    setRoute({ ...newRoute(), ...r, vessel: { ...VESSEL, ...r.vessel } })
    setFindings(null)
    setPicked(null)
    if (r.waypoints?.length) goTo([r.waypoints[0].lng, r.waypoints[0].lat])
  }
  const load = async (e) => {
    const chosen = e.target.files?.[0]
    e.target.value = ''
    if (!chosen) return
    try {
      const read = readRoute(chosen.name, await chosen.text())
      if (read.waypoints.length < 2) throw new Error('It has fewer than two waypoints')
      open(read)
    } catch (err) {
      setProblem(`${chosen.name} couldn't be read: ${err.message}`)
    }
  }
  const safeName = route.name.replace(/[^\w .-]+/g, '_') || 'route'
  const byLeg = Object.groupBy?.(findings ?? [], (f) => f.leg) ?? {}
  const counts = (findings ?? []).reduce((c, f) => ({ ...c, [f.severity]: (c[f.severity] ?? 0) + 1 }), {})

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input value={route.name} onChange={(e) => set({ name: e.target.value })} aria-label="Route name" maxLength={120} className={`${input} min-w-0 flex-1`} />
          <button type="button" className={button} onClick={() => open(newRoute())}>
            New
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={mode === 'edit'} className={mode === 'edit' ? 'rounded-lg bg-orange-300 px-2.5 py-1.5 font-medium text-slate-900' : button} onClick={() => setMode(mode === 'edit' ? null : 'edit')}>
            {mode === 'edit' ? 'Done' : 'Lay on the map'}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'plan'}
            className={mode === 'plan' ? 'rounded-lg bg-orange-300 px-2.5 py-1.5 font-medium text-slate-900' : button}
            onClick={() => {
              setPlanEnds([])
              setMode(mode === 'plan' ? null : 'plan')
            }}
          >
            {mode === 'plan' ? 'Cancel plan' : 'Plan from A to B'}
          </button>
          <button type="button" className={button} disabled={route.waypoints.length < 2 || !!busy} onClick={check}>
            Check
          </button>
          <button type="button" className={button} disabled={route.waypoints.length < 2 || !route.name.trim() || !!busy} onClick={save}>
            Save
          </button>
        </div>
        <p className={note}>
          {mode === 'edit'
            ? 'Click to add a waypoint, on a leg to put one in it. Drag a waypoint to move it; pick one, then Delete to take it out.'
            : mode === 'plan'
              ? planEnds.length
                ? 'Now click where it ends.'
                : 'Click where the route starts.'
              : 'Plan lays a first route through water deep enough for the draught and clearance below: edit it after.'}
        </p>
        {busy && <p className="text-xs text-orange-200">{busy}</p>}
        {problem && <p className="text-xs text-amber-200">{problem}</p>}
      </section>

      <section className="flex flex-col gap-2" aria-label="Vessel and passage">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="flex flex-col gap-0.5 text-slate-400">
            Draught, m
            <input type="number" min="0" step="0.1" value={route.vessel.draught} onChange={(e) => setVessel({ draught: e.target.value })} className={`${input} text-slate-100`} />
          </label>
          <label className="flex flex-col gap-0.5 text-slate-400">
            Under keel, m
            <input type="number" min="0" step="0.1" value={route.vessel.ukc} onChange={(e) => setVessel({ ukc: e.target.value })} className={`${input} text-slate-100`} />
          </label>
          <label className="flex flex-col gap-0.5 text-slate-400">
            Air draught, m
            <input type="number" min="0" step="0.1" value={route.vessel.air_draught ?? ''} onChange={(e) => setVessel({ air_draught: e.target.value })} placeholder="–" className={`${input} text-slate-100`} />
          </label>
          <label className="flex flex-col gap-0.5 text-slate-400">
            Speed, kn
            <input type="number" min="0.5" step="0.5" value={route.speed} onChange={(e) => set({ speed: e.target.value })} className={`${input} text-slate-100`} />
          </label>
          <label className="flex flex-col gap-0.5 text-slate-400">
            XTD, nm
            <input type="number" min="0.01" step="0.01" value={route.xtd} onChange={(e) => set({ xtd: e.target.value })} className={`${input} text-slate-100`} />
          </label>
          <label className="col-span-3 flex flex-col gap-0.5 text-slate-400">
            Departure
            <input type="datetime-local" value={forInput(route.departure)} onChange={(e) => set({ departure: e.target.value ? new Date(e.target.value).getTime() : null })} className={`${input} text-slate-100`} />
          </label>
        </div>
      </section>

      {legs.length > 0 && (
        <section aria-label="Legs" className="flex flex-col gap-1">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="font-normal">To</th>
                <th className="font-normal">Course</th>
                <th className="text-right font-normal">nm</th>
                <th className="pl-2 font-normal">Sailing</th>
                <th className="pl-1 font-normal">kn</th>
                <th className="text-right font-normal">ETA</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <tr key={leg.index} className={picked === leg.index ? 'bg-orange-400/10' : ''}>
                  <td>
                    <button type="button" className="max-w-20 truncate text-left hover:text-orange-200" onClick={() => (setPicked(leg.index), goTo([leg.to.lng, leg.to.lat]))}>
                      {leg.to.name || `WP${leg.index + 1}`}
                    </button>
                    {byLeg[leg.index - 1]?.length > 0 && <span className={`ml-1 ${SEVERITY[byLeg[leg.index - 1][0].severity]}`} aria-label="has findings">●</span>}
                  </td>
                  <td>{course(leg.bearing)}</td>
                  <td className="text-right">{leg.nm.toFixed(1)}</td>
                  <td>
                    <select value={leg.great ? 'great' : 'rhumb'} onChange={(e) => setLeg(leg.index, { geometry: e.target.value })} aria-label="How the leg is sailed" className="bg-transparent">
                      <option value="rhumb">RL</option>
                      <option value="great">GC</option>
                    </select>
                  </td>
                  <td>
                    <input type="number" min="0.5" step="0.5" value={leg.to.leg?.speed ?? ''} placeholder={String(route.speed)} onChange={(e) => setLeg(leg.index, { speed: e.target.value ? +e.target.value : undefined })} aria-label="Leg speed" className="w-10 bg-transparent" />
                  </td>
                  <td className="text-right">{leg.eta ? localTime(leg.eta) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="flex justify-between border-t border-slate-700 pt-1 text-xs font-medium tabular-nums">
            <span>
              {route.waypoints.length} waypoints, {total.toFixed(1)} nm
            </span>
            <span>{legs.at(-1)?.eta ? `Arrives ${localTime(legs.at(-1).eta)}` : `${(legs.reduce((h, l) => h + l.nm / l.speed, 0)).toFixed(1)} h underway`}</span>
          </p>
          {picked != null && route.waypoints[picked] && (
            <div className="flex items-center gap-2 text-xs">
              <input value={route.waypoints[picked].name} onChange={(e) => set({ waypoints: route.waypoints.map((w, k) => (k === picked ? { ...w, name: e.target.value } : w)) })} aria-label="Waypoint name" className={`${input} w-28`} />
              <span className="text-slate-400 tabular-nums">
                {route.waypoints[picked].lat.toFixed(5)}, {route.waypoints[picked].lng.toFixed(5)}
              </span>
              <button
                type="button"
                className="ml-auto rounded px-1 text-red-300 underline hover:text-red-200"
                onClick={() => {
                  set({ waypoints: route.waypoints.filter((_, k) => k !== picked) })
                  setPicked(null)
                }}
              >
                Delete
              </button>
            </div>
          )}
          <button type="button" className="self-start rounded px-1 text-xs text-slate-300 underline hover:text-orange-200" onClick={() => set({ waypoints: [...route.waypoints].reverse().map((w, i, all) => ({ ...w, leg: all[i - 1]?.leg ?? route.waypoints.at(-1)?.leg })) })}>
            Reverse
          </button>
        </section>
      )}

      {findings && (
        <section aria-label="Check" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">
            Check:{' '}
            {findings.length === 0 ? (
              <span className="text-emerald-300">nothing found</span>
            ) : (
              <span>
                <span className={SEVERITY.danger}>{counts.danger ?? 0} danger</span>, <span className={SEVERITY.caution}>{counts.caution ?? 0} caution</span>, <span className={SEVERITY.info}>{counts.info ?? 0} note</span>
              </span>
            )}
          </h3>
          <ol className="flex max-h-56 flex-col gap-1 overflow-y-auto [scrollbar-width:thin]">
            {findings.map((f, i) => (
              <li key={i}>
                <button type="button" onClick={() => goTo(f.at)} className="text-left hover:underline">
                  <span className="text-slate-400">Leg {f.leg + 1}: </span>
                  <span className={SEVERITY[f.severity]}>{f.text}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className={note}>From NOAA's charts at chart datum, and its tides at bridges. Not for navigation: a planning aid only.</p>
        </section>
      )}

      <section aria-label="Files" className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => file.current?.click()}>
            Import
          </button>
          <input ref={file} type="file" accept=".rtz,.gpx,.csv,.txt,.xml" onChange={load} className="hidden" aria-label="Route file" />
          {['rtz', 'gpx', 'csv'].map((kind) => (
            <button
              key={kind}
              type="button"
              className={button}
              disabled={route.waypoints.length < 2}
              onClick={() => download(`${safeName}.${kind}`, { rtz: writeRtz, gpx: writeGpx, csv: writeCsv }[kind](route), kind === 'csv' ? 'text/csv' : 'application/xml')}
            >
              {kind.toUpperCase()}
            </button>
          ))}
        </div>
        <p className={note}>RTZ is what ECDIS take (IEC 61174). GPX for plotters and apps; CSV for spreadsheets.</p>
      </section>

      {Object.keys(kept).length > 0 && (
        <section aria-label="Saved routes" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-slate-400">Saved</h3>
          <ul className="flex flex-col gap-0.5">
            {Object.values(kept).map((r) => (
              <li key={r.name} className="flex items-center justify-between gap-2">
                <button type="button" className={`truncate text-left hover:text-orange-200 ${r.name === route.name ? 'text-orange-200' : ''}`} onClick={() => open(r)}>
                  {r.name}
                </button>
                <button type="button" aria-label={`Delete ${r.name}`} className="grid size-7 shrink-0 place-items-center rounded-md text-lg leading-none text-slate-300 hover:bg-slate-800 hover:text-red-300" onClick={() => remove(r.name)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
