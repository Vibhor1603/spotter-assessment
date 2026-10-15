import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'

type Props = {
  hour: number
  maxHour: number
  timeLabel: string
  showHeatmap: boolean
  onHour: (h: number) => void
  onToggleHeatmap: (on: boolean) => void
  /** Pixels from viewport bottom so the scrubber clears the sheet (horizontal / desktop). */
  bottomOffset?: number
  /** Start collapsed on narrow screens (horizontal only). */
  defaultCollapsed?: boolean
  /**
   * `vertical` — phone volume-style rail on the right (map stays clear).
   * `horizontal` — desktop bottom bar.
   */
  orientation?: 'horizontal' | 'vertical'
}

export default function TimelineScrubber({
  hour, maxHour, timeLabel, showHeatmap, onHour, onToggleHeatmap,
  bottomOffset = 16,
  defaultCollapsed = false,
  orientation = 'horizontal',
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

  if (orientation === 'vertical') {
    const shortLabel = hour === 0 ? 'Now' : `+${hour}h`
    // Match MapLibre ctrl-group: 34px wide, 10px radius, ink/90 + border-line
    return (
      <div
        className={cn(
          'pointer-events-none absolute z-[2] animate-rise',
          // Same inset as .maplibregl-ctrl-top-right; sit just under +/- group (~78px)
          'right-[max(10px,env(safe-area-inset-right,0px))]',
          'top-[max(5.5rem,calc(env(safe-area-inset-top,0px)+5.35rem))]',
        )}
        aria-label="Forecast timeline"
      >
        <div
          className={cn(
            'pointer-events-auto flex w-[34px] flex-col items-stretch overflow-hidden rounded-[10px]',
            'border border-line bg-ink/90 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-[12px]',
          )}
        >
          <div className="flex flex-col items-center px-0 pb-1.5 pt-2">
            <p
              className="text-center text-[9px] font-semibold leading-none tracking-tight text-mist tabular-nums"
              title={timeLabel}
            >
              {shortLabel}
            </p>
            <span className="mt-0.5 text-[7px] font-semibold uppercase tracking-[0.06em] text-muted/80">
              +{maxHour}h
            </span>

            <div className="relative my-1.5 h-[112px] w-full">
              <input
                className="timeline-range timeline-range-vertical"
                type="range"
                min={0}
                max={maxHour}
                step={1}
                value={hour}
                aria-valuetext={timeLabel}
                aria-label="Forecast hour"
                onChange={e => setHour(+e.target.value)}
              />
            </div>

            <span className="text-[7px] font-semibold uppercase tracking-[0.06em] text-muted/80">
              Now
            </span>
          </div>

          <button
            type="button"
            className={cn(
              'flex h-[44px] w-full cursor-pointer flex-col items-center justify-center gap-0.5 border-0 border-t border-line bg-transparent transition-[background,color,transform] duration-150 ease-out-strong active:scale-[0.96]',
              showHeatmap ? 'bg-teal/35 text-mist' : 'text-muted',
            )}
            role="switch"
            aria-checked={showHeatmap}
            aria-label={showHeatmap ? 'Heatmap on' : 'Heatmap off'}
            onClick={() => onToggleHeatmap(!showHeatmap)}
          >
            <span className="relative grid h-4 w-4 place-items-center">
              <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M8 2.5c2.2 2.4 3.5 4.2 3.5 6.1A3.5 3.5 0 1 1 4.5 8.6C4.5 6.7 5.8 4.9 8 2.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  fill={showHeatmap ? 'currentColor' : 'none'}
                  fillOpacity={showHeatmap ? 0.35 : 0}
                />
              </svg>
              {!showHeatmap && (
                <span
                  className="absolute inset-x-[-1px] top-1/2 h-px origin-center -rotate-45 bg-muted"
                  aria-hidden
                />
              )}
            </span>
            <span
              className={cn(
                'text-[8px] font-bold uppercase tracking-[0.08em]',
                showHeatmap ? 'text-mint' : 'text-muted/70',
              )}
            >
              {showHeatmap ? 'On' : 'Off'}
            </span>
          </button>

          <button
            type="button"
            className={cn(
              'grid h-[34px] w-full cursor-pointer place-items-center border-0 border-t border-line bg-transparent transition-[background,color,transform] duration-150 ease-out-strong active:scale-[0.96]',
              playing ? 'bg-mint/14 text-mist' : 'text-mint/90',
            )}
            onClick={() => setPlaying(p => !p)}
            aria-pressed={playing}
            aria-label={playing ? 'Pause timeline' : 'Play timeline'}
          >
            {playing ? (
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                <rect x="2" y="2" width="2.5" height="8" rx="0.5" />
                <rect x="7.5" y="2" width="2.5" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                <path d="M3.5 2.2v7.6L10 6 3.5 2.2Z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    )
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
