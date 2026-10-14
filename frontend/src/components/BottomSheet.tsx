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
  /** Called whenever the visible sheet height (px) changes — for map overlays. */
  onHeightChange?: (heightPx: number) => void
  className?: string
}

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const SNAP_MS = 320
const VELOCITY_FLICK = 0.45 // px/ms

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

function snapHeights(vh: number, peekBody = 0): Record<SheetSnap, number> {
  const sb = safeBottom()
  // Handle (~44) + measured peek body (trip + swipe cards), hard-capped so map stays visible
  const peekRaw = Math.round(44 + sb + Math.max(peekBody, 96))
  const half = Math.round(vh * 0.55)
  const full = Math.round(Math.min(vh * 0.92, vh - 8))
  const peek = Math.min(peekRaw, Math.round(vh * 0.34), half - 48)
  return {
    peek: Math.max(peek, 120 + sb),
    half: Math.max(half, peek + 56),
    full: Math.max(full, half + 40),
  }
}

function nearestSnap(height: number, heights: Record<SheetSnap, number>, velocity: number): SheetSnap {
  const ordered: SheetSnap[] = ['peek', 'half', 'full']
  if (velocity < -VELOCITY_FLICK) {
    // flick up → taller
    const taller = ordered.find(s => heights[s] > height + 8)
    if (taller) return taller
  }
  if (velocity > VELOCITY_FLICK) {
    // flick down → shorter
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
  snap, onSnapChange, children, footer, fitContent = false, onHeightChange, className,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [vh, setVh] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 800)
  const [peekBody, setPeekBody] = useState(0)
  const [fitH, setFitH] = useState(0)
  const heights = snapHeights(vh, peekBody)
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
  const DRAG_THRESHOLD = 8

  // Keep height in sync when snap / fit / viewport changes (not mid-drag)
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

  // Measure only dedicated peek body (trip chip + swipe cards)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const body = root.querySelector('[data-sheet-peek-body]') as HTMLElement | null
      setPeekBody(body ? body.offsetHeight : 0)
    }
    measure()
    const body = root.querySelector('[data-sheet-peek-body]')
    if (!body) return
    const ro = new ResizeObserver(measure)
    ro.observe(body)
    return () => ro.disconnect()
  }, [children])

  // Measure natural content height for fit-to-content planning mode
  useLayoutEffect(() => {
    if (!fitContent) {
      setFitH(0)
      return
    }
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const handle = root.querySelector('[data-sheet-handle]') as HTMLElement | null
      const scroll = root.querySelector('[data-sheet-scroll]') as HTMLElement | null
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
    const scroll = root.querySelector('[data-sheet-scroll]')
    const foot = root.querySelector('[data-sheet-footer]')
    if (scroll) ro.observe(scroll)
    if (foot) ro.observe(foot)
    return () => ro.disconnect()
  }, [fitContent, children, footer])

  const commitSnap = useCallback((next: SheetSnap) => {
    onSnapChange(next)
    if (fitContent && next === 'half' && fitH > 0) {
      const h = Math.min(maxH, Math.max(fitH, 240))
      heightRef.current = h
      setHeight(h)
      return
    }
    const h = snapHeights(window.innerHeight, peekBody)[next]
    heightRef.current = h
    setHeight(h)
  }, [onSnapChange, peekBody, fitContent, fitH, maxH])

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // Don't start sheet drag from interactive controls inside content
    if (target.closest('input, textarea, select, button, a, [role="slider"], [data-no-drag]')) {
      // Allow handle button itself
      if (!target.closest('[data-sheet-handle]')) return
    }
    // Only drag from handle or peek chrome unless content is at scroll top
    const fromHandle = !!target.closest('[data-sheet-handle]')
    const scroller = rootRef.current?.querySelector('[data-sheet-scroll]') as HTMLElement | null
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
    const dy = d.startY - e.clientY // up = taller
    if (!d.moved && Math.abs(d.startY - e.clientY) < DRAG_THRESHOLD) return
    if (!d.moved) {
      d.moved = true
      setDragging(true)
      try {
        e.currentTarget.setPointerCapture(d.pointerId)
      } catch { /* already captured or released */ }
    }
    const next = Math.min(maxH, Math.max(heights.peek * 0.85, d.startH + dy))
    const now = performance.now()
    const dt = Math.max(1, now - d.lastT)
    d.velocity = (e.clientY - d.lastY) / dt // down positive
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
      // Pure tap — leave snap to the handle button onClick cycle
      setDragging(false)
      return
    }
    const v = d.velocity
    setDragging(false)
    if (fitContent && fitH > 0) {
      // Planning mode: settle back to content height unless flicked toward full
      if (v < -VELOCITY_FLICK || heightRef.current > (fitH + maxH) / 2) {
        commitSnap('full')
      } else {
        commitSnap('half') // half + fitContent → content height
      }
      return
    }
    const next = nearestSnap(heightRef.current, heights, v)
    commitSnap(next)
  }

  const translate = maxH - height
  const duration = dragging || preferReducedMotion() ? 0 : SNAP_MS

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
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
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
        className="flex shrink-0 cursor-grab justify-center px-0 pb-1 pt-1.5 active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      >
        <button
          type="button"
          data-sheet-handle
          className="min-h-11 min-w-[44px] cursor-grab border-0 bg-transparent px-8 py-3 active:scale-[0.97] active:cursor-grabbing"
          aria-label={`Sheet ${snap}. Drag to resize.`}
          onPointerDown={e => {
            // Keep taps for snap-cycle; drag still works from the chrome strip around the pill
            e.stopPropagation()
          }}
          onClick={() => {
            if (fitContent) {
              commitSnap(snap === 'full' ? 'half' : 'full')
              return
            }
            const cycle: SheetSnap[] = ['peek', 'half', 'full']
            const i = cycle.indexOf(snap)
            commitSnap(cycle[(i + 1) % cycle.length])
          }}
        >
          <span className="mx-auto block h-1 w-10 rounded-full bg-mint/35" />
        </button>
      </div>

      <div
        data-sheet-scroll
        className={cn(
          'flex touch-pan-y flex-col gap-3 overscroll-contain px-5 pt-0',
          // fitContent: hug children (no flex stretch gap above footer)
          fitContent ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto',
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
