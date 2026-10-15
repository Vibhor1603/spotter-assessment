"""Thin HTTP clients for free, no-key APIs. Swap implementations via settings.

Verified live on 2026-10-11: OSRM public demo (alternatives), Open-Meteo
forecast (multi-location, mph/inch units), Photon geocoding.
NOTE: OSRM public demo is car profile only and rate-limited; fine for a demo,
mention in README/Loom. OpenRouteService has driving-hgv (needs free key).
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from time import sleep
from typing import Protocol, Sequence
import re
import requests
from django.conf import settings
from django.core.cache import cache

from .geo import perpendicular_offsets, dedupe_routes

TIMEOUT = 12          # fail fast on public demos
VIA_TIMEOUT = 8
# Open-Meteo multi-point forecasts are heavier; allow longer read + retries.
WEATHER_TIMEOUT = (5, 28)  # (connect, read) seconds
WEATHER_RETRIES = 3
WEATHER_CACHE_TTL = 1800  # 30 min
GEO_CACHE_TTL = 3600
FORECAST_DAYS = 3  # trip planning window (Open-Meteo max 16)
HEATMAP_HOURS = 48

_session = requests.Session()


def _get(url, params, timeout: float | tuple[float, float] = TIMEOUT, retries: int = 1):
    """GET JSON with optional retries on timeout / connection errors."""
    last: Exception | None = None
    attempts = max(1, retries)
    for attempt in range(attempts):
        try:
            r = _session.get(
                url, params=params, timeout=timeout,
                headers={"User-Agent": settings.HTTP_USER_AGENT},
            )
            r.raise_for_status()
            return r.json()
        except (requests.Timeout, requests.ConnectionError) as e:
            last = e
            if attempt + 1 >= attempts:
                break
            sleep(0.4 * (2 ** attempt))  # 0.4s, 0.8s, …
    assert last is not None
    raise last


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
    """OSRM with alternatives + parallel via-waypoint fallback for 3 routes."""

    def _fetch(
        self,
        waypoints: Sequence[Place],
        alternatives: int = 3,
        *,
        annotate: bool = True,
        timeout: float = TIMEOUT,
    ) -> list[RouteOption]:
        coords = ";".join(f"{p.lon},{p.lat}" for p in waypoints)
        url = f"{settings.OSRM_BASE_URL}/route/v1/driving/{coords}"
        params = {
            "alternatives": alternatives if len(waypoints) == 2 else "false",
            "overview": "full",
            "geometries": "geojson",
        }
        if annotate:
            params["annotations"] = "duration"
        data = _get(url, params, timeout=timeout)
        if data.get("code") != "Ok":
            raise RuntimeError(f"OSRM error: {data.get('code')}")
        out = []
        for i, r in enumerate(data["routes"]):
            legs = r.get("legs") or []
            cum = None
            if annotate and legs and "annotation" in legs[0] and legs[0]["annotation"].get("duration"):
                parts: list[float] = []
                for leg in legs:
                    parts.extend(leg["annotation"]["duration"])
                cum = _cum_from_annotation(parts)
                n_verts = len(r["geometry"]["coordinates"])
                if len(cum) != n_verts:
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
            pass

        # Parallel via-detours when OSRM returns <n alternatives (was sequential & slow).
        if len(dedupe_routes(collected)) < n:
            jobs: list[Place] = []
            for frac in (0.12, 0.28):
                for via_lon, via_lat in perpendicular_offsets(
                    (a.lon, a.lat), (b.lon, b.lat), fraction=frac
                ):
                    jobs.append(Place("via", via_lon, via_lat))

            def _via(via: Place) -> list[RouteOption]:
                return self._fetch(
                    [a, via, b], alternatives=1, annotate=False, timeout=VIA_TIMEOUT,
                )

            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(_via, via) for via in jobs]
                for fut in as_completed(futures):
                    try:
                        collected.extend(fut.result())
                    except Exception:
                        continue
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
    # Drop unused gusts — smaller payloads, faster multi-point calls
    HOURLY = "wind_speed_10m,precipitation,rain,snowfall"
    CHUNK = 40  # smaller batches = fewer Open-Meteo timeouts

    def _cache_key(self, lon: float, lat: float, forecast_days: int) -> str:
        return f"wx:{lat:.3f}:{lon:.3f}:d{forecast_days}"

    def _fetch_chunk(self, points: Sequence[tuple[float, float]], forecast_days: int) -> list[dict]:
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
            data = _get(
                f"{settings.OPEN_METEO_BASE_URL}/v1/forecast",
                {
                    "latitude": lats, "longitude": lons, "hourly": self.HOURLY,
                    "wind_speed_unit": "mph", "precipitation_unit": "inch",
                    "timezone": "UTC", "forecast_days": forecast_days,
                },
                timeout=WEATHER_TIMEOUT,
                retries=WEATHER_RETRIES,
            )
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
        # Parallel chunk fetches when a long corridor needs >1 Open-Meteo call
        chunks = [points[i:i + self.CHUNK] for i in range(0, len(points), self.CHUNK)]
        if len(chunks) == 1:
            return self._fetch_chunk(chunks[0], forecast_days)
        out: list[dict | None] = [None] * len(chunks)
        # Cap concurrency — Open-Meteo free tier stalls under 4 parallel multi-point calls.
        with ThreadPoolExecutor(max_workers=min(2, len(chunks))) as pool:
            futs = {
                pool.submit(self._fetch_chunk, chunk, forecast_days): i
                for i, chunk in enumerate(chunks)
            }
            for fut in as_completed(futs):
                out[futs[fut]] = fut.result()
        flat: list[dict] = []
        for part in out:
            flat.extend(part or [])
        return flat


def value_at(hourly_payload: dict, when: datetime) -> dict:
    """Pick the forecast hour nearest to `when` (UTC)."""
    h = hourly_payload["hourly"]
    target = when.astimezone(timezone.utc).replace(tzinfo=None) if when.tzinfo else when
    times = [datetime.fromisoformat(t) for t in h["time"]]
    i = min(range(len(times)), key=lambda k: abs((times[k] - target).total_seconds()))
    return {k: h[k][i] for k in h if k != "time"} | {"time": h["time"][i]}


# Risk 0..4 → heatmap weight. Low stays a faint ribbon; High+ jumps hard so
# yellow/orange/red read clearly when weather worsens along the corridor.
_HEAT_WEIGHT_BY_RISK = (0.14, 0.40, 0.72, 0.90, 1.0)


def series_weights(hourly_payload: dict, hours: int = HEATMAP_HOURS) -> tuple[list[str], list[float]]:
    """Return (times[:hours], risk-weight 0..1) for heatmap paint properties.

    Times are UTC ISO strings with a Z suffix so the frontend does not
    mis-parse them as local wall-clock. Weight floor stays >0 so the
    corridor heatmap remains visible even in calm weather; High+ punches
    so scrubbing and hotspots show real color change.
    """
    from .risk import classify_wind, classify_rain, classify_snow
    h = hourly_payload["hourly"]
    raw_times = h["time"][:hours]
    times = []
    naive_utc = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$")
    for t in raw_times:
        # Open-Meteo UTC times look like "2026-10-13T12:00" (no offset).
        # Append Z so JS Date parses them as UTC, not local wall-clock.
        if isinstance(t, str) and naive_utc.match(t):
            times.append(t + "Z")
        else:
            times.append(t)
    weights = []
    for i in range(len(times)):
        wind = h["wind_speed_10m"][i] or 0
        rain = h["rain"][i] or 0
        snow = h["snowfall"][i] or 0
        level = int(max(classify_wind(wind), classify_rain(rain), classify_snow(snow)))
        weights.append(_HEAT_WEIGHT_BY_RISK[min(level, 4)])
    return times, weights
