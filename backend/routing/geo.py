"""Checkpoint sampling along a polyline with ETA interpolation (pure)."""
from __future__ import annotations
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Sequence

EARTH_RADIUS_MI = 3958.7613
ALLOWED_INTERVALS = (10, 25, 50)


def haversine_mi(a: tuple[float, float], b: tuple[float, float]) -> float:
    """a, b are (lon, lat) like GeoJSON."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(h))


@dataclass(frozen=True)
class Checkpoint:
    index: int
    lon: float
    lat: float
    mile: float
    eta: datetime
    segment_miles: float  # miles this checkpoint "represents" (for severe-mile totals)


def sample_checkpoints(coords: Sequence[Sequence[float]], interval_mi: float,
                       departure: datetime, duration_s: float,
                       cum_time_s: Sequence[float] | None = None) -> list[Checkpoint]:
    """Place a checkpoint at start, every `interval_mi`, and at the destination.

    ETA: if `cum_time_s` (cumulative seconds at each vertex, e.g. from OSRM
    annotations) is given, interpolate it; else assume uniform speed over the
    route (total duration * fraction of distance).
    Each checkpoint represents half the gap to each neighbour (segment_miles),
    so sum(segment_miles) == total route miles.
    """
    if len(coords) < 2:
        raise ValueError("polyline needs >= 2 points")
    if interval_mi <= 0:
        raise ValueError("interval must be positive")
    cum = [0.0]
    for i in range(1, len(coords)):
        cum.append(cum[-1] + haversine_mi(coords[i - 1], coords[i]))
    total = cum[-1]
    targets = [0.0]
    m = interval_mi
    while m < total - 1e-9:
        targets.append(m)
        m += interval_mi
    if total > 0:
        targets.append(total)

    pts = []
    j = 0
    for t in targets:
        while j < len(cum) - 2 and cum[j + 1] < t:
            j += 1
        seg = cum[j + 1] - cum[j]
        f = 0.0 if seg == 0 else (t - cum[j]) / seg
        f = min(max(f, 0.0), 1.0)
        lon = coords[j][0] + f * (coords[j + 1][0] - coords[j][0])
        lat = coords[j][1] + f * (coords[j + 1][1] - coords[j][1])
        if cum_time_s is not None:
            secs = cum_time_s[j] + f * (cum_time_s[j + 1] - cum_time_s[j])
        else:
            secs = duration_s * (t / total) if total else 0.0
        pts.append((lon, lat, t, departure + timedelta(seconds=secs)))

    out = []
    for i, (lon, lat, mile, eta) in enumerate(pts):
        prev_gap = mile - pts[i - 1][2] if i > 0 else 0.0
        next_gap = pts[i + 1][2] - mile if i < len(pts) - 1 else 0.0
        out.append(Checkpoint(i, lon, lat, mile, eta, (prev_gap + next_gap) / 2))
    return out
