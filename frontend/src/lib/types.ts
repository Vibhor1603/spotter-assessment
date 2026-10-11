export type RiskLabel = 'Low' | 'Moderate' | 'High' | 'Severe' | 'No Travel'
export interface Place { name: string; lon: number; lat: number }
export interface Checkpoint {
  index: number; lon: number; lat: number; mile: number; eta: string; forecast_time: string
  wind_mph: number; rain_in_hr: number; snow_in_hr: number; risk: RiskLabel; risk_level: number; load_escalated: boolean
}
export interface RouteResult {
  id: string; geometry: [number, number][]; distance_mi: number; duration_s: number
  checkpoints: Checkpoint[]; summary: { miles_by_risk: Record<RiskLabel, number>; avg_risk: number }
}
export interface PlanResponse { recommended: string | null; routes: RouteResult[] }
export const RISK_COLORS: Record<RiskLabel, string> = {
  Low: '#2da44e', Moderate: '#d4a72c', High: '#fb8500', Severe: '#cf222e', 'No Travel': '#6e40c9',
}
