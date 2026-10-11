"""Pure risk classification, load rules and route ranking (no I/O).

Thresholds from the Spotter brief. Band boundaries are lower-inclusive,
e.g. rain 0.25 in/hr -> High (brief lists "0.10-0.25 Moderate, 0.25-0.50 High").
Top bands: wind >= 55 -> No Travel; rain > 1.00 and snow > 3.0 -> No Travel
(so exactly 1.00 in/hr rain is Severe, exactly 3.0 in/hr snow is Severe).
"""
from __future__ import annotations
from dataclasses import dataclass
from enum import IntEnum
from typing import Iterable, Sequence


class Risk(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def label(self) -> str:
        return {0: "Low", 1: "Moderate", 2: "High", 3: "Severe", 4: "No Travel"}[int(self)]


def classify_wind(mph: float) -> Risk:
    if mph >= 55: return Risk.NO_TRAVEL
    if mph >= 45: return Risk.SEVERE
    if mph >= 35: return Risk.HIGH
    if mph >= 25: return Risk.MODERATE
    return Risk.LOW


def classify_rain(in_per_hr: float) -> Risk:
    if in_per_hr > 1.00: return Risk.NO_TRAVEL
    if in_per_hr >= 0.50: return Risk.SEVERE
    if in_per_hr >= 0.25: return Risk.HIGH
    if in_per_hr >= 0.10: return Risk.MODERATE
    return Risk.LOW


def classify_snow(in_per_hr: float) -> Risk:
    if in_per_hr > 3.0: return Risk.NO_TRAVEL
    if in_per_hr >= 2.0: return Risk.SEVERE
    if in_per_hr >= 1.0: return Risk.HIGH
    if in_per_hr >= 0.5: return Risk.MODERATE
    return Risk.LOW


def apply_load_rules(wind_mph: float, load_lb: float, base: Risk) -> Risk:
    """Load-weight escalation. Only ever raises risk."""
    if wind_mph >= 55:
        return Risk.NO_TRAVEL
    if 45 <= wind_mph < 55 and load_lb > 30_000:
        return Risk.NO_TRAVEL
    if 35 <= wind_mph < 45 and load_lb > 40_000:
        return max(base, Risk.SEVERE)
    return base


@dataclass(frozen=True)
class Weather:
    wind_mph: float
    rain_in_hr: float
    snow_in_hr: float


@dataclass(frozen=True)
class Assessment:
    risk: Risk
    wind: Risk
    rain: Risk
    snow: Risk
    load_escalated: bool


def assess(w: Weather, load_lb: float) -> Assessment:
    wr, rr, sr = classify_wind(w.wind_mph), classify_rain(w.rain_in_hr), classify_snow(w.snow_in_hr)
    base = max(wr, rr, sr)
    final = apply_load_rules(w.wind_mph, load_lb, base)
    return Assessment(final, wr, rr, sr, final > base)


# ---- unit conversions (Open-Meteo metric -> imperial) ----
def kmh_to_mph(v: float) -> float: return v * 0.621371
def mm_to_in(v: float) -> float: return v / 25.4
def cm_to_in(v: float) -> float: return v / 2.54


# ---- route ranking ----
@dataclass(frozen=True)
class SegmentRisk:
    miles: float
    risk: Risk


@dataclass(frozen=True)
class RouteSummary:
    route_id: str
    duration_s: float
    miles_by_risk: dict
    avg_risk: float  # mileage-weighted, 0..4

    @property
    def severe_miles(self): return self.miles_by_risk.get(Risk.SEVERE, 0.0)
    @property
    def high_miles(self): return self.miles_by_risk.get(Risk.HIGH, 0.0)
    @property
    def no_travel_miles(self): return self.miles_by_risk.get(Risk.NO_TRAVEL, 0.0)


def summarize(route_id: str, duration_s: float, segments: Iterable[SegmentRisk]) -> RouteSummary:
    by: dict = {r: 0.0 for r in Risk}
    total = weighted = 0.0
    for s in segments:
        by[s.risk] += s.miles
        total += s.miles
        weighted += s.miles * int(s.risk)
    return RouteSummary(route_id, duration_s, by, (weighted / total) if total else 0.0)


def rank_key(r: RouteSummary):
    # ASSUMPTION: No Travel miles rank worse than anything (brief doesn't list them
    # explicitly in the tie-break order). Then brief order: severe, high, avg, time.
    return (round(r.no_travel_miles, 3), round(r.severe_miles, 3),
            round(r.high_miles, 3), round(r.avg_risk, 6), r.duration_s)


def rank_routes(routes: Sequence[RouteSummary]) -> list[RouteSummary]:
    return sorted(routes, key=rank_key)
