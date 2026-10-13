import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/cn'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

type Props = {
  id?: string
  label: string
  value: string
  onChange: (next: string) => void
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function parseLocal(value: string): Date {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

function toLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function daysInMonth(y: number, m: number) {
  return new Date(y, m + 1, 0).getDate()
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function formatTrigger(d: Date) {
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function Chevron({ dir }: { dir: 'up' | 'down' | 'left' | 'right' }) {
  const rot = { up: -90, down: 90, left: 180, right: 0 }[dir]
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function DateTimePicker({ id, label, value, onChange }: Props) {
  const labelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null)
  const selected = useMemo(() => parseLocal(value), [value])
  const [view, setView] = useState(() => startOfMonth(selected))

  function measure() {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.min(Math.max(r.width, 320), 420)
    let left = r.left
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
    if (left < 12) left = 12
    setAnchor({ top: r.bottom + 8, left, width })
  }

  useEffect(() => {
    if (!open) return
    measure()
    setView(startOfMonth(selected))
    const onScroll = () => measure()
    window.addEventListener('resize', onScroll)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, selected])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const cells = useMemo(() => {
    const y = view.getFullYear()
    const m = view.getMonth()
    const firstDow = startOfMonth(view).getDay()
    const dim = daysInMonth(y, m)
    const prevDim = daysInMonth(y, m - 1)
    const out: { date: Date; inMonth: boolean }[] = []
    for (let i = firstDow - 1; i >= 0; i--) {
      out.push({ date: new Date(y, m - 1, prevDim - i), inMonth: false })
    }
    for (let d = 1; d <= dim; d++) {
      out.push({ date: new Date(y, m, d), inMonth: true })
    }
    while (out.length % 7 !== 0 || out.length < 42) {
      const last = out[out.length - 1].date
      out.push({
        date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
        inMonth: false,
      })
    }
    return out.slice(0, 42)
  }, [view])

  function commitDate(day: Date) {
    const next = new Date(selected)
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
    onChange(toLocalValue(next))
  }

  function commitTime(partial: { hours?: number; minutes?: number }) {
    const next = new Date(selected)
    if (partial.hours != null) next.setHours(partial.hours)
    if (partial.minutes != null) next.setMinutes(partial.minutes)
    onChange(toLocalValue(next))
  }

  const hour24 = selected.getHours()
  const isPm = hour24 >= 12
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  const minute = selected.getMinutes()

  function setHour12(h12: number, pm: boolean) {
    let h = h12 % 12
    if (pm) h += 12
    commitTime({ hours: h })
  }

  const today = new Date()

  return (
    <div className="relative z-6" ref={root}>
      <label id={labelId} htmlFor={id} className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
        {label}
      </label>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={cn(
          'flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-left font-sans text-sm font-medium tracking-tight text-mist transition-[border-color,background,transform,box-shadow] duration-150 ease-out-strong active:scale-[0.985] hover:border-line-strong hover:bg-surface-2',
          open && 'border-mint/40 shadow-[0_0_0_3px_rgba(13,124,130,0.22)]',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => setOpen(o => !o)}
      >
        <span>{formatTrigger(selected)}</span>
        <svg className="shrink-0 text-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.75" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>

      {open && anchor && (
        <div
          className="fixed z-80 grid animate-pop grid-cols-[1.15fr_0.85fr] overflow-hidden rounded-[18px] border border-line-strong bg-[#121c1f] shadow-[0_24px_56px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(197,225,229,0.06)] max-[420px]:grid-cols-1"
          role="dialog"
          aria-label="Choose departure"
          style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
        >
          <div className="border-r border-line px-3.5 pb-3 pt-3.5 max-[420px]:border-r-0 max-[420px]:border-b">
            <div className="mb-3 grid grid-cols-[32px_1fr_32px] items-center gap-1">
              <button
                type="button"
                className="grid h-8 w-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/8 hover:text-mist active:scale-[0.92]"
                aria-label="Previous month"
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
              >
                <Chevron dir="left" />
              </button>
              <p className="m-0 flex items-baseline justify-center gap-2 text-[13px] font-semibold tracking-tight text-white">
                <span>{MONTHS[view.getMonth()]}</span>
                <span className="font-normal text-muted/55" aria-hidden>|</span>
                <span>{view.getFullYear()}</span>
              </p>
              <button
                type="button"
                className="grid h-8 w-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/8 hover:text-mist active:scale-[0.92]"
                aria-label="Next month"
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
              >
                <Chevron dir="right" />
              </button>
            </div>

            <div className="mb-1 grid grid-cols-7" aria-hidden>
              {WEEKDAYS.map(d => (
                <span key={d} className="py-1 text-center text-[10px] font-semibold text-muted/70">{d}</span>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5" role="grid">
              {cells.map(({ date, inMonth }) => {
                const selectedDay = sameDay(date, selected)
                const isToday = sameDay(date, today)
                return (
                  <button
                    key={date.toISOString()}
                    type="button"
                    role="gridcell"
                    aria-selected={selectedDay}
                    className={cn(
                      'aspect-square cursor-pointer rounded-full border-0 bg-transparent font-sans text-xs font-medium text-white transition-[background,color,transform] duration-140 ease-out-strong active:scale-[0.92] hover:bg-mint/10',
                      !inMonth && 'text-muted/40',
                      isToday && !selectedDay && 'shadow-[inset_0_0_0_1px_rgba(197,225,229,0.35)]',
                      selectedDay && 'bg-mint font-semibold text-ink hover:bg-mint',
                    )}
                    onClick={() => commitDate(date)}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>

            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent px-1 py-1.5 font-sans text-xs font-semibold text-mint transition-[opacity,transform] duration-140 ease-out-strong active:scale-[0.97] active:opacity-80"
                onClick={() => {
                  const n = new Date()
                  n.setMinutes(n.getMinutes() + 60)
                  n.setSeconds(0, 0)
                  onChange(toLocalValue(n))
                  setView(startOfMonth(n))
                }}
              >
                Today
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3 bg-ink/35 px-3.5 pb-3 pt-3.5" aria-label="Time">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Time</p>
            <div className="flex items-center justify-center gap-1.5">
              <div className="flex flex-col items-center gap-0.5">
                <button type="button" className="grid h-7 w-9 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/8 hover:text-mist active:scale-[0.92]" aria-label="Hour up" onClick={() => setHour12(hour12 === 12 ? 1 : hour12 + 1, isPm)}>
                  <Chevron dir="up" />
                </button>
                <span className="min-w-10 text-center text-[28px] font-semibold tabular-nums tracking-tighter leading-tight text-white">{pad(hour12)}</span>
                <button type="button" className="grid h-7 w-9 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/8 hover:text-mist active:scale-[0.92]" aria-label="Hour down" onClick={() => setHour12(hour12 === 1 ? 12 : hour12 - 1, isPm)}>
                  <Chevron dir="down" />
                </button>
              </div>
              <span className="-mt-1 text-2xl font-medium text-muted" aria-hidden>:</span>
              <div className="flex flex-col items-center gap-0.5">
                <button type="button" className="grid h-7 w-9 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/8 hover:text-mist active:scale-[0.92]" aria-label="Minute up" onClick={() => commitTime({ minutes: (minute + 5) % 60 })}>
                  <Chevron dir="up" />
                </button>
                <span className="min-w-10 text-center text-[28px] font-semibold tabular-nums tracking-tighter leading-tight text-white">{pad(minute)}</span>
                <button type="button" className="grid h-7 w-9 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/8 hover:text-mist active:scale-[0.92]" aria-label="Minute down" onClick={() => commitTime({ minutes: (minute + 55) % 60 })}>
                  <Chevron dir="down" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-0 rounded-[10px] border border-line bg-ink/55 p-0.5">
              <button type="button" className={cn('cursor-pointer rounded-lg border-0 bg-transparent py-2 font-sans text-xs font-semibold transition-[color,background,transform] duration-150 ease-out-strong active:scale-[0.97]', !isPm ? 'bg-mint/16 text-mist shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]' : 'text-muted')} onClick={() => setHour12(hour12, false)}>AM</button>
              <button type="button" className={cn('cursor-pointer rounded-lg border-0 bg-transparent py-2 font-sans text-xs font-semibold transition-[color,background,transform] duration-150 ease-out-strong active:scale-[0.97]', isPm ? 'bg-mint/16 text-mist shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]' : 'text-muted')} onClick={() => setHour12(hour12, true)}>PM</button>
            </div>

            <div className="grid grid-cols-4 gap-1" role="group" aria-label="Minutes">
              {[0, 15, 30, 45].map(m => (
                <button
                  key={m}
                  type="button"
                  className={cn(
                    'cursor-pointer rounded-lg border border-line bg-transparent py-1.5 font-sans text-[11px] font-semibold tabular-nums transition-[background,color,border-color,transform] duration-140 ease-out-strong active:scale-[0.96]',
                    minute === m ? 'border-mint/30 bg-teal/35 text-mist' : 'text-muted',
                  )}
                  onClick={() => commitTime({ minutes: m })}
                >
                  :{pad(m)}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="mt-auto w-full cursor-pointer rounded-[10px] border-0 bg-mint py-2.5 font-sans text-[13px] font-semibold tracking-tight text-ink transition-[transform,filter] duration-140 ease-out-strong hover:brightness-105 active:scale-[0.97]"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
