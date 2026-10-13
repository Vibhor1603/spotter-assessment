import { useEffect, useId, useRef, useState } from 'react'
import { geocode } from '../lib/api'
import { cn } from '../lib/cn'
import type { Place } from '../lib/types'

type Props = {
  label: string
  value: string
  onChange: (text: string) => void
  onSelect: (place: Place | null) => void
  selected: Place | null
  mark?: string
}

export default function PlaceInput({ label, value, onChange, onSelect, selected, mark }: Props) {
  const listId = useId()
  const [hits, setHits] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const active = useRef(false)

  useEffect(() => {
    if (!active.current) return
    if (value.trim().length < 2) {
      setHits([])
      setOpen(false)
      return
    }
    if (selected && selected.name === value) {
      setHits([])
      setOpen(false)
      return
    }
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const next = await geocode(value.trim())
        setHits(next)
        if (active.current) setOpen(next.length > 0)
      } catch {
        setHits([])
      } finally {
        setBusy(false)
      }
    }, 280)
    return () => clearTimeout(t)
  }, [value, selected])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false)
        active.current = false
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="relative grid grid-cols-[28px_1fr] items-start gap-2.5 px-4 pb-3 pt-3.5" ref={box}>
      {mark && (
        <span
          className={cn(
            'mt-[22px] grid h-[22px] w-[22px] place-items-center rounded-full text-[11px] font-semibold tracking-tight shadow-[0_0_0_3px_rgba(197,225,229,0.12)]',
            mark === 'B'
              ? 'bg-teal-bright text-white shadow-[0_0_0_3px_rgba(13,124,130,0.2)]'
              : 'bg-mint text-ink',
          )}
          aria-hidden
        >
          {mark}
        </span>
      )}
      <div className="min-w-0">
        <label
          htmlFor={listId}
          className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-muted"
        >
          {label}
        </label>
        <div className="relative">
          <input
            id={listId}
            value={value}
            autoComplete="off"
            placeholder="City, state…"
            className="w-full border-0 bg-transparent py-1.5 font-sans text-[15px] font-medium tracking-tight text-mist placeholder:font-normal placeholder:text-muted/55 focus:outline-none"
            onChange={e => {
              active.current = true
              onSelect(null)
              onChange(e.target.value)
            }}
            onFocus={() => {
              active.current = true
              if (hits.length) setOpen(true)
            }}
            onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
          />
          {busy && (
            <span className="absolute right-0 top-1/2 -translate-y-1/2 text-xs text-muted" aria-hidden>
              …
            </span>
          )}
        </div>
        {selected && (
          <p className="mt-0.5 text-[10px] font-medium tabular-nums tracking-wide text-muted/70">
            {selected.lat.toFixed(3)}°, {selected.lon.toFixed(3)}°
          </p>
        )}
      </div>
      {open && hits.length > 0 && (
        <ul
          className="absolute left-3 right-3 top-[calc(100%-4px)] z-30 max-h-[220px] animate-pop list-none overflow-auto rounded-xl border border-line-strong bg-surface-2/95 p-1.5 shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl"
          role="listbox"
        >
          {hits.map((p, i) => (
            <li key={`${p.lon},${p.lat},${i}`}>
              <button
                type="button"
                role="option"
                className="w-full cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2.5 text-left font-sans text-[13px] font-normal text-mist transition-colors duration-120 ease-out-strong hover:bg-teal/30"
                onClick={() => {
                  onChange(p.name)
                  onSelect(p)
                  setOpen(false)
                  setHits([])
                  active.current = false
                }}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
