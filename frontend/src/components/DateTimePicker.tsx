import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { MOBILE_MQ, useMediaQuery } from '../hooks/useMediaQuery'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** Desktop popover: wide enough for calendar + time without clipping. */
const DESKTOP_W = 520
const DESKTOP_H = 392

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
  'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/10 hover:text-mist active:scale-[0.94]'
const spinBtn =
  'grid h-6 w-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/10 hover:text-mist active:scale-[0.94]'

export default function DateTimePicker({ id, label, value, onChange }: Props) {
  const labelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const isMobile = useMediaQuery(MOBILE_MQ)
  const selected = useMemo(() => parseLocal(open ? draft : value), [open, draft, value])
  const [view, setView] = useState(() => startOfMonth(selected))

  function measure() {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 16
    // Prefer aligning to the trigger; if it would clip, slide fully into the viewport.
    let left = r.left
    if (left + DESKTOP_W > window.innerWidth - pad) {
      left = window.innerWidth - DESKTOP_W - pad
    }
    if (left < pad) left = pad

    let top = r.bottom + 8
    if (top + DESKTOP_H > window.innerHeight - pad) {
      top = Math.max(pad, r.top - DESKTOP_H - 8)
    }
    setAnchor({ top, left })
  }

  function closeDiscard() {
    setOpen(false)
    setDraft(value)
  }

  function closeSave() {
    onChange(draft)
    setOpen(false)
  }

  function openPicker() {
    setDraft(value)
    setView(startOfMonth(parseLocal(value)))
    setOpen(true)
  }

  useEffect(() => {
    if (!open || isMobile) return
    measure()
    const onResize = () => measure()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, isMobile])

  useEffect(() => {
    if (!open) {
      delete document.body.dataset.pickerOpen
      return
    }
    document.body.dataset.pickerOpen = '1'

    function isInsidePicker(t: EventTarget | null) {
      if (!(t instanceof Node)) return false
      if (triggerRef.current?.contains(t)) return true
      if (panelRef.current?.contains(t)) return true
      const el = t instanceof Element ? t : t.parentElement
      return !!el?.closest?.('[data-picker-panel]')
    }

    function onPointer(e: PointerEvent) {
      if (isInsidePicker(e.target)) return
      closeDiscard()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDiscard()
    }

    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    if (isMobile) document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      delete document.body.dataset.pickerOpen
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setDraft(prev => {
      const base = parseLocal(prev)
      const next = new Date(base)
      next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
      return toLocalValue(next)
    })
    if (day.getMonth() !== view.getMonth() || day.getFullYear() !== view.getFullYear()) {
      setView(startOfMonth(day))
    }
  }

  function commitTime(partial: { hours?: number; minutes?: number }) {
    setDraft(prev => {
      const next = parseLocal(prev)
      if (partial.hours != null) next.setHours(partial.hours)
      if (partial.minutes != null) next.setMinutes(partial.minutes)
      return toLocalValue(next)
    })
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
        isMobile && 'flex items-end justify-center',
      )}
      data-no-drag
      data-picker-root
    >
      <button
        type="button"
        tabIndex={-1}
        className={cn(
          'absolute inset-0 cursor-default border-0',
          isMobile ? 'bg-ink/72 backdrop-blur-[2px]' : 'bg-transparent',
        )}
        aria-label="Close calendar"
        onPointerDown={e => {
          e.preventDefault()
          closeDiscard()
        }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-label="Choose departure"
        data-no-drag
        data-picker-panel
        className={cn(
          'z-[1] animate-pop border border-line bg-ink-soft',
          'shadow-[0_24px_56px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(197,225,229,0.08)]',
          'bg-[linear-gradient(180deg,rgba(197,225,229,0.04)_0%,transparent_80px),var(--color-ink-soft)]',
          isMobile
            ? 'relative flex w-full max-w-lg flex-col overflow-hidden rounded-t-[20px] border-b-0 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]'
            : 'fixed flex flex-col overflow-hidden rounded-2xl',
        )}
        style={
          isMobile
            ? undefined
            : {
                top: anchor!.top,
                left: anchor!.left,
                width: DESKTOP_W,
              }
        }
        onPointerDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 border-b border-line',
            isMobile ? 'min-h-10 px-3 py-1' : 'min-h-12 px-3.5 py-2',
          )}
        >
          <button
            type="button"
            className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted transition-[background,color,transform] duration-140 ease-out-strong hover:bg-mint/10 hover:text-mist active:scale-[0.94]"
            aria-label="Close"
            onPointerDown={e => e.stopPropagation()}
            onClick={closeDiscard}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[13px] font-semibold tracking-tight text-mist">{label}</p>
            <p className="m-0 truncate text-[11px] tabular-nums text-muted">{formatTrigger(selected)}</p>
          </div>
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent px-2 py-1.5 font-sans text-xs font-semibold text-mint transition-[opacity,transform] duration-140 ease-out-strong active:scale-[0.97]"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => {
              const n = new Date()
              n.setMinutes(n.getMinutes() + 60)
              n.setSeconds(0, 0)
              setDraft(toLocalValue(n))
              setView(startOfMonth(n))
            }}
          >
            Today
          </button>
        </div>

        {/* Body: stacked on mobile, side-by-side on desktop */}
        <div
          className={cn(
            'min-h-0',
            isMobile ? 'flex flex-col' : 'grid grid-cols-[1fr_200px]',
          )}
        >
          <div
            className={cn(
              'border-line',
              isMobile ? 'border-b px-2.5 pb-1.5 pt-1' : 'border-r px-3.5 pb-3.5 pt-3',
            )}
          >
            <div className={cn('mb-1.5 grid grid-cols-[32px_1fr_32px] items-center', isMobile && 'mb-0.5')}>
              <button
                type="button"
                className={navBtn}
                aria-label="Previous month"
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
              >
                <Chevron dir="left" />
              </button>
              <p className="m-0 flex items-baseline justify-center gap-1.5 text-[13px] font-semibold tracking-tight text-mist">
                <span>{MONTHS[view.getMonth()].slice(0, isMobile ? 3 : undefined)}</span>
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

            <div className="mb-0.5 grid grid-cols-7" aria-hidden>
              {WEEKDAYS.map(d => (
                <span
                  key={d}
                  className={cn(
                    'text-center font-semibold uppercase tracking-wide text-muted',
                    isMobile ? 'py-0 text-[9px] leading-4' : 'py-1 text-[10px]',
                  )}
                >
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
                      'mx-auto flex w-full max-w-10 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent font-sans font-medium text-mist transition-[background,color,transform] duration-140 ease-out-strong active:scale-[0.92] hover:bg-mint/10',
                      isMobile ? 'h-7 text-[11px]' : 'h-9 text-xs',
                      !inMonth && 'text-muted/35',
                      isToday && !selectedDay && 'shadow-[inset_0_0_0_1px_rgba(197,225,229,0.35)]',
                      selectedDay && 'bg-mint font-semibold text-ink hover:bg-mint-soft',
                    )}
                    onPointerDown={e => {
                      e.stopPropagation()
                      commitDate(date)
                    }}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>
          </div>

          <div
            className={cn(
              'flex flex-col bg-surface/40',
              isMobile ? 'gap-1.5 px-2.5 pb-2 pt-1.5' : 'gap-3 px-3 py-3',
            )}
            aria-label="Time"
          >
            <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-muted">
              Time
            </p>

            <div className="flex flex-1 flex-col items-center justify-center gap-2">
              <div className="flex items-center justify-center gap-1">
                <div className="flex flex-col items-center">
                  <button type="button" className={spinBtn} aria-label="Hour up" onClick={() => setHour12(hour12 === 12 ? 1 : hour12 + 1, isPm)}>
                    <Chevron dir="up" />
                  </button>
                  <span className={cn('min-w-9 text-center font-semibold tabular-nums tracking-tighter text-mist', isMobile ? 'text-[20px] leading-none' : 'text-[26px] leading-tight')}>
                    {pad(hour12)}
                  </span>
                  <button type="button" className={spinBtn} aria-label="Hour down" onClick={() => setHour12(hour12 === 1 ? 12 : hour12 - 1, isPm)}>
                    <Chevron dir="down" />
                  </button>
                </div>
                <span className={cn('font-medium text-muted', isMobile ? 'text-lg' : 'text-2xl')} aria-hidden>:</span>
                <div className="flex flex-col items-center">
                  <button type="button" className={spinBtn} aria-label="Minute up" onClick={() => commitTime({ minutes: (minute + 5) % 60 })}>
                    <Chevron dir="up" />
                  </button>
                  <span className={cn('min-w-9 text-center font-semibold tabular-nums tracking-tighter text-mist', isMobile ? 'text-[20px] leading-none' : 'text-[26px] leading-tight')}>
                    {pad(minute)}
                  </span>
                  <button type="button" className={spinBtn} aria-label="Minute down" onClick={() => commitTime({ minutes: (minute + 55) % 60 })}>
                    <Chevron dir="down" />
                  </button>
                </div>
              </div>

              <div className="grid w-full max-w-[140px] grid-cols-2 gap-1 rounded-lg border border-line bg-ink/55 p-0.5">
                <button
                  type="button"
                  className={cn(
                    'cursor-pointer rounded-md border-0 bg-transparent py-1.5 font-sans text-[11px] font-semibold transition-[color,background,transform] duration-150 ease-out-strong active:scale-[0.97]',
                    !isPm ? 'bg-mint/16 text-mist' : 'text-muted',
                  )}
                  onClick={() => setHour12(hour12, false)}
                >
                  AM
                </button>
                <button
                  type="button"
                  className={cn(
                    'cursor-pointer rounded-md border-0 bg-transparent py-1.5 font-sans text-[11px] font-semibold transition-[color,background,transform] duration-150 ease-out-strong active:scale-[0.97]',
                    isPm ? 'bg-mint/16 text-mist' : 'text-muted',
                  )}
                  onClick={() => setHour12(hour12, true)}
                >
                  PM
                </button>
              </div>
            </div>

            <div className={cn('grid gap-1', isMobile ? 'grid-cols-4' : 'grid-cols-2')} role="group" aria-label="Minutes">
              {[0, 15, 30, 45].map(m => (
                <button
                  key={m}
                  type="button"
                  className={cn(
                    'cursor-pointer rounded-lg border border-line bg-transparent font-sans text-[11px] font-semibold tabular-nums transition-[background,color,border-color,transform] duration-140 ease-out-strong active:scale-[0.96]',
                    isMobile ? 'min-h-8 py-1' : 'min-h-9 py-1.5',
                    minute === m ? 'border-mint/35 bg-teal/30 text-mist' : 'text-muted hover:border-line-strong hover:text-mist',
                  )}
                  onClick={() => commitTime({ minutes: m })}
                >
                  :{pad(m)}
                </button>
              ))}
            </div>

            <div className={cn('grid gap-2', isMobile ? 'grid-cols-[1fr_1.4fr] pt-0.5' : 'grid-cols-1 pt-1')}>
              {isMobile && (
                <button
                  type="button"
                  className="min-h-9 w-full cursor-pointer rounded-xl border border-line bg-transparent px-3 py-1.5 font-sans text-sm font-semibold tracking-tight text-mist transition-[transform,background] duration-140 ease-out-strong hover:bg-mint/8 active:scale-[0.97]"
                  onClick={closeDiscard}
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className={cn(
                  'w-full cursor-pointer rounded-xl border-0 bg-[linear-gradient(180deg,var(--color-mint-soft)_0%,var(--color-mint)_100%)] px-4 font-sans text-sm font-semibold tracking-tight text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_1px_0_rgba(0,0,0,0.12)] transition-[transform,filter] duration-140 ease-out-strong hover:brightness-[1.03] active:scale-[0.97]',
                  isMobile ? 'min-h-9 py-1.5' : 'min-h-10 py-2',
                )}
                onClick={closeSave}
              >
                Done
              </button>
            </div>
          </div>
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
        data-picker-trigger
        onClick={() => {
          if (open) closeDiscard()
          else openPicker()
        }}
      >
        <span className="tabular-nums">{formatTrigger(parseLocal(value))}</span>
        <svg className="shrink-0 text-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.75" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>

      {typeof document !== 'undefined' && panel ? createPortal(panel, document.body) : null}
    </div>
  )
}
