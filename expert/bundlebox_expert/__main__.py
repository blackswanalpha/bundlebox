"""python3 -m bundlebox_expert <verb>   JSON in on stdin, JSON out on stdout."""
from __future__ import annotations
import json
import sys
import time

from . import __version__, confidence, graph, memory, model, rules, signals, triage


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
    elif verb == "confidence":
        out = {k: confidence.for_rule(v.get("precision", "heuristic"), v.get("held", 0), v.get("weak", 0), v.get("broken", 0)) for k, v in inp.get("rules", {}).items()}
    elif verb == "signals":
        per = [dict(signals.session_signals(s.get("turns", [])), session_id=s.get("session_id"), interrupts=s.get("interrupts", 0)) for s in inp.get("sessions", [])]
        out = {"sessions": per, "aggregate": signals.aggregate(per)}
    elif verb == "rules":
        out = rules.decide(inp.get("signals", {}), inp.get("thresholds"))
    elif verb == "graph":
        out = graph.build(inp.get("episodes", []))
    elif verb == "model-train":
        eps = inp.get("episodes", [])
        out = model.train(eps, graph.build(eps).get("lift"))
    elif verb == "model-predict":
        out = model.predict(inp.get("model") or {}, inp.get("episode") or {}, inp.get("lift"))
    elif verb == "memory-derive":
        fresh = memory.derive(inp.get("signals") or {}, inp.get("episodes") or [], inp.get("scripts") or [], inp.get("root", "."), now_iso)
        out = {"claims": memory.reconcile(inp.get("old") or [], fresh, now_iso)}
    elif verb == "memory-recall":
        out = memory.recall(inp.get("claims") or [], inp.get("about", ""), int(inp.get("budget_tokens", 1100)))
    elif verb == "thresholds":
        out = {"defaults": rules.THRESHOLDS}
    else:
        print(json.dumps({"error": f"unknown verb {verb!r}", "verbs": ["version", "triage", "confidence", "signals", "rules", "graph", "model-train", "model-predict", "memory-derive", "memory-recall", "thresholds"]}))
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
