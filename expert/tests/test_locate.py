"""The locate baseline, and the board limit that gave the throttle a close path."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import confidence, locate, throttle  # noqa: E402


def window(i, **over):
    w = {
        "session": f"s{i}", "at": i + 1, "brief": f"b{i}",
        "scope": [f"in{i}.js"], "cut": [f"cut{i}.js"], "candidates": [f"cand{i}.js"],
        "edits": [
            {"file": f"in{i}.js", "hash": "a"},
            {"file": f"cut{i}.js", "hash": "b"},
            {"file": f"miss{i}.js", "hash": "c"},
            {"file": f"other{i}.js", "hash": "d"},
            {"file": f"flip{i}.js", "hash": "e"},
            {"file": f"flip{i}.js", "hash": "e"},
        ],
    }
    w.update(over)
    return w


class Locate(unittest.TestCase):
    def test_an_in_scope_edit_is_not_evidence(self):
        c = locate.classify(window(0))
        self.assertEqual(c["in_scope"], ["in0.js"])
        self.assertEqual(c["from_cut"], ["cut0.js"])
        self.assertEqual(c["unnamed"], ["miss0.js", "other0.js"])
        # The brief said to edit the scope, so an obedient agent drives that
        # number wherever it likes and it says nothing about the locate.
        self.assertEqual(c["rows"], 3)

    def test_a_file_changed_and_changed_back_is_a_wrong_turn(self):
        c = locate.classify(window(0))
        self.assertEqual(c["reverted"], ["flip0.js"])
        self.assertNotIn("flip0.js", c["unnamed"])
        # No hash and no path: a shell write is counted on neither side.
        bare = locate.classify({"scope": ["a.js"], "edits": [{"file": "", "hash": ""}]})
        self.assertEqual(bare["rows"], 0)

    def test_a_row_the_write_guard_exempts_is_not_a_recall_miss(self):
        w = window(0, edits=[
            {"file": "in0.js", "hash": "a"},
            {"file": "real.js", "hash": "b"},
            {"file": "test/thing.test.js", "hash": "c"},
            {"file": ".bundlebox/out/x.json", "hash": "d"},
            {"file": "/elsewhere/other.mjs", "hash": "e"},
            {"file": "born.js", "hash": "f", "created": True},
        ])
        c = locate.classify(w)
        self.assertEqual(c["unnamed"], ["real.js"])
        self.assertEqual(c["rows"], 1)
        self.assertEqual(sorted(x["why"] for x in c["excluded"]),
                         ["created", "generated", "outside-workspace", "test"])

    def test_the_exclusions_mirror_the_js_copy(self):
        # `src/pinpoint/locate.js` holds the same four rules and
        # `test/pinpoint.test.js` pins them to the write guard. Both files are
        # read by the same figure, so a rule added to one and not the other
        # would make the JS and expert engines disagree about the denominator.
        self.assertEqual(locate.excluded("src/a.js"), "")
        self.assertEqual(locate.excluded("src/a.js", created=True), "created")
        self.assertEqual(locate.excluded("test/a.test.js"), "test")
        self.assertEqual(locate.excluded("tests/a.js"), "test")
        self.assertEqual(locate.excluded("src/x_test.py"), "test")
        self.assertEqual(locate.excluded(".bundlebox/out/x.json"), "generated")
        self.assertEqual(locate.excluded("GATES.md"), "generated")
        self.assertEqual(locate.excluded("/tmp/x.js"), "outside-workspace")
        self.assertEqual(locate.excluded("../sibling/x.js"), "outside-workspace")
        # The guard's narrower pattern, not the wider one in detectors/_shared:
        # dropping a row the guard would deny flatters the ranker.
        self.assertEqual(locate.excluded("fixtures/a.js"), "")

    def test_too_few_rows_is_unknown_and_never_a_figure(self):
        r = locate.replay([window(0)])
        self.assertEqual(r["verdict"], "unknown")
        self.assertIsNone(r["precision"])
        self.assertIsNone(r["recall"])
        self.assertIn("3 exception row(s) over 1 brief(s)", r["detail"])
        self.assertEqual(r["thresholds"], {"min_rows": 12, "min_windows": 4})

    def test_the_baseline_ships_with_its_sample_size(self):
        r = locate.replay([window(i) for i in range(4)])
        self.assertEqual(r["verdict"], "measured")
        self.assertEqual((r["n"], r["named"], r["missed"], r["offered"]), (12, 4, 8, 8))
        self.assertEqual(r["recall"], round(4 / 12, 4))
        self.assertEqual(r["precision"], 0.5)
        self.assertEqual(r["in_scope_unscored"], 4)
        self.assertIn("n", r)
        # Shrunk toward the method, never past it: twelve samples of a 0.33
        # recall cannot say the method is worth 0.33.
        self.assertGreater(r["confidence"], r["recall"])
        self.assertLess(r["confidence"], confidence.PRECISION["lexical"])

    def test_the_threshold_is_an_input(self):
        cfg = {"pinpoint": {"locate": {"min_rows": 3, "min_windows": 1}}}
        r = locate.replay([window(0)], cfg)
        self.assertEqual(r["verdict"], "measured")
        self.assertEqual(r["thresholds"], {"min_rows": 3, "min_windows": 1})


class BoardLimit(unittest.TestCase):
    ROWS = [
        {"id": "a", "detector": "duplicate-blocks", "promote": True, "priority": 2, "ev": 40, "est_tokens": 6000, "auto_fix": "plan-block-lift"},
        {"id": "b", "detector": "duplicate-blocks", "promote": True, "priority": 2, "ev": 39, "est_tokens": 6000, "auto_fix": "strip-debug-line"},
        {"id": "c", "detector": "doc-links", "promote": True, "priority": 1, "ev": 50, "est_tokens": 500},
    ]

    def test_a_detector_over_the_cap_reports_as_a_count(self):
        r = throttle.apply(self.ROWS, None, {"duplicate-blocks": {"cooldown": 0, "open": 285}})
        self.assertEqual(sorted(d["id"] for d in r["promoted"]), ["b", "c"])
        self.assertEqual([d["id"] for d in r["deferred"]], ["a"])
        self.assertIn("at or over per_detector_open=40", r["deferred"][0]["throttle_reason"])

    def test_the_suppressed_count_is_printed_rather_than_dropped(self):
        r = throttle.apply(self.ROWS, None, {"duplicate-blocks": {"open": 285}})
        self.assertEqual(r["suppressed"]["duplicate-blocks"], {"open": 285, "limit": 40, "deferred": 1})
        self.assertIn("1 board-suppressed", r["summary"])
        self.assertIn("duplicate-blocks suppressed at 285 open", r["summary"])

    def test_a_plan_actuator_is_not_a_close_path(self):
        self.assertTrue(throttle.closes("strip-debug-line"))
        self.assertFalse(throttle.closes("plan-block-lift"))
        self.assertFalse(throttle.closes(""))

    def test_under_the_cap_nothing_changes_and_zero_turns_it_off(self):
        quiet = throttle.apply(self.ROWS, None, {"duplicate-blocks": {"open": 39}})
        self.assertEqual(quiet["deferred"], [])
        self.assertEqual(quiet["suppressed"], {})
        off = throttle.apply(self.ROWS, {"expert": {"throttle": {"per_detector_open": 0}}}, {"duplicate-blocks": {"open": 285}})
        self.assertEqual(off["deferred"], [])


if __name__ == "__main__":
    unittest.main()
