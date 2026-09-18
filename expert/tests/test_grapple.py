"""grapple: the arithmetic behind the handoff layer. Deterministic, stdlib
only, and every threshold is confidence.py's."""
import ast
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import confidence, grapple  # noqa: E402

SRC = os.path.join(HERE, "bundlebox_expert", "grapple.py")


def item(key, **over):
    base = {"key": key, "shape": "pattern", "detector": "swallowed-errors", "severity": "medium", "precision": "heuristic", "est_tokens": 2000, "n": 5}
    base.update(over)
    return base


class Grapple(unittest.TestCase):
    def test_rank_is_a_total_order_and_suppresses_answered_items(self):
        items = [item("a"), item("b", severity="high"), item("c", n=1), item("d", shape="instance", fingerprint="fp1", n=1), item("e", pattern="pk", n=1)]
        answers = {"d": {"shape": "instance", "fingerprint": "fp1"}, "pk": {"shape": "pattern"}}
        r = grapple.rank(items, answers)
        keys = [a["key"] for a in r["asked"]]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertNotIn("d", keys, "a live instance answer suppresses the question")
        self.assertNotIn("e", keys, "a covering pattern answer suppresses the question")
        evs = [a["ev"] for a in r["asked"]]
        self.assertEqual(evs, sorted(evs, reverse=True))
        self.assertEqual(keys[0], "b")
        # distinct inputs, no ties: the key breaks any equal value
        twins = grapple.rank([item("y"), item("x")], {})["asked"]
        self.assertEqual([t["key"] for t in twins], ["x", "y"])
        # the moved fingerprint re-asks
        r2 = grapple.rank([item("d", shape="instance", fingerprint="fp2", n=1)], answers)
        self.assertEqual([a["key"] for a in r2["asked"]], ["d"])

    def test_rank_is_deterministic_and_reads_no_environment(self):
        items = [item(k, severity=s) for k, s in (("a", "low"), ("b", "high"), ("c", "medium"))]
        self.assertEqual(grapple.rank(items, {}), grapple.rank(list(reversed(items)), {}))
        with open(SRC) as fh:
            src = ast.parse(fh.read())
        names = {n.id for n in ast.walk(src) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(src) if isinstance(n, ast.Attribute)}
        for banned in ("time", "random", "environ", "getenv", "open", "datetime", "urandom"):
            self.assertNotIn(banned, names, f"grapple.py reads {banned}")

    def test_rank_prior_is_for_rule_over_the_fitted_counts(self):
        it = item("a", detector="swallowed-errors", severity="medium", est_tokens=1000, n=1)
        base = grapple.rank([it], {})["asked"][0]
        self.assertEqual(base["prior"], confidence.PRECISION["heuristic"], "no labels: the method's base, exactly")
        fitted = grapple.rank([it], {}, priors={"swallowed-errors": {"held": 0, "broken": confidence.SHRINKAGE}})["asked"][0]
        self.assertEqual(fitted["prior"], confidence.for_rule("heuristic", 0, 0, confidence.SHRINKAGE)["confidence"])
        self.assertLess(fitted["prior"], base["prior"])
        self.assertGreater(fitted["ev"], base["ev"], "a detector the labels keep contradicting is worth more to ask about")

    def test_propagate_ends_are_the_answer_and_the_prior(self):
        rows = [{"id": "near", "precision": "heuristic", "distance": 0.0}, {"id": "far", "precision": "heuristic", "distance": 1.0}, {"id": "mid", "precision": "heuristic", "distance": 0.5}]
        r = grapple.propagate({"value": "yes", "confidence": 0.9}, rows)
        by = {l["id"]: l["confidence"] for l in r["labels"]}
        self.assertEqual(by["near"], 0.9)
        self.assertEqual(by["far"], confidence.PRECISION["heuristic"])
        self.assertTrue(by["far"] < by["mid"] < by["near"])

    def test_promote_three_identical_samples_do_not_clear_the_shrinkage_bar(self):
        below = confidence.SHRINKAGE - 1
        self.assertEqual(below, 3, "the spec's three, derived from the constant rather than copied")
        t = {"answers": [{"key": "pk", "value": "yes", "support": below}], "overrides": [{"detector": "dead-exports", "support": below}], "drifts": []}
        r = grapple.promote(t)
        self.assertTrue(all(not row["promote"] for row in r["rows"]))
        t2 = {"answers": [{"key": "pk", "value": "yes", "support": confidence.SHRINKAGE}], "overrides": [], "drifts": []}
        self.assertTrue(grapple.promote(t2)["rows"][0]["promote"], "at SHRINKAGE history weighs as much as the method")
        self.assertEqual(r["shrinkage"], confidence.SHRINKAGE)

    def test_drift_signature_is_stable(self):
        turns = [{"tool": "Read", "file": "src/x.js", "hash": "h1"}] * 4 + [{"tool": "Read", "file": "src/y.js", "hash": "h2"}] * 10
        w = {"turns": turns, "scope": ["src/a.js"]}
        a, b = grapple.drift(w), grapple.drift(dict(w))
        self.assertEqual(a, b)
        self.assertEqual(a["signature"], "out_of_scope+repeats+since_edit")
        self.assertEqual(a["score"], 1.0)
        self.assertEqual(grapple.drift({"turns": [], "scope": []})["signature"], "none")

    def test_stdlib_only(self):
        with open(SRC) as fh:
            src = ast.parse(fh.read())
        for n in ast.walk(src):
            if isinstance(n, ast.Import):
                self.fail(f"grapple.py imports {[a.name for a in n.names]}")
            if isinstance(n, ast.ImportFrom):
                self.assertTrue(n.level == 1 or n.module == "__future__", f"grapple.py imports {n.module}")


if __name__ == "__main__":
    unittest.main()
