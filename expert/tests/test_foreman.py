"""foreman: the responsibility policy over Jev's probabilities or the box's
own evidence. Deterministic, stdlib only, and every action has one path."""
import ast
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from bundlebox_expert import foreman as F  # noqa: E402

SRC = os.path.join(HERE, "bundlebox_expert", "foreman.py")


def turns(n, edit_every=0, file="src/a.js", same=False):
    return [{"tool": "Read", "file": file, "edit": bool(edit_every) and i % edit_every == 0, "hash": "h" if same else f"h{i}"} for i in range(n)]


def quiet():
    """Every check below its bar: nothing proposed but the completion default."""
    return {c["key"]: 0.0 for c in F.checks()}


class Policy(unittest.TestCase):
    def test_every_check_has_a_bar_but_progress_and_keys_are_unique(self):
        cs = F.checks()
        self.assertEqual(len({c["key"] for c in cs}), len(cs))
        self.assertEqual([c["key"] for c in cs if c["min"] is None], ["core.worker-health__meaningful_progress"])

    def test_human_escalation_outranks_everything(self):
        s = dict(quiet(), **{F.key(F.HUMAN, "needs_human"): 0.9, F.key(F.HEALTH, "worker_stuck"): 0.99})
        d = F.decide(s, {"active": True})
        self.assertEqual((d["action"], d["responsibility"]), ("escalate", F.HUMAN))

    def test_warning_steers_once_then_stops_and_waits_out_the_grace_window(self):
        s = dict(quiet(), **{F.key(F.HEALTH, "worker_stuck"): 0.9})
        self.assertEqual(F.decide(s, {"active": True, "steers": 0})["action"], "steer")
        self.assertEqual(F.decide(s, {"active": True, "steers": 1, "turns_since_steer": 2})["action"], "continue")
        self.assertEqual(F.decide(s, {"active": True, "steers": 1, "turns_since_steer": 9})["action"], "stop")
        self.assertEqual(F.decide(s, {"active": True, "steers": 1}, {"max_steers": 3})["action"], "steer")
        self.assertEqual(F.decide(s, {"active": False})["action"], "resume", "no running agent, no warning")

    def test_equal_warnings_break_toward_instructions(self):
        s = dict(quiet(), **{F.key(F.HEALTH, "worker_stuck"): 0.9, F.key(F.INSTRUCTIONS, "instructions_drift"): 0.9})
        self.assertEqual(F.decide(s, {"active": True})["responsibility"], F.INSTRUCTIONS)

    def test_finish_needs_every_bar_and_resolved_verification(self):
        done = dict(quiet(), **{F.key(F.COMPLETION, k): 0.9 for k in ("implementation_complete", "requirements_satisfied", "ready_to_finish")},
                    **{F.key(F.VERIFICATION, "tests_sufficient"): 0.9, F.key(F.VERIFICATION, "needs_verification"): 0.9})
        self.assertEqual(F.decide(done, {})["action"], "verify", "verification comes first and runs once")
        self.assertEqual(F.decide(done, {"verification_started": True})["action"], "resume", "started, not completed")
        self.assertEqual(F.decide(done, {"verification_started": True, "verification_completed": True})["action"], "finish")
        weak = dict(done, **{F.key(F.VERIFICATION, "tests_sufficient"): 0.5})
        self.assertEqual(F.decide(weak, {"verification_started": True, "verification_completed": True})["action"], "resume")

    def test_stop_resumes_until_the_retry_limit_then_escalates(self):
        self.assertEqual(F.decide(quiet(), {"previous": "stop", "retries": 0})["action"], "resume")
        d = F.decide(quiet(), {"previous": "stop", "retries": 2})
        self.assertEqual((d["action"], d["responsibility"]), ("escalate", "foreman.runtime"))

    def test_iteration_limit_escalates(self):
        self.assertEqual(F.decide(quiet(), {"iteration": 50})["action"], "escalate")
        self.assertEqual(F.decide(quiet(), {"iteration": 50}, {"max_iterations": 99})["action"], "resume")

    def test_documentation_is_routed(self):
        s = dict(quiet(), **{F.key(F.DOCUMENTATION, "documentation_sufficient"): 0.1})
        self.assertNotIn(F.DOCUMENTATION, [p["responsibility"] for p in F.decide(s, {})["proposed"]])
        s[F.route_key(F.DOCUMENTATION)] = 0.9
        self.assertEqual(F.decide(s, {})["responsibility"], F.DOCUMENTATION)

    def test_thresholds_and_disabled_come_from_cfg(self):
        s = dict(quiet(), **{F.key(F.HEALTH, "worker_stuck"): 0.7})
        self.assertEqual(F.decide(s, {"active": True})["action"], "continue")
        self.assertEqual(F.decide(s, {"active": True}, {"thresholds": {"core.worker-health__worker_stuck": 0.6}})["action"], "steer")
        s2 = dict(quiet(), **{F.key(F.HUMAN, "needs_human"): 0.99})
        cfg = {"disabled": [F.HUMAN]}
        self.assertEqual(F.decide(s2, {}, cfg)["action"], "resume")
        self.assertNotIn(F.key(F.HUMAN, "needs_human"), F.questions({}, cfg)["questions"])


class Evidence(unittest.TestCase):
    def test_a_loop_without_edits_is_stuck_and_steered(self):
        r = F.assess({"active": True, "turns": turns(15, same=True)})
        self.assertEqual(r["scores"][F.key(F.HEALTH, "worker_stuck")], 1.0)
        self.assertEqual(r["action"], "steer")
        self.assertEqual(r["via"], "evidence")

    def test_out_of_scope_reads_are_off_track_only_with_a_scope(self):
        obs = {"active": True, "turns": turns(6, edit_every=1, file="src/z.js")}
        self.assertEqual(F.assess(obs)["scores"][F.key(F.HEALTH, "work_off_track")], 0.0)
        r = F.assess(dict(obs, scope=["src/a.js"]))
        self.assertEqual(r["scores"][F.key(F.HEALTH, "work_off_track")], 1.0)
        self.assertEqual(r["action"], "steer")

    def test_evidence_verifies_then_finishes_only_after_a_passing_run(self):
        obs = {"active": False, "turns": turns(4, edit_every=1), "git": {"files": ["src/a.js", "test/a.test.js"]}}
        self.assertEqual(F.assess(obs)["action"], "verify")
        passed = dict(obs, verification={"command": "npm test", "ok": True, "current": True})
        self.assertEqual(F.assess(passed)["action"], "finish")
        failed = dict(obs, verification={"command": "npm test", "ok": False, "current": True})
        self.assertEqual(F.assess(failed)["action"], "resume")
        stale = dict(obs, verification={"command": "npm test", "ok": True, "current": False})
        self.assertEqual(F.assess(stale)["action"], "verify", "a pass before the last change verifies nothing")

    def test_jev_overrides_evidence_key_by_key(self):
        obs = {"active": True, "turns": turns(15, same=True)}
        r = F.assess(obs, jev={F.key(F.HEALTH, "worker_stuck"): 0.1, "junk": 1})
        self.assertEqual(r["sources"][F.key(F.HEALTH, "worker_stuck")], "jev")
        self.assertEqual(r["sources"][F.key(F.HUMAN, "needs_human")], "evidence")
        self.assertEqual(r["via"], "mixed")
        self.assertEqual(r["action"], "continue")
        r2 = F.assess(obs, jev={F.key(F.HEALTH, "worker_stuck"): float("nan")})
        self.assertEqual(r2["sources"][F.key(F.HEALTH, "worker_stuck")], "evidence", "NaN is not an answer")

    def test_questions_cover_every_check_and_route_and_keep_the_job(self):
        q = F.questions({"job": "JOB-MARKER", "git": {"diff": "x" * 200000}})
        self.assertEqual(set(q["questions"]), {c["key"] for c in F.checks()} | {r["key"] for r in F.routes()})
        self.assertIn("JOB-MARKER", q["state"])
        self.assertLessEqual(len(q["state"]), F.STATE_CHARS + 40)


class Replay(unittest.TestCase):
    def test_replay_counts_moves_and_labels(self):
        s = dict(quiet(), **{F.key(F.HEALTH, "worker_stuck"): 0.7})
        rows = [{"scores": s, "state": {"active": True}, "action": "continue", "label": "wrong"},
                {"scores": quiet(), "state": {"active": True}, "action": "continue", "label": "right"}]
        same = F.replay(rows)
        self.assertEqual((same["agree"], same["changed"]), (2, []))
        moved = F.replay(rows, {"thresholds": {"core.worker-health__worker_stuck": 0.6}})
        self.assertEqual(moved["changed"], [{"i": 0, "was": "continue", "now": "steer", "label": "wrong"}])
        self.assertEqual((moved["candidate_fixes"], moved["candidate_regressions"], moved["labelled"]), (1, 0, 2))

    def test_deterministic_and_stdlib_only(self):
        obs = {"active": True, "turns": turns(20, edit_every=7), "scope": ["src/a.js"], "git": {"files": ["src/a.js"]}}
        self.assertEqual(F.assess(obs), F.assess(dict(obs)))
        with open(SRC) as fh:
            src = ast.parse(fh.read())
        names = {n.id for n in ast.walk(src) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(src) if isinstance(n, ast.Attribute)}
        for banned in ("time", "random", "environ", "getenv", "open", "datetime"):
            self.assertNotIn(banned, names, f"foreman.py reads {banned}")
        for n in ast.walk(src):
            if isinstance(n, ast.Import):
                self.assertEqual([a.name for a in n.names], ["re"])
            if isinstance(n, ast.ImportFrom):
                self.assertTrue(n.level == 1 or n.module == "__future__", f"foreman.py imports {n.module}")


if __name__ == "__main__":
    unittest.main()
