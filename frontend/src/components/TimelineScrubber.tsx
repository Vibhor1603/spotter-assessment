import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'

type Props = {
  hour: number
  maxHour: number
  timeLabel: string
  showHeatmap: boolean
  onHour: (h: number) => void
  onToggleHeatmap: (on: boolean) => void
}

export default function TimelineScrubber({
  hour, maxHour, timeLabel, showHeatmap, onHour, onToggleHeatmap,
}: Props) {
  const [playing, setPlaying] = useState(false)
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

  return (
    <div
      className="absolute inset-x-4 bottom-4 z-[2] animate-rise rounded-2xl border border-line bg-ink/92 px-4 pb-4 pt-3.5 shadow-[inset_0_1px_0_rgba(197,225,229,0.08),0_12px_28px_rgba(0,0,0,0.4)] backdrop-blur-xl max-md:inset-x-2.5 max-md:bottom-[calc(56px+env(safe-area-inset-bottom,0px)+8px)]"
      aria-label="Forecast timeline"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
            Weather along the corridor
          </p>
          <p className="mt-1 m-0 text-base font-semibold tracking-tight text-mist tabular-nums leading-tight">
            {timeLabel}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <label className="inline-flex items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-muted">Heat</span>
            <button
              type="button"
              className={cn(
                'relative h-6 w-10 cursor-pointer rounded-full border-0 p-0 transition-colors duration-180 ease-out-strong',
                showHeatmap ? 'bg-teal' : 'bg-mint/16',
              )}
              role="switch"
              aria-checked={showHeatmap}
              onClick={() => onToggleHeatmap(!showHeatmap)}
            >
              <span
                className={cn(
                  'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-spring',
                  showHeatmap && 'translate-x-4',
                )}
              />
            </button>
          </label>
          <button
            type="button"
            className={cn(
              'cursor-pointer whitespace-nowrap rounded-lg border-0 px-2.5 py-1.5 font-sans text-[11px] font-semibold transition-[background,transform] duration-140 ease-out-strong active:scale-[0.97]',
              playing ? 'bg-teal/40 text-mist' : 'bg-mint/8 text-mint hover:bg-teal/35',
            )}
            onClick={() => setPlaying(p => !p)}
            aria-pressed={playing}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
        </div>
      </div>

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
    </div>
  )
}
