import { useEffect, useId, useRef, useState } from 'react'
import { geocode } from '../lib/api'
import type { Place } from '../lib/types'

type Props = {
  label: string
  value: string
  onChange: (text: string) => void
  onSelect: (place: Place | null) => void
  selected: Place | null
}

export default function PlaceInput({ label, value, onChange, onSelect, selected }: Props) {
  const listId = useId()
  const [hits, setHits] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (value.trim().length < 2) { setHits([]); return }
    // Don't re-query if we just selected this exact place
    if (selected && selected.name === value) { setHits([]); return }
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        setHits(await geocode(value.trim()))
        setOpen(true)
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
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="field" ref={box}>
      <label htmlFor={listId}>{label}</label>
      <div className="input-wrap">
        <input
          id={listId}
          value={value}
          autoComplete="off"
          placeholder="City, state…"
          onChange={e => { onSelect(null); onChange(e.target.value) }}
          onFocus={() => hits.length && setOpen(true)}
        />
        {busy && <span className="input-hint" aria-hidden>…</span>}
      </div>
      {open && hits.length > 0 && (
        <ul className="suggest" role="listbox">
          {hits.map((p, i) => (
            <li key={`${p.lon},${p.lat},${i}`}>
              <button
                type="button"
                role="option"
                onClick={() => {
                  onChange(p.name)
                  onSelect(p)
                  setOpen(false)
                  setHits([])
                }}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <p className="coord">{selected.lat.toFixed(3)}, {selected.lon.toFixed(3)}</p>
      )}
    </div>
  )
}
