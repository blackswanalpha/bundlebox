"""Silent-failure checks for the expert system. Each prints a measurement."""
import inspect
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import confidence, memory, model, rules, signals, triage  # noqa: E402


class Expert(unittest.TestCase):
    def test_every_threshold_is_read_by_a_rule(self):
        src = inspect.getsource(rules).split("RS = RuleSet")[1]
        unread = [k for k in rules.THRESHOLDS if f'"{k}"' not in src]
        self.assertEqual(unread, [], f"thresholds nobody reads: {unread}")

    def test_confidence_shrinks_toward_the_method(self):
        c0 = confidence.for_rule("exact")
        self.assertEqual(c0["confidence"], 0.95)
        c3 = confidence.for_rule("exact", held=0, weak=0, broken=3)
        self.assertGreater(c3["confidence"], 0.4)  # three failures cannot zero an exact method
        self.assertLess(c3["confidence"], 0.95)

    def test_judgement_is_sticky_over_critical(self):
        t = triage.triage({"detector": "big-file", "severity": "critical", "precision": "exact", "est_tokens": 90000})
        self.assertFalse(t["promote"])
        self.assertIn("judgement-call", [s["rule"] for s in t["steps"]])

    def test_signals_never_report_zero_for_nothing_measured(self):
        s = signals.session_signals([])
        self.assertIsNone(s["reread_ratio"])
        self.assertIsNone(s["singleton_turn_ratio"])

    def test_slope_segments_at_compaction(self):
        ys = [1000, 2000, 3000, 4000, 1200, 2200, 3200, 4200]
        self.assertGreater(signals._slope(ys), 900)

    def test_model_refuses_until_it_beats_the_base_rate(self):
        eps = [{"verb": "scan", "useful": 1, "at": f"2026-01-{i+1:02d}"} for i in range(20)]
        m = model.train(eps)
        self.assertFalse(m["useful"])
        self.assertEqual(model.predict(m, eps[0])["source"], "base-rate")

    def test_featurize_serves_train_and_predict(self):
        a = model.featurize({"verb": "x", "prev": "y", "features": {"inputs": 3}})
        self.assertIn("verb=x", a)
        self.assertIn("edge_lift", model.featurize({"verb": "x", "prev": "y"}, {"y>x": 1.5}))

    def test_memory_refuses_missing_paths(self):
        with tempfile.TemporaryDirectory() as d:
            claims = memory.derive({"top_reread_files": [["nope.js", 9]]}, [], [], d, "2026-09-13T00:00:00")
            self.assertEqual(claims, [])

    def test_cli_round_trip(self):
        r = subprocess.run([sys.executable, "-m", "bundlebox_expert", "rules"], input=json.dumps({"signals": {}}), capture_output=True, text=True, env={**os.environ, "PYTHONPATH": HERE})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["verdict"], "lean")


if __name__ == "__main__":
    unittest.main()
