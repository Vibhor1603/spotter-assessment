import { useMemo, useState } from 'react'
import PlaceInput from './components/PlaceInput'
import RouteMap from './components/RouteMap'
import { geocode, plan } from './lib/api'
import type { Place, PlanResponse, RiskLabel } from './lib/types'
import { RISK_COLORS, RISK_ORDER } from './lib/types'

function defaultDepartureLocal() {
  const d = new Date(Date.now() + 3600e3)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const hourLabel = useMemo(() => {
    const t = data?.heatmap?.times?.[hour]
    if (!t) return `+${hour}h`
    try {
      return new Date(t + 'Z').toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric',
      })
    } catch {
      return t
    }
  }, [data, hour])

  async function resolvePlace(text: string, cached: Place | null): Promise<Place> {
    if (cached && cached.name === text) return cached
    const hits = await geocode(text)
    if (!hits[0]) throw new Error(`Could not geocode “${text}”`)
    return hits[0]
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const [o, d] = await Promise.all([
        resolvePlace(originText, origin),
        resolvePlace(destText, dest),
      ])
      setOrigin(o)
      setDest(d)
      const res = await plan({
        origin: o,
        destination: d,
        departure: new Date(departure).toISOString(),
        load_lb: load,
        interval_mi: interval,
      })
      setData(res)
      setSelectedId(res.recommended)
      setHour(0)
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="layout">
      <aside className="panel">
        <header className="brand">
          <div className="brand-mark" aria-hidden />
          <div>
            <p className="brand-kicker">Spotter · take-home</p>
            <h1>Weather-Aware Routing</h1>
          </div>
        </header>

        <form className="plan-form" onSubmit={submit}>
          <PlaceInput
            label="Origin"
            value={originText}
            onChange={setOriginText}
            selected={origin}
            onSelect={setOrigin}
          />
          <PlaceInput
            label="Destination"
            value={destText}
            onChange={setDestText}
            selected={dest}
            onSelect={setDest}
          />

          <div className="field">
            <label htmlFor="dep">Departure (local)</label>
            <input id="dep" type="datetime-local" value={departure} onChange={e => setDeparture(e.target.value)} />
          </div>

          <div className="row2">
            <div className="field">
              <label htmlFor="load">Load (lb)</label>
              <input id="load" type="number" min={0} step={500} value={load}
                onChange={e => setLoad(+e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="iv">Checkpoint every</label>
              <select id="iv" value={interval} onChange={e => setIntervalMi(+e.target.value)}>
                {[10, 25, 50].map(v => <option key={v} value={v}>{v} mi</option>)}
              </select>
            </div>
          </div>

          <button className="primary" disabled={busy} type="submit">
            <span className={busy ? 'btn-busy' : undefined}>
              {busy ? 'Planning routes…' : 'Plan routes'}
            </span>
          </button>
        </form>

        {err && <div className="banner error" role="alert">{err}</div>}

        {busy && !data && (
          <div className="skeleton-stack" aria-hidden>
            <div className="skel" /><div className="skel" /><div className="skel short" />
          </div>
        )}

        {data && (
          <section className="results">
            {data.why && (
              <div className="why">
                <h2>Why this route</h2>
                <p>{data.why}</p>
              </div>
            )}

            <div className="route-list">
              {data.routes.map((r, i) => {
                const isBest = r.id === data.recommended
                const isSel = r.id === selectedId
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`route-card${isBest ? ' best' : ''}${isSel ? ' selected' : ''}`}
                    onClick={() => setSelectedId(r.id)}
                    style={{ animationDelay: `${i * 40}ms` }}
                  >
                    <div className="route-card-top">
                      <strong>{isBest ? 'Recommended' : `Option ${r.id}`}</strong>
                      <span className="pill">{r.distance_mi} mi · {(r.duration_s / 3600).toFixed(1)} h</span>
                    </div>
                    <div className="risk-bars">
                      {RISK_ORDER.map(label => {
                        const mi = r.summary.miles_by_risk[label as RiskLabel] ?? 0
                        if (!mi) return null
                        return (
                          <span key={label} style={{ background: RISK_COLORS[label as RiskLabel] }}
                            title={`${label}: ${mi} mi`}>
                            {label.slice(0, 1)} {mi}
                          </span>
                        )
                      })}
                    </div>
                    <small>avg risk {r.summary.avg_risk.toFixed(2)}</small>
                  </button>
                )
              })}
            </div>

            <div className="legend">
              <h2>Risk legend</h2>
              <ul>
                {RISK_ORDER.map(l => (
                  <li key={l}><i style={{ background: RISK_COLORS[l] }} />{l}</li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </aside>

      <main className="map-pane">
        <RouteMap data={data} selectedId={selectedId} hour={hour} showHeatmap={showHeatmap} />

        {data?.heatmap && (
          <div className="map-hud">
            <div className="hud-row">
              <label className="toggle">
                <input type="checkbox" checked={showHeatmap} onChange={e => setShowHeatmap(e.target.checked)} />
                Corridor heatmap
              </label>
              <span className="hud-time">{hourLabel}</span>
            </div>
            <input
              className="hour-slider"
              type="range"
              min={0}
              max={Math.max(0, (data.heatmap.hours ?? 48) - 1)}
              value={hour}
              onChange={e => setHour(+e.target.value)}
              aria-label="Forecast hour"
            />
            <div className="hud-scale">
              <span>0h</span>
              <span>client-side hour · no refetch</span>
              <span>48h</span>
            </div>
          </div>
        )}

        {!data && !busy && (
          <div className="map-empty">
            <p>Plan a trip to see ranked routes, ETA-matched risk, and a 48h corridor heatmap.</p>
          </div>
        )}
      </main>
    </div>
  )
}
