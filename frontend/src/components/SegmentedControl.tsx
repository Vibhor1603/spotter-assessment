import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'

type Option<T extends string | number> = {
  value: T
  label: string
}

type Props<T extends string | number> = {
  options: readonly Option<T>[] | Option<T>[]
  value: T
  onChange: (value: T) => void
  'aria-label'?: string
  'aria-labelledby'?: string
}

export default function SegmentedControl<T extends string | number>({
  options, value, onChange, ...aria
}: Props<T>) {
  const track = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState({ x: 0, w: 0, ready: false })
  const idx = options.findIndex(o => o.value === value)

  function syncThumb() {
    const el = track.current
    if (!el || idx < 0) {
      setThumb(t => ({ ...t, ready: false }))
      return
    }
    const btn = el.querySelectorAll<HTMLButtonElement>('[data-seg]')[idx]
    if (!btn) return
    setThumb({ x: btn.offsetLeft, w: btn.offsetWidth, ready: true })
  }

  useLayoutEffect(() => {
    syncThumb()
  }, [idx, options, value])

  useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const ro = new ResizeObserver(() => syncThumb())
    ro.observe(el)
    return () => ro.disconnect()
  }, [idx])

  return (
    <div
      className="relative mt-1.5 flex rounded-[10px] border border-line bg-ink/55 p-0.5"
      role="radiogroup"
      ref={track}
      {...aria}
    >
      <span
        className="pointer-events-none absolute bottom-0.5 left-0 top-0.5 rounded-lg bg-mint/16 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-[transform,width,opacity] duration-200 ease-out-strong will-change-[transform,width]"
        aria-hidden
        style={{
          width: thumb.w || undefined,
          transform: `translateX(${thumb.x}px)`,
          opacity: thumb.ready ? 1 : 0,
        }}
      />
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          data-seg
          aria-checked={o.value === value}
          className={cn(
            'relative z-1 flex min-h-8 flex-1 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent px-1.5 py-1.5 font-sans text-xs font-semibold tracking-tight transition-[color,transform] duration-150 ease-out-strong active:scale-[0.97]',
            o.value === value ? 'text-mist' : 'text-muted hover:text-mist/85',
          )}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
