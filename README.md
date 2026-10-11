# Weather-Aware Truck Routing

Plan a truck trip and pick the safest of up to 3 routes based on the forecast weather the truck will meet **at the time it reaches each checkpoint**, adjusted for load weight.

**Stack:** Django + DRF backend · React + Vite + TypeScript + MapLibre frontend · free, key-less APIs (OSRM routing, Photon geocoding, Open-Meteo hourly forecast).

## Quick start
```bash
make setup   # venv + pip, npm install, copy .env.example files
make dev     # Django on :8000, Vite on :5173
make test    # backend unit tests
```

## How it works
1. Geocode origin/destination (Photon).
2. Fetch route alternatives (OSRM, `alternatives=3`, GeoJSON geometry).
3. Sample checkpoints every 10/25/50 miles along each polyline; ETA = departure + interpolated travel time.
4. Fetch hourly forecast for all checkpoints in one Open-Meteo call (mph, inch units); pick the hour nearest each ETA.
5. Classify wind / rain / snow risk, take the max, apply load rules.
6. Rank routes: fewest No-Travel miles → fewest Severe miles → fewest High miles → lowest mileage-weighted avg risk → shortest time.

Core logic is pure and unit-tested: `backend/routing/risk.py`, `backend/routing/geo.py`.

### Risk rules
| | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (mph) | <25 | 25–34 | 35–44 | 45–54 | ≥55 |
| Rain (in/hr) | <0.10 | 0.10–<0.25 | 0.25–<0.50 | 0.50–1.00 | >1.00 |
| Snow (in/hr) | <0.5 | 0.5–<1.0 | 1.0–<2.0 | 2.0–3.0 | >3.0 |

Load: wind ≥55 → No Travel (any load); 45–54 mph & >30,000 lb → No Travel; 35–44 mph & >40,000 lb → Severe.

### Assumptions
- Band edges are lower-inclusive (e.g. 0.25 in/hr rain = High).
- Each checkpoint represents half the distance to each neighbour when totalling risk miles.
- Routes with any No-Travel miles rank below all others.
- OSRM public demo uses a car profile and may return fewer than 3 alternatives.

## API
- `GET /api/health/`
- `GET /api/geocode/?q=Denver`
- `POST /api/plan/` `{origin:{lon,lat,name}, destination:{...}, departure: ISO, load_lb, interval_mi: 10|25|50}`
