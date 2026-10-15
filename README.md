# Weather-Aware Truck Routing

This is a Spotter AI take-home: a React and Django app that helps a driver compare up to three road options and pick the safest one for their load. Weather is scored where the truck would actually be at each stop, not only at the start of the trip.

## Demo

| | |
|---|---|
| App | https://spotter-assessment-theta.vercel.app |
| API | https://spotter-assessment-api.vercel.app |

A good first trip is Denver, CO to Salt Lake City, UT, with a 35,000 lb load and weather stops every 25 miles.

## How a trip works

You enter origin, destination, departure time, load weight, and how often to sample weather (every 10, 25, or 50 miles). The backend then:

1. Resolves places and asks a routing service for up to three different drives.
2. Places checkpoints along each drive and estimates the arrival time at each one.
3. Fetches hourly weather at those points for those arrival times.
4. Grades every checkpoint, summarizes each route, and ranks the routes.
5. Returns map geometry, a short “why this won” explanation, and a corridor heatmap for the next 48 hours.

```
Form → plan API → routes + checkpoints + weather → risk grades → ranked routes + heatmap → map UI
```

## How risk is calculated

At each checkpoint the app reads wind (mph), rain (inches per hour), and snow (inches per hour). Each of those is mapped to a band from the brief. The checkpoint’s overall grade is the worst of the three, because one severe condition is enough to treat that stretch as unsafe. Load weight can only raise that grade; it never lowers it.

| | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (mph) | under 25 | 25–35 | 35–45 | 45–55 | 55 and up |
| Rain (in/hr) | under 0.10 | 0.10–0.25 | 0.25–0.50 | 0.50–1.00 | over 1.00 |
| Snow (in/hr) | under 0.5 | 0.5–1.0 | 1.0–2.0 | 2.0–3.0 | over 3.0 |

Load rules on top of that grade:

- Wind at 55 mph or more is No Travel for any load.
- Wind from 45 up to 55 mph with more than 30,000 lb is No Travel.
- Wind from 35 up to 45 mph with more than 40,000 lb is at least Severe.

Stop colors on the map use the overall grade. The stop popup still shows wind, rain, and snow separately so you can see which dial drove the result.

## How routes are ranked

Each checkpoint owns a share of the route’s miles. Those miles are totaled into buckets (No Travel, Severe, High, and so on). The app also stores a mileage-weighted average risk and the total drive time.

Routes are sorted best to worst by this order. The first difference decides the winner:

1. Fewest No Travel miles
2. Fewest Severe miles
3. Fewest High miles
4. Lower average risk
5. Shorter drive time

No Travel is ranked before Severe on purpose. The brief’s written order starts at Severe, but No Travel is a harder “do not go” signal, so it is treated as the primary key. Average risk is rounded so tiny float noise cannot beat a real time difference. The UI “why” line explains the first criterion that separated Route 1 from Route 2.

## Map and heatmap

The map shows up to three routes, risk-colored stops, start and end markers, and summaries. Selecting a route card highlights that path without calling the API again.

The heatmap is a separate view of weather along the corridor over the next 48 forecast hours. Moving the slider only changes how the map paints data that was already downloaded. It does not refetch weather.

Stops and ranking use weather at the truck’s arrival time. The heatmap slider uses wall-clock forecast hours along the corridor. Those are two different clocks on purpose.

## Outside services

| Service | Role |
|---|---|
| Photon | Turns place names into coordinates for autocomplete |
| OSRM | Returns driving paths, distances, and travel times |
| Open-Meteo | Supplies hourly wind, rain, and snow |
| MapTiler (optional) | Basemap tiles; a keyless dark style is used if no key is set |

Weather and geocode responses are cached in the API process. Checkpoint weather for a plan is batched into a small number of Open-Meteo calls instead of one call per pin. If OSRM returns fewer than three distinct paths, the API requests extra routes through side waypoints and drops near-duplicates.

The public OSRM demo uses a car profile, not truck restrictions, and may rate-limit under heavy use.

## Stack

The UI is React, Vite, TypeScript, Tailwind, and MapLibre. The API is Django and Django REST Framework.

The graded scoring and geometry helpers live in `backend/routing/risk.py` and `backend/routing/geo.py`. Those modules do no network I/O and are covered by unit tests (`make test`).

## Setup

```bash
make setup   # Python venv, dependencies, frontend install, env examples
make dev     # API on http://localhost:8000 and UI on http://localhost:5173
make test    # backend unit tests
```

Optional: set `VITE_MAPTILER_KEY` in `frontend/.env` for MapTiler tiles. Point the UI at a remote API with `VITE_API_BASE` when needed.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health/` | Liveness check for deploys |
| GET | `/api/geocode/?q=` | Place search for the form |
| POST | `/api/plan/` | Full plan: routes, ranks, why text, heatmap |

`POST /api/plan/` expects origin and destination coordinates, an ISO departure time, load in pounds, and `interval_mi` of 10, 25, or 50. Validation and forecast-window problems return 400. Failures from OSRM, Photon, or Open-Meteo return 502.

## Limits and choices

Band edges follow the brief, with lower-inclusive boundaries where the ranges meet. Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr stay Severe; values above those become No Travel.

Weather uses the nearest forecast hour rather than interpolating between hours. The default planning window is three forecast days; trips that leave or arrive outside that window are rejected with a clear error.

The product prefers a correct, explainable ranking over extra features. Free keyless APIs keep the demo runnable without paid keys, at the cost of car-only routing and public rate limits.

## Deploy

This submission runs on Vercel: the UI project `spotter-assessment` (root `frontend/`) and the API project `spotter-assessment-api` (root `backend/`). The UI needs `VITE_API_BASE` pointing at the API. `backend/render.yaml` remains if you prefer Render for the API.

## Layout

```
backend/routing/   API handlers, upstream clients, plan orchestration, risk.py, geo.py, tests
frontend/src/      Form, map, timeline, mobile sheet
Makefile           setup, dev, test
```
