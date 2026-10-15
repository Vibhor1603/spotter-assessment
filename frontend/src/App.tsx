import { useCallback, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import BottomSheet, { type SheetSnap } from './components/BottomSheet'
import DateTimePicker from './components/DateTimePicker'
import PlaceInput from './components/PlaceInput'
import RouteMap from './components/RouteMap'
import SegmentedControl from './components/SegmentedControl'
import SwapIcon from './components/SwapIcon'
import TimelineScrubber from './components/TimelineScrubber'
import { MOBILE_MQ, useMediaQuery } from './hooks/useMediaQuery'
import { geocode, plan } from './lib/api'
import { cn } from './lib/cn'
import { formatArrival, formatLocalTime } from './lib/time'
import type { Place, PlanResponse, RiskLabel, RouteResult } from './lib/types'
import {
  RISK_COLORS,
  RISK_ORDER,
  avgRiskWord,
  formatDriveTime,
  loadEscalationCount,
  riskMilesLine,
  routeArrivalIso,
  routeRankLabel,
} from './lib/types'

const LOAD_PRESETS = [
  { lb: 20000, label: '20k' },
  { lb: 35000, label: '35k' },
  { lb: 45000, label: '45k' },
  { lb: 80000, label: '80k' },
] as const

const fieldLabel = 'mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-muted'
const fieldInput = 'w-full min-h-9 rounded-[10px] border border-line bg-surface px-3 py-1.5 font-sans text-sm font-medium tracking-tight text-mist tabular-nums transition-[border-color,background,box-shadow] duration-160 ease-out-strong focus:border-mint/40 focus:bg-surface-2 focus:outline-none focus:shadow-[0_0_0_3px_rgba(13,124,130,0.22)]'

function defaultDepartureLocal() {
  const d = new Date(Date.now() + 3600e3)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function RiskStack({ miles }: { miles: Record<RiskLabel, number> }) {
  const total = RISK_ORDER.reduce((s, l) => s + (miles[l] ?? 0), 0) || 1
  return (
    <div className="mb-2.5 flex h-1.5 overflow-hidden rounded-full bg-mint/8" title={riskMilesLine(miles)} aria-hidden>
      {RISK_ORDER.map(label => {
        const mi = miles[label] ?? 0
        if (mi <= 0) return null
        return (
          <span
            key={label}
            className="block h-full min-w-0.5"
            style={{
              flex: `${mi} 0 0`,
              background: RISK_COLORS[label],
              maxWidth: `${(mi / total) * 100}%`,
            }}
          />
        )
      })}
    </div>
  )
}

function samePlace(a: Place, b: Place) {
  return Math.abs(a.lon - b.lon) < 1e-5 && Math.abs(a.lat - b.lat) < 1e-5
}

function formatLeaveShort(local: string) {
  try {
    return new Date(local).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return local
  }
}

function shortPlace(name: string) {
  const part = name.split(',')[0]?.trim()
  return part || name
}

export default function App() {
  const isMobile = useMediaQuery(MOBILE_MQ)
  const [originText, setOriginText] = useState('Denver, CO')
  const [destText, setDestText] = useState('Salt Lake City, UT')
  const [origin, setOrigin] = useState<Place | null>(null)
  const [dest, setDest] = useState<Place | null>(null)
  const [departure, setDeparture] = useState(defaultDepartureLocal)
  const [load, setLoad] = useState(35000)
  const [interval, setIntervalMi] = useState(25)
  const [data, setData] = useState<PlanResponse | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hour, setHour] = useState(0)
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [recenterToken, setRecenterToken] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  // Planning uses fit-to-content; after results, peek / half / full apply
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('half')
  const [sheetHeight, setSheetHeight] = useState(0)
  const [formOpen, setFormOpen] = useState(true)
  const [legendOpen, setLegendOpen] = useState(true)
  const [planDepartureIso, setPlanDepartureIso] = useState<string | null>(null)

  const onSheetHeight = useCallback((h: number) => setSheetHeight(h), [])

  const hourLabel = useMemo(() => {
    const t = data?.heatmap?.times?.[hour]
    if (!t) return hour === 0 ? 'Now' : `In ${hour} hours`
    return formatLocalTime(t)
  }, [data, hour])

  const selected = useMemo(() => {
    if (!data) return null
    return data.routes.find(r => r.id === selectedId)
      ?? data.routes.find(r => r.id === data.recommended)
      ?? null
  }, [data, selectedId])

  function markInputsDirty() {
    setErr(null)
    if (data) setStale(true)
  }

  function onOriginText(text: string) {
    setOriginText(text)
    markInputsDirty()
  }
  function onDestText(text: string) {
    setDestText(text)
    markInputsDirty()
  }
  function onOriginSelect(p: Place | null) {
    setOrigin(p)
    markInputsDirty()
  }
  function onDestSelect(p: Place | null) {
    setDest(p)
    markInputsDirty()
  }

  async function resolvePlace(text: string, cached: Place | null): Promise<Place> {
    const q = text.trim()
    if (!q) throw new Error('Enter a city and state for From and To.')
    if (cached && cached.name === q) return cached
    const hits = await geocode(q)
    if (!hits[0]) throw new Error(`Could not find “${q}”. Try a city and state.`)
    return hits[0]
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setBusy(true)
    setErr(null)
    setStatus('Looking up places…')
    try {
      const [o, d] = await Promise.all([
        resolvePlace(originText, origin),
        resolvePlace(destText, dest),
      ])
      if (samePlace(o, d)) {
        throw new Error('Origin and destination must be different places.')
      }
      setOrigin(o)
      setDest(d)
      setOriginText(o.name)
      setDestText(d.name)
      setStatus('Checking weather along routes…')
      const depIso = new Date(departure).toISOString()
      const res = await plan({
        origin: o,
        destination: d,
        departure: depIso,
        load_lb: load,
        interval_mi: interval,
      })
      setData(res)
      setPlanDepartureIso(depIso)
      setSelectedId(res.recommended)
      setHour(0)
      setShowHeatmap(true)
      setStale(false)
      setFormOpen(false)
      setLegendOpen(false)
      // Collapse so the route is visible on the map; cards stay in peek strip
      setSheetSnap(isMobile ? 'peek' : 'half')
    } catch (x) {
      setData(null)
      setPlanDepartureIso(null)
      setSelectedId(null)
      setStale(false)
      setFormOpen(true)
      // fitContent kicks in again when data is cleared
      setSheetSnap('half')
      setErr(x instanceof Error ? x.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  function swapEnds() {
    setOriginText(destText)
    setDestText(originText)
    setOrigin(dest)
    setDest(origin)
    markInputsDirty()
  }

  const hideChrome = isMobile && !!data && sheetSnap === 'peek'

  const panel = (
    <>
      {!hideChrome && (
        <header className="flex shrink-0 flex-col gap-1.5" data-sheet-chrome>
          <div className="flex items-center gap-2">
            <img
              className="block h-8 w-8 shrink-0 rounded-md"
              src="/spotter-logo.png"
              alt="spotter.ai"
              width={32}
              height={32}
            />
            <span className="text-[1.2rem] font-semibold tracking-tight text-white leading-none">spotter.ai</span>
          </div>
          {!data && (
            <p className="m-0 text-[13px] font-normal tracking-tight leading-snug text-muted">
              Safest route for your load
            </p>
          )}
        </header>
      )}

      {/* Mobile: trip chip when sheet is raised (peek is handle-only so the map stays open) */}
      {data && isMobile && sheetSnap !== 'peek' && (
        <div data-sheet-chrome className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            className={cn(
              'group flex min-h-11 w-full cursor-pointer flex-col gap-0.5 rounded-xl border border-line bg-surface/80 px-3 py-2.5 text-left font-sans',
              'shadow-[inset_0_1px_0_rgba(197,225,229,0.05)]',
              'transition-[background,border-color,transform] duration-160 ease-out-strong',
              'hover:border-mint/28 hover:bg-surface-2/80 active:scale-[0.985]',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_rgba(13,124,130,0.28)]',
            )}
            onClick={() => {
              setFormOpen(true)
              setSheetSnap('full')
            }}
            aria-expanded={formOpen}
            aria-controls="trip-form-panel"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Your trip</span>
              <span className="text-[12px] font-semibold tracking-tight text-mint">Edit</span>
            </div>
            <p className="m-0 truncate text-[13px] font-medium tracking-tight text-mist">
              {shortPlace(originText)} → {shortPlace(destText)}
            </p>
          </button>
        </div>
      )}

      {data && !isMobile && (
        <button
          type="button"
          className={cn(
            'group flex w-full shrink-0 cursor-pointer flex-col gap-1 rounded-2xl border border-line bg-surface/80 px-3.5 py-3 text-left font-sans',
            'min-h-11 shadow-[inset_0_1px_0_rgba(197,225,229,0.05)]',
            'transition-[background,border-color,transform] duration-160 ease-out-strong',
            'hover:border-mint/28 hover:bg-surface-2/80 active:scale-[0.985]',
            'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_rgba(13,124,130,0.28)]',
          )}
          onClick={() => setFormOpen(o => !o)}
          aria-expanded={formOpen}
          aria-controls="trip-form-panel"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
              {formOpen ? 'Trip details' : 'Your trip'}
            </span>
            <span className="inline-flex min-h-11 items-center gap-1.5 text-[12px] font-semibold tracking-tight text-mint">
              {formOpen ? 'Hide' : 'Edit'}
              <svg
                className={cn(
                  'h-3.5 w-3.5 transition-transform duration-200 ease-out-strong motion-reduce:transition-none',
                  formOpen ? 'rotate-180' : 'rotate-0',
                )}
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
              >
                <path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
          <p className="m-0 truncate text-[13px] font-medium tracking-tight text-mist">
            {shortPlace(originText)} → {shortPlace(destText)}
          </p>
          <p className="m-0 truncate text-[12px] tabular-nums tracking-tight text-muted">
            {load.toLocaleString()} lb · Leave {formatLeaveShort(departure)} · every {interval} mi
          </p>
        </button>
      )}

      <div
        id="trip-form-panel"
        className={cn(
          'grid shrink-0 transition-[grid-template-rows] duration-[260ms] ease-drawer motion-reduce:duration-150',
          formOpen && !(isMobile && sheetSnap === 'peek') ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        data-open={formOpen ? 'true' : 'false'}
      >
        <div
          className={cn(
            'min-h-0',
            formOpen ? 'overflow-visible' : 'overflow-hidden',
          )}
        >
          <div
            className={cn(
              'flex flex-col gap-3 transition-[opacity,transform] duration-[240ms] ease-out-strong motion-reduce:transition-none',
              formOpen
                ? 'translate-y-0 opacity-100'
                : 'pointer-events-none -translate-y-1 opacity-0',
            )}
            aria-hidden={!formOpen}
          >
            <form id="trip-plan-form" className="flex flex-col gap-3" onSubmit={submit} data-no-drag>
              <div className="relative flex flex-col overflow-visible rounded-2xl border border-line bg-surface shadow-[inset_0_1px_0_rgba(197,225,229,0.06),0_1px_2px_rgba(0,0,0,0.2)]">
                <PlaceInput
                  label="From"
                  mark="A"
                  value={originText}
                  onChange={onOriginText}
                  selected={origin}
                  onSelect={onOriginSelect}
                />
                <div className="relative ml-[54px] mr-4 flex h-0 items-center justify-end border-t border-line" aria-hidden>
                  <button
                    type="button"
                    className="absolute right-0 top-1/2 z-4 grid h-11 w-11 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-line-strong bg-[linear-gradient(180deg,rgba(197,225,229,0.12)_0%,rgba(18,36,40,0.95)_100%)] text-mint shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_6px_16px_rgba(0,0,0,0.35),0_0_0_4px_var(--color-surface)] backdrop-blur-[10px] transition-[transform,background,color,border-color] duration-180 ease-out-strong hover:border-mint/40 hover:bg-[linear-gradient(180deg,rgba(26,154,163,0.45)_0%,rgba(13,124,130,0.85)_100%)] hover:text-white active:scale-[0.92] active:rotate-180"
                    onClick={swapEnds}
                    aria-label="Swap origin and destination"
                    tabIndex={formOpen ? 0 : -1}
                  >
                    <SwapIcon />
                  </button>
                </div>
                <PlaceInput
                  label="To"
                  mark="B"
                  value={destText}
                  onChange={onDestText}
                  selected={dest}
                  onSelect={onDestSelect}
                />
              </div>

              <div className="flex flex-col gap-2.5 overflow-visible rounded-2xl border border-line bg-surface/55 px-3.5 pb-3 pt-2.5">
                <DateTimePicker
                  id="dep"
                  label="Leave at"
                  value={departure}
                  onChange={v => {
                    setDeparture(v)
                    markInputsDirty()
                  }}
                />

                <div className="relative">
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <label htmlFor="load" className={fieldLabel + ' mb-0'}>Load weight</label>
                    <span className="text-xs font-semibold tabular-nums tracking-tight text-mint">
                      {load.toLocaleString()} lb
                    </span>
                  </div>
                  <input
                    id="load"
                    type="number"
                    min={0}
                    step={500}
                    value={load}
                    className={fieldInput}
                    onChange={e => {
                      setLoad(+e.target.value)
                      markInputsDirty()
                    }}
                    tabIndex={formOpen ? 0 : -1}
                  />
                  <SegmentedControl
                    aria-label="Load presets"
                    value={load}
                    onChange={v => {
                      setLoad(v)
                      markInputsDirty()
                    }}
                    options={LOAD_PRESETS.map(p => ({ value: p.lb, label: p.label }))}
                  />
                </div>

                <div className="relative">
                  <label id="iv-label" className={fieldLabel}>Weather stops</label>
                  <SegmentedControl
                    aria-labelledby="iv-label"
                    value={interval}
                    onChange={v => {
                      setIntervalMi(v)
                      markInputsDirty()
                    }}
                    options={[
                      { value: 10, label: '10 mi' },
                      { value: 25, label: '25 mi' },
                      { value: 50, label: '50 mi' },
                    ]}
                  />
                </div>
              </div>

              {/* Desktop CTA — mobile uses BottomSheet footer so it never scrolls away */}
              {!isMobile && (
                <button
                  className="mt-0.5 min-h-11 w-full cursor-pointer rounded-xl border-0 bg-[linear-gradient(180deg,var(--color-mint-soft)_0%,var(--color-mint)_100%)] px-4 py-2.5 font-sans text-sm font-semibold tracking-tight text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_1px_0_rgba(0,0,0,0.12),0_10px_28px_rgba(197,225,229,0.12)] transition-[transform,filter,box-shadow] duration-150 ease-out-strong hover:brightness-[1.03] active:scale-[0.97] disabled:cursor-wait disabled:opacity-55 disabled:hover:brightness-100"
                  disabled={busy}
                  type="submit"
                  tabIndex={formOpen ? 0 : -1}
                >
                  <span className={busy ? 'inline-block animate-pulse-soft' : undefined}>
                    {busy ? (status ?? 'Finding routes…') : data ? 'Update safest routes' : 'Find safest routes'}
                  </span>
                </button>
              )}
            </form>

            {busy && status && (
              <p className="m-0 text-xs tracking-tight text-muted" role="status" aria-live="polite">{status}</p>
            )}

            {err && (
              <div className="animate-rise rounded-xl border border-coral/35 bg-coral/12 px-3 py-2.5 text-[13px] leading-snug text-[#ffc4c7]" role="alert">
                {err}
              </div>
            )}

            {busy && !data && (
              <div className="flex flex-col gap-2.5" aria-hidden>
                <div className="h-[76px] animate-shimmer rounded-xl bg-[linear-gradient(90deg,var(--color-surface)_25%,var(--color-surface-2)_50%,var(--color-surface)_75%)] bg-size-[200%_100%]" />
                <div className="h-[76px] animate-shimmer rounded-xl bg-[linear-gradient(90deg,var(--color-surface)_25%,var(--color-surface-2)_50%,var(--color-surface)_75%)] bg-size-[200%_100%]" />
                <div className="h-10 w-[70%] animate-shimmer rounded-xl bg-[linear-gradient(90deg,var(--color-surface)_25%,var(--color-surface-2)_50%,var(--color-surface)_75%)] bg-size-[200%_100%]" />
              </div>
            )}
          </div>
        </div>
      </div>

      {data && !(isMobile && sheetSnap === 'peek') && (
        <section
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-3.5',
            !isMobile && 'overflow-y-auto overscroll-contain pr-0.5',
            stale && 'opacity-55 saturate-70',
          )}
        >
          {stale && (
            <button
              type="button"
              className="m-0 min-h-11 w-full shrink-0 cursor-pointer rounded-xl border border-[#d4a24c]/35 bg-[#d4a24c]/12 px-3 py-2.5 text-left text-xs leading-snug text-[#e8d0a0] transition-[transform,background] duration-140 ease-out-strong hover:bg-[#d4a24c]/18 active:scale-[0.985]"
              role="status"
              onClick={() => {
                setFormOpen(true)
                if (isMobile) setSheetSnap('full')
              }}
            >
              Inputs changed — tap to edit, then Update safest routes.
            </button>
          )}

          {data.why && (
            <div className="animate-rise shrink-0 rounded-xl border border-mint/14 bg-teal/14 p-3.5">
              <h2 className="mb-1.5 mt-0 text-xs font-semibold tracking-tight text-mint">Why Route 1 is recommended</h2>
              <p className="m-0 text-[13px] leading-relaxed text-[#d5e2e4]">{data.why}</p>
            </div>
          )}

          {!isMobile && (
            <div className="flex flex-col gap-2">
              {data.routes.map((r, i) => (
                <RouteCard
                  key={r.id}
                  route={r}
                  rank={i}
                  recommended={r.id === data.recommended}
                  selected={r.id === selectedId}
                  why={r.id === data.recommended ? data.why : undefined}
                  loadLb={load}
                  onSelect={() => setSelectedId(r.id)}
                />
              ))}
            </div>
          )}

          {isMobile && (
            <div className="flex flex-col gap-2" data-no-drag>
              {data.routes.map((r, i) => (
                <RouteCard
                  key={`list-${r.id}`}
                  route={r}
                  rank={i}
                  recommended={r.id === data.recommended}
                  selected={r.id === selectedId}
                  why={r.id === data.recommended ? data.why : undefined}
                  loadLb={load}
                  onSelect={() => setSelectedId(r.id)}
                />
              ))}
            </div>
          )}

          <div className="shrink-0 pb-1">
            <button
              type="button"
              className="mb-2 flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent p-0 text-left font-sans active:scale-[0.99]"
              onClick={() => setLegendOpen(o => !o)}
              aria-expanded={legendOpen}
            >
              <span className="text-xs text-muted">Stop colors = risk at arrival. Tap a stop for weather.</span>
              <span className="text-[11px] font-semibold text-mint">{legendOpen ? 'Hide' : 'Legend'}</span>
            </button>
            {legendOpen && (
              <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-2 p-0">
                {RISK_ORDER.map(l => (
                  <li key={l} className="flex min-h-11 items-center gap-1.5 text-xs text-muted">
                    <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[l] }} />
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </>
  )

  return (
    <div
      className={cn(
        'grid h-dvh min-h-0 grid-cols-[400px_1fr] grid-rows-1',
        isMobile && 'relative block overflow-hidden',
      )}
      data-sheet={sheetSnap}
      style={
        isMobile
          ? ({ '--sheet-h': `${sheetHeight}px` } as CSSProperties)
          : undefined
      }
    >
      {isMobile ? (
        <BottomSheet
          snap={sheetSnap}
          onSnapChange={setSheetSnap}
          onHeightChange={onSheetHeight}
          fitContent={!data && formOpen}
          handleOnlyPeek={!!data}
          footer={
            formOpen ? (
              <button
                form="trip-plan-form"
                className="min-h-11 w-full cursor-pointer rounded-xl border-0 bg-[linear-gradient(180deg,var(--color-mint-soft)_0%,var(--color-mint)_100%)] px-4 py-2.5 font-sans text-sm font-semibold tracking-tight text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_1px_0_rgba(0,0,0,0.12),0_8px_20px_rgba(197,225,229,0.1)] transition-[transform,filter,box-shadow] duration-150 ease-out-strong hover:brightness-[1.03] active:scale-[0.97] disabled:cursor-wait disabled:opacity-55 disabled:hover:brightness-100"
                disabled={busy}
                type="submit"
              >
                <span className={busy ? 'inline-block animate-pulse-soft' : undefined}>
                  {busy ? (status ?? 'Finding routes…') : data ? 'Update safest routes' : 'Find safest routes'}
                </span>
              </button>
            ) : undefined
          }
        >
          {panel}
        </BottomSheet>
      ) : (
        <aside
          className={cn(
            'flex min-h-0 flex-col gap-3 overflow-hidden border-r border-line bg-ink-soft px-5 pb-5 pt-5',
            'bg-[linear-gradient(180deg,rgba(197,225,229,0.03)_0%,transparent_120px),var(--color-ink-soft)]',
          )}
        >
          {panel}
        </aside>
      )}

      <main
        className={cn(
          'relative h-full min-h-0 bg-ink',
          isMobile && 'absolute inset-0',
        )}
        style={
          isMobile
            ? {
                paddingTop: 'env(safe-area-inset-top, 0px)',
                paddingLeft: 'env(safe-area-inset-left, 0px)',
                paddingRight: 'env(safe-area-inset-right, 0px)',
              }
            : undefined
        }
      >
        <RouteMap
          data={data}
          selectedId={selectedId}
          hour={hour}
          showHeatmap={showHeatmap}
          departureIso={planDepartureIso}
          dimmed={stale}
          recenterToken={recenterToken}
          onSelectRoute={setSelectedId}
        />

        {selected && data && (
          <div
            className={cn(
              'absolute left-4 top-4 z-[2] max-w-[min(340px,calc(100%-72px))] animate-rise rounded-xl border border-line bg-ink/88 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(197,225,229,0.08),0_12px_28px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-opacity duration-200 ease-out-strong',
              isMobile && 'left-2.5 top-[max(0.625rem,env(safe-area-inset-top))] max-w-[calc(100%-56px)]',
              stale && 'opacity-45',
            )}
            role="status"
          >
            <div className="mb-1 flex items-center justify-between gap-2.5">
              <strong className="text-[13px] tracking-tight">
                {selected.id === data.recommended
                  ? `${routeRankLabel(data.routes.findIndex(r => r.id === selected.id))} · Recommended`
                  : routeRankLabel(data.routes.findIndex(r => r.id === selected.id))}
              </strong>
              <button
                type="button"
                className="min-h-11 cursor-pointer whitespace-nowrap rounded-lg border-0 bg-mint/8 px-2.5 py-2 font-sans text-[11px] font-semibold text-mint transition-[background,transform] duration-140 ease-out-strong hover:bg-teal/35 active:scale-[0.97]"
                onClick={() => setRecenterToken(n => n + 1)}
              >
                Show full trip
              </button>
            </div>
            <p className="m-0 text-[13px] tabular-nums text-[#d5e2e4]">
              {selected.distance_mi} mi · {formatDriveTime(selected.duration_s)} ·{' '}
              <span style={{ color: RISK_COLORS[avgRiskWord(selected.summary.avg_risk)] }}>
                {avgRiskWord(selected.summary.avg_risk)}
              </span>
              {' average'}
            </p>
            <p className="mt-1 m-0 text-xs tabular-nums text-muted">
              {riskMilesLine(selected.summary.miles_by_risk)}
            </p>
          </div>
        )}

        {data?.heatmap && (
          <TimelineScrubber
            hour={hour}
            maxHour={Math.max(0, (data.heatmap.hours ?? 48) - 1)}
            timeLabel={hourLabel}
            showHeatmap={showHeatmap}
            onHour={setHour}
            onToggleHeatmap={setShowHeatmap}
            orientation={isMobile ? 'vertical' : 'horizontal'}
            bottomOffset={16}
          />
        )}

        {/* Desktop only — mobile already shows the form in the sheet */}
        {!data && !busy && !isMobile && (
          <div className="pointer-events-none absolute inset-0 z-[1] grid place-items-center p-6">
            <div className="max-w-[280px] animate-rise rounded-2xl border border-line bg-ink/90 px-6 py-5 text-center shadow-[inset_0_1px_0_rgba(197,225,229,0.08),0_12px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl">
              <p className="mb-1.5 mt-0 text-base font-semibold tracking-tight text-mist leading-snug">Plan a trip</p>
              <p className="m-0 text-[13px] leading-snug text-muted">
                Enter From and To, then find the safest routes.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function RouteCard({
  route, rank, recommended, selected, why, loadLb, onSelect, compact, className,
}: {
  route: RouteResult
  rank: number
  recommended: boolean
  selected: boolean
  why?: string
  loadLb: number
  onSelect: () => void
  compact?: boolean
  className?: string
}) {
  const word = avgRiskWord(route.summary.avg_risk)
  const arrival = routeArrivalIso(route)
  const escalations = loadEscalationCount(route)
  const severe = route.summary.severe_miles ?? route.summary.miles_by_risk.Severe ?? 0
  const high = route.summary.high_miles ?? route.summary.miles_by_risk.High ?? 0
  const noTravel = route.summary.no_travel_miles ?? route.summary.miles_by_risk['No Travel'] ?? 0

  return (
    <button
      type="button"
      className={cn(
        'w-full animate-rise cursor-pointer rounded-xl border border-line bg-transparent text-left font-sans text-inherit transition-[border-color,transform,background] duration-160 ease-out-strong active:scale-[0.985]',
        compact ? 'min-h-11 p-2.5' : 'p-3.5',
        recommended && 'border-[#3d9a7a]/45',
        selected && 'border-mint/55 bg-surface',
        className,
      )}
      onClick={onSelect}
      style={{ animationDelay: `${rank * 40}ms` }}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <strong className="text-sm font-semibold tracking-tight">
          {routeRankLabel(rank)}
          {recommended ? ' · Recommended' : ''}
        </strong>
        <span className="text-xs tabular-nums text-muted">
          {route.distance_mi} mi · {formatDriveTime(route.duration_s)}
        </span>
      </div>

      <RiskStack miles={route.summary.miles_by_risk} />

      {!compact && (
        <ul className="mb-2.5 mt-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 text-xs tabular-nums text-mist">
          {noTravel > 0 && (
            <li><span className="mr-1 text-muted">No Travel</span> {Math.round(noTravel)} mi</li>
          )}
          <li><span className="mr-1 text-muted">Severe</span> {Math.round(severe)} mi</li>
          <li><span className="mr-1 text-muted">High</span> {Math.round(high)} mi</li>
          {arrival && (
            <li>
              <span className="mr-1 text-muted">Arrive</span>
              {formatArrival(arrival)}
            </li>
          )}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-mint/10 px-2 py-1 text-[11px] font-semibold tabular-nums text-mint">
          Load {loadLb.toLocaleString()} lb
        </span>
        {!compact && escalations > 0 && (
          <span className="rounded-full bg-coral/16 px-2 py-1 text-[11px] font-semibold text-[#ffc4c7]">
            Load raised risk at {escalations} stop{escalations === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto text-[11px] font-semibold" style={{ color: RISK_COLORS[word] }}>
          {word} avg
        </span>
      </div>

      {!compact && recommended && why && (
        <p className="mt-2.5 mb-0 text-xs leading-snug text-[#d5e2e4]">{why}</p>
      )}
    </button>
  )
}
