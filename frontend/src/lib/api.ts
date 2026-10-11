import type { Place, PlanResponse } from './types'
const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000/api'

export async function geocode(q: string): Promise<Place[]> {
  const r = await fetch(`${BASE}/geocode/?q=${encodeURIComponent(q)}`)
  if (!r.ok) throw new Error(`geocode ${r.status}`)
  return r.json()
}

export async function plan(body: {
  origin: Place; destination: Place; departure: string; load_lb: number; interval_mi: number
}): Promise<PlanResponse> {
  const r = await fetch(`${BASE}/plan/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`plan ${r.status}: ${await r.text()}`)
  return r.json()
}
