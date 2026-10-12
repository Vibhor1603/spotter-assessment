"""Thin HTTP clients for free, no-key APIs. Swap implementations via settings.

Verified live on 2026-10-11: OSRM public demo (alternatives), Open-Meteo
forecast (multi-location, mph/inch units), Photon geocoding.
NOTE: OSRM public demo is car profile only and rate-limited; fine for a demo,
mention in README/Loom. OpenRouteService has driving-hgv (needs free key).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol, Sequence
import requests
from django.conf import settings
from django.core.cache import cache

from .geo import perpendicular_offsets, dedupe_routes

TIMEOUT = 20
WEATHER_CACHE_TTL = 1800  # 30 min
GEO_CACHE_TTL = 3600
FORECAST_DAYS = 3  # trip planning window (Open-Meteo max 16)
HEATMAP_HOURS = 48


def _get(url, params):
    r = requests.get(url, params=params, timeout=TIMEOUT,
                     headers={"User-Agent": settings.HTTP_USER_AGENT})
    r.raise_for_status()
    return r.json()


@dataclass
class Place:
    name: str
    lon: float
    lat: float


@dataclass
class RouteOption:
    id: str
    coords: list  # [[lon, lat], ...]
    distance_m: float
    duration_s: float
    cum_time_s: list[float] | None = None  # cumulative seconds at each vertex


class Geocoder(Protocol):
    def search(self, q: str, limit: int = 5) -> list[Place]: ...


class Router(Protocol):
    def routes(self, a: Place, b: Place, n: int = 3) -> list[RouteOption]: ...


class WeatherProvider(Protocol):
    def hourly(self, points: Sequence[tuple[float, float]], forecast_days: int = FORECAST_DAYS) -> list[dict]: ...


class PhotonGeocoder:
    def search(self, q, limit=5):
        key = f"geo:{q.lower()}:{limit}"
        if (hit := cache.get(key)) is not None:
            return hit
        data = _get(f"{settings.PHOTON_BASE_URL}/api/", {"q": q, "limit": limit})
        out = []
        for f in data.get("features", []):
            p = f["properties"]
            label = ", ".join(x for x in [p.get("name"), p.get("state"), p.get("country")] if x)
            lon, lat = f["geometry"]["coordinates"]
            out.append(Place(label, lon, lat))
        cache.set(key, out, GEO_CACHE_TTL)
        return out


def _cum_from_annotation(duration_list: list[float]) -> list[float]:
    """OSRM annotation duration is per-leg between vertices; build cumulative."""
    cum = [0.0]
    for d in duration_list:
        cum.append(cum[-1] + (d or 0.0))
    return cum


class OSRMRouter:
    """OSRM with alternatives + via-waypoint fallback to aim for 3 distinct routes."""

    def _fetch(self, waypoints: Sequence[Place], alternatives: int = 3) -> list[RouteOption]:
        coords = ";".join(f"{p.lon},{p.lat}" for p in waypoints)
        url = f"{settings.OSRM_BASE_URL}/route/v1/driving/{coords}"
        data = _get(url, {
            "alternatives": alternatives if len(waypoints) == 2 else "false",
            "overview": "full",
            "geometries": "geojson",
            "annotations": "duration",
        })
        if data.get("code") != "Ok":
            raise RuntimeError(f"OSRM error: {data.get('code')}")
        out = []
        for i, r in enumerate(data["routes"]):
            legs = r.get("legs") or []
            cum = None
            # Prefer per-leg annotation durations when present
            if legs and "annotation" in legs[0] and legs[0]["annotation"].get("duration"):
                parts: list[float] = []
                for leg in legs:
                    parts.extend(leg["annotation"]["duration"])
                cum = _cum_from_annotation(parts)
                # Ensure length matches geometry vertices
                n_verts = len(r["geometry"]["coordinates"])
                if len(cum) != n_verts:
                    # Fall back to uniform if mismatch (via routes with multi-leg)
                    cum = None
            out.append(RouteOption(
                id=f"tmp{i}",
                coords=r["geometry"]["coordinates"],
                distance_m=r["distance"],
                duration_s=r["duration"],
                cum_time_s=cum,
            ))
        return out

    def routes(self, a, b, n=3):
        collected: list[RouteOption] = []
        try:
            collected.extend(self._fetch([a, b], alternatives=max(n, 3)))
        except Exception:
            # Re-raise empty later if nothing works
            pass

        # Force alternate geometries when OSRM returns <n distinct alternatives.
        # Try several offset fractions — short corridors often need a wider detour.
        if len(dedupe_routes(collected)) < n:
            for frac in (0.08, 0.14, 0.22, 0.32):
                for via_lon, via_lat in perpendicular_offsets(
                    (a.lon, a.lat), (b.lon, b.lat), fraction=frac
                ):
                    via = Place("via", via_lon, via_lat)
                    try:
                        collected.extend(self._fetch([a, via, b], alternatives=1))
                    except Exception:
                        continue
                    if len(dedupe_routes(collected)) >= n:
                        break
                if len(dedupe_routes(collected)) >= n:
                    break

        unique = dedupe_routes(collected)[:n]
        if not unique:
            raise RuntimeError("No routes found between origin and destination")
        for i, opt in enumerate(unique):
            opt.id = f"r{i}"
        return unique


class OpenMeteoWeather:
    """Hourly forecast in imperial units directly (wind mph, precip inch).
    Open-Meteo `snowfall` with precipitation_unit=inch is inches of snow
    (metric default is cm; see risk.cm_to_in if you switch units)."""
    HOURLY = "wind_speed_10m,wind_gusts_10m,precipitation,rain,snowfall"
    CHUNK = 80  # keep URL size sane

    def _cache_key(self, lon: float, lat: float, forecast_days: int) -> str:
        return f"wx:{lat:.3f}:{lon:.3f}:d{forecast_days}"

    def _fetch_chunk(self, points: Sequence[tuple[float, float]], forecast_days: int) -> list[dict]:
        # Serve from cache when every point is warm
        cached = []
        missing_idx = []
        for i, (lon, lat) in enumerate(points):
            hit = cache.get(self._cache_key(lon, lat, forecast_days))
            if hit is not None:
                cached.append((i, hit))
            else:
                missing_idx.append(i)

        results: list[dict | None] = [None] * len(points)
        for i, hit in cached:
            results[i] = hit

        if missing_idx:
            miss_pts = [points[i] for i in missing_idx]
            lats = ",".join(f"{p[1]:.4f}" for p in miss_pts)
            lons = ",".join(f"{p[0]:.4f}" for p in miss_pts)
            data = _get(f"{settings.OPEN_METEO_BASE_URL}/v1/forecast", {
                "latitude": lats, "longitude": lons, "hourly": self.HOURLY,
                "wind_speed_unit": "mph", "precipitation_unit": "inch",
                "timezone": "UTC", "forecast_days": forecast_days,
            })
            payloads = data if isinstance(data, list) else [data]
            for j, payload in enumerate(payloads):
                idx = missing_idx[j]
                lon, lat = points[idx]
                cache.set(self._cache_key(lon, lat, forecast_days), payload, WEATHER_CACHE_TTL)
                results[idx] = payload

        return results  # type: ignore[return-value]

    def hourly(self, points, forecast_days: int = FORECAST_DAYS):
        if not points:
            return []
        out: list[dict] = []
        for i in range(0, len(points), self.CHUNK):
            out.extend(self._fetch_chunk(points[i:i + self.CHUNK], forecast_days))
        return out


def value_at(hourly_payload: dict, when: datetime) -> dict:
    """Pick the forecast hour nearest to `when` (UTC)."""
    h = hourly_payload["hourly"]
    target = when.astimezone(timezone.utc).replace(tzinfo=None) if when.tzinfo else when
    times = [datetime.fromisoformat(t) for t in h["time"]]
    i = min(range(len(times)), key=lambda k: abs((times[k] - target).total_seconds()))
    return {k: h[k][i] for k in h if k != "time"} | {"time": h["time"][i]}


def series_weights(hourly_payload: dict, hours: int = HEATMAP_HOURS) -> tuple[list[str], list[float]]:
    """Return (times[:hours], risk-weight 0..1) for heatmap paint properties.

    Weight uses wind mph normalised against No-Travel threshold (55), blended
    with rain/snow intensity so the heatmap reacts to all three hazards.
    """
    from .risk import classify_wind, classify_rain, classify_snow, Risk
    h = hourly_payload["hourly"]
    times = h["time"][:hours]
    weights = []
    for i in range(len(times)):
        wind = h["wind_speed_10m"][i] or 0
        rain = h["rain"][i] or 0
        snow = h["snowfall"][i] or 0
        level = max(classify_wind(wind), classify_rain(rain), classify_snow(snow))
        # Map Risk 0..4 -> weight 0.05..1.0 (MapLibre heatmap needs >0 to show)
        weights.append(0.05 + 0.2375 * int(level))
    return times, weights
