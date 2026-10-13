from django.test import SimpleTestCase
from routing.risk import (Risk, classify_wind, classify_rain, classify_snow, apply_load_rules,
                          assess, Weather, summarize, SegmentRisk, rank_routes, cm_to_in, mm_to_in, kmh_to_mph)


class Bands(SimpleTestCase):
    def test_wind(self):
        for v, r in [(0, Risk.LOW), (24.9, Risk.LOW), (25, Risk.MODERATE), (34.9, Risk.MODERATE),
                     (35, Risk.HIGH), (44.9, Risk.HIGH), (45, Risk.SEVERE), (54.9, Risk.SEVERE),
                     (55, Risk.NO_TRAVEL), (80, Risk.NO_TRAVEL)]:
            self.assertEqual(classify_wind(v), r, v)

    def test_rain(self):
        for v, r in [(0, Risk.LOW), (0.09, Risk.LOW), (0.10, Risk.MODERATE), (0.25, Risk.HIGH),
                     (0.49, Risk.HIGH), (0.50, Risk.SEVERE), (1.00, Risk.SEVERE), (1.01, Risk.NO_TRAVEL)]:
            self.assertEqual(classify_rain(v), r, v)

    def test_snow(self):
        for v, r in [(0.49, Risk.LOW), (0.5, Risk.MODERATE), (1.0, Risk.HIGH), (2.0, Risk.SEVERE),
                     (3.0, Risk.SEVERE), (3.01, Risk.NO_TRAVEL)]:
            self.assertEqual(classify_snow(v), r, v)


class LoadRules(SimpleTestCase):
    def test_55_any_load(self):
        self.assertEqual(apply_load_rules(55, 0, Risk.NO_TRAVEL), Risk.NO_TRAVEL)

    def test_45_54_heavy(self):
        self.assertEqual(apply_load_rules(50, 30_001, Risk.SEVERE), Risk.NO_TRAVEL)
        self.assertEqual(apply_load_rules(50, 30_000, Risk.SEVERE), Risk.SEVERE)

    def test_35_44_heavy(self):
        self.assertEqual(apply_load_rules(40, 40_001, Risk.HIGH), Risk.SEVERE)
        self.assertEqual(apply_load_rules(40, 40_000, Risk.HIGH), Risk.HIGH)

    def test_never_lowers(self):
        self.assertEqual(apply_load_rules(40, 45_000, Risk.NO_TRAVEL), Risk.NO_TRAVEL)

    def test_assess_takes_max_and_flags_escalation(self):
        a = assess(Weather(46, 0.3, 0), 35_000)
        self.assertEqual(a.risk, Risk.NO_TRAVEL)
        self.assertTrue(a.load_escalated)
        b = assess(Weather(10, 0.6, 1.2), 50_000)
        self.assertEqual(b.risk, Risk.SEVERE)
        self.assertFalse(b.load_escalated)


class Units(SimpleTestCase):
    def test_conversions(self):
        self.assertAlmostEqual(cm_to_in(2.54), 1)
        self.assertAlmostEqual(mm_to_in(25.4), 1)
        self.assertAlmostEqual(kmh_to_mph(100), 62.1371, places=3)


class Ranking(SimpleTestCase):
    def s(self, rid, dur, segs):
        return summarize(rid, dur, [SegmentRisk(m, r) for m, r in segs])

    def test_fewest_severe_first(self):
        a = self.s("a", 100, [(10, Risk.SEVERE), (90, Risk.LOW)])
        b = self.s("b", 999, [(5, Risk.SEVERE), (50, Risk.HIGH), (45, Risk.LOW)])
        self.assertEqual([r.route_id for r in rank_routes([a, b])], ["b", "a"])

    def test_then_high(self):
        a = self.s("a", 100, [(20, Risk.HIGH), (80, Risk.LOW)])
        b = self.s("b", 200, [(10, Risk.HIGH), (90, Risk.LOW)])
        self.assertEqual(rank_routes([a, b])[0].route_id, "b")

    def test_then_avg_then_time(self):
        a = self.s("a", 100, [(50, Risk.MODERATE), (50, Risk.LOW)])
        b = self.s("b", 200, [(100, Risk.LOW)])
        c = self.s("c", 150, [(100, Risk.LOW)])
        self.assertEqual([r.route_id for r in rank_routes([a, b, c])], ["c", "b", "a"])

    def test_no_travel_worst(self):
        a = self.s("a", 100, [(1, Risk.NO_TRAVEL), (99, Risk.LOW)])
        b = self.s("b", 100, [(50, Risk.SEVERE), (50, Risk.LOW)])
        self.assertEqual(rank_routes([a, b])[0].route_id, "b")

    def test_avg_is_mileage_weighted(self):
        self.assertAlmostEqual(self.s("x", 1, [(30, Risk.SEVERE), (90, Risk.LOW)]).avg_risk, 0.75)

    def test_tiny_avg_noise_does_not_beat_much_shorter_trip(self):
        # Both ~Low: 1 mi Moderate vs 2 mi Moderate → avg 0.01 vs 0.02, both 0.0 at 1dp.
        # Longer trip must not win on float noise once avg is rounded to 2dp (both 0.01→0.01? wait)
        # 1/100 = 0.01 vs 2/100 = 0.02 — 2dp still differs. Use noise below 0.005.
        a = self.s("long", 20 * 3600, [(0.2, Risk.MODERATE), (99.8, Risk.LOW)])  # avg 0.002
        b = self.s("short", 9 * 3600, [(0.4, Risk.MODERATE), (99.6, Risk.LOW)])  # avg 0.004
        # Both round to 0.00 at 2dp → shorter wins
        self.assertEqual(rank_routes([a, b])[0].route_id, "short")
