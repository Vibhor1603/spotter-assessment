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


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial bearing from a -> b in degrees [0, 360)."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def destination_point(origin: tuple[float, float], bearing: float, miles: float) -> tuple[float, float]:
    """Point `miles` from origin along `bearing` degrees. Returns (lon, lat)."""
    lon1, lat1 = map(math.radians, origin)
    br = math.radians(bearing)
    ang = miles / EARTH_RADIUS_MI
    lat2 = math.asin(math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(br))
    lon2 = lon1 + math.atan2(
        math.sin(br) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    return (math.degrees(lon2), math.degrees(lat2))


def midpoint(coords: Sequence[Sequence[float]]) -> tuple[float, float]:
    """Geometric midpoint by cumulative distance along the polyline."""
    if len(coords) < 2:
        raise ValueError("need >= 2 points")
    cum = [0.0]
    for i in range(1, len(coords)):
        cum.append(cum[-1] + haversine_mi(coords[i - 1], coords[i]))
    half = cum[-1] / 2
    j = 0
    while j < len(cum) - 2 and cum[j + 1] < half:
        j += 1
    seg = cum[j + 1] - cum[j]
    f = 0.0 if seg == 0 else (half - cum[j]) / seg
    lon = coords[j][0] + f * (coords[j + 1][0] - coords[j][0])
    lat = coords[j][1] + f * (coords[j + 1][1] - coords[j][1])
    return (lon, lat)


def perpendicular_offsets(
    a: tuple[float, float],
    b: tuple[float, float],
    fraction: float = 0.08,
) -> list[tuple[float, float]]:
    """Two waypoints offset perpendicular to a→b by ~fraction of |a-b|.

    Used to force alternate OSRM paths when the demo returns <3 alternatives.
    """
    dist = haversine_mi(a, b)
    if dist <= 0:
        return []
    mid = destination_point(a, bearing_deg(a, b), dist / 2)
    br = bearing_deg(a, b)
    offset_mi = max(5.0, min(dist * fraction, 40.0))
    return [
        destination_point(mid, (br + 90) % 360, offset_mi),
        destination_point(mid, (br - 90) % 360, offset_mi),
    ]


def corridor_offsets(
    coords: Sequence[Sequence[float]],
    interval_mi: float,
    offset_mi: float = 8.0,
) -> list[tuple[float, float]]:
    """Sample points along the polyline plus left/right lateral offsets for heatmap."""
    if len(coords) < 2:
        return []
    # Build sparse samples along the line
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

    points: list[tuple[float, float]] = []
    j = 0
    for t in targets:
        while j < len(cum) - 2 and cum[j + 1] < t:
            j += 1
        seg = cum[j + 1] - cum[j]
        f = 0.0 if seg == 0 else (t - cum[j]) / seg
        lon = coords[j][0] + f * (coords[j + 1][0] - coords[j][0])
        lat = coords[j][1] + f * (coords[j + 1][1] - coords[j][1])
        pt = (lon, lat)
        points.append(pt)
        br = bearing_deg(coords[j], coords[j + 1])
        points.append(destination_point(pt, (br + 90) % 360, offset_mi))
        points.append(destination_point(pt, (br - 90) % 360, offset_mi))
    return points


def route_similarity(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]], samples: int = 8) -> float:
    """Mean nearest-neighbour distance (mi) between sampled points on two polylines.

    Lower => more similar. Routes with similarity < ~5 mi are treated as duplicates.
    """
    if not a or not b:
        return float("inf")

    def sample(coords: Sequence[Sequence[float]]) -> list[tuple[float, float]]:
        if len(coords) == 1:
            return [(coords[0][0], coords[0][1])]
        cum = [0.0]
        for i in range(1, len(coords)):
            cum.append(cum[-1] + haversine_mi(coords[i - 1], coords[i]))
        total = cum[-1] or 1.0
        out = []
        for k in range(samples):
            t = total * k / (samples - 1) if samples > 1 else 0.0
            j = 0
            while j < len(cum) - 2 and cum[j + 1] < t:
                j += 1
            seg = cum[j + 1] - cum[j]
            f = 0.0 if seg == 0 else (t - cum[j]) / seg
            out.append((
                coords[j][0] + f * (coords[j + 1][0] - coords[j][0]),
                coords[j][1] + f * (coords[j + 1][1] - coords[j][1]),
            ))
        return out

    sa, sb = sample(a), sample(b)

    def mean_nn(src, dst):
        total = 0.0
        for p in src:
            total += min(haversine_mi(p, q) for q in dst)
        return total / len(src)

    return (mean_nn(sa, sb) + mean_nn(sb, sa)) / 2


def dedupe_routes(routes: list, threshold_mi: float = 5.0) -> list:
    """Keep routes whose geometry differs by more than threshold_mi (similarity)."""
    kept = []
    for r in routes:
        coords = r.coords if hasattr(r, "coords") else r
        if all(route_similarity(coords, k.coords if hasattr(k, "coords") else k) >= threshold_mi for k in kept):
            kept.append(r)
    return kept


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
            if len(cum_time_s) != len(coords):
                raise ValueError("cum_time_s length must match coords")
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
