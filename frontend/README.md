# Frontend

Vite + React + TypeScript + Tailwind + MapLibre UI for Weather-Aware Truck Routing.

See the repository root [README](../README.md) for setup, API, and deploy notes.

```bash
# from repo root
make setup
make dev   # Vite on :5173, proxies /api → Django :8000
```

Optional: set `VITE_MAPTILER_KEY` and `VITE_API_BASE` in `.env` (see `.env.example`).
