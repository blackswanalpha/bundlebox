"""triage.py: the rule order, the actuator priority, and what counts as a scorable sample."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import triage  # noqa: E402


def f(**kw):
    return {"detector": "x", "severity": "medium", "precision": "exact", "est_tokens": 2000, **kw}


class Triage(unittest.TestCase):
    def test_info_is_noise_even_when_mechanical(self):
        t = triage.triage(f(detector="doc-links", severity="info"))
        self.assertFalse(t["promote"])
        self.assertEqual([s["rule"] for s in t["steps"]], ["noise-floor"])

    def test_critical_promotes_to_opus_at_priority_zero(self):
        t = triage.triage(f(severity="critical"))
        self.assertEqual((t["promote"], t["model"], t["priority"]), (True, "opus", 0))

    def test_severity_floor_reads_promote_at_from_cfg(self):
        self.assertTrue(triage.triage(f(severity="low"), {"detectors": {"promote_at": "low"}})["promote"])
        t = triage.triage(f(severity="low"))
        self.assertFalse(t["promote"])
        self.assertIn("below promote_at=medium", t["reason"])

    def test_a_small_mechanical_finding_is_a_sonnet_edit_and_an_auto_fix_jumps_the_queue(self):
        t = triage.triage(f(detector="doc-links", files=["a.md"]))
        self.assertEqual((t["model"], t["priority"], t["reason"]), ("sonnet", 2, "mechanical edit"))
        a = triage.triage(f(detector="doc-links", files=["a.md"], auto_fix="relink"))
        self.assertEqual((a["priority"], a["actuator"]), (0, "relink"))

    def test_an_expensive_heuristic_falls_under_the_ev_floor(self):
        t = triage.triage(f(precision="heuristic", est_tokens=900000))
        self.assertFalse(t["promote"])
        self.assertLess(t["ev"], t["ev_floor"])

    def test_scorable_drops_open_and_unknown_closures(self):
        rows = [{"status": "open", "closed_by": "acted_on"}, {"status": "closed", "closed_by": "unknown"},
                {"status": "closed", "closed_by": None}, {"status": "closed", "closed_by": "acted_on"}]
        self.assertEqual(triage.scorable(rows), [rows[3]])


if __name__ == "__main__":
    unittest.main()
