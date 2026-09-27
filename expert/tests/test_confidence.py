"""confidence.py: the method constant, the shrinkage, Jev's flipped prior, value and floor."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import confidence as C  # noqa: E402


class Confidence(unittest.TestCase):
    def test_unknown_precision_falls_back_to_heuristic_and_nothing_settled_is_unmeasured(self):
        c = C.for_rule("made-up")
        self.assertEqual(c["base"], C.PRECISION["heuristic"])
        self.assertEqual(c["confidence"], C.PRECISION["heuristic"])
        self.assertIsNone(c["hold_rate"])
        self.assertEqual(c["weight"], 0.0)

    def test_history_blends_at_settled_over_settled_plus_shrinkage(self):
        c = C.for_rule("heuristic", held=4, weak=0, broken=0)
        self.assertEqual(c["weight"], 0.5)
        self.assertEqual(c["confidence"], round(0.5 * 0.6 + 0.5 * 1.0, 4))

    def test_a_prior_moves_the_start_but_not_the_base(self):
        c = C.for_rule("exact", prior={"p": 0.15, "n": 4})
        self.assertEqual(c["base"], 0.95)
        self.assertEqual(c["prior"]["weight"], 0.5)
        self.assertEqual(c["confidence"], round(0.5 * 0.95 + 0.5 * 0.15, 4))
        self.assertEqual(C.for_rule("exact", prior={"p": 0.1, "n": 0})["confidence"], 0.95, "n=0 is no prior")

    def test_jev_prior_flips_p_and_clamps_n(self):
        j = C.jev_prior({"jev": {"p": 0.8, "n": 3}})
        self.assertAlmostEqual(j["p"], 0.2)
        self.assertEqual(j["n"], 3)
        self.assertEqual(C.jev_prior({"jev": {"p": 1.4}})["p"], 0.0)
        self.assertEqual(C.jev_prior({"jev": {"p": 0.2, "n": -2}})["n"], 1)
        self.assertIsNone(C.jev_prior({"jev": {"p": True}}), "a bool is not a probability")
        self.assertIsNone(C.jev_prior({}))

    def test_value_puts_a_floor_under_cost_and_floor_scales_with_promote_at(self):
        self.assertEqual(C.value(1.0, "low", 0), C.value(1.0, "low", 1000))
        self.assertGreater(C.value(0.6, "high", 5000), C.value(0.6, "low", 5000))
        self.assertEqual(C.floor("medium"), 0.6)
        self.assertGreater(C.floor("high"), C.floor("medium"))


if __name__ == "__main__":
    unittest.main()
