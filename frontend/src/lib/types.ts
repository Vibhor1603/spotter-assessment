export type RiskLabel = 'Low' | 'Moderate' | 'High' | 'Severe' | 'No Travel'
export interface Place { name: string; lon: number; lat: number }
export interface Checkpoint {
  index: number; lon: number; lat: number; mile: number; eta: string; forecast_time: string
  wind_mph: number; rain_in_hr: number; snow_in_hr: number
  risk: RiskLabel; risk_level: number; load_escalated: boolean
  wind_risk?: RiskLabel; rain_risk?: RiskLabel; snow_risk?: RiskLabel
}
export interface RouteResult {
  id: string; geometry: [number, number][]; distance_mi: number; duration_s: number
  checkpoints: Checkpoint[]
  summary: {
    miles_by_risk: Record<RiskLabel, number>
    avg_risk: number
    severe_miles?: number
    high_miles?: number
    no_travel_miles?: number
  }
}
export interface HeatmapPayload {
  hours: number
  times: string[]
  points: { lon: number; lat: number; weights: number[] }[]
}
export interface PlanResponse {
  recommended: string | null
  why?: string
  routes: RouteResult[]
  heatmap?: HeatmapPayload
  forecast_days?: number
}
/** Risk colors tuned to Spotter logo (mint / teal / coral) while staying distinct. */
export const RISK_COLORS: Record<RiskLabel, string> = {
  Low: '#3d9a7a',
  Moderate: '#d4a24c',
  High: '#e07a3a',
  Severe: '#f07178',
  'No Travel': '#8b6bb5',
}
export const RISK_ORDER: RiskLabel[] = ['Low', 'Moderate', 'High', 'Severe', 'No Travel']

/** Display rank in the sorted (best→worst) route list. */
export function routeRankLabel(rankIndex: number): string {
  return `Route ${rankIndex + 1}`
}

/** Map numeric avg risk (0–4) to a plain word. */
export function avgRiskWord(avg: number): RiskLabel {
  if (avg < 0.5) return 'Low'
  if (avg < 1.5) return 'Moderate'
  if (avg < 2.5) return 'High'
  if (avg < 3.5) return 'Severe'
  return 'No Travel'
}

export function formatDriveTime(seconds: number): string {
  const h = seconds / 3600
  if (h < 1) return `${Math.round(seconds / 60)} min`
  return `${h.toFixed(1)} hr`
}

export function riskMilesLine(miles: Record<RiskLabel, number>): string {
  const parts: string[] = []
  for (const label of ['No Travel', 'Severe', 'High'] as RiskLabel[]) {
    const mi = miles[label] ?? 0
    if (mi > 0) parts.push(`${label} ${Math.round(mi)} mi`)
  }
  if (!parts.length) {
    const mod = miles.Moderate ?? 0
    if (mod > 0) return `Moderate ${Math.round(mod)} mi`
    return 'Mostly low risk'
  }
  return parts.join(' · ')
}

export function loadEscalationCount(route: RouteResult): number {
  return route.checkpoints.filter(c => c.load_escalated).length
}

export function routeArrivalIso(route: RouteResult): string | null {
  const last = route.checkpoints[route.checkpoints.length - 1]
  return last?.eta ?? null
}

/** Progress 0..1 of the truck along the trip at a wall-clock forecast time. */
export function truckProgressAt(
  departureIso: string,
  durationS: number,
  forecastMs: number,
): number {
  if (!durationS || durationS <= 0) return 0
  const dep = Date.parse(departureIso)
  if (!Number.isFinite(dep) || !Number.isFinite(forecastMs)) return 0
  return Math.max(0, Math.min(1, (forecastMs - dep) / 1000 / durationS))
}

/** Interpolate a lon/lat along a linestring by fraction of path length (0..1). */
export function pointAlongRoute(
  coords: [number, number][],
  t: number,
): [number, number] | null {
  if (!coords.length) return null
  if (coords.length === 1 || t <= 0) return coords[0]
  if (t >= 1) return coords[coords.length - 1]
  let total = 0
  const segLens: number[] = []
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0]
    const dy = coords[i][1] - coords[i - 1][1]
    const len = Math.hypot(dx, dy)
    segLens.push(len)
    total += len
  }
  if (total <= 0) return coords[0]
  let remain = t * total
  for (let i = 0; i < segLens.length; i++) {
    const len = segLens[i]
    if (remain <= len || i === segLens.length - 1) {
      const u = len > 0 ? remain / len : 0
      const a = coords[i]
      const b = coords[i + 1]
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
    }
    remain -= len
  }
  return coords[coords.length - 1]
}

const SNAP_MS = 20 * 60 * 1000 // snap to a stop when within ±20 min of its ETA

/**
 * Truck position on the selected route at a wall-clock forecast time.
 * Anchors to checkpoint ETAs so the marker lands on stops when the scrubber
 * reaches that hour — not a free-running distance fraction that drifts off.
 */
export function truckPositionAt(
  route: RouteResult,
  departureIso: string,
  forecastMs: number,
): [number, number] | null {
  const geom = route.geometry
  if (!geom?.length) return null

  const cps = route.checkpoints
  if (!cps.length) {
    const t = truckProgressAt(departureIso, route.duration_s, forecastMs)
    return pointAlongRoute(geom, t)
  }

  type Anchor = { ms: number; mile: number; lon: number; lat: number }
  const depMs = Date.parse(departureIso)
  const anchors: Anchor[] = []
  if (Number.isFinite(depMs)) {
    const start = geom[0]
    anchors.push({ ms: depMs, mile: 0, lon: start[0], lat: start[1] })
  }
  for (const c of cps) {
    const raw = c.eta.trim()
    const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) continue
    anchors.push({ ms, mile: c.mile, lon: c.lon, lat: c.lat })
  }

  if (!anchors.length) {
    const t = truckProgressAt(departureIso, route.duration_s, forecastMs)
    return pointAlongRoute(geom, t)
  }

  anchors.sort((a, b) => a.ms - b.ms)

  // Snap onto a stop when the scrubbed hour is near that stop's ETA
  let nearest = anchors[0]
  let nearestAbs = Math.abs(forecastMs - nearest.ms)
  for (const a of anchors) {
    const d = Math.abs(forecastMs - a.ms)
    if (d < nearestAbs) {
      nearest = a
      nearestAbs = d
    }
  }
  if (nearestAbs <= SNAP_MS) {
    return [nearest.lon, nearest.lat]
  }

  if (forecastMs <= anchors[0].ms) {
    return [anchors[0].lon, anchors[0].lat]
  }
  const last = anchors[anchors.length - 1]
  if (forecastMs >= last.ms) {
    return [last.lon, last.lat]
  }

  let i = 0
  while (i < anchors.length - 1 && anchors[i + 1].ms < forecastMs) i++
  const a = anchors[i]
  const b = anchors[i + 1]
  const span = b.ms - a.ms
  const u = span > 0 ? (forecastMs - a.ms) / span : 0
  const totalMi = Math.max(last.mile, route.distance_mi, 1e-6)
  const mile = a.mile + (b.mile - a.mile) * u
  // Prefer geometry interpolation so the truck stays on the road between stops
  const onRoad = pointAlongRoute(geom, mile / totalMi)
  if (onRoad) return onRoad
  return [a.lon + (b.lon - a.lon) * u, a.lat + (b.lat - a.lat) * u]
}
