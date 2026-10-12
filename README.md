# Weather-Aware Truck Routing

Plan a truck trip and pick the safest of up to **3 routes** based on the forecast weather the truck will meet **at the time it reaches each checkpoint**, adjusted for load weight.

Built as a Spotter AI take-home (React + Django). Scoring emphasis: risk logic (40%) and map/heatmap smoothness (35%).

**Stack:** Django + DRF · React + Vite + TypeScript + MapLibre · free, key-less APIs (OSRM, Photon, Open-Meteo).

## Quick start

```bash
make setup   # venv + pip, npm install, copy .env.example files
make dev     # Django :8000 · Vite :5173
make test    # backend unit + API tests
```

Open http://localhost:5173 — try **Denver, CO → Salt Lake City, UT**, load **35,000–42,000 lb**, interval **25 mi**.

## How it works

1. Geocode origin/destination (Photon autocomplete).
2. Fetch route alternatives (OSRM `alternatives` + `annotations=duration`). If fewer than 3 distinct geometries, add via-waypoint detours (perpendicular offset near midpoint) and dedupe.
3. Sample checkpoints every 10/25/50 miles; ETA from cumulative OSRM leg durations (falls back to uniform speed).
4. Batch hourly forecast for all checkpoints (Open-Meteo, mph + inch); pick the hour nearest each ETA.
5. Classify wind / rain / snow risk, take the max, apply load rules.
6. Rank: fewest No-Travel miles → Severe → High → lowest mileage-weighted avg risk → shortest time.
7. Build a corridor heatmap (route + lateral offsets) with **48 hourly weights** in one response; the UI slider updates MapLibre `heatmap-weight` via `setPaintProperty` — **no refetch**.

Core logic is pure and unit-tested: `backend/routing/risk.py`, `backend/routing/geo.py`.

### Risk rules

| | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (mph) | <25 | 25–34 | 35–44 | 45–54 | ≥55 |
| Rain (in/hr) | <0.10 | 0.10–<0.25 | 0.25–<0.50 | 0.50–1.00 | >1.00 |
| Snow (in/hr) | <0.5 | 0.5–<1.0 | 1.0–<2.0 | 2.0–3.0 | >3.0 |

Load: wind ≥55 → No Travel (any load); 45–54 mph & >30,000 lb → No Travel; 35–44 mph & >40,000 lb → Severe.

### Assumptions

- Band edges are lower-inclusive (e.g. 0.25 in/hr rain = High); rain >1.00 and snow >3.0 are No Travel (exact 1.00 / 3.0 stay Severe).
- Each checkpoint represents half the distance to each neighbour when totalling risk miles.
- Routes with any No-Travel miles rank below all others (brief omits No Travel in the tie-break list; we put it first).
- OSRM public demo uses a **car** profile (not HGV) and is rate-limited.
- Weather is nearest-hour lookup, not interpolated between hours.
- Forecast window defaults to **3 days** (Open-Meteo supports up to 16); departures/ETAs outside the window return **400**.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health/` | Liveness |
| `GET` | `/api/geocode/?q=` | Photon places |
| `POST` | `/api/plan/` | Body: `{origin, destination, departure, load_lb, interval_mi}` → ranked routes, `why`, corridor `heatmap` |

Errors: **400** validation / forecast window; **502** upstream (OSRM / Open-Meteo / Photon).

## Architecture (short)

```
Browser (Vite/React/MapLibre)
  └─ POST /api/plan  →  Django/DRF
        ├─ OSRM (routes + duration annotations)
        ├─ Open-Meteo (batched hourly, cached ~30m)
        └─ risk.py / geo.py (pure)
```

## Deploy

- **Backend:** Render Web Service, root `backend`, start `gunicorn config.wsgi --bind 0.0.0.0:$PORT`. See `backend/render.yaml` and `_vibhor/DEPLOY.md` (private notes).
- **Frontend:** Vercel, root `frontend`, env `VITE_API_BASE=https://<api-host>/api`. See `frontend/vercel.json`.
- Set `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`.

## Loom talking points

Risk bands + load escalation → ETA-matched forecasts → ranking order → heatmap slider is paint-only → OSRM car-profile caveat & via-waypoint fallback for 3 options.
