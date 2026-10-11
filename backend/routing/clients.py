"""Thin HTTP clients for free, no-key APIs. Swap implementations via settings.

Verified live on 2026-10-11: OSRM public demo (alternatives), Open-Meteo
forecast (multi-location, mph/inch units), Photon geocoding.
NOTE: OSRM public demo is car profile only and rate-limited; fine for a demo,
mention in README/Loom. OpenRouteService has driving-hgv (needs free key).
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol, Sequence
import requests
from django.conf import settings
from django.core.cache import cache

TIMEOUT = 15


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


class Geocoder(Protocol):
    def search(self, q: str, limit: int = 5) -> list[Place]: ...


class Router(Protocol):
    def routes(self, a: Place, b: Place, n: int = 3) -> list[RouteOption]: ...


class WeatherProvider(Protocol):
    def hourly(self, points: Sequence[tuple[float, float]]) -> list[dict]: ...


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
        cache.set(key, out, 3600)
        return out


class OSRMRouter:
    def routes(self, a, b, n=3):
        url = f"{settings.OSRM_BASE_URL}/route/v1/driving/{a.lon},{a.lat};{b.lon},{b.lat}"
        data = _get(url, {"alternatives": n, "overview": "full", "geometries": "geojson"})
        if data.get("code") != "Ok":
            raise RuntimeError(f"OSRM error: {data.get('code')}")
        return [RouteOption(f"r{i}", r["geometry"]["coordinates"], r["distance"], r["duration"])
                for i, r in enumerate(data["routes"][:n])]
        # TODO: OSRM demo often returns <3 alternatives. Fallback idea: route via
        # a perpendicular-offset waypoint at the midpoint to force variants.


class OpenMeteoWeather:
    """Hourly forecast in imperial units directly (wind mph, precip inch).
    Open-Meteo `snowfall` with precipitation_unit=inch is inches of snow
    (metric default is cm; see risk.cm_to_in if you switch units)."""
    HOURLY = "wind_speed_10m,wind_gusts_10m,precipitation,rain,snowfall"

    def hourly(self, points):
        lats = ",".join(f"{p[1]:.4f}" for p in points)
        lons = ",".join(f"{p[0]:.4f}" for p in points)
        data = _get(f"{settings.OPEN_METEO_BASE_URL}/v1/forecast", {
            "latitude": lats, "longitude": lons, "hourly": self.HOURLY,
            "wind_speed_unit": "mph", "precipitation_unit": "inch",
            "timezone": "UTC", "forecast_days": 3,
        })
        return data if isinstance(data, list) else [data]


def value_at(hourly_payload: dict, when: datetime) -> dict:
    """Pick the forecast hour nearest to `when` (UTC)."""
    h = hourly_payload["hourly"]
    target = when.astimezone(timezone.utc).replace(tzinfo=None)
    times = [datetime.fromisoformat(t) for t in h["time"]]
    i = min(range(len(times)), key=lambda k: abs((times[k] - target).total_seconds()))
    return {k: h[k][i] for k in h if k != "time"} | {"time": h["time"][i]}
