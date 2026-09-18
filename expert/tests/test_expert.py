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
from bundlebox_expert import confidence, coverage, memory, model, rules, scenarios, signals, throttle, triage, world  # noqa: E402


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

    def test_memory_consolidates_many_episodic_rows_into_one_semantic_claim(self):
        with tempfile.TemporaryDirectory() as d:
            for n in ("a.js", "b.js", "c.js", "d.js"):
                open(os.path.join(d, n), "w").close()
            sig = {"top_reread_files": [[n, 4] for n in ("a.js", "b.js", "c.js", "d.js")]}
            claims = memory.derive(sig, [], [], d, "2026-09-13T00:00:00")
            tiers = {c["tier"] for c in claims}
            self.assertIn("semantic", tiers)
            semantic = [c for c in claims if c["tier"] == "semantic"][0]
            self.assertEqual(len(semantic["consolidates"]), 4)
            # The read path must not bill for the four rows AND the sentence that folds them.
            r = memory.recall(claims, "hot files")
            self.assertEqual(r["suppressed"], 4, r)
            self.assertEqual([c["key"] for c in r["claims"]], ["set/hot"])

    def test_memory_supersession_keeps_a_tombstone_and_recency_wins(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "a.js"), "w").close()
            old = memory.derive({"top_reread_files": [["a.js", 2]]}, [], [], d, "2026-09-13T00:00:00")
            new = memory.derive({"top_reread_files": [["a.js", 9]]}, [], [], d, "2026-09-14T00:00:00")
            r = memory.reconcile(old, new, "2026-09-14T00:00:00")
            self.assertEqual(len(r["claims"]), 1)
            self.assertIn("9 times", r["claims"][0]["claim"])
            self.assertEqual([t["reason"] for t in r["tombstones"]], ["superseded"])
            self.assertIn("2 times", r["tombstones"][0]["claim"])

    def test_memory_reinforcement_survives_regeneration_and_is_capped(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "a.js"), "w").close()
            sig = {"top_reread_files": [["a.js", 2]]}
            claims = memory.derive(sig, [], [], d, "2026-09-13T00:00:00")
            memory.reinforce(claims, ["file/a.js"], useful=True)
            again = memory.derive(sig, [], [], d, "2026-09-13T00:00:00")
            kept = memory.reconcile(claims, again, "2026-09-13T00:00:00")["claims"][0]
            self.assertEqual((kept["uses"], kept["useful"]), (1, 1))
            self.assertEqual(memory.reinforcement({"uses": 999, "useful": 999}), memory.REINFORCE_CAP)

    def test_throttle_defers_rather_than_drops_and_is_stable(self):
        rows = [{"id": f"d{i}", "detector": "dead-exports", "promote": True, "priority": 3, "ev": 10, "est_tokens": 5000} for i in range(9)]
        rows.append({"id": "g", "detector": "god-file", "promote": True, "priority": 0, "ev": 90, "est_tokens": 4000})
        r = throttle.apply(rows)
        self.assertEqual(len(r["promoted"]) + len(r["deferred"]), 10, "nothing is dropped")
        self.assertEqual(r["promoted"][0]["id"], "g", "priority 0 goes first")
        self.assertEqual([d["id"] for d in r["deferred"]], [d["id"] for d in throttle.apply(rows)["deferred"]], "stable")

    def test_throttle_cooldown_comes_from_outcomes_not_opinion(self):
        h = throttle.cooldowns([{"detectors": ["god-file"], "verdict": "broken", "scored_at": "2026-09-13"},
                                {"detectors": ["doc-links"], "verdict": "held", "scored_at": "2026-09-13"}])
        self.assertEqual(h["god-file"]["cooldown"], throttle.THROTTLE["cooldown_runs"])
        self.assertEqual(h["doc-links"]["cooldown"], 0)
        r = throttle.apply([{"id": "x", "detector": "god-file", "promote": True, "priority": 0, "ev": 9, "est_tokens": 10}], history=h)
        self.assertEqual(r["promoted"], [])
        self.assertIn("cooldown", r["deferred"][0]["throttle_reason"])

    def test_model_refuses_a_label_that_is_a_function_of_the_verb(self):
        leaky = [{"verb": v, "prev": "-", "at": f"2026-01-{i % 28 + 1:02d}", "useful": 1 if v == "scan" else 0,
                  "features": {"inputs": i}} for i, v in enumerate(["scan", "route"] * 15)]
        m = model.train(leaky)
        self.assertFalse(m["useful"])
        self.assertEqual(m["verb_accuracy"], 1.0)
        self.assertIn("function of the verb", m["why"])

    def test_cli_round_trip(self):
        r = subprocess.run([sys.executable, "-m", "bundlebox_expert", "rules"], input=json.dumps({"signals": {}}), capture_output=True, text=True, env={**os.environ, "PYTHONPATH": HERE})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["verdict"], "lean")


class Coverage(unittest.TestCase):
    """The matcher that decides whether a corpus exercises what a document declares.

    Every check here is a shape that once reported the wrong number silently:
    100% from a single step, 0% from a corpus that covered everything, a
    permanent gap for a command no corpus may run, and a phantom route that was
    really a deliberate 404 probe.
    """

    def test_one_command_does_not_cover_every_command(self):
        # The original rule matched on the first token, so `bb scan` covered
        # `bb compile` and a one-step corpus read as 100%.
        self.assertTrue(coverage.match_cmd("bb scan", "bb scan --json"))
        self.assertFalse(coverage.match_cmd("bb compile", "bb scan --json"))
        self.assertTrue(coverage.match_cmd("bb cookbook", "bb cookbook run --base x"))

    def test_a_checkout_invocation_is_the_same_capability_as_the_documented_one(self):
        for called in ["node bin/bb.js scan", "./bin/bb.js scan", "timeout 10 node bin/bb.js scan",
                       "BB_KERNEL=/nope node bin/bb.js scan --json"]:
            self.assertTrue(coverage.match_cmd("bb scan", called), called)

    def test_a_declared_flag_must_actually_have_been_passed(self):
        # `--apply` is the difference between a report and a change; a corpus
        # that ran the dry half must not report the apply half as covered.
        self.assertFalse(coverage.match_cmd("bb run --apply", "node bin/bb.js run"))
        self.assertTrue(coverage.match_cmd("bb run --apply", "node bin/bb.js run --apply"))

    def test_every_segment_of_a_shell_line_is_a_call(self):
        self.assertTrue(coverage.match_cmd("bb update", "node bin/bb.js update; test $? -le 2"))
        self.assertTrue(coverage.match_cmd("bb mcp", "printf x | timeout 5 node bin/bb.js mcp | head -1"))

    def test_an_excluded_capability_leaves_the_denominator_with_its_reason(self):
        w = {"capabilities": [
            {"id": "cmd:bb scan", "kind": "cmd", "cmd": "bb scan", "surface": ""},
            {"id": "cmd:bb run --apply", "kind": "cmd", "cmd": "bb run --apply", "surface": ""},
        ], "rules": []}
        c = {"scenarios": [{"id": "s1", "steps": [{"run": "node bin/bb.js scan"}]}],
             "excluded": [{"match": "bb run --apply", "why": "it spends"}]}
        p = coverage.plan(w, c)
        self.assertEqual(p["declared"], 1)
        self.assertEqual(p["declared_total"], 2)
        self.assertEqual(p["coverage_pct"], 100.0)
        self.assertEqual(p["excluded"][0]["why"], "it spends")

    def test_a_404_probe_is_not_a_phantom_route(self):
        w = {"capabilities": [{"id": "http:GET /health", "kind": "http", "method": "GET", "path": "/health", "surface": ""}], "rules": []}
        c = {"scenarios": [{"id": "s1", "steps": [
            {"do": "GET /health", "expect": {"status": 200}},
            {"do": "GET /api/write", "expect": {"status": 404}},
        ]}]}
        self.assertEqual(coverage.plan(w, c)["phantom_calls"], [])

    def test_a_route_that_is_really_missing_is_still_reported(self):
        w = {"capabilities": [{"id": "http:GET /health", "kind": "http", "method": "GET", "path": "/health", "surface": ""}], "rules": []}
        c = {"scenarios": [{"id": "s1", "steps": [{"do": "GET /ghost", "expect": {"status": 200}}]}]}
        self.assertEqual(coverage.plan(w, c)["phantom_calls"], ["GET /ghost"])


class World(unittest.TestCase):
    def test_a_formula_and_a_cd_are_not_capabilities(self):
        # Both were extracted as commands and stayed permanently uncovered,
        # pulling the coverage percentage down for a reason no corpus could fix.
        self.assertEqual(world._clean_cmd("projected = overhead + brief + payload x churn"), "")
        self.assertEqual(world._clean_cmd("cd your-repo"), "")
        self.assertEqual(world._clean_cmd("and the scenario runner, the load simulator"), "")
        self.assertEqual(world._clean_cmd("bb scan --json"), "bb scan --json")


def _world(n_boards, red_ids, n=6):
    """A corpus of `n` scenarios and `n_boards` boards in which `red_ids` are the
    ones that ever go red. Board k is stamped k days apart so staleness moves."""
    scen = [{"id": "s%d" % i, "surface": "x", "severity": "high", "steps": [{}] * (i + 1)} for i in range(n)]
    boards = []
    for k in range(n_boards):
        boards.append({"at": "2026-09-%02dT00:00:00" % (k + 1), "scenarios": [
            {"id": s["id"], "state": "failed" if s["id"] in red_ids else "passed"} for s in scen]})
    return scen, boards


class Replay(unittest.TestCase):
    def test_a_board_with_nothing_red_is_not_scored_rather_than_scored_zero(self):
        # Scoring a green board as 0 would drag every candidate's mean toward
        # whichever vector spends least, which is the vector that runs nothing.
        scen, boards = _world(3, red_ids=set())
        r = scenarios.replay(scen, boards[:1], boards[1])
        self.assertFalse(r["scored"])
        self.assertIsNone(r["score"])

    def test_replay_scores_the_set_and_never_executes_anything(self):
        scen, boards = _world(3, red_ids={"s0"})
        r = scenarios.replay(scen, boards[:2], boards[2], budget_steps=0)
        self.assertTrue(r["scored"])
        self.assertEqual(r["red"], 1)
        self.assertEqual(r["caught"], 1)          # no budget: everything is picked
        self.assertEqual(r["recall"], 1.0)
        self.assertEqual(r["steps"], r["steps_total"])

    def test_a_budget_that_cannot_hold_the_corpus_trades_recall_for_steps(self):
        scen, boards = _world(4, red_ids={"s5"}, n=6)
        wide = scenarios.replay(scen, boards[:3], boards[3], budget_steps=0)
        tight = scenarios.replay(scen, boards[:3], boards[3], budget_steps=3)
        self.assertLess(tight["steps"], wide["steps"])
        self.assertLessEqual(tight["recall"], wide["recall"])


class Calibrate(unittest.TestCase):
    def test_too_little_history_returns_the_shipped_weights_and_says_why(self):
        scen, boards = _world(3, red_ids={"s0"})
        r = scenarios.calibrate(scen, boards)
        self.assertFalse(r["ok"])
        self.assertEqual(r["weights"], scenarios.WEIGHTS)
        self.assertIn("need", r)

    def test_the_fit_is_never_worse_than_the_shipped_vector(self):
        # The shipped weights are candidate zero and the search takes the max,
        # so this is structural. It is asserted because a refactor that drops
        # candidate zero would silently make `--apply` a downgrade.
        scen, boards = _world(8, red_ids={"s0", "s4"})
        r = scenarios.calibrate(scen, boards, budget_steps=4)
        self.assertTrue(r["ok"], r.get("why"))
        self.assertGreaterEqual(r["score_after"], r["score_before"])
        self.assertEqual(r["shipped"], scenarios.WEIGHTS)

    def test_every_score_is_out_of_sample(self):
        # Board i is scored by a policy that saw boards[:i] only. If the fit
        # ever reads the board it is scored on, a vector that memorises the
        # history wins and the number stops predicting anything.
        scen, boards = _world(8, red_ids={"s1"})
        r = scenarios.calibrate(scen, boards, budget_steps=4)
        self.assertEqual(len(r["per_board"]), r["scored"])
        self.assertEqual([b["at"] for b in r["per_board"]], [b["at"] for b in boards[1:]])


def _f(i, closed_by, severity="high", tokens=1000, detector="x"):
    return {"id": "f%d" % i, "detector": detector, "severity": severity, "precision": "exact",
            "status": "resolved", "closed_by": closed_by, "est_tokens": tokens, "files": ["a.js"]}


class Triage(unittest.TestCase):
    def test_an_unknown_closure_is_not_a_sample(self):
        rows = [_f(1, "acted_on"), _f(2, "unknown"), _f(3, None), dict(_f(4, "acted_on"), status="open")]
        self.assertEqual([f["id"] for f in triage.scorable(rows)], ["f1"])

    def test_waste_is_a_share_of_the_corpus_not_of_what_was_promoted(self):
        # The first fit on this workspace answered "promote everything": waste
        # normalised by the promoted set is a RATE, and a rate cannot punish
        # promoting more. Against the whole corpus it can.
        rows = [_f(1, "acted_on"), *[_f(i, "unchanged") for i in range(2, 11)]]
        wide = triage.replay(rows, {"promote_at": "low"})
        narrow = triage.replay(rows, {"promote_at": "critical"})
        self.assertEqual(wide["budget"], narrow["budget"])
        self.assertGreater(wide["waste_share"], narrow["waste_share"])

    def test_calibrate_refuses_below_the_floor_and_says_what_it_needs(self):
        r = triage.calibrate([_f(1, "acted_on"), _f(2, "unchanged")])
        self.assertFalse(r["ok"])
        self.assertEqual(r["policy"], triage.POLICY)
        self.assertIn("need", r)

    def test_the_fit_is_never_worse_than_the_shipped_rule(self):
        rows = [*[_f(i, "acted_on") for i in range(20)], *[_f(100 + i, "unchanged") for i in range(20)]]
        r = triage.calibrate(rows)
        self.assertTrue(r["ok"], r.get("why"))
        self.assertGreaterEqual(r["score_after"], r["score_before"])
        self.assertEqual(r["shipped"], triage.POLICY)

    def test_the_cost_it_trades_against_is_an_input_and_steers_the_answer(self):
        # Cheap tokens buy recall; dear tokens buy precision. A fit that gave
        # the same policy either way would not be trading anything.
        rows = [*[_f(i, "acted_on", severity="low") for i in range(20)],
                *[_f(100 + i, "unchanged", severity="low", tokens=40000) for i in range(30)]]
        cheap = triage.calibrate(rows, cost_penalty=0.05)
        dear = triage.calibrate(rows, cost_penalty=20.0)
        self.assertTrue(cheap["ok"] and dear["ok"])
        self.assertNotEqual(cheap["policy"], dear["policy"])

    def test_the_search_leaves_the_shipped_rule_on_a_tie(self):
        # Every neighbour scores the same when nothing was ever acted on... so
        # the floor catches it first. With one positive above the floor and no
        # separation, a tie must not move the policy.
        rows = [*[_f(i, "acted_on") for i in range(14)]]
        r = triage.calibrate(rows)
        self.assertTrue(r["ok"])
        self.assertGreaterEqual(r["score_after"], r["score_before"])


if __name__ == "__main__":
    unittest.main()
