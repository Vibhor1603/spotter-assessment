import { useMemo, useState } from 'react'
import DateTimePicker from './components/DateTimePicker'
import PlaceInput from './components/PlaceInput'
import RouteMap from './components/RouteMap'
import SegmentedControl from './components/SegmentedControl'
import SwapIcon from './components/SwapIcon'
import TimelineScrubber from './components/TimelineScrubber'
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

const EXAMPLE_TRIPS: { from: string; to: string; load: number; label: string }[] = [
  { from: 'Denver, CO', to: 'Salt Lake City, UT', load: 35000, label: 'Denver → Salt Lake' },
  { from: 'Chicago, IL', to: 'Indianapolis, IN', load: 45000, label: 'Chicago → Indy' },
  { from: 'Kansas City, MO', to: 'Omaha, NE', load: 20000, label: 'KC → Omaha' },
]

const fieldLabel = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.04em] text-muted'
const fieldInput = 'w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 font-sans text-sm font-medium tracking-tight text-mist tabular-nums transition-[border-color,background,box-shadow] duration-160 ease-out-strong focus:border-mint/40 focus:bg-surface-2 focus:outline-none focus:shadow-[0_0_0_3px_rgba(13,124,130,0.22)]'

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
  const [sheetOpen, setSheetOpen] = useState(true)
  const [formOpen, setFormOpen] = useState(true)
  const [planDepartureIso, setPlanDepartureIso] = useState<string | null>(null)

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

  async function submit(e?: React.FormEvent) {
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
      setSheetOpen(true)
      setFormOpen(false)
    } catch (x) {
      setData(null)
      setPlanDepartureIso(null)
      setSelectedId(null)
      setStale(false)
      setFormOpen(true)
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

  function applyExample(ex: typeof EXAMPLE_TRIPS[number]) {
    setOriginText(ex.from)
    setDestText(ex.to)
    setOrigin(null)
    setDest(null)
    setLoad(ex.load)
    markInputsDirty()
  }

  return (
    <div
      className={cn(
        'grid h-dvh min-h-0 grid-cols-[400px_1fr] grid-rows-1',
        'max-md:relative max-md:block max-md:overflow-hidden',
      )}
      data-sheet={sheetOpen ? 'open' : 'closed'}
    >
      <aside
        className={cn(
          'flex min-h-0 flex-col gap-4 overflow-hidden border-r border-line bg-ink-soft px-6 pb-6 pt-7',
          'bg-[linear-gradient(180deg,rgba(197,225,229,0.03)_0%,transparent_120px),var(--color-ink-soft)]',
          'max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-[5] max-md:max-h-[min(62dvh,560px)] max-md:rounded-t-[18px] max-md:border-r-0 max-md:border-t max-md:pt-2 max-md:shadow-[0_-12px_40px_rgba(0,0,0,0.45)] max-md:transition-transform max-md:duration-[280ms] max-md:ease-out-strong',
          sheetOpen ? 'max-md:translate-y-0' : 'max-md:translate-y-[calc(100%-56px)]',
        )}
      >
        <div className="hidden shrink-0 justify-center px-0 pb-1 pt-0.5 max-md:flex" aria-hidden>
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent px-6 py-2 active:scale-[0.97]"
            onClick={() => setSheetOpen(o => !o)}
            aria-expanded={sheetOpen}
            aria-label={sheetOpen ? 'Collapse trip panel' : 'Expand trip panel'}
          >
            <span className="block h-1 w-10 rounded-full bg-mint/35" />
          </button>
        </div>

        <header className="flex shrink-0 flex-col gap-2">
          <div className="flex items-center gap-2.5">
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

        {data && (
          <button
            type="button"
            className={cn(
              'group flex w-full shrink-0 cursor-pointer flex-col gap-1 rounded-2xl border border-line bg-surface/80 px-3.5 py-3 text-left font-sans',
              'shadow-[inset_0_1px_0_rgba(197,225,229,0.05)]',
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
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold tracking-tight text-mint">
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
            formOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
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
                'flex flex-col gap-4 transition-[opacity,transform] duration-[240ms] ease-out-strong motion-reduce:transition-none',
                formOpen
                  ? 'translate-y-0 opacity-100'
                  : 'pointer-events-none -translate-y-1 opacity-0',
              )}
              aria-hidden={!formOpen}
            >
              <form className="flex flex-col gap-4" onSubmit={submit}>
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
                      className="absolute right-0 top-1/2 z-4 grid h-9 w-9 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-line-strong bg-[linear-gradient(180deg,rgba(197,225,229,0.12)_0%,rgba(18,36,40,0.95)_100%)] text-mint shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_6px_16px_rgba(0,0,0,0.35),0_0_0_4px_var(--color-surface)] backdrop-blur-[10px] transition-[transform,background,color,border-color] duration-180 ease-out-strong hover:border-mint/40 hover:bg-[linear-gradient(180deg,rgba(26,154,163,0.45)_0%,rgba(13,124,130,0.85)_100%)] hover:text-white active:scale-[0.92] active:rotate-180"
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

                <div className="flex flex-col gap-3.5 overflow-visible rounded-2xl border border-line bg-surface/55 px-4 pb-4 pt-3.5">
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

                <button
                  className="mt-0.5 w-full cursor-pointer rounded-[14px] border-0 bg-[linear-gradient(180deg,var(--color-mint-soft)_0%,var(--color-mint)_100%)] px-4 py-3.5 font-sans text-sm font-semibold tracking-tight text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_1px_0_rgba(0,0,0,0.12),0_10px_28px_rgba(197,225,229,0.12)] transition-[transform,filter,box-shadow] duration-150 ease-out-strong hover:brightness-[1.03] active:scale-[0.97] disabled:cursor-wait disabled:opacity-55 disabled:hover:brightness-100"
                  disabled={busy}
                  type="submit"
                  tabIndex={formOpen ? 0 : -1}
                >
                  <span className={busy ? 'inline-block animate-pulse-soft' : undefined}>
                    {busy ? (status ?? 'Finding routes…') : data ? 'Update safest routes' : 'Find safest routes'}
                  </span>
                </button>
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

              {!data && !busy && !err && (
                <section className="flex flex-col gap-2.5" aria-label="Example trips">
                  <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Try an example</p>
                  <div className="flex flex-col gap-1.5">
                    {EXAMPLE_TRIPS.map(ex => (
                      <button
                        key={ex.label}
                        type="button"
                        className="flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-xl border border-line bg-transparent px-3.5 py-3 text-left font-sans text-[13px] font-medium tracking-tight text-mist transition-[background,border-color,transform] duration-140 ease-out-strong hover:border-mint/28 hover:bg-teal/16 active:scale-[0.985]"
                        onClick={() => applyExample(ex)}
                        tabIndex={formOpen ? 0 : -1}
                      >
                        {ex.label}
                        <span className="text-xs font-medium tabular-nums text-muted">{ex.load.toLocaleString()} lb</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>

        {data && (
          <section
            className={cn(
              'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain pr-0.5',
              stale && 'opacity-55 saturate-70',
            )}
          >
            {stale && (
              <button
                type="button"
                className="m-0 w-full shrink-0 cursor-pointer rounded-xl border border-[#d4a24c]/35 bg-[#d4a24c]/12 px-3 py-2.5 text-left text-xs leading-snug text-[#e8d0a0] transition-[transform,background] duration-140 ease-out-strong hover:bg-[#d4a24c]/18 active:scale-[0.985]"
                role="status"
                onClick={() => setFormOpen(true)}
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

            <div className="shrink-0 pb-1">
              <p className="mb-2 mt-0 text-xs text-muted">Stop colors = risk at arrival. Tap a stop for weather.</p>
              <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-2 p-0">
                {RISK_ORDER.map(l => (
                  <li key={l} className="flex items-center gap-1.5 text-xs text-muted">
                    <i className="inline-block h-2 w-2 rounded-full" style={{ background: RISK_COLORS[l] }} />
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </aside>

      <main className="relative h-full min-h-0 bg-ink max-md:absolute max-md:inset-0">
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
              'max-md:left-2.5 max-md:top-2.5 max-md:max-w-[calc(100%-56px)]',
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
                className="cursor-pointer whitespace-nowrap rounded-lg border-0 bg-mint/8 px-2.5 py-1.5 font-sans text-[11px] font-semibold text-mint transition-[background,transform] duration-140 ease-out-strong hover:bg-teal/35 active:scale-[0.97]"
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
          />
        )}

        {!data && !busy && (
          <div className="pointer-events-none absolute inset-0 z-[1] grid place-items-center p-6">
            <div className="max-w-[280px] animate-rise rounded-2xl border border-line bg-ink/90 px-6 py-5 text-center shadow-[inset_0_1px_0_rgba(197,225,229,0.08),0_12px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl">
              <p className="mb-1.5 mt-0 text-base font-semibold tracking-tight text-mist leading-snug">Plan a trip</p>
              <p className="m-0 text-[13px] leading-snug text-muted">
                Pick From and To, or tap an example, then find the safest routes.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function RouteCard({
  route, rank, recommended, selected, why, loadLb, onSelect,
}: {
  route: RouteResult
  rank: number
  recommended: boolean
  selected: boolean
  why?: string
  loadLb: number
  onSelect: () => void
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
        'w-full animate-rise cursor-pointer rounded-xl border border-line bg-transparent p-3.5 text-left font-sans text-inherit transition-[border-color,transform,background] duration-160 ease-out-strong active:scale-[0.985]',
        recommended && 'border-[#3d9a7a]/45',
        selected && 'border-mint/55 bg-surface',
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

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-mint/10 px-2 py-1 text-[11px] font-semibold tabular-nums text-mint">
          Load {loadLb.toLocaleString()} lb
        </span>
        {escalations > 0 && (
          <span className="rounded-full bg-coral/16 px-2 py-1 text-[11px] font-semibold text-[#ffc4c7]">
            Load raised risk at {escalations} stop{escalations === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto text-[11px] font-semibold" style={{ color: RISK_COLORS[word] }}>
          {word} avg
        </span>
      </div>

      {recommended && why && (
        <p className="mt-2.5 mb-0 text-xs leading-snug text-[#d5e2e4]">{why}</p>
      )}
    </button>
  )
}
