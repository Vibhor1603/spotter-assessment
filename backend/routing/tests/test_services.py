from datetime import datetime, timedelta, timezone
from django.test import SimpleTestCase, override_settings
from routing.clients import Place, RouteOption
from routing.services import plan, validate_departure, PlanError, explain_recommendation, build_heatmap
from routing.risk import Risk, summarize, SegmentRisk


NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
DEP = NOW + timedelta(hours=2)


def _hourly_payload(wind=10, rain=0, snow=0, hours=72):
    start = NOW.replace(minute=0, second=0, microsecond=0)
    times = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:00") for i in range(hours)]
    return {
        "hourly": {
            "time": times,
            "wind_speed_10m": [wind] * hours,
            "wind_gusts_10m": [wind] * hours,
            "precipitation": [rain + snow] * hours,
            "rain": [rain] * hours,
            "snowfall": [snow] * hours,
        }
    }


class FakeRouter:
    def __init__(self, n=3, duration_s=3600):
        self.n = n
        self.duration_s = duration_s

    def routes(self, a, b, n=3):
        # Three slightly divergent N-S lines
        out = []
        for i in range(min(self.n, n)):
            lon = a.lon + i * 0.15
            coords = [[lon, a.lat], [lon, (a.lat + b.lat) / 2], [lon, b.lat]]
            # 3 vertices -> 2 legs of equal duration
            half = self.duration_s / 2
            out.append(RouteOption(
                id=f"r{i}", coords=coords,
                distance_m=1609.344 * 100,  # ~100 mi
                duration_s=self.duration_s,
                cum_time_s=[0, half, self.duration_s],
            ))
        return out


class FakeWeather:
    def __init__(self, wind=10, rain=0, snow=0):
        self.wind, self.rain, self.snow = wind, rain, snow
        self.calls = []

    def hourly(self, points, forecast_days=3):
        self.calls.append((len(points), forecast_days))
        return [_hourly_payload(self.wind, self.rain, self.snow) for _ in points]


class Validation(SimpleTestCase):
    def test_past_rejected(self):
        with self.assertRaises(PlanError):
            validate_departure(NOW - timedelta(hours=5), now=NOW)

    def test_beyond_forecast_rejected(self):
        with self.assertRaises(PlanError):
            validate_departure(NOW + timedelta(days=10), now=NOW, forecast_days=3)

    def test_ok_near_now(self):
        d = validate_departure(NOW + timedelta(hours=1), now=NOW)
        self.assertEqual(d.tzinfo, timezone.utc)


class PlanPipeline(SimpleTestCase):
    def test_plan_ranks_and_explains(self):
        origin = Place("A", -105.0, 39.0)
        dest = Place("B", -105.0, 40.5)
        # Route r0 calm, but FakeRouter makes identical weather — ranking falls to duration
        out = plan(origin, dest, DEP, 20000, 50, router=FakeRouter(3), weather=FakeWeather(10), now=NOW)
        self.assertEqual(len(out["routes"]), 3)
        self.assertEqual(out["recommended"], "r0")
        self.assertIn("why", out)
        self.assertIn("heatmap", out)
        self.assertEqual(out["heatmap"]["hours"], 48)
        self.assertGreater(len(out["heatmap"]["points"]), 0)
        # Checkpoints carry load_escalated + per-hazard labels
        cp = out["routes"][0]["checkpoints"][0]
        self.assertIn("wind_risk", cp)
        self.assertFalse(cp["load_escalated"])

    def test_load_escalation_reflected(self):
        origin = Place("A", -105.0, 39.0)
        dest = Place("B", -105.0, 40.5)
        # 50 mph wind + 35k lb -> No Travel via load rule
        out = plan(origin, dest, DEP, 35000, 50,
                   router=FakeRouter(2, duration_s=1800),
                   weather=FakeWeather(wind=50), now=NOW)
        risks = {c["risk"] for r in out["routes"] for c in r["checkpoints"]}
        self.assertIn("No Travel", risks)
        self.assertTrue(any(c["load_escalated"] for r in out["routes"] for c in r["checkpoints"]))

    def test_eta_uses_cum_time(self):
        origin = Place("A", -105.0, 39.0)
        dest = Place("B", -105.0, 40.5)
        out = plan(origin, dest, DEP, 10000, 1000,
                   router=FakeRouter(1, duration_s=7200),
                   weather=FakeWeather(), now=NOW)
        cps = out["routes"][0]["checkpoints"]
        self.assertEqual(cps[0]["eta"], DEP.isoformat())
        # Last checkpoint ETA should match duration
        last = datetime.fromisoformat(cps[-1]["eta"])
        self.assertAlmostEqual((last - DEP).total_seconds(), 7200, delta=2)

    def test_trip_beyond_forecast_rejected(self):
        origin = Place("A", -105.0, 39.0)
        dest = Place("B", -105.0, 40.5)
        # Depart near end of window with long duration
        late = NOW + timedelta(days=2, hours=20)
        with self.assertRaises(PlanError):
            plan(origin, dest, late, 10000, 50,
                 router=FakeRouter(1, duration_s=3600 * 10),
                 weather=FakeWeather(), now=NOW)


class Explain(SimpleTestCase):
    def test_explain_severe(self):
        a = summarize("r0", 100, [SegmentRisk(10, Risk.SEVERE), SegmentRisk(90, Risk.LOW)])
        b = summarize("r1", 200, [SegmentRisk(5, Risk.SEVERE), SegmentRisk(95, Risk.LOW)])
        text = explain_recommendation(["r1", "r0"], {"r0": a, "r1": b})
        self.assertIn("Severe", text)
        self.assertIn("r1", text)


class Heatmap(SimpleTestCase):
    def test_build_heatmap_weights(self):
        coords = [[-105, 39], [-105, 40], [-105, 41]]
        hm = build_heatmap(coords, interval_mi=50, weather=FakeWeather(wind=40), hours=48)
        self.assertEqual(hm["hours"], 48)
        self.assertEqual(len(hm["times"]), 48)
        self.assertGreater(len(hm["points"]), 0)
        self.assertEqual(len(hm["points"][0]["weights"]), 48)
        # High wind -> weight closer to 1 than calm
        calm = build_heatmap(coords, interval_mi=50, weather=FakeWeather(wind=5), hours=48)
        self.assertGreater(hm["points"][0]["weights"][0], calm["points"][0]["weights"][0])


@override_settings(ROOT_URLCONF="config.urls")
class ApiViews(SimpleTestCase):
    """Lightweight API checks with fakes injected via services — hit serializers."""

    def test_health(self):
        from django.test import Client
        c = Client()
        r = c.get("/api/health/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])

    def test_plan_validation_error(self):
        from django.test import Client
        c = Client()
        r = c.post("/api/plan/", data={}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
