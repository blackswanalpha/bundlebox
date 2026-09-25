"""signals.py: per-session ratios with named denominators, and the per-kind split."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import signals  # noqa: E402


def turn(uses=(), results=(), **kw):
    return {"msgId": kw.pop("msgId", "m"), "toolUses": list(uses), "toolResults": list(results), **kw}


class Signals(unittest.TestCase):
    def test_bash_reads_count_as_reads_and_flags_are_not_files(self):
        self.assertEqual(signals._files_in_command("cat -n a.js | head -5; sed -n 1,20p 'b.py'"), ["a.js", "b.py"])

    def test_rereads_repeats_errors_and_retries(self):
        turns = [
            turn([{"name": "Read", "input": {"file_path": "a.js"}}], [{"chars": 9000}]),
            turn([{"name": "Bash", "input": {"command": "cat a.js"}}, {"name": "Grep", "input": {}}], [{"chars": 1000, "error": True, "key": "k"}]),
            turn([{"name": "Bash", "input": {"command": "cat a.js"}}], [{"chars": 0, "error": True, "key": "k"}]),
        ]
        s = signals.session_signals(turns)
        self.assertEqual((s["reads"], s["searches"], s["tool_calls"]), (3, 1, 4))
        self.assertAlmostEqual(s["reread_ratio"], 2 / 3)
        self.assertEqual(s["top_reread_files"], [("a.js", 3)])
        self.assertAlmostEqual(s["repeat_cmd_ratio"], 1 / 4)
        self.assertAlmostEqual(s["error_ratio"], 2 / 3)
        self.assertEqual(s["retry_ratio"], 0.5)
        self.assertAlmostEqual(s["fat_chars_share"], 0.9)

    def test_a_compaction_is_counted_not_read_as_a_falling_slope(self):
        ws = [1000, 2000, 3000, 4000, 500, 1500, 2500]
        s = signals.session_signals([{"msgId": str(i), "input": w} for i, w in enumerate(ws)])
        self.assertEqual(s["compactions"], 1)
        self.assertGreater(s["ctx_slope"], 0)
        self.assertEqual(s["ctx_peak"], 4000)

    def test_aggregate_splits_by_kind_only_when_there_are_two_kinds(self):
        a = {"reread_ratio": 0.2, "kind": "fix", "long": True}
        b = {"reread_ratio": 0.4, "kind": "fix"}
        one = signals.aggregate([a, b])
        self.assertEqual((one["by_kind"], one["kinds_seen"], one["long_session_share"]), ({}, ["fix"], 0.5))
        two = signals.aggregate([a, dict(b, kind="investigate")])
        self.assertEqual(sorted(two["by_kind"]), ["fix", "investigate"])
        self.assertEqual(two["by_kind"]["fix"]["reread_ratio"], 0.2)
        self.assertIsNone(signals.aggregate([])["long_session_share"])


if __name__ == "__main__":
    unittest.main()
