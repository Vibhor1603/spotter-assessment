# Weather-Aware Truck Routing

Spotter AI take-home: a React + Django app that helps a truck driver pick the **safest of up to three routes** using forecast weather at the truck’s ETA, load weight, and travel time.

## Demo

| | |
|---|---|
| **App** | _Vercel URL after deploy_ |
| **API** | _Render URL after deploy_ |
| **Loom** | _walkthrough link_ |

Try locally: **Denver, CO → Salt Lake City, UT**, load **35,000 lb**, weather every **25 mi**.

## What it does

Matches the assessment brief:

1. Enter origin, destination, departure time, and load weight.
2. Build up to **3 route options** (OSRM + fallbacks if needed).
3. Sample weather every **10 / 25 / 50 miles** at the truck’s **ETA** for each stop.
4. Score wind / rain / snow with the brief’s risk bands, then apply **load rules**.
5. **Recommend** the best route: fewest No-Travel → Severe → High miles, then lowest average risk, then shortest time.
6. Show routes, checkpoints, risk, ETAs, and summaries on a map.
7. Show a **weather heatmap** along the trip corridor with a **0–48 hour** forecast slider (client-side paint only — no refetch while scrubbing).

## Stack

- **Frontend:** React, Vite, TypeScript, Tailwind, MapLibre
- **Backend:** Django, Django REST Framework
- **APIs:** OSRM (routing), Photon (geocoding), Open-Meteo (weather), MapTiler optional (basemap)

Graded core logic lives in pure modules: `backend/routing/risk.py` and `backend/routing/geo.py` (no I/O, unit-tested).

## Setup

```bash
make setup   # Python venv + deps, npm install, copy .env.example files
make dev     # API http://localhost:8000 · UI http://localhost:5173
make test    # backend tests
```

Optional: free [MapTiler](https://cloud.maptiler.com/account/keys/) key in `frontend/.env` as `VITE_MAPTILER_KEY`. Without it, the UI uses a keyless dark basemap.

## Risk rules

| | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (mph) | &lt;25 | 25–34 | 35–44 | 45–54 | ≥55 |
| Rain (in/hr) | &lt;0.10 | 0.10–0.25 | 0.25–0.50 | 0.50–1.00 | &gt;1.00 |
| Snow (in/hr) | &lt;0.5 | 0.5–1.0 | 1.0–2.0 | 2.0–3.0 | &gt;3.0 |

**Load:** ≥55 mph → No Travel (any load); 45–54 mph and &gt;30,000 lb → No Travel; 35–44 mph and &gt;40,000 lb → Severe.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health/` | Health check |
| `GET` | `/api/geocode/?q=` | Place autocomplete |
| `POST` | `/api/plan/` | Plan routes → ranked results, `why`, heatmap |

**400** = validation / forecast window. **502** = upstream (OSRM / Open-Meteo / Photon).

## How it fits together

```
UI (Vite / MapLibre)
  → POST /api/plan
      → OSRM routes + ETAs
      → Open-Meteo hourly weather (batched, cached)
      → risk.py / geo.py ranking
```

## Deploy

- **API (Render):** `backend/` · `gunicorn config.wsgi --bind 0.0.0.0:$PORT` · see `backend/render.yaml`  
  Set `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`.
- **UI (Vercel):** `frontend/` · set `VITE_API_BASE=https://<api-host>/api` · optional `VITE_MAPTILER_KEY`.

## Assumptions

- Band edges are lower-inclusive (e.g. rain 0.25 → High). Exactly 1.00 in/hr rain and 3.0 in/hr snow stay Severe; above → No Travel.
- **No Travel** miles rank first (brief lists Severe first; No Travel is worse).
- OSRM public demo uses a **car** profile (not truck/HGV) and is rate-limited.
- Weather is nearest forecast hour (not interpolated).
- Default forecast window is **3 days**; trips outside it return 400.

## Layout

```
backend/routing/   # API, clients, services, risk.py, geo.py, tests
frontend/src/      # UI, map, timeline, forms
Makefile           # setup / dev / test
```
