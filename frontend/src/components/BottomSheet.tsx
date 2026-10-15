import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { cn } from '../lib/cn'

export type SheetSnap = 'peek' | 'half' | 'full'

type Props = {
  snap: SheetSnap
  onSnapChange: (snap: SheetSnap) => void
  children: ReactNode
  /** Always-visible foot of the sheet (e.g. primary CTA) — sits below the scroll area. */
  footer?: ReactNode
  /**
   * Size the sheet to its content (no empty stretch above the footer).
   * Used for the planning form before routes exist.
   */
  fitContent?: boolean
  /**
   * Peek shows only the grab handle (legacy). Prefer measured peek body for results.
   */
  handleOnlyPeek?: boolean
  /** Called whenever the visible sheet height (px) changes — for map overlays. */
  onHeightChange?: (heightPx: number) => void
  className?: string
}

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const SNAP_MS = 380
const VELOCITY_FLICK = 0.42 // px/ms

function preferReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function safeBottom() {
  if (typeof window === 'undefined') return 0
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden'
  document.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  return h
}

function snapHeights(
  vh: number,
  peekBody = 0,
  handleOnlyPeek = false,
): Record<SheetSnap, number> {
  const sb = safeBottom()
  const half = Math.round(vh * 0.55)
  const full = Math.round(Math.min(vh * 0.92, vh - 8))
  const handleH = 52
  let peek: number
  if (handleOnlyPeek) {
    peek = Math.round(handleH + sb)
  } else {
    const peekRaw = Math.round(handleH + sb + Math.max(peekBody, 96))
    peek = Math.min(peekRaw, Math.round(vh * 0.38), half - 40)
    peek = Math.max(peek, 120 + sb)
  }
  return {
    peek,
    half: Math.max(half, peek + 56),
    full: Math.max(full, half + 40),
  }
}

function nearestSnap(height: number, heights: Record<SheetSnap, number>, velocity: number): SheetSnap {
  const ordered: SheetSnap[] = ['peek', 'half', 'full']
  if (velocity < -VELOCITY_FLICK) {
    const taller = ordered.find(s => heights[s] > height + 8)
    if (taller) return taller
  }
  if (velocity > VELOCITY_FLICK) {
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (heights[ordered[i]] < height - 8) return ordered[i]
    }
  }
  let best: SheetSnap = 'half'
  let bestDist = Infinity
  for (const s of ordered) {
    const d = Math.abs(heights[s] - height)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  return best
}

/**
 * Mobile-only draggable sheet with peek / half / full snaps.
 * Desktop callers should not mount this — keep sidebar layout untouched.
 */
export default function BottomSheet({
  snap, onSnapChange, children, footer, fitContent = false, handleOnlyPeek = false,
  onHeightChange, className,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [vh, setVh] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 800)
  const [peekBody, setPeekBody] = useState(0)
  const [fitH, setFitH] = useState(0)
  const heights = snapHeights(vh, peekBody, handleOnlyPeek)
  const maxH = heights.full

  const restingH = fitContent && fitH > 0
    ? Math.min(maxH, Math.max(fitH, 240))
    : heights[snap]

  const heightRef = useRef(restingH)
  const [height, setHeight] = useState(restingH)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{
    startY: number
    startH: number
    lastY: number
    lastT: number
    velocity: number
    moved: boolean
    pointerId: number
  } | null>(null)
  /** Survives pointerup so handle onClick can ignore a completed drag. */
  const skipHandleClick = useRef(false)
  const DRAG_THRESHOLD = 8

  useLayoutEffect(() => {
    if (dragging) return
    heightRef.current = restingH
    setHeight(restingH)
  }, [restingH, dragging])

  useEffect(() => {
    onHeightChange?.(height)
  }, [height, onHeightChange])

  useEffect(() => {
    function onResize() {
      setVh(window.innerHeight)
    }
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [])

  // Measure peek body before paint to avoid height jumps after plan
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const body = root.querySelector('[data-sheet-peek-body]') as HTMLElement | null
      setPeekBody(body ? Math.ceil(body.getBoundingClientRect().height) : 0)
    }
    measure()
    const body = root.querySelector('[data-sheet-peek-body]')
    if (!body) return
    const ro = new ResizeObserver(measure)
    ro.observe(body)
    return () => ro.disconnect()
  }, [children, snap])

  useLayoutEffect(() => {
    if (!fitContent) {
      setFitH(0)
      return
    }
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const handle = root.querySelector('[data-sheet-handle]') as HTMLElement | null
      const scroll = scrollRef.current
      const foot = root.querySelector('[data-sheet-footer]') as HTMLElement | null
      const sb = safeBottom()
      const next = (handle?.offsetHeight ?? 44)
        + (scroll?.scrollHeight ?? 0)
        + (foot?.offsetHeight ?? 0)
        + sb
        + 2
      setFitH(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (scrollRef.current) ro.observe(scrollRef.current)
    const foot = root.querySelector('[data-sheet-footer]')
    if (foot) ro.observe(foot)
    return () => ro.disconnect()
  }, [fitContent, children, footer])

  // Peek: lock scroll so the strip feels like a solid HUD, not a nested scroller
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (snap === 'peek' && !fitContent) {
      el.scrollTop = 0
    }
  }, [snap, fitContent])

  const commitSnap = useCallback((next: SheetSnap) => {
    onSnapChange(next)
    if (fitContent && next === 'half' && fitH > 0) {
      const h = Math.min(maxH, Math.max(fitH, 240))
      heightRef.current = h
      setHeight(h)
      return
    }
    const h = snapHeights(window.innerHeight, peekBody, handleOnlyPeek)[next]
    heightRef.current = h
    setHeight(h)
    if (next === 'peek' && scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [onSnapChange, peekBody, fitContent, fitH, maxH, handleOnlyPeek])

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    // Portaled calendar / overlays live on document.body above this sheet
    if (document.body.dataset.pickerOpen === '1') return
    const target = e.target as HTMLElement
    // Interactive controls — except the sheet handle, which must drag
    if (target.closest('input, textarea, select, a, [role="slider"], [data-no-drag]')) {
      return
    }
    if (target.closest('button') && !target.closest('[data-sheet-handle]')) {
      return
    }

    const fromHandle = !!target.closest('[data-sheet-handle]')
    const scroller = scrollRef.current
    const atTop = !scroller || scroller.scrollTop <= 0
    if (!fromHandle && !atTop) return
    if (!fromHandle && !target.closest('[data-sheet-chrome]')) return

    const now = performance.now()
    drag.current = {
      startY: e.clientY,
      startH: heightRef.current,
      lastY: e.clientY,
      lastT: now,
      velocity: 0,
      moved: false,
      pointerId: e.pointerId,
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    const dy = d.startY - e.clientY
    if (!d.moved && Math.abs(d.startY - e.clientY) < DRAG_THRESHOLD) return
    if (!d.moved) {
      d.moved = true
      skipHandleClick.current = true
      setDragging(true)
      try {
        e.currentTarget.setPointerCapture(d.pointerId)
      } catch { /* already captured */ }
    }
    e.preventDefault()
    const next = Math.min(maxH, Math.max(heights.peek * 0.88, d.startH + dy))
    const now = performance.now()
    const dt = Math.max(1, now - d.lastT)
    d.velocity = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = now
    heightRef.current = next
    setHeight(next)
  }

  function onPointerUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (!d.moved) {
      setDragging(false)
      return
    }
    const v = d.velocity
    setDragging(false)
    if (fitContent && fitH > 0) {
      if (v < -VELOCITY_FLICK || heightRef.current > (fitH + maxH) / 2) {
        commitSnap('full')
      } else {
        commitSnap('half')
      }
      return
    }
    commitSnap(nearestSnap(heightRef.current, heights, v))
  }

  const translate = maxH - height
  const duration = dragging || preferReducedMotion() ? 0 : SNAP_MS
  const lockScroll = snap === 'peek' && !fitContent

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-label="Trip panel"
      className={cn(
        'absolute inset-x-0 bottom-0 z-[5] flex flex-col overflow-hidden rounded-t-[18px] border border-line border-b-0 bg-ink-soft shadow-[0_-12px_40px_rgba(0,0,0,0.45)]',
        'bg-[linear-gradient(180deg,rgba(197,225,229,0.03)_0%,transparent_120px),var(--color-ink-soft)]',
        className,
      )}
      style={{
        height: maxH,
        transform: `translate3d(0, ${translate}px, 0)`,
        transition: duration ? `transform ${duration}ms ${EASE}` : 'none',
        willChange: 'transform',
        paddingBottom: handleOnlyPeek && snap === 'peek'
          ? 0
          : 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'max(0px, env(safe-area-inset-left, 0px))',
        paddingRight: 'max(0px, env(safe-area-inset-right, 0px))',
        touchAction: dragging ? 'none' : 'auto',
      }}
      data-sheet-snap={snap}
      data-sheet-height={Math.round(height)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        data-sheet-handle
        data-sheet-chrome
        className={cn(
          'flex shrink-0 cursor-grab justify-center px-0 pt-1.5 active:cursor-grabbing',
          handleOnlyPeek && snap === 'peek'
            ? 'pb-[max(0.25rem,env(safe-area-inset-bottom,0px))]'
            : 'pb-1',
        )}
        style={{ touchAction: 'none' }}
      >
        <button
          type="button"
          data-sheet-handle
          className="min-h-11 min-w-[44px] cursor-grab border-0 bg-transparent px-8 py-3 active:scale-[0.97] active:cursor-grabbing"
          aria-label={`Sheet ${snap}. Drag to resize.`}
          onClick={() => {
            if (skipHandleClick.current) {
              skipHandleClick.current = false
              return
            }
            if (fitContent) {
              commitSnap(snap === 'full' ? 'half' : 'full')
              return
            }
            const cycle: SheetSnap[] = ['peek', 'half', 'full']
            const i = cycle.indexOf(snap)
            commitSnap(cycle[(i + 1) % cycle.length])
          }}
        >
          <span className="mx-auto block h-1 w-10 rounded-full bg-mint/35 transition-colors duration-150" />
        </button>
      </div>

      <div
        ref={scrollRef}
        data-sheet-scroll
        className={cn(
          'flex flex-col gap-3 overscroll-contain px-5 pt-0',
          fitContent ? 'shrink-0' : 'min-h-0 flex-1',
          // Peek: no vertical scroll (horizontal route swipe still works via pan-x on cards)
          lockScroll ? 'overflow-hidden' : 'overflow-y-auto touch-pan-y',
          footer ? 'pb-2' : 'pb-4',
        )}
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {children}
      </div>

      {footer && (
        <div
          data-sheet-footer
          data-sheet-chrome
          data-no-drag
          className="shrink-0 border-t border-line/80 bg-ink-soft/95 px-5 pb-3 pt-2.5 backdrop-blur-md"
        >
          {footer}
        </div>
      )}
    </div>
  )
}
