"""Orchestration: geocode -> routes -> checkpoints -> weather -> risk -> ranking."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from .clients import (
    OSRMRouter, OpenMeteoWeather, Place, value_at, series_weights,
    FORECAST_DAYS, HEATMAP_HOURS,
)
from .geo import sample_checkpoints, corridor_offsets, haversine_mi
from .risk import Weather, assess, summarize, rank_routes, SegmentRisk, Risk

M_PER_MI = 1609.344


class PlanError(Exception):
    """Client-facing validation error (maps to 4xx)."""
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class UpstreamError(Exception):
    """External API failure (maps to 502)."""
    def __init__(self, message: str):
        super().__init__(message)


def validate_departure(departure: datetime, now: datetime | None = None,
                       forecast_days: int = FORECAST_DAYS) -> datetime:
    """Ensure departure is timezone-aware UTC and within the forecast window."""
    now = now or datetime.now(timezone.utc)
    if departure.tzinfo is None:
        departure = departure.replace(tzinfo=timezone.utc)
    else:
        departure = departure.astimezone(timezone.utc)
    # Allow 1h past (clock skew / "leaving now")
    if departure < now - timedelta(hours=1):
        raise PlanError(
            f"Departure {departure.isoformat()} is in the past. "
            "Choose a time from now onward."
        )
    horizon = now + timedelta(days=forecast_days)
    if departure > horizon:
        raise PlanError(
            f"Departure {departure.isoformat()} is beyond the {forecast_days}-day "
            f"forecast window (ends ~{horizon.isoformat()}). "
            "Open-Meteo supports up to 16 days; shorten departure or raise forecast_days."
        )
    return departure


def explain_recommendation(ranked: list, summaries: dict) -> str:
    """Human-readable why the top route won (for UI + Loom)."""
    if not ranked:
        return "No routes available."
    best = ranked[0]
    b = summaries[best]
    if len(ranked) == 1:
        return (
            f"Only one distinct route found. Avg risk {b.avg_risk:.2f}, "
            f"{b.severe_miles:.0f} Severe mi, {b.high_miles:.0f} High mi."
        )
    second = summaries[ranked[1]]
    reasons = []
    if round(b.no_travel_miles, 3) < round(second.no_travel_miles, 3):
        reasons.append(
            f"fewer No-Travel miles ({b.no_travel_miles:.1f} vs {second.no_travel_miles:.1f})"
        )
    if round(b.severe_miles, 3) < round(second.severe_miles, 3):
        reasons.append(
            f"fewer Severe miles ({b.severe_miles:.1f} vs {second.severe_miles:.1f})"
        )
    if round(b.high_miles, 3) < round(second.high_miles, 3):
        reasons.append(
            f"fewer High miles ({b.high_miles:.1f} vs {second.high_miles:.1f})"
        )
    if round(b.avg_risk, 6) < round(second.avg_risk, 6):
        reasons.append(f"lower avg risk ({b.avg_risk:.2f} vs {second.avg_risk:.2f})")
    if b.duration_s < second.duration_s and not reasons:
        reasons.append(
            f"shorter time ({b.duration_s / 3600:.1f}h vs {second.duration_s / 3600:.1f}h) "
            "with equal weather risk"
        )
    if not reasons:
        reasons.append("tied on weather metrics; fastest duration wins")
    return f"Recommended {best} over {ranked[1]}: " + "; ".join(reasons) + "."


def plan(origin: Place, dest: Place, departure: datetime, load_lb: float, interval_mi: int,
         router=None, weather=None, now: datetime | None = None) -> dict:
    departure = validate_departure(departure, now=now)
    router = router or OSRMRouter()
    weather = weather or OpenMeteoWeather()
    try:
        options = router.routes(origin, dest, 3)
    except Exception as e:
        raise UpstreamError(f"Routing failed: {e}") from e

    # Reject if any ETA would fall past forecast horizon
    now = now or datetime.now(timezone.utc)
    horizon = now + timedelta(days=FORECAST_DAYS)
    max_eta = departure + timedelta(seconds=max(o.duration_s for o in options))
    if max_eta > horizon:
        raise PlanError(
            f"Trip ETA ~{max_eta.isoformat()} exceeds the {FORECAST_DAYS}-day forecast "
            f"window ending ~{horizon.isoformat()}. Depart sooner or shorten the trip.",
            status=400,
        )

    try:
        results, summaries = [], []
        for opt in options:
            cps = sample_checkpoints(
                opt.coords, interval_mi, departure, opt.duration_s,
                cum_time_s=opt.cum_time_s,
            )
            wx = weather.hourly([(c.lon, c.lat) for c in cps])
            cp_out, segs = [], []
            for c, w in zip(cps, wx):
                v = value_at(w, c.eta)
                a = assess(Weather(v.get("wind_speed_10m") or 0, v.get("rain") or 0,
                                   v.get("snowfall") or 0), load_lb)
                segs.append(SegmentRisk(c.segment_miles, a.risk))
                cp_out.append({
                    "index": c.index, "lon": c.lon, "lat": c.lat, "mile": round(c.mile, 1),
                    "eta": c.eta.isoformat(), "forecast_time": v["time"],
                    "wind_mph": v.get("wind_speed_10m"), "rain_in_hr": v.get("rain"),
                    "snow_in_hr": v.get("snowfall"), "risk": a.risk.label,
                    "risk_level": int(a.risk), "load_escalated": a.load_escalated,
                    "wind_risk": a.wind.label, "rain_risk": a.rain.label, "snow_risk": a.snow.label,
                })
            s = summarize(opt.id, opt.duration_s, segs)
            summaries.append(s)
            results.append({
                "id": opt.id, "geometry": opt.coords,
                "distance_mi": round(opt.distance_m / M_PER_MI, 1),
                "duration_s": opt.duration_s, "checkpoints": cp_out,
                "summary": {
                    "miles_by_risk": {r.label: round(m, 1) for r, m in s.miles_by_risk.items()},
                    "avg_risk": round(s.avg_risk, 3),
                    "severe_miles": round(s.severe_miles, 1),
                    "high_miles": round(s.high_miles, 1),
                    "no_travel_miles": round(s.no_travel_miles, 1),
                },
            })
    except PlanError:
        raise
    except Exception as e:
        raise UpstreamError(f"Weather/risk pipeline failed: {e}") from e

    ranked = rank_routes(summaries)
    order = [s.route_id for s in ranked]
    by_id = {s.route_id: s for s in summaries}
    results.sort(key=lambda r: order.index(r["id"]))
    why = explain_recommendation(order, by_id)

    # Corridor heatmap for the recommended route (single fetch; 48h client-side switch)
    heatmap = build_heatmap(
        next(r for r in results if r["id"] == order[0])["geometry"] if order else [],
        interval_mi=max(interval_mi, 25),
        weather=weather,
    )

    return {
        "recommended": order[0] if order else None,
        "why": why,
        "routes": results,
        "heatmap": heatmap,
        "forecast_days": FORECAST_DAYS,
    }


def build_heatmap(coords: list, interval_mi: float = 25, weather=None,
                  hours: int = HEATMAP_HOURS) -> dict:
    """Grid of corridor points each carrying 48 hourly weights for MapLibre.

    Frontend stores w0..w{hours-1} as feature properties and updates
    `heatmap-weight` via setPaintProperty — no refetch on slider move.
    """
    if not coords or len(coords) < 2:
        return {"hours": hours, "times": [], "points": []}
    weather = weather or OpenMeteoWeather()
    # Cap points so Open-Meteo URL stays sane (~100)
    pts = corridor_offsets(coords, interval_mi=interval_mi, offset_mi=8.0)
    if len(pts) > 90:
        step = max(1, len(pts) // 90)
        pts = pts[::step][:90]
    try:
        wx = weather.hourly(pts, forecast_days=max(3, (hours + 23) // 24))
    except Exception as e:
        raise UpstreamError(f"Heatmap weather failed: {e}") from e

    times: list[str] = []
    points = []
    for (lon, lat), payload in zip(pts, wx):
        t, weights = series_weights(payload, hours=hours)
        if not times:
            times = t
        props = {f"w{i}": round(w, 4) for i, w in enumerate(weights)}
        # Also expose current hour-0 risk level for legend sampling
        props["lon"] = lon
        props["lat"] = lat
        points.append({"lon": lon, "lat": lat, "weights": [round(w, 4) for w in weights]})
    return {"hours": hours, "times": times, "points": points}
