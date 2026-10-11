"""Orchestration: geocode -> routes -> checkpoints -> weather -> risk -> ranking."""
from __future__ import annotations
from datetime import datetime
from .clients import OSRMRouter, OpenMeteoWeather, Place, value_at
from .geo import sample_checkpoints
from .risk import Weather, assess, summarize, rank_routes, SegmentRisk

M_PER_MI = 1609.344


def plan(origin: Place, dest: Place, departure: datetime, load_lb: float, interval_mi: int,
         router=None, weather=None) -> dict:
    router = router or OSRMRouter()
    weather = weather or OpenMeteoWeather()
    options = router.routes(origin, dest, 3)
    results, summaries = [], []
    for opt in options:
        cps = sample_checkpoints(opt.coords, interval_mi, departure, opt.duration_s)
        wx = weather.hourly([(c.lon, c.lat) for c in cps])
        cp_out, segs = [], []
        for c, w in zip(cps, wx):
            v = value_at(w, c.eta)
            a = assess(Weather(v.get("wind_speed_10m") or 0, v.get("rain") or 0,
                               v.get("snowfall") or 0), load_lb)
            segs.append(SegmentRisk(c.segment_miles, a.risk))
            cp_out.append({"index": c.index, "lon": c.lon, "lat": c.lat, "mile": round(c.mile, 1),
                           "eta": c.eta.isoformat(), "forecast_time": v["time"],
                           "wind_mph": v.get("wind_speed_10m"), "rain_in_hr": v.get("rain"),
                           "snow_in_hr": v.get("snowfall"), "risk": a.risk.label,
                           "risk_level": int(a.risk), "load_escalated": a.load_escalated})
        s = summarize(opt.id, opt.duration_s, segs)
        summaries.append(s)
        results.append({"id": opt.id, "geometry": opt.coords,
                        "distance_mi": round(opt.distance_m / M_PER_MI, 1),
                        "duration_s": opt.duration_s, "checkpoints": cp_out,
                        "summary": {"miles_by_risk": {r.label: round(m, 1) for r, m in s.miles_by_risk.items()},
                                    "avg_risk": round(s.avg_risk, 3)}})
    order = [s.route_id for s in rank_routes(summaries)]
    results.sort(key=lambda r: order.index(r["id"]))
    return {"recommended": order[0] if order else None, "routes": results}
