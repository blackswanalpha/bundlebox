"""scenarios.py — which scenarios to run next, and what a board means.

Two halves of the same loop.

`select()` is the process-learning half. A corpus grows faster than the wall
clock available to run it, so running all of it every time is the thing that
stops happening. The selector ranks by EXPECTED INFORMATION rather than by
order on disk: how often this scenario has been red, how often it has changed
its mind, how long since anything looked, and what it costs in steps — scaled
by the severity of what it is about. Every term is printed beside the score,
because a ranking nobody can read is a ranking nobody will trust enough to run.

`verdicts()` is the judgement half: board metrics against thresholds that live
in a file, each fired rule carrying the facts it fired on. Two of the rules are
deliberately not about the product — blocked steps are the environment and
empty steps are the corpus — because reporting either as a defect is how a
board loses its meaning.
"""
from __future__ import annotations

import time

SEVERITY_WEIGHT = {"critical": 4.0, "high": 3.0, "medium": 2.0, "low": 1.0, "": 1.5}
THRESHOLDS = {
    "red_share_gap": 0.15,        # a surface with more than this share red is a gap
    "surface_score_floor": 60.0,  # a surface scoring below this is friction even with nothing blocked
    "blocked_share_env": 0.10,    # blocked steps above this share is the environment, not the product
    "flip_count_flaky": 3,        # state changes over the boards kept before it is flaky
    "stale_days": 7.0,            # a scenario nobody has run for this long is worth running
    "cost_weight": 0.02,          # per step, subtracted from the value of running it
}
STATE_RED = ("failed", "error")


def _epoch(ts: str) -> float:
    if not ts:
        return 0.0
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return time.mktime(time.strptime(str(ts)[:19], fmt))
        except ValueError:
            continue
    return 0.0


def history(boards: list) -> dict:
    """Per scenario id: the states it has been in, oldest first, with the board
    stamp each came from. Boards arrive newest-last."""
    out = {}
    for b in boards:
        at = b.get("at") or b.get("stamp") or ""
        for sc in b.get("scenarios", []):
            out.setdefault(sc.get("id", ""), []).append({"state": sc.get("state", ""), "at": at})
    return out


def select(scenarios: list, boards: list, budget_steps: int = 0, now: str = "") -> dict:
    hist = history(boards)
    now_s = _epoch(now) or time.time()
    ranked = []
    for sc in scenarios:
        sid = sc.get("id", "")
        runs = hist.get(sid, [])
        reds = sum(1 for r in runs if r["state"] in STATE_RED)
        flips = sum(1 for a, b in zip(runs, runs[1:]) if a["state"] != b["state"])
        last = runs[-1] if runs else None
        age_days = (now_s - _epoch(last["at"])) / 86400.0 if last and _epoch(last["at"]) else None
        steps = len(sc.get("steps", []))
        sev = SEVERITY_WEIGHT.get(sc.get("severity", ""), 1.5)
        # Laplace-smoothed, so a scenario nobody has run is not assumed green.
        p_red = (reds + 1.0) / (len(runs) + 2.0)
        flip_rate = flips / max(len(runs) - 1, 1) if len(runs) > 1 else 0.0
        staleness = 1.0 if age_days is None else min(age_days / THRESHOLDS["stale_days"], 2.0)
        value = sev * (2.0 * p_red + 1.0 * flip_rate + 0.8 * staleness) - THRESHOLDS["cost_weight"] * steps
        ranked.append({
            "id": sid, "surface": sc.get("surface", ""), "severity": sc.get("severity", ""),
            "steps": steps, "runs": len(runs), "reds": reds, "flips": flips,
            "last_state": last["state"] if last else "never run",
            "age_days": None if age_days is None else round(age_days, 2),
            "p_red": round(p_red, 3), "value": round(value, 3),
            "why": "severity %s × (2×p_red %.2f + flips %.2f + staleness %.2f) − %d steps"
                   % (sc.get("severity", "?"), p_red, flip_rate, staleness, steps),
        })
    ranked.sort(key=lambda r: (-r["value"], r["id"]))
    selected, spent = [], 0
    for r in ranked:
        if budget_steps and spent + r["steps"] > budget_steps and selected:
            continue
        selected.append(r["id"])
        spent += r["steps"]
        if budget_steps and spent >= budget_steps:
            break
    return {"ranked": ranked, "selected": selected if budget_steps else [r["id"] for r in ranked],
            "budget_steps": budget_steps, "steps_selected": spent,
            "basis": "%d board(s) of history" % len(boards) if boards else "no history: every scenario is scored as unseen"}


def _counts(steps: list) -> dict:
    c = {"passed": 0, "failed": 0, "blocked": 0, "error": 0, "empty": 0}
    for st in steps:
        c[st.get("state", "empty") if st.get("state") in c else "empty"] += 1
    return c


def verdicts(board: dict, thresholds: dict = None, previous: dict = None) -> dict:
    t = dict(THRESHOLDS)
    t.update({k: v for k, v in (thresholds or {}).items() if k in THRESHOLDS})
    scenarios = board.get("scenarios", [])
    by_surface = {}
    for sc in scenarios:
        s = by_surface.setdefault(sc.get("surface", "") or "(none)", {"scenarios": [], "steps": []})
        s["scenarios"].append(sc)
        s["steps"].extend(sc.get("steps", []))

    prev_state = {sc.get("id"): sc.get("state") for sc in (previous or {}).get("scenarios", [])}
    fired, findings = [], []

    def fire(rule, severity, title, detail, facts, evidence=None, key=""):
        fired.append({"rule": rule, "facts": facts, "threshold": t.get(rule)})
        findings.append({"rule": rule, "severity": severity, "title": title, "detail": detail,
                         "key": key or title, "evidence": evidence or facts})

    for name, s in sorted(by_surface.items()):
        c = _counts(s["steps"])
        total = sum(c.values())
        if not total:
            continue
        red = c["failed"] + c["error"]
        decided = c["passed"] + red
        score = round(100.0 * c["passed"] / decided, 1) if decided else None
        red_share = red / total
        if red_share > t["red_share_gap"]:
            fire("red_share_gap", "high" if red_share > 0.4 else "medium",
                 "%s: %d of %d steps red" % (name, red, total),
                 "The surface disagrees with what the corpus says it should do. Each red step carries the rule it contradicts.",
                 {"surface": name, "red": red, "steps": total, "red_share": round(red_share, 3)}, key="surface:%s" % name)
        elif score is not None and score < t["surface_score_floor"]:
            fire("surface_score_floor", "medium", "%s scores %s" % (name, score),
                 "Nothing is blocked, so this is friction rather than an outage.",
                 {"surface": name, "score": score}, key="surface:%s" % name)
        if c["blocked"] / total > t["blocked_share_env"]:
            fire("blocked_share_env", "low", "%s: %d of %d steps blocked" % (name, c["blocked"], total),
                 "Blocked is the ENVIRONMENT, not the product: a precondition did not hold, so the steps after it were never asked. "
                 "Fix the precondition before reading anything else on this surface.",
                 {"surface": name, "blocked": c["blocked"], "steps": total}, key="blocked:%s" % name)
        if c["empty"]:
            fire("empty_steps", "medium", "%s: %d steps assert nothing" % (name, c["empty"]),
                 "A step with no expectation is green because nothing was checked. That is a corpus defect, not a product one.",
                 {"surface": name, "empty": c["empty"]}, key="empty:%s" % name)

    for sc in scenarios:
        sid = sc.get("id", "")
        was, now = prev_state.get(sid), sc.get("state")
        if was == "passed" and now in STATE_RED:
            first = next((st for st in sc.get("steps", []) if st.get("state") in STATE_RED), {})
            fire("regression", "high", "%s went red" % sid,
                 "It passed on the previous board. %s" % ("; ".join(first.get("why", []))[:300] or "No reason recorded."),
                 {"scenario": sid, "was": was, "now": now},
                 evidence={"step": first.get("name"), "request": first.get("request"), "why": first.get("why", [])},
                 key="regression:%s" % sid)

    return {"findings": findings, "fired": fired, "thresholds": t,
            "surfaces": {k: _counts(v["steps"]) for k, v in sorted(by_surface.items())},
            "totals": _counts([st for sc in scenarios for st in sc.get("steps", [])])}
