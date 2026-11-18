// The motions side bar: how My vessel will move along a passage through the forecast (backend/motions.py), at a time
// picked on its timeline. A little ship rolls (seen from astern) and pitches (from the side) at the significant
// amplitudes, with the accelerations at her cargo and the warnings. An estimate from her GM and the sea, not her own
// seakeeping: a planning aid.
import { useEffect, useMemo, useRef, useState } from 'react'

const HIGH_G = 0.5 // significant transverse or vertical acceleration (g) shown as high: about cargo securing's design range
const localTime = (s) => new Date(s * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const course = (deg) => `${String(Math.round(deg) % 360).padStart(3, '0')}°`

// the ship drawn in place, moved by refs each frame (no re-render): rolling about her waterline from astern, pitching
// and heaving from the side
function Ship({ motion, wavePeriod, still }) {
  const roll = useRef(null)
  const pitch = useRef(null)
  useEffect(() => {
    if (!motion) return
    const tr = Math.max(motion.roll_period || 12, 3)
    const tp = Math.max(wavePeriod || 8, 3)
    // a narrow-band look: her roll at her own period, waxing and waning; pitch and heave at the waves'
    const at = (t) => [
      motion.roll * 0.5 * (Math.sin((2 * Math.PI * t) / tr) * (0.75 + 0.25 * Math.sin((2 * Math.PI * t) / (6.3 * tr))) + 0.35 * Math.sin((2 * Math.PI * t) / (1.17 * tr) + 1)),
      motion.pitch * 0.6 * Math.sin((2 * Math.PI * t) / tp + 0.5),
      motion.heave * 0.6 * Math.sin((2 * Math.PI * t) / tp - 1),
    ]
    const put = (t) => {
      const [r, p, h] = at(t)
      roll.current?.setAttribute('transform', `rotate(${(-r).toFixed(2)} 50 40)`)
      pitch.current?.setAttribute('transform', `translate(0 ${(-h * 2).toFixed(2)}) rotate(${(-p).toFixed(2)} 60 40)`)
    }
    if (still) return put((motion.roll_period || 12) / 4)
    let frame
    const start = performance.now()
    const tick = (now) => {
      put((now - start) / 1000)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [motion, wavePeriod, still])
  return (
    <div className="grid grid-cols-2 gap-2" aria-hidden="true">
      <svg viewBox="0 0 100 70" className="h-20 w-full rounded bg-slate-950">
        <g ref={roll}>
          <path d="M22 26 L78 26 L78 44 Q78 52 70 52 L30 52 Q22 52 22 44 Z" fill="#334155" stroke="#94a3b8" strokeWidth="1" />
          <rect x="40" y="14" width="20" height="12" fill="#475569" stroke="#94a3b8" strokeWidth="1" />
        </g>
        <rect x="0" y="40" width="100" height="30" fill="#0e7490" fillOpacity="0.45" />
        <text x="4" y="10" fontSize="7" fill="#94a3b8">Stern view</text>
      </svg>
      <svg viewBox="0 0 120 70" className="h-20 w-full rounded bg-slate-950">
        <g ref={pitch}>
          <path d="M8 30 L104 30 L114 26 L108 46 L16 46 Q8 46 8 38 Z" fill="#334155" stroke="#94a3b8" strokeWidth="1" />
          <rect x="14" y="18" width="16" height="12" fill="#475569" stroke="#94a3b8" strokeWidth="1" />
        </g>
        <rect x="0" y="40" width="120" height="30" fill="#0e7490" fillOpacity="0.45" />
        <text x="4" y="10" fontSize="7" fill="#94a3b8">Side view</text>
      </svg>
    </div>
  )
}

// passage: { name, timeline } (each sample { t, lng, lat, heading, speed, forecast, motion, accelerations }); onAt:
// called with the sample picked, for the map to mark where she is
export function MotionsBar({ passage, onAt }) {
  const [open, setOpen] = useState(true)
  const [i, setI] = useState(0)
  const still = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, [])
  const timeline = passage.timeline
  const s = timeline[Math.min(i, timeline.length - 1)]
  const worst = useMemo(() => timeline.reduce((w, x, k) => ((x.motion?.roll ?? 0) > (timeline[w].motion?.roll ?? 0) ? k : w), 0), [timeline])
  useEffect(() => setI(0), [passage])
  useEffect(() => onAt(open ? s : null), [s, open])
  useEffect(() => () => onAt(null), [])
  if (!s?.motion) return null
  const f = s.forecast
  return (
    <aside aria-label="Motions" className="absolute top-14 right-4 z-20 max-h-[calc(100vh-8rem)] w-80 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 text-xs text-slate-200 shadow-xl">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-medium hover:text-cyan-300">
        <span>Motions: {passage.name}</span>
        <span className="tabular-nums text-slate-400">{open ? '–' : `Roll ${s.motion.roll}°`}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <Ship motion={s.motion} wavePeriod={f?.period} still={still} />
          <label className="flex flex-col gap-1 text-slate-400">
            <span className="flex justify-between tabular-nums">
              <span>{localTime(s.t)}</span>
              <span>HDG {course(s.heading)}, SOG {s.speed} kn</span>
            </span>
            <input type="range" min="0" max={timeline.length - 1} value={i} onChange={(e) => setI(+e.target.value)} aria-label="Passage time" className="accent-cyan-400" />
          </label>
          <dl className="grid grid-cols-3 gap-x-2 gap-y-0.5 tabular-nums">
            <dt className="text-slate-400">Roll</dt>
            <dt className="text-slate-400">Pitch</dt>
            <dt className="text-slate-400">Heave</dt>
            <dd className="text-base">{s.motion.roll}°</dd>
            <dd className="text-base">{s.motion.pitch}°</dd>
            <dd className="text-base">{s.motion.heave} m</dd>
          </dl>
          <p className="text-slate-400 tabular-nums">
            {f ? `Waves ${f.wave ?? '–'} m, ${f.period ?? '–'} s` : 'Beyond forecast range: calm assumed'}; roll period {s.motion.roll_period} s
          </p>
          <table className="tabular-nums">
            <caption className="text-left text-slate-400">Significant accelerations, g</caption>
            <thead className="text-slate-400">
              <tr>
                <th className="text-left font-normal">Position</th>
                <th className="text-right font-normal">Vert.</th>
                <th className="text-right font-normal">Trans.</th>
                <th className="text-right font-normal">Long.</th>
              </tr>
            </thead>
            <tbody>
              {s.accelerations.map((a) => (
                <tr key={a.name}>
                  <td className="max-w-28 truncate" title={a.name}>{a.name}</td>
                  {['vertical', 'transverse', 'longitudinal'].map((k) => (
                    <td key={k} className={`text-right ${a[k] >= HIGH_G ? 'text-red-300' : ''}`}>
                      {a[k].toFixed(2)}
                      {a[k] >= HIGH_G ? ' !' : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {s.motion.warnings.map((w) => (
            <p key={w} className="text-amber-200">⚠ {w}</p>
          ))}
          <button type="button" className="self-start rounded px-1 text-slate-300 underline hover:text-cyan-300" onClick={() => setI(worst)}>
            Maximum roll: {timeline[worst].motion.roll}° at {localTime(timeline[worst].t)}
          </button>
          <p className="text-slate-500">Estimated from GM and forecast sea state, not from vessel seakeeping data. Planning aid only. Not for navigation.</p>
        </div>
      )}
    </aside>
  )
}
