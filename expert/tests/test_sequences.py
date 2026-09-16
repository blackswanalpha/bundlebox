"""The sequence miner. Every case here was a defect on real data first."""
import unittest

from bundlebox_expert import sequences


class TestPeriod(unittest.TestCase):
    def test_base_cycle(self):
        self.assertEqual(sequences.period(("grep", "head", "grep", "head")), 2)
        self.assertEqual(sequences.period(("a", "a", "a")), 1)
        self.assertEqual(sequences.period(("a", "b", "c")), 3)
        self.assertEqual(sequences.period(("a", "b", "a")), 3)


class TestMine(unittest.TestCase):
    def test_one_pipeline_is_one_habit(self):
        # With MAX_LEN at 8 this returned six rows at the same support, all of
        # them windows of this single ten-verb run: growth stopped at the cap, so
        # no extension existed to disprove closedness.
        run = ["scan", "oversight", "compile", "route", "snapgen",
               "guidelines", "recommend", "ledger", "episodes", "bench"]
        rows = sequences.mine([run, run, run], min_support=3)
        self.assertEqual(len(rows), 1, [r["items"] for r in rows])
        self.assertEqual(rows[0]["items"], run)
        self.assertEqual(rows[0]["support"], 3)
        self.assertEqual(rows[0]["sessions"], 3)

    def test_prefix_survives_only_when_more_frequent(self):
        rows = sequences.mine([["a", "b", "c"]] * 3 + [["a", "b"]] * 2, min_support=3)
        got = {tuple(r["items"]): r["support"] for r in rows}
        self.assertEqual(got[("a", "b", "c")], 3)
        self.assertEqual(got[("a", "b")], 5)

    def test_repetition_reports_its_cycle(self):
        six = ["grep", "head"] * 3
        rows = sequences.mine([six, six, six], min_support=3)
        self.assertNotIn(6, [len(r["items"]) for r in rows])
        self.assertIn(("grep", "head"), [tuple(r["items"]) for r in rows])

    def test_floor(self):
        self.assertEqual(sequences.mine([["x", "y"], ["x", "y"]], min_support=3), [])

    def test_gaps_are_not_patterns(self):
        # Contiguity: `a c` never happens, however often a and c both do.
        rows = sequences.mine([["a", "b", "c"]] * 4, min_support=3)
        self.assertNotIn(("a", "c"), [tuple(r["items"]) for r in rows])

    def test_confidence_and_lift(self):
        rows = sequences.mine([["a", "b", "c"]] * 3 + [["a", "b", "z"]], min_support=3)
        ab = next(r for r in rows if r["items"] == ["a", "b"] or r["items"][:2] == ["a", "b"])
        self.assertGreater(ab["support"], 0)
        self.assertLessEqual(ab["confidence"], 1.0)

    def test_empty(self):
        self.assertEqual(sequences.mine([], min_support=3), [])
        self.assertEqual(sequences.mine([[]], min_support=3), [])

    def test_occurrences_agrees_with_mine(self):
        runs = [["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c"]]
        for r in sequences.mine(runs, min_support=3):
            self.assertEqual(r["support"], sequences.occurrences(runs, tuple(r["items"])))
            self.assertEqual(r["sessions"], sequences.sessions_with(runs, tuple(r["items"])))


class TestEntropy(unittest.TestCase):
    def test_bits(self):
        self.assertEqual(sequences.entropy({"a": 1}), 0.0)
        self.assertEqual(sequences.entropy({"a": 1, "b": 1}), 1.0)
        self.assertEqual(sequences.entropy({"a": 1, "b": 1, "c": 1, "d": 1}), 2.0)
        self.assertEqual(sequences.entropy({}), 0.0)


class TestCompletions(unittest.TestCase):
    def test_never_completes_a_whole_name(self):
        # `out_of_scope -> out_of_scope` was in the first table 400 times over,
        # because the prefix loop runs up to the name's own length.
        rows = sequences.completions(["out_of_scope", "reinforcement", "reinforced"], min_count=1)
        for r in rows:
            self.assertTrue(any(len(n) > len(r["prefix"]) for n in r["names"]), r)

    def test_certain_is_one_continuation(self):
        rows = sequences.completions(["loginToken", "refreshSession"], min_count=1)
        certain = [r for r in rows if r["certain"]]
        self.assertTrue(certain)
        for r in certain:
            self.assertEqual(len(r["names"]), 1)
            self.assertEqual(r["entropy"], 0.0)

    def test_entropy_orders_the_table(self):
        rows = sequences.completions(["abcd", "abce", "abcf", "zzzz"], min_count=1)
        self.assertEqual(rows, sorted(rows, key=lambda r: (r["entropy"], -len(r["prefix"]))))


if __name__ == "__main__":
    unittest.main()
