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
    """Plain-language why the top route won (for UI + Loom).

    Ranked list is already sorted best→worst; UI labels them Route 1, 2, 3
    in that order (not by internal OSRM ids). Uses the same rounding as rank_key
    so we never claim “lower average risk (0.0 vs 0.0)”.
    """
    if not ranked:
        return "No routes available."
    best = ranked[0]
    b = summaries[best]
    if len(ranked) == 1:
        return (
            f"Only one distinct route found. Average risk {b.avg_risk:.2f}, "
            f"with {b.severe_miles:.0f} severe miles and {b.high_miles:.0f} high-risk miles."
        )
    second = summaries[ranked[1]]
    reasons = []
    if round(b.no_travel_miles, 3) < round(second.no_travel_miles, 3):
        reasons.append(
            f"less No Travel weather ({b.no_travel_miles:.0f} vs "
            f"{second.no_travel_miles:.0f} miles)"
        )
    if round(b.severe_miles, 3) < round(second.severe_miles, 3):
        reasons.append(
            f"fewer Severe miles ({b.severe_miles:.0f} vs {second.severe_miles:.0f})"
        )
    if round(b.high_miles, 3) < round(second.high_miles, 3):
        reasons.append(
            f"fewer High miles ({b.high_miles:.0f} vs {second.high_miles:.0f})"
        )
    if round(b.avg_risk, 2) < round(second.avg_risk, 2):
        reasons.append(
            f"lower average risk ({b.avg_risk:.2f} vs {second.avg_risk:.2f})"
        )
    if not reasons and b.duration_s < second.duration_s:
        reasons.append(
            f"same weather risk, but arrives sooner "
            f"({b.duration_s / 3600:.1f} vs {second.duration_s / 3600:.1f} hours)"
        )
    if not reasons and b.duration_s <= second.duration_s:
        reasons.append("weather looks similar; this one is as fast or faster")
    if not reasons:
        reasons.append("weather looks similar on the ranked criteria")
    return "Route 1 wins over Route 2: " + ", and ".join(reasons) + "."


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
        # Sample all routes first, then ONE batched Open-Meteo call (was N sequential).
        sampled = [
            (
                opt,
                sample_checkpoints(
                    opt.coords, interval_mi, departure, opt.duration_s,
                    cum_time_s=opt.cum_time_s,
                ),
            )
            for opt in options
        ]
        all_pts = [(c.lon, c.lat) for _, cps in sampled for c in cps]
        all_wx = weather.hourly(all_pts) if all_pts else []

        results, summaries = [], []
        cursor = 0
        for opt, cps in sampled:
            wx = all_wx[cursor:cursor + len(cps)]
            cursor += len(cps)
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
        msg = str(e)
        if "timed out" in msg.lower() or "timeout" in msg.lower():
            raise UpstreamError(
                "Weather forecast timed out (Open-Meteo). Wait a few seconds and try again."
            ) from e
        raise UpstreamError(f"Weather/risk pipeline failed: {e}") from e

    ranked = rank_routes(summaries)
    order = [s.route_id for s in ranked]
    by_id = {s.route_id: s for s in summaries}
    results.sort(key=lambda r: order.index(r["id"]))
    why = explain_recommendation(order, by_id)

    # Corridor heatmap across ALL route alternatives (not only the winner),
    # so the forecast ribbon covers the trip corridor the driver is comparing.
    heatmap = {"hours": HEATMAP_HOURS, "times": [], "points": []}
    try:
        heatmap = build_heatmap_for_routes(
            [r["geometry"] for r in results],
            interval_mi=14,
            weather=weather,
        )
    except Exception:
        pass

    return {
        "recommended": order[0] if order else None,
        "why": why,
        "routes": results,
        "heatmap": heatmap,
        "forecast_days": FORECAST_DAYS,
    }


def _dedupe_pts(pts: list[tuple[float, float]], min_deg: float = 0.08) -> list[tuple[float, float]]:
    """Drop samples that sit almost on top of an earlier one (corridor overlap)."""
    out: list[tuple[float, float]] = []
    for lon, lat in pts:
        if any(abs(lon - olon) < min_deg and abs(lat - olat) < min_deg for olon, olat in out):
            continue
        out.append((lon, lat))
    return out


def build_heatmap_for_routes(geometries: list, interval_mi: float = 14, weather=None,
                             hours: int = HEATMAP_HOURS) -> dict:
    """Heatmap samples along every alternative so the corridor covers the comparison set."""
    pts: list[tuple[float, float]] = []
    for coords in geometries:
        if not coords or len(coords) < 2:
            continue
        # Dense centerline + mild side offsets → continuous ribbon, not stop halos
        pts.extend(corridor_offsets(coords, interval_mi=interval_mi, offset_mi=0.0))
        pts.extend(corridor_offsets(coords, interval_mi=interval_mi * 1.5, offset_mi=5.0))
    pts = _dedupe_pts(pts, min_deg=0.04)
    if len(pts) > 100:
        step = max(1, len(pts) // 100)
        pts = pts[::step][:100]
    return build_heatmap_points(pts, weather=weather, hours=hours)


def build_heatmap(coords: list, interval_mi: float = 14, weather=None,
                  hours: int = HEATMAP_HOURS) -> dict:
    """Corridor heatmap for MapLibre (0–48h paint-only scrub).

    Dense enough samples that blobs fuse into a ribbon; frontend stores w0..w{n}
    and updates `heatmap-weight` via setPaintProperty — no refetch on slider.
    """
    if not coords or len(coords) < 2:
        return {"hours": hours, "times": [], "points": []}
    pts = corridor_offsets(coords, interval_mi=interval_mi, offset_mi=0.0)
    pts.extend(corridor_offsets(coords, interval_mi=interval_mi * 1.5, offset_mi=5.0))
    pts = _dedupe_pts(pts, min_deg=0.04)
    if len(pts) > 100:
        step = max(1, len(pts) // 100)
        pts = pts[::step][:100]
    return build_heatmap_points(pts, weather=weather, hours=hours)


def build_heatmap_points(pts: list[tuple[float, float]], weather=None,
                         hours: int = HEATMAP_HOURS) -> dict:
    if not pts:
        return {"hours": hours, "times": [], "points": []}
    weather = weather or OpenMeteoWeather()
    try:
        wx = weather.hourly(pts, forecast_days=FORECAST_DAYS)
    except Exception as e:
        raise UpstreamError(f"Heatmap weather failed: {e}") from e

    times: list[str] = []
    points = []
    for (lon, lat), payload in zip(pts, wx):
        t, weights = series_weights(payload, hours=hours)
        if not times:
            times = t
        points.append({
            "lon": lon,
            "lat": lat,
            "weights": [round(w, 4) for w in weights],
        })
    return {"hours": hours, "times": times, "points": points}
