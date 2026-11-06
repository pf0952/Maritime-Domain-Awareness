// The side menus: a rail of buttons down the left, each opening its own panel beside it, one at a time
import { useEffect, useState } from 'react'

// outline icons, 24 across
export const ICONS = {
  chart: 'M12 3 2 8l10 5 10-5-10-5Z M2 12.5l10 5 10-5 M2 17l10 5 10-5',
  vessels: 'M4 14h16l-2.5 6h-11Z M12 3v11 M12 4l5 8h-5',
  warnings: 'M12 3 2 20h20Z M12 9.5v5 M12 17.5v.5',
  conditions: 'M2 16c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5-1 M2 20.5c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5-1 M12 4v1 M7 6l.7.7 M17 6l-.7.7 M8.5 11.5a3.5 3.5 0 0 1 7 0',
  routes: 'M5 19a2 2 0 1 0 0-.01 M19 5a2 2 0 1 0 0-.01 M7 18.5h6.5a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7H17',
  tools: 'M3.5 16.5 16.5 3.5l4 4-13 13Z M7.5 12.5l2 2 M10.5 9.5l2 2 M13.5 6.5l2 2',
  about: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Z M12 11v6 M12 7.5v.5',
}

// menus: { id, label, title, icon, body }, and as wanted: off (its layer is hidden), alert (something's wrong), apart (set
// off below the rest), wide (its panel needs the room)
export function SideMenu({ menus }) {
  const [open, setOpen] = useState(null) // always starts collapsed
  const menu = menus.find((m) => m.id === open)

  useEffect(() => {
    if (!open) return
    const close = (e) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  return (
    <>
      <nav
        aria-label="Menus"
        className="absolute top-4 left-4 z-15 flex w-16 flex-col gap-1 rounded-xl border border-slate-700 bg-slate-900/90 p-1 shadow-xl"
      >
        {menus.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-expanded={open === m.id}
            aria-controls="side-panel"
            title={m.title}
            onClick={() => setOpen(open === m.id ? null : m.id)}
            className={`relative flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[11px] leading-tight ${
              m.apart ? 'mt-1 before:absolute before:-top-1 before:inset-x-2 before:border-t before:border-slate-700' : ''
            } ${open === m.id ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-300 hover:bg-slate-800 hover:text-cyan-300'} ${
              m.off ? 'opacity-55' : ''
            }`}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={m.icon} />
            </svg>
            {m.label}
            {m.alert && (
              <>
                <span className="absolute top-1 right-2 size-2 rounded-full bg-amber-400" aria-hidden="true" />
                <span className="sr-only">, needs a look</span>
              </>
            )}
          </button>
        ))}
      </nav>
      {/* every menu's panel stays mounted, only the open one showing: a panel's work in hand (a route being planned,
          say) carries on with it closed, and it's as it was when opened again */}
      {(
        <aside
          id="side-panel"
          aria-label={menu?.title}
          hidden={!menu}
          className={`absolute top-4 left-22 z-15 ${menu ? 'flex' : 'hidden'} max-h-[calc(100%-2rem)] ${menu?.wide ? 'w-[min(27rem,calc(100vw-6.5rem))]' : 'w-[min(18rem,calc(100vw-6.5rem))]'} flex-col gap-4 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 p-4 text-sm text-slate-100 shadow-xl [scrollbar-color:#475569_transparent] [scrollbar-width:thin]`}
        >
          <header className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{menu?.title}</h2>
            <button type="button" aria-label="Close the menu" onClick={() => setOpen(null)} className="grid size-7 shrink-0 place-items-center rounded-md text-lg leading-none text-slate-300 hover:bg-slate-800 hover:text-cyan-300">
              ×
            </button>
          </header>
          {menus.map((m) => (
            <div key={m.id} className={m.id === open ? 'contents' : 'hidden'}>
              {m.body}
            </div>
          ))}
        </aside>
      )}
    </>
  )
}

export function Toggle({ checked, onChange, disabled, children }) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? 'opacity-50' : ''}`}>
      <input type="checkbox" className="accent-cyan-400" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

export function Section({ title, children, className = 'gap-1' }) {
  return (
    <fieldset className={`flex flex-col ${className}`}>
      <legend className="mb-1 font-medium text-slate-400">{title}</legend>
      {children}
    </fieldset>
  )
}
