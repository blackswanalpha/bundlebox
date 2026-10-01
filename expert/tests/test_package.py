"""The package surface: "__init__.py" carries the version and "__main__.py" is the
one-verb-per-call CLI the Node side spawns."""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import bundlebox_expert  # noqa: E402
from bundlebox_expert import __main__ as cli  # noqa: E402

ENV = {**os.environ, "PYTHONPATH": HERE}


def run(*argv, stdin=""):
    r = subprocess.run([sys.executable, "-m", "bundlebox_expert", *argv], input=stdin, capture_output=True, text=True, env=ENV)
    return r.returncode, json.loads(r.stdout) if r.stdout.strip() else None


class Package(unittest.TestCase):
    def test_version_verb_reports_the_init_version_without_reading_stdin(self):
        self.assertTrue(os.path.isfile(os.path.join(HERE, "bundlebox_expert", "__init__.py")))
        self.assertEqual(run("version"), (0, {"version": bundlebox_expert.__version__}))

    def test_an_unknown_verb_exits_2_and_lists_the_verbs(self):
        rc, out = run("nope")
        self.assertEqual(rc, 2)
        self.assertIn("nope", out["error"])
        self.assertIn("triage", out["verbs"])

    def test_every_listed_verb_is_dispatched(self):
        self.assertTrue(os.path.isfile(os.path.join(HERE, "bundlebox_expert", "__main__.py")))
        _, out = run("nope")
        with open(cli.__file__) as fh:
            src = fh.read()
        missing = [v for v in out["verbs"] if f'"{v}"' not in src.split("else:")[0] and v != "version"]
        self.assertEqual(missing, [], "listed verbs with no branch")

    def test_empty_stdin_is_an_empty_object_and_confidence_answers_per_rule(self):
        self.assertEqual(run("signals"), (0, {"sessions": [], "aggregate": run("signals", stdin="{}")[1]["aggregate"]}))
        rc, out = run("confidence", stdin=json.dumps({"rules": {"r": {"precision": "exact"}}}))
        self.assertEqual((rc, out["r"]["confidence"]), (0, 0.95))


if __name__ == "__main__":
    unittest.main()
