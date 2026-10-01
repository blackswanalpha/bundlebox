"""world.py: a document and a finding row read into the same world shape."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import world  # noqa: E402

DOC = """# Billing

Users must never see another tenant invoice.

```bash
bb scan --json
```

GET /api/invoices/{id} returns one invoice.
"""


class World(unittest.TestCase):
    def test_derive_reads_a_rule_a_command_and_a_route_under_their_heading(self):
        w = world.derive(DOC, name="x")
        self.assertEqual([s["id"] for s in w["surfaces"]], ["billing"])
        self.assertEqual([(r["modality"], r["line"]) for r in w["rules"]], [("must_not", 3)])
        caps = {c["kind"]: c for c in w["capabilities"]}
        self.assertEqual(caps["cmd"]["cmd"], "bb scan --json")
        self.assertEqual((caps["http"]["method"], caps["http"]["path"], caps["http"]["tier"]), ("GET", "/api/invoices/{id}", "complex"))
        self.assertTrue(all(c["surface"] == "billing" for c in w["capabilities"]))

    def test_tier_comes_from_the_capability_shape(self):
        self.assertEqual(world.tier_of("GET", "/api/health"), "simple")
        self.assertEqual(world.tier_of("GET", "/api/items/{id}"), "complex")
        self.assertEqual(world.tier_of("POST", "/api/items"), "complex")
        self.assertEqual(world.tier_of("GET", "/api/members"), "complicated", "a multi-party word outranks the verb")

    def test_slug_trims_and_caps(self):
        self.assertEqual(world.slug("  Hello, World!  "), "hello-world")
        self.assertEqual(len(world.slug("a" * 99)), 40)

    def test_derive_row_takes_surface_and_rule_from_the_fields_and_names_what_it_lacks(self):
        r = world.derive_row({"title": "big thing", "path": "src/a/b.js", "detector": "big-file", "id": "abc",
                              "evidence": {"z": ["q" * 300], "a": "first"}})
        self.assertEqual([s["id"] for s in r["surfaces"]], ["b"])
        self.assertEqual((r["rules"][0]["text"], r["rules"][0]["modality"], r["rules"][0]["why"]), ("big thing", "must", "finding abc"))
        self.assertEqual(r["row"], {"kind": "finding", "id": "abc", "path": "src/a/b.js", "detector": "big-file"})
        self.assertEqual(r["source"].splitlines()[1], "first", "evidence walks keys sorted")
        self.assertEqual(len(r["source"].splitlines()[2]), 200, "evidence lines are capped")
        self.assertTrue(any("no detail" in u for u in r["unknown"]))
        self.assertTrue(any("no route and no command" in u for u in r["unknown"]))

    def test_derive_row_keeps_a_stated_modality_over_must(self):
        r = world.derive_row({"title": "t", "detail": "The handler must never log a token.", "path": "src/x.js"})
        self.assertEqual(r["rules"][0]["modality"], "must_not")
        self.assertFalse(any("no detail" in u for u in r["unknown"]))


if __name__ == "__main__":
    unittest.main()
