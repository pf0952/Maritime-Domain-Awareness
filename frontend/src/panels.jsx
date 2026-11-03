// The cards over the map: tide, search, a picked vessel, and the loading screen
import { useRef, useState } from 'react'
import { AIS, VESSELS_FOUND, aisValue, vesselCategory } from './vessels'

export const TIDE_HOURS = 120 // either side of now
// tucked away below the screen, all but its first line, until the pointer's on it
const TIDE_CARD =
  'absolute bottom-0 left-1/2 w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 translate-y-[calc(100%-2.25rem)] rounded-t-xl border border-b-0 border-slate-700 bg-slate-900/90 px-4 pt-2.5 pb-4 text-slate-100 shadow-xl transition-transform duration-200 hover:translate-y-0 focus-within:translate-y-0'

export function syncMessage(sync) {
  if (!sync) return 'Connecting'
  const { phase, done, total, charts, problem } = sync
  if (phase === 'downloading' && total > 0) return `Downloading charts: ${done.toLocaleString()} of ${total.toLocaleString()}`
  if (phase === 'compiling' && total > 0) return `Preparing charts: ${done.toLocaleString()} of ${total.toLocaleString()}`
  if (phase === 'coast') return "Downloading the world's coast: 1 GB, the first time only"
  if (phase === 'seabed') return "Downloading the world's seabed: 4 GB, the first time only"
  if (phase === 'checking' || phase === 'starting') return 'Checking NOAA for updates'
  return `${charts.toLocaleString()} charts${problem ? '' : ', up to date'}`
}

export function TidePanel({ tide, hour, setHour }) {
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

export function SearchBar({ go }) {
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState([])
  const [note, setNote] = useState('')

  async function search(e) {
    e.preventDefault()
    if (!query.trim()) return
    setNote('Searching')
    setPlaces([])
    const q = encodeURIComponent(query.trim())
    const [towns, ships] = await Promise.all([
      fetch(`/api/search?q=${q}`).then((res) => (res.ok ? res.json() : null), () => null),
      // Open Waters looks up a ship by name or MMSI, wherever it is
      fetch(`${AIS}?q=${q}`).then((res) => (res.ok ? res.json() : null), () => null),
    ])
    const vessels = (ships?.features ?? []).slice(0, VESSELS_FOUND).map(({ geometry: { coordinates: [lng, lat] }, properties }) => ({
      name: `${properties.name || properties.mmsi} (vessel, ${vesselCategory(properties)})`,
      vessel: { ...properties, hdg: properties.heading ?? properties.cog, lng, lat },
    }))
    // a ship named exactly so, or its MMSI, comes before places, unless a place is named so too: Rotterdam is a barge
    const asked = query.trim().toUpperCase()
    const exact =
      vessels.some(({ vessel }) => [vessel.name, String(vessel.mmsi)].includes(asked)) &&
      !(towns ?? []).some((town) => town.name.split(',')[0].trim().toUpperCase() === asked)
    const found = exact ? [...vessels, ...(towns ?? [])] : [...(towns ?? []), ...vessels]
    setNote(towns || ships ? (found.length ? '' : 'Nothing found') : "Search isn't available just now")
    setPlaces(found)
    if (found.length) go(found[0])
  }

  return (
    <form
      role="search"
      onSubmit={search}
      className="absolute top-3 right-4 left-22 z-10 text-sm text-slate-100 md:right-auto md:left-1/2 md:w-[26rem] md:-translate-x-1/2"
    >
      <input
        type="search"
        aria-label="Search for a place or vessel"
        placeholder="Search for a place or vessel, then press Enter"
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
          {places.map((place, i) => (
            <li key={`${i} ${place.name}`}>
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

// every field it has sent: the map's tiles carry a few, and the rest comes from the vessel's own record
export function VesselCard({ vessel, detail, close }) {
  const { particulars = {}, ...fields } = detail?.properties ?? vessel
  const shown = ([key, value]) => value !== null && value !== '' && typeof value !== 'object' && !['lng', 'lat', 'mmsi', 'name'].includes(key)
  const row = ([key, value]) => (
    <div key={key} className="flex justify-between gap-3">
      <dt className="text-slate-400">{key.replaceAll('_', ' ')}</dt>
      <dd className="text-right break-words">{aisValue(key, value)}</dd>
    </div>
  )
  return (
    <section
      aria-label={`Vessel ${vessel.name ?? vessel.mmsi}`}
      className="absolute top-4 right-4 flex max-h-[60%] w-80 max-w-[calc(100%-2rem)] flex-col gap-2 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 [scrollbar-color:#475569_transparent] [scrollbar-width:thin] p-4 text-sm text-slate-100 shadow-xl"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{fields.name ?? 'Unnamed vessel'}</h2>
          <p className="text-xs text-slate-400">{vesselCategory(fields)}, MMSI {vessel.mmsi}</p>
        </div>
        <button type="button" aria-label="Close" onClick={close} className="rounded px-1 text-slate-300 hover:text-cyan-300">
          ×
        </button>
      </header>
      <dl className="flex flex-col gap-0.5 text-xs">{Object.entries(fields).filter(shown).map(row)}</dl>
      {Object.keys(particulars).length > 0 && (
        <dl className="flex flex-col gap-0.5 border-t border-slate-700 pt-2 text-xs">{Object.entries(particulars).filter(shown).map(row)}</dl>
      )}
      <p className="text-xs text-slate-400">{Object.values(detail?.attribution ?? {}).join(' ') || 'Open Waters AIS'}</p>
    </section>
  )
}

export function LoadingScreen({ sync }) {
  const stage = useRef(null) // when this stage began to count, to tell how long it has left
  const { phase, done = 0, total = 0, problem } = sync ?? {}
  if (!stage.current || stage.current.phase !== phase || done < stage.current.done) {
    stage.current = { phase, done, at: Date.now() }
  }
  const rate = (done - stage.current.done) / (Date.now() - stage.current.at)
  const minutes = rate > 0 ? Math.ceil((total - done) / rate / 60000) : null
  const heading =
    { downloading: 'Downloading charts from NOAA', compiling: 'Preparing charts', warnings: 'Placing nav warnings' }[phase] ??
    'Checking charts'
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
