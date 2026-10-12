from datetime import datetime, timedelta, timezone
from django.test import SimpleTestCase
from routing.geo import (
    sample_checkpoints, haversine_mi, perpendicular_offsets, destination_point,
    bearing_deg, route_similarity, dedupe_routes, corridor_offsets, midpoint,
)

DEP = datetime(2026, 10, 12, 8, tzinfo=timezone.utc)
# ~69.1 mi per degree latitude along a meridian
LINE = [[-90.0, 40.0], [-90.0, 41.0], [-90.0, 42.0]]


class Geo(SimpleTestCase):
    def test_haversine_degree(self):
        self.assertAlmostEqual(haversine_mi((-90, 40), (-90, 41)), 69.09, delta=0.1)

    def test_sampling_positions_and_endpoints(self):
        cps = sample_checkpoints(LINE, 25, DEP, 7200)
        self.assertEqual([round(c.mile) for c in cps], [0, 25, 50, 75, 100, 125, 138])
        self.assertAlmostEqual(cps[1].lat, 40 + 25 / 69.09, places=2)
        self.assertEqual((cps[-1].lon, cps[-1].lat), (-90.0, 42.0))

    def test_eta_uniform(self):
        cps = sample_checkpoints(LINE, 50, DEP, 7200)
        self.assertEqual(cps[0].eta, DEP)
        self.assertEqual(cps[-1].eta, DEP + timedelta(seconds=7200))
        frac = cps[1].mile / cps[-1].mile
        self.assertAlmostEqual((cps[1].eta - DEP).total_seconds(), 7200 * frac, delta=1)

    def test_eta_from_cumulative_times(self):
        cps = sample_checkpoints(LINE, 1000, DEP, 0, cum_time_s=[0, 3600, 3600 * 3])
        self.assertEqual(cps[-1].eta, DEP + timedelta(hours=3))

    def test_segment_miles_sum_to_total(self):
        cps = sample_checkpoints(LINE, 10, DEP, 7200)
        self.assertAlmostEqual(sum(c.segment_miles for c in cps), cps[-1].mile, places=6)

    def test_short_route(self):
        cps = sample_checkpoints([[-90, 40], [-90, 40.01]], 50, DEP, 60)
        self.assertEqual(len(cps), 2)

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            sample_checkpoints([[0, 0]], 10, DEP, 1)

    def test_bearing_and_destination(self):
        # Due north ~69 mi should land ~1 deg lat higher
        p = destination_point((-90, 40), 0, 69.09)
        self.assertAlmostEqual(p[1], 41.0, delta=0.02)
        self.assertAlmostEqual(bearing_deg((-90, 40), (-90, 41)), 0, delta=1)

    def test_perpendicular_offsets(self):
        a, b = (-105.0, 39.7), (-111.9, 40.7)
        offs = perpendicular_offsets(a, b, fraction=0.1)
        self.assertEqual(len(offs), 2)
        mid = midpoint([list(a), list(b)])
        d0 = haversine_mi(mid, offs[0])
        d1 = haversine_mi(mid, offs[1])
        # Both sides should be meaningfully offset (sphere makes exact equality soft)
        self.assertGreater(d0, 4)
        self.assertGreater(d1, 4)
        # Offsets should not collapse onto the main corridor
        self.assertGreater(haversine_mi(offs[0], offs[1]), 8)

    def test_route_similarity_identical(self):
        self.assertLess(route_similarity(LINE, LINE), 0.1)

    def test_route_similarity_divergent(self):
        other = [[-91.0, 40.0], [-91.0, 41.0], [-91.0, 42.0]]
        self.assertGreater(route_similarity(LINE, other), 40)

    def test_dedupe_routes(self):
        class R:
            def __init__(self, coords):
                self.coords = coords
        a = R(LINE)
        b = R([[p[0] + 0.001, p[1]] for p in LINE])  # nearly identical
        c = R([[-91.0, 40.0], [-91.0, 42.0]])
        kept = dedupe_routes([a, b, c], threshold_mi=5.0)
        self.assertEqual(len(kept), 2)

    def test_corridor_offsets(self):
        pts = corridor_offsets(LINE, interval_mi=50, offset_mi=5)
        # start + mid-ish + end, each with L/R => multiples of 3
        self.assertGreaterEqual(len(pts), 6)
        self.assertEqual(len(pts) % 3, 0)

    def test_midpoint(self):
        m = midpoint(LINE)
        self.assertAlmostEqual(m[0], -90.0, places=3)
        self.assertAlmostEqual(m[1], 41.0, delta=0.05)
