"""space.py: tokenisation, the build refusals, and the distance that says unmeasured."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import space  # noqa: E402


class Space(unittest.TestCase):
    def test_terms_drops_stopwords_and_short_words_and_splits_camel_case(self):
        self.assertEqual(space.terms("fix the laneModel in router"), ["lanemodel", "lane", "model", "router"])
        self.assertEqual(space.terms(None), [])

    def test_path_terms_keeps_directories_and_stem_not_extension(self):
        self.assertEqual(space.path_terms("src/pinpoint/rankTable.js"), ["src", "pinpoint", "ranktable", "rank", "table"])

    def test_rows_parse_only_symbol_file_line_rows(self):
        R = space.rows({"t": "# header\nlaneModel src/router.js:12\nnot a row\n"})
        self.assertEqual(len(R), 1)
        self.assertEqual(R[0][:2], ("laneModel", "src/router.js"))
        self.assertIn("router", R[0][2])

    def test_build_refuses_too_few_rows_and_too_few_shared_terms(self):
        self.assertIn("need 8", space.build({"t": "a src/x.js:1"})["why"])
        lonely = "\n".join(f"sym{i}Alpha{i} d{i}/f{i}.js:{i}" for i in range(10))
        out = space.build({"t": lonely})
        self.assertFalse(out["useful"])
        self.assertIn("shared terms", out["why"])

    def test_distance_is_none_without_coverage_and_one_for_the_same_set(self):
        sp = {"k": 2, "terms": {"wire": [1.0, 0.0], "guard": [0.0, 1.0]}}
        self.assertEqual(space.distance(sp, ["wire"], ["wire"]), 1.0)
        self.assertEqual(space.distance(sp, ["wire"], ["guard"]), 0.0)
        self.assertIsNone(space.distance(sp, ["wire"], ["guard", "zzz", "qqq"]), "one known word in three is unmeasured")
        self.assertIsNone(space.distance(sp, [], ["wire"]))


if __name__ == "__main__":
    unittest.main()
