import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { MOBILE_MQ, useMediaQuery } from '../hooks/useMediaQuery'

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

const navBtn =
  'grid min-h-11 min-w-11 cursor-pointer place-items-center rounded-xl border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/10 hover:text-mist active:scale-[0.94]'
const spinBtn =
  'grid h-9 w-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/10 hover:text-mist active:scale-[0.94]'

export default function DateTimePicker({ id, label, value, onChange }: Props) {
  const labelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null)
  const isMobile = useMediaQuery(MOBILE_MQ)
  const selected = useMemo(() => parseLocal(value), [value])
  const [view, setView] = useState(() => startOfMonth(selected))

  function measure() {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.min(Math.max(r.width, 340), 440)
    let left = r.left
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
    if (left < 12) left = 12
    // Keep panel in viewport vertically when possible
    let top = r.bottom + 8
    const estH = 360
    if (top + estH > window.innerHeight - 12) {
      top = Math.max(12, r.top - estH - 8)
    }
    setAnchor({ top, left, width })
  }

  useEffect(() => {
    if (!open) return
    measure()
    setView(startOfMonth(selected))
    const onScroll = () => measure()
    window.addEventListener('resize', onScroll)
    // Only re-anchor on window scroll — sheet transform no longer traps the portal
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, selected])

  useEffect(() => {
    if (!open) return
    function onPointer(e: PointerEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    // pointerdown works for touch + mouse; capture so sheet handlers don’t steal first
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    if (isMobile) document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, isMobile])

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

  const panel = open && (isMobile || anchor) ? (
    <div
      className={cn(
        'fixed inset-0 z-[80]',
        isMobile && 'flex items-end justify-center sm:items-center',
      )}
      data-no-drag
    >
      {/* Backdrop — dims map/sheet so the picker is usable on phone */}
      <button
        type="button"
        className={cn(
          'absolute inset-0 cursor-default border-0',
          isMobile ? 'bg-ink/72 backdrop-blur-[2px]' : 'bg-ink/35',
        )}
        aria-label="Close calendar"
        onClick={() => setOpen(false)}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-label="Choose departure"
        data-no-drag
        className={cn(
          'z-[1] grid animate-pop overflow-hidden border border-line bg-ink-soft',
          'shadow-[0_24px_56px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(197,225,229,0.08)]',
          'bg-[linear-gradient(180deg,rgba(197,225,229,0.04)_0%,transparent_120px),var(--color-ink-soft)]',
          isMobile
            ? 'relative max-h-[min(92dvh,720px)] w-full max-w-lg grid-cols-1 overflow-y-auto rounded-t-[22px] border-b-0 pb-[env(safe-area-inset-bottom,0px)]'
            : 'fixed grid-cols-[1.15fr_0.85fr] rounded-2xl',
        )}
        style={
          isMobile
            ? undefined
            : {
                top: anchor!.top,
                left: anchor!.left,
                width: anchor!.width,
              }
        }
        onPointerDown={e => e.stopPropagation()}
      >
        {/* Mobile grab cue */}
        {isMobile && (
          <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-mint/35" />
          </div>
        )}

        <div
          className={cn(
            'border-line px-3.5 pb-3',
            isMobile ? 'border-b pt-1' : 'border-r px-3.5 pb-3 pt-3.5',
            !isMobile && 'pt-3.5',
          )}
        >
          <div className="mb-2.5 grid grid-cols-[44px_1fr_44px] items-center gap-1">
            <button
              type="button"
              className={navBtn}
              aria-label="Previous month"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
            >
              <Chevron dir="left" />
            </button>
            <p className="m-0 flex items-baseline justify-center gap-2 text-[13px] font-semibold tracking-tight text-mist">
              <span>{MONTHS[view.getMonth()]}</span>
              <span className="font-normal text-muted/60" aria-hidden>|</span>
              <span className="text-muted">{view.getFullYear()}</span>
            </p>
            <button
              type="button"
              className={navBtn}
              aria-label="Next month"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
            >
              <Chevron dir="right" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7" aria-hidden>
            {WEEKDAYS.map(d => (
              <span key={d} className="py-1.5 text-center text-[10px] font-semibold uppercase tracking-wide text-muted">
                {d}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5" role="grid">
            {cells.map(({ date, inMonth }) => {
              const selectedDay = sameDay(date, selected)
              const isToday = sameDay(date, today)
              return (
                <button
                  key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${inMonth ? 'm' : 'x'}`}
                  type="button"
                  role="gridcell"
                  aria-selected={selectedDay}
                  className={cn(
                    'aspect-square min-h-10 cursor-pointer rounded-full border-0 bg-transparent font-sans text-xs font-medium text-mist transition-[background,color,transform] duration-140 ease-out-strong active:scale-[0.92] hover:bg-mint/10',
                    !inMonth && 'text-muted/35',
                    isToday && !selectedDay && 'shadow-[inset_0_0_0_1px_rgba(197,225,229,0.35)]',
                    selectedDay && 'bg-mint font-semibold text-ink hover:bg-mint-soft',
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
              className="min-h-11 cursor-pointer border-0 bg-transparent px-2 py-1.5 font-sans text-xs font-semibold text-mint transition-[opacity,transform] duration-140 ease-out-strong active:scale-[0.97] active:opacity-80"
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

        <div
          className={cn(
            'flex flex-col gap-3 bg-surface/40 px-3.5 pb-3.5',
            isMobile ? 'pt-3' : 'pt-3.5',
          )}
          aria-label="Time"
        >
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Time</p>
          <div className="flex items-center justify-center gap-1.5">
            <div className="flex flex-col items-center gap-0.5">
              <button type="button" className={spinBtn} aria-label="Hour up" onClick={() => setHour12(hour12 === 12 ? 1 : hour12 + 1, isPm)}>
                <Chevron dir="up" />
              </button>
              <span className="min-w-10 text-center text-[28px] font-semibold tabular-nums tracking-tighter leading-tight text-mist">
                {pad(hour12)}
              </span>
              <button type="button" className={spinBtn} aria-label="Hour down" onClick={() => setHour12(hour12 === 1 ? 12 : hour12 - 1, isPm)}>
                <Chevron dir="down" />
              </button>
            </div>
            <span className="-mt-1 text-2xl font-medium text-muted" aria-hidden>:</span>
            <div className="flex flex-col items-center gap-0.5">
              <button type="button" className={spinBtn} aria-label="Minute up" onClick={() => commitTime({ minutes: (minute + 5) % 60 })}>
                <Chevron dir="up" />
              </button>
              <span className="min-w-10 text-center text-[28px] font-semibold tabular-nums tracking-tighter leading-tight text-mist">
                {pad(minute)}
              </span>
              <button type="button" className={spinBtn} aria-label="Minute down" onClick={() => commitTime({ minutes: (minute + 55) % 60 })}>
                <Chevron dir="down" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-0.5 rounded-xl border border-line bg-ink/55 p-0.5">
            <button
              type="button"
              className={cn(
                'min-h-11 cursor-pointer rounded-[10px] border-0 bg-transparent py-2 font-sans text-xs font-semibold transition-[color,background,transform] duration-150 ease-out-strong active:scale-[0.97]',
                !isPm ? 'bg-mint/16 text-mist shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]' : 'text-muted',
              )}
              onClick={() => setHour12(hour12, false)}
            >
              AM
            </button>
            <button
              type="button"
              className={cn(
                'min-h-11 cursor-pointer rounded-[10px] border-0 bg-transparent py-2 font-sans text-xs font-semibold transition-[color,background,transform] duration-150 ease-out-strong active:scale-[0.97]',
                isPm ? 'bg-mint/16 text-mist shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]' : 'text-muted',
              )}
              onClick={() => setHour12(hour12, true)}
            >
              PM
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Minutes">
            {[0, 15, 30, 45].map(m => (
              <button
                key={m}
                type="button"
                className={cn(
                  'min-h-11 cursor-pointer rounded-xl border border-line bg-transparent py-2 font-sans text-[11px] font-semibold tabular-nums transition-[background,color,border-color,transform] duration-140 ease-out-strong active:scale-[0.96]',
                  minute === m ? 'border-mint/35 bg-teal/30 text-mist' : 'text-muted hover:border-line-strong hover:text-mist',
                )}
                onClick={() => commitTime({ minutes: m })}
              >
                :{pad(m)}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="mt-auto min-h-11 w-full cursor-pointer rounded-xl border-0 bg-[linear-gradient(180deg,var(--color-mint-soft)_0%,var(--color-mint)_100%)] px-4 py-2.5 font-sans text-sm font-semibold tracking-tight text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_1px_0_rgba(0,0,0,0.12)] transition-[transform,filter] duration-140 ease-out-strong hover:brightness-[1.03] active:scale-[0.97]"
            onClick={() => setOpen(false)}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="relative">
      <label id={labelId} htmlFor={id} className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
        {label}
      </label>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={cn(
          'flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-left font-sans text-sm font-medium tracking-tight text-mist transition-[border-color,background,transform,box-shadow] duration-150 ease-out-strong active:scale-[0.985] hover:border-line-strong hover:bg-surface-2',
          open && 'border-mint/40 shadow-[0_0_0_3px_rgba(13,124,130,0.22)]',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={labelId}
        data-no-drag
        onClick={() => setOpen(o => !o)}
      >
        <span className="tabular-nums">{formatTrigger(selected)}</span>
        <svg className="shrink-0 text-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.75" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>

      {typeof document !== 'undefined' && panel ? createPortal(panel, document.body) : null}
    </div>
  )
}
