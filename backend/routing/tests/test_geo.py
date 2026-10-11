from datetime import datetime, timedelta, timezone
from django.test import SimpleTestCase
from routing.geo import sample_checkpoints, haversine_mi

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
