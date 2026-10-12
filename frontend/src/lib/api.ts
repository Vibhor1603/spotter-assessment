import type { Place, PlanResponse } from './types'
const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000/api'

async function readError(r: Response): Promise<string> {
  try {
    const j = await r.json()
    if (typeof j?.detail === 'string') return j.detail
    if (j?.detail) return JSON.stringify(j.detail)
    return JSON.stringify(j)
  } catch {
    return r.statusText || String(r.status)
  }
}

export async function geocode(q: string): Promise<Place[]> {
  const r = await fetch(`${BASE}/geocode/?q=${encodeURIComponent(q)}`)
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

export async function plan(body: {
  origin: Place; destination: Place; departure: string; load_lb: number; interval_mi: number
}): Promise<PlanResponse> {
  const r = await fetch(`${BASE}/plan/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}
