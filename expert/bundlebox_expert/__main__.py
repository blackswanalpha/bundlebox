"""python3 -m bundlebox_expert <verb>   JSON in on stdin, JSON out on stdout."""
from __future__ import annotations
import json
import sys
import time

from . import __version__, confidence, coverage, graph, memory, model, rules, scenarios, sequences, signals, throttle, triage, world


def main(argv: list) -> int:
    verb = argv[0] if argv else ""
    if verb == "version":
        print(json.dumps({"version": __version__}))
        return 0
    raw = sys.stdin.read()
    inp = json.loads(raw) if raw.strip() else {}
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    if verb == "triage":
        out = [triage.triage(f, inp.get("cfg"), inp.get("history")) for f in inp.get("findings", [])]
    elif verb == "triage-replay":
        out = triage.replay(triage.scorable(inp.get("findings") or []), inp.get("policy"), inp.get("cfg"),
                            inp.get("history"), float(inp.get("cost_penalty", triage.TRIAGE_COST)))
    elif verb == "triage-calibrate":
        out = triage.calibrate(inp.get("findings") or [], inp.get("cfg"), inp.get("history"),
                               float(inp.get("cost_penalty", triage.TRIAGE_COST)),
                               int(inp.get("min_acted", triage.MIN_ACTED)))
    elif verb == "confidence":
        out = {k: confidence.for_rule(v.get("precision", "heuristic"), v.get("held", 0), v.get("weak", 0), v.get("broken", 0)) for k, v in inp.get("rules", {}).items()}
    elif verb == "signals":
        per = [dict(signals.session_signals(s.get("turns", [])), session_id=s.get("session_id"), interrupts=s.get("interrupts", 0)) for s in inp.get("sessions", [])]
        out = {"sessions": per, "aggregate": signals.aggregate(per)}
    elif verb == "rules":
        out = rules.decide(inp.get("signals", {}), inp.get("thresholds"))
    elif verb == "graph":
        out = graph.build(inp.get("episodes", []))
    elif verb == "sequences":
        out = {"patterns": sequences.mine(inp.get("sequences") or [], int(inp.get("min_support", sequences.MIN_SUPPORT)),
                                          int(inp.get("max_len", sequences.MAX_LEN)))}
    elif verb == "completions":
        out = {"prefixes": sequences.completions(inp.get("names") or [], int(inp.get("min_prefix", 3)),
                                                 int(inp.get("max_prefix", 12)), int(inp.get("min_count", 2)))}
    elif verb == "model-train":
        eps = inp.get("episodes", [])
        out = model.train(eps, graph.build(eps).get("lift"))
    elif verb == "model-predict":
        out = model.predict(inp.get("model") or {}, inp.get("episode") or {}, inp.get("lift"))
    elif verb == "memory-derive":
        fresh = memory.derive(inp.get("signals") or {}, inp.get("episodes") or [], inp.get("scripts") or [],
                              inp.get("root", "."), now_iso, inp.get("recommendations") or [])
        out = memory.reconcile(inp.get("old") or [], fresh, now_iso, tombstones=inp.get("tombstones") or [])
    elif verb == "memory-recall":
        out = memory.recall(inp.get("claims") or [], inp.get("about", ""), int(inp.get("budget_tokens", 1100)),
                            tiers=inp.get("tiers"))
    elif verb == "memory-reinforce":
        out = memory.reinforce(inp.get("claims") or [], inp.get("keys") or [], bool(inp.get("useful")), now_iso)
    elif verb == "throttle":
        out = throttle.apply(inp.get("decisions") or [], inp.get("cfg"), inp.get("history") or throttle.cooldowns(inp.get("outcomes") or []))
    elif verb == "world-derive":
        out = world.derive(inp.get("text", ""), inp.get("name", ""), inp.get("base", ""))
    elif verb == "coverage-plan":
        out = coverage.plan(inp.get("world") or {}, inp.get("corpus") or {}, int(inp.get("limit", 40)))
    elif verb == "scenario-select":
        out = scenarios.select(inp.get("scenarios") or [], inp.get("boards") or [], int(inp.get("budget_steps", 0)),
                               inp.get("now") or now_iso, inp.get("weights"))
    elif verb == "scenario-replay":
        out = scenarios.replay(inp.get("scenarios") or [], inp.get("boards") or [], inp.get("board") or {},
                               inp.get("weights"), int(inp.get("budget_steps", 0)),
                               float(inp.get("cost_penalty", scenarios.REPLAY_COST)))
    elif verb == "scenario-calibrate":
        out = scenarios.calibrate(inp.get("scenarios") or [], inp.get("boards") or [], int(inp.get("budget_steps", 0)),
                                  float(inp.get("cost_penalty", scenarios.REPLAY_COST)),
                                  int(inp.get("min_boards", scenarios.MIN_BOARDS)))
    elif verb == "board-verdicts":
        out = scenarios.verdicts(inp.get("board") or {}, inp.get("thresholds"), inp.get("previous"))
    elif verb == "thresholds":
        out = {"defaults": rules.THRESHOLDS, "throttle": throttle.limits(inp.get("cfg")), "board": scenarios.THRESHOLDS}
    else:
        print(json.dumps({"error": f"unknown verb {verb!r}", "verbs": ["version", "triage", "triage-replay", "triage-calibrate", "confidence", "signals", "rules", "graph", "model-train", "model-predict", "memory-derive", "memory-recall", "memory-reinforce", "throttle", "thresholds", "world-derive", "coverage-plan", "scenario-select", "scenario-replay", "scenario-calibrate", "board-verdicts"]}))
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
