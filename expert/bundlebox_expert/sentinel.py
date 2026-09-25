"""sentinel — the overseer's decisions, deterministic and stdlib only.

The JavaScript side gathers the evidence (the store, git, gh, the kernel) and
owns every side effect. This module decides, from that evidence alone:

  tier     which findings the free path closes, which a person applies, and
           which few go to agents (A6), with d, the share closable for free
  step     one autonomy-ladder transition for a fix type (A5)
  phases   which phases a run takes, and why each one that is skipped is
  round    whether a PR gets another review lane, waits, or needs a person (A3)

Each op mirrors a JS fallback in src/sentinel/ line for line, and
test/sentinel.test.js pins the two against each other.
"""
from __future__ import annotations

SEVERITY = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
OUTCOMES = ("merged", "rejected", "reverted")


def tier_of(f: dict, sets: dict) -> str:
    a = f.get("auto_fix")
    if a and a in sets["certain"]:
        return "free"
    if a and a in sets["actuators"] and a not in sets["plan_only"] and a not in sets["destructive"]:
        return "local"
    return "agent"


def tier(findings: list, sets: dict, top: int) -> dict:
    s = {k: set(sets.get(k) or []) for k in ("certain", "actuators", "plan_only", "destructive")}
    opened = [f for f in findings if f.get("status") == "open"]
    by = {"free": [], "local": [], "agent": []}
    for f in opened:
        by[tier_of(f, s)].append(f)
    promotable = [f for f in by["agent"] if f.get("promote", True)]
    promotable.sort(key=lambda f: (-SEVERITY.get(f.get("severity"), 0), float(f.get("est_tokens") or 0), str(f.get("id"))))
    n = max(0, int(top or 0))
    agent = promotable[:n]
    counts: dict = {}
    for f in opened:
        c = counts.setdefault(f.get("detector"), {"detector": f.get("detector"), "open": 0, "closable": 0, "certain": 0})
        c["open"] += 1
        t = tier_of(f, s)
        if t != "agent":
            c["closable"] += 1
        if t == "free":
            c["certain"] += 1
    detectors = sorted(counts.values(), key=lambda c: (-c["certain"], -c["closable"], -c["open"]))
    d = round((len(by["free"]) + len(by["local"])) / len(opened), 3) if opened else 0
    return {"open": len(opened), "free": [f["id"] for f in by["free"]], "local": [f["id"] for f in by["local"]],
            "agent": [f["id"] for f in agent], "held": len(by["agent"]) - len(agent), "detectors": detectors, "d": d}


def step(t: dict | None, outcome: str, k: int) -> dict:
    n = {"streak": 0, "merged": 0, "rejected": 0, "reverted": 0, "level": "draft", "last": ""}
    n.update(t or {})
    if outcome == "merged":
        n["merged"] += 1
        n["streak"] += 1
    elif outcome in ("rejected", "reverted"):
        n[outcome] += 1
        n["streak"] = 0
    n["level"] = "auto" if n["streak"] >= k else "draft"
    n["last"] = outcome
    return n


def phases(state: dict) -> dict:
    """Which phases run. Every skipped one names the fact that skipped it."""
    run, skip = [], {}
    run.append("sync")
    run.append("scan")
    run.append("rank")
    if state.get("free", 0) > 0 or state.get("scripts", 0) > 0:
        run.append("autofix")
    else:
        skip["autofix"] = "no certain finding and no @safe script tagged @fixes for an open detector"
    if not state.get("spend"):
        skip["sprint"] = skip["review"] = "no --spend"
    elif not state.get("spend_ok"):
        skip["sprint"] = skip["review"] = "spend keys not set: " + ", ".join(state.get("missing") or [])
    else:
        if state.get("agent", 0) > 0:
            run.append("sprint")
        else:
            skip["sprint"] = "nothing in the agent tier"
        run.append("review")
    return {"run": run, "skip": skip}


def round_(s: dict) -> dict:
    """One PR's next review step."""
    if not s.get("changes") and not s.get("failed"):
        return {"state": "clean"}
    if int(s.get("rounds") or 0) >= int(s.get("max") or 3):
        return {"state": "needs-human", "why": f"{s.get('rounds')} rounds, the cap is {s.get('max')}"}
    if s.get("sig") and s.get("sig") == s.get("last_sig"):
        return {"state": "waiting", "why": "no new feedback since the last round"}
    if not s.get("writable"):
        return {"state": "refused", "why": "not a bb/ branch"}
    return {"state": "run", "round": int(s.get("rounds") or 0) + 1}


def dispatch(inp: dict) -> dict:
    op = str(inp.get("op") or "")
    if op == "tier":
        return tier(inp.get("findings") or [], inp.get("sets") or {}, int(inp.get("top") or 0))
    if op == "step":
        if inp.get("outcome") not in OUTCOMES:
            return {"error": f"outcome must be one of {', '.join(OUTCOMES)}"}
        return step(inp.get("current"), inp["outcome"], max(1, int(inp.get("k") or 5)))
    if op == "phases":
        return phases(inp.get("state") or {})
    if op == "round":
        return round_(inp.get("state") or {})
    return {"error": f"unknown sentinel op {op!r}", "ops": ["tier", "step", "phases", "round"]}
