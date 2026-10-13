import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'

type Props = {
  hour: number
  maxHour: number
  timeLabel: string
  showHeatmap: boolean
  onHour: (h: number) => void
  onToggleHeatmap: (on: boolean) => void
  /** Pixels from viewport bottom so the scrubber clears the sheet (mobile). */
  bottomOffset?: number
  /** Start collapsed on narrow screens. */
  defaultCollapsed?: boolean
}

export default function TimelineScrubber({
  hour, maxHour, timeLabel, showHeatmap, onHour, onToggleHeatmap,
  bottomOffset = 16,
  defaultCollapsed = false,
}: Props) {
  const [playing, setPlaying] = useState(false)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const hourRef = useRef(hour)
  const maxRef = useRef(maxHour)
  const timer = useRef(0)

  hourRef.current = hour
  maxRef.current = maxHour

  useEffect(() => () => window.clearInterval(timer.current), [])

  useEffect(() => {
    if (!playing) {
      window.clearInterval(timer.current)
      return
    }
    timer.current = window.setInterval(() => {
      const next = hourRef.current >= maxRef.current ? 0 : hourRef.current + 1
      onHour(next)
    }, 480)
    return () => window.clearInterval(timer.current)
  }, [playing, onHour])

  function setHour(h: number) {
    setPlaying(false)
    onHour(Math.max(0, Math.min(maxHour, h)))
  }

  const bottom = `calc(${bottomOffset}px + env(safe-area-inset-bottom, 0px))`

  return (
    <div
      className={cn(
        'absolute inset-x-4 z-[2] animate-rise rounded-2xl border border-line bg-ink/92 shadow-[inset_0_1px_0_rgba(197,225,229,0.08),0_12px_28px_rgba(0,0,0,0.4)] backdrop-blur-xl',
        'max-[860px]:inset-x-2.5',
        collapsed ? 'px-3 py-2' : 'px-4 pb-4 pt-3.5',
      )}
      style={{ bottom }}
      aria-label="Forecast timeline"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className={cn('flex items-center justify-between gap-3', !collapsed && 'mb-3 items-start')}>
        <button
          type="button"
          className="min-h-11 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left font-sans active:scale-[0.99]"
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand weather timeline' : 'Collapse weather timeline'}
        >
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
            Weather along the corridor
          </p>
          <p className="mt-1 m-0 text-base font-semibold tracking-tight text-mist tabular-nums leading-tight">
            {timeLabel}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <label className="inline-flex min-h-11 items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-muted">Heat</span>
            <button
              type="button"
              className={cn(
                'relative h-7 w-11 min-h-7 min-w-11 cursor-pointer rounded-full border-0 p-0 transition-colors duration-180 ease-out-strong',
                showHeatmap ? 'bg-teal' : 'bg-mint/16',
              )}
              role="switch"
              aria-checked={showHeatmap}
              onClick={() => onToggleHeatmap(!showHeatmap)}
            >
              <span
                className={cn(
                  'absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-spring',
                  showHeatmap && 'translate-x-4',
                )}
              />
            </button>
          </label>
          {!collapsed && (
            <button
              type="button"
              className={cn(
                'min-h-11 cursor-pointer whitespace-nowrap rounded-lg border-0 px-3 py-2 font-sans text-[12px] font-semibold transition-[background,transform] duration-140 ease-out-strong active:scale-[0.97]',
                playing ? 'bg-teal/40 text-mist' : 'bg-mint/8 text-mint hover:bg-teal/35',
              )}
              onClick={() => setPlaying(p => !p)}
              aria-pressed={playing}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
          )}
          <button
            type="button"
            className="grid min-h-11 min-w-11 cursor-pointer place-items-center rounded-lg border-0 bg-mint/8 text-mint transition-[background,transform] duration-140 ease-out-strong active:scale-[0.97]"
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            <svg
              className={cn(
                'h-4 w-4 transition-transform duration-200 ease-out-strong motion-reduce:transition-none',
                collapsed ? 'rotate-180' : 'rotate-0',
              )}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
          <span className="text-[11px] font-semibold tabular-nums text-muted">Now</span>
          <input
            className="timeline-range"
            type="range"
            min={0}
            max={maxHour}
            step={1}
            value={hour}
            aria-valuetext={timeLabel}
            aria-label="Forecast hour"
            onChange={e => setHour(+e.target.value)}
          />
          <span className="text-[11px] font-semibold tabular-nums text-muted">+{maxHour}h</span>
        </div>
      )}
    </div>
  )
}
