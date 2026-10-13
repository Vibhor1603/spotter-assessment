import type { Place, PlanResponse } from './types'
const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000/api'

async function readError(r: Response): Promise<string> {
  try {
    const j = await r.json()
    if (typeof j?.detail === 'string' && j.detail.trim()) {
      const d = j.detail.trim()
      // Never surface raw Python / stack fragments if a proxy leaks them
      if (/traceback|file "|exception:|connectionpool/i.test(d)) {
        return fallbackForStatus(r.status)
      }
      return d
    }
    if (j?.detail) return fallbackForStatus(r.status)
    return fallbackForStatus(r.status)
  } catch {
    return fallbackForStatus(r.status)
  }
}

function fallbackForStatus(status: number): string {
  if (status === 400) return 'Check origin, destination, departure time, and load weight.'
  if (status === 502 || status === 503) {
    return 'Routing or weather service is unavailable. Try again shortly.'
  }
  if (status >= 500) return 'Something went wrong. Try again in a moment.'
  return rStatus(status)
}

function rStatus(status: number): string {
  return status ? `Request failed (${status})` : 'Request failed'
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
