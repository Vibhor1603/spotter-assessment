import { useState } from 'react'
import RouteMap from './components/RouteMap'
import { geocode, plan } from './lib/api'
import type { PlanResponse } from './lib/types'

export default function App() {
  const [origin, setOrigin] = useState('Denver, CO')
  const [dest, setDest] = useState('Salt Lake City, UT')
  const [departure, setDeparture] = useState(() => new Date(Date.now() + 3600e3).toISOString().slice(0, 16))
  const [load, setLoad] = useState(35000)
  const [interval, setInterval] = useState(25)
  const [data, setData] = useState<PlanResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      // TODO(next): replace with autocomplete dropdown on geocode results
      const [[o], [d]] = await Promise.all([geocode(origin), geocode(dest)])
      if (!o || !d) throw new Error('Could not geocode origin/destination')
      setData(await plan({ origin: o, destination: d, departure: new Date(departure).toISOString(),
        load_lb: load, interval_mi: interval }))
    } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }

  return (
    <div className="layout">
      <form className="panel" onSubmit={submit}>
        <h2>Weather-Aware Truck Routing</h2>
        <label>Origin</label><input value={origin} onChange={e => setOrigin(e.target.value)} />
        <label>Destination</label><input value={dest} onChange={e => setDest(e.target.value)} />
        <label>Departure (local)</label>
        <input type="datetime-local" value={departure} onChange={e => setDeparture(e.target.value)} />
        <label>Load weight (lb)</label>
        <input type="number" min={0} value={load} onChange={e => setLoad(+e.target.value)} />
        <label>Checkpoint interval</label>
        <select value={interval} onChange={e => setInterval(+e.target.value)}>
          {[10, 25, 50].map(v => <option key={v} value={v}>{v} miles</option>)}
        </select>
        <button disabled={busy}>{busy ? 'Planning…' : 'Plan routes'}</button>
        {err && <p style={{ color: 'crimson' }}>{err}</p>}
        {data?.routes.map(r => (
          <div key={r.id} className={`route ${r.id === data.recommended ? 'best' : ''}`}>
            <strong>{r.id === data.recommended ? '★ Recommended' : r.id}</strong>
            <div>{r.distance_mi} mi · {(r.duration_s / 3600).toFixed(1)} h · avg risk {r.summary.avg_risk}</div>
            <small>{Object.entries(r.summary.miles_by_risk).map(([k, v]) => `${k}: ${v} mi`).join(' · ')}</small>
          </div>
        ))}
      </form>
      <RouteMap data={data} />
    </div>
  )
}
