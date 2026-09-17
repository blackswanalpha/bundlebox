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

# The shipped ranking weights. Named because `calibrate()` below searches them
# against recorded boards and `--apply` writes a fitted set beside them: a
# coefficient that only exists inside the expression cannot be fitted, reported
# or argued with.
WEIGHTS = {"p_red": 2.0, "flip": 1.0, "staleness": 0.8, "cost": THRESHOLDS["cost_weight"]}
# Below this many boards that actually contain a red, a fit is a coincidence.
MIN_BOARDS = 4
# What one point of recall is worth in corpus-steps. Printed with every score,
# never hidden: a replay whose trade-off nobody can see is a number to distrust.
REPLAY_COST = 0.5


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


def select(scenarios: list, boards: list, budget_steps: int = 0, now: str = "", weights: dict = None) -> dict:
    w = dict(WEIGHTS, **(weights or {}))
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
        value = sev * (w["p_red"] * p_red + w["flip"] * flip_rate + w["staleness"] * staleness) - w["cost"] * steps
        ranked.append({
            "id": sid, "surface": sc.get("surface", ""), "severity": sc.get("severity", ""),
            "steps": steps, "runs": len(runs), "reds": reds, "flips": flips,
            "last_state": last["state"] if last else "never run",
            "age_days": None if age_days is None else round(age_days, 2),
            "p_red": round(p_red, 3), "value": round(value, 3),
            "why": "severity %s × (%g×p_red %.2f + %g×flips %.2f + %g×staleness %.2f) − %g×%d steps"
                   % (sc.get("severity", "?"), w["p_red"], p_red, w["flip"], flip_rate,
                      w["staleness"], staleness, w["cost"], steps),
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
            "basis": "%d board(s) of history" % len(boards) if boards else "no history: every scenario is scored as unseen",
            "weights": w}


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


# ── the replay simulator, and the experiment that reads it ──────────────────
#
# A stored board records the realised state of every scenario in the corpus. So
# the set an ALTERNATIVE selector would have run is scoreable without running
# anything: the outcomes are already on disk. That makes a board a replay world,
# a weight vector a policy, and `calibrate()` an off-policy search in which
# every number comes from a run that already happened. Nothing here makes a
# request, spawns a process or spends a token.
#
# Four rules keep it from being a number that flatters itself:
#
#   1. A board is only ever scored by a policy fitted WITHOUT it. `calibrate()`
#      walks boards in recorded order and each score uses strictly earlier ones.
#   2. The shipped weights are always candidate zero, so the vector that comes
#      back is never worse than today's on the same held-out boards.
#   3. A selection is scored as a SET, never as an order. Path order is
#      execution order and scenarios in a corpus share their setup, so a
#      reordering is not something this history can price — and pricing it
#      anyway is how a replay starts lying about what it knows.
#   4. A board with nothing red carries no signal about a selector that is
#      trying to find red. Those are excluded from the mean, not scored as zero.


def replay(scenarios: list, boards: list, board: dict, weights: dict = None,
           budget_steps: int = 0, cost_penalty: float = REPLAY_COST) -> dict:
    """One replay: what the policy would have chosen knowing only `boards`,
    scored against what `board` actually recorded. Executes nothing."""
    states = {sc.get("id", ""): sc.get("state", "") for sc in board.get("scenarios", [])}
    steps_of = {sc.get("id", ""): len(sc.get("steps") or []) for sc in scenarios}
    red = {sid for sid, st in states.items() if st in STATE_RED}
    total = sum(steps_of.get(sid, 0) for sid in states) or 1
    at = board.get("at") or board.get("stamp") or ""
    r = select(scenarios, boards, budget_steps, at, weights)
    chosen = [sid for sid in r["selected"] if sid in states]
    spent = sum(steps_of.get(sid, 0) for sid in chosen)
    caught = len(red & set(chosen))
    recall = (caught / len(red)) if red else None
    share = spent / total
    return {
        "at": at, "scored": recall is not None,
        "red": len(red), "caught": caught, "selected": len(chosen), "of": len(states),
        "steps": spent, "steps_total": total, "cost_share": round(share, 4),
        "recall": None if recall is None else round(recall, 4),
        "score": None if recall is None else round(recall - cost_penalty * share, 4),
        "why": "recall %s − %g×cost %.2f" % ("n/a" if recall is None else "%.2f" % recall, cost_penalty, share),
    }


def _grid() -> list:
    """The candidate weight vectors, deterministic and small. Only the four
    terms that shape the ranking move; SEVERITY_WEIGHT and stale_days stay put
    because they say what the corpus MEANS, not how hard to lean on it."""
    out = []
    for pr in (1.0, 2.0, 3.0, 4.0):
        for fl in (0.0, 1.0, 2.0):
            for st in (0.0, 0.8, 1.6):
                for co in (0.0, 0.02, 0.05):
                    out.append({"p_red": pr, "flip": fl, "staleness": st, "cost": co})
    return out


def calibrate(scenarios: list, boards: list, budget_steps: int = 0,
              cost_penalty: float = REPLAY_COST, min_boards: int = MIN_BOARDS) -> dict:
    """Search the weights against the recorded boards, out-of-sample. Returns
    the shipped vector unchanged when the history is too thin to say anything —
    a fitted number from four boards is a number about four boards."""
    gradable = [i for i, b in enumerate(boards)
                if i > 0 and any(sc.get("state") in STATE_RED for sc in b.get("scenarios", []))]
    shipped = dict(WEIGHTS)
    if len(gradable) < min_boards:
        return {"ok": False, "weights": shipped, "boards": len(boards), "scorable": len(gradable),
                "need": min_boards, "cost_penalty": cost_penalty,
                "why": "%d board(s) can be scored out-of-sample (need %d): a board with nothing red says "
                       "nothing about a selector looking for red, and the first board has no history behind it"
                       % (len(gradable), min_boards)}

    def mean_score(w):
        xs = [replay(scenarios, boards[:i], boards[i], w, budget_steps, cost_penalty)["score"] for i in gradable]
        xs = [x for x in xs if x is not None]
        return (sum(xs) / len(xs)) if xs else None

    rows = []
    for w in [shipped] + [c for c in _grid() if c != shipped]:
        sc = mean_score(w)
        if sc is not None:
            rows.append({"weights": w, "score": round(sc, 4)})
    if not rows:
        return {"ok": False, "weights": shipped, "boards": len(boards), "scorable": len(gradable),
                "need": min_boards, "cost_penalty": cost_penalty,
                "why": "no board produced a score; every one of them is either first or entirely green"}
    before = rows[0]["score"]
    # Ties go to the shipped vector: it is rows[0] and the sort is stable, so a
    # candidate has to actually WIN to be applied, not merely match.
    best = max(rows, key=lambda r: r["score"])
    ranked = sorted(rows, key=lambda r: -r["score"])[:8]
    return {"ok": True, "weights": best["weights"], "shipped": shipped,
            "score_before": before, "score_after": best["score"],
            "changed": best["weights"] != shipped,
            "boards": len(boards), "scored": len(gradable), "candidates": len(rows),
            "cost_penalty": cost_penalty, "budget_steps": budget_steps,
            "ranked": ranked,
            "per_board": [replay(scenarios, boards[:i], boards[i], best["weights"], budget_steps, cost_penalty)
                          for i in gradable],
            "basis": "%d candidate vector(s) over %d out-of-sample board(s); score = mean(recall − %g×cost share)"
                     % (len(rows), len(gradable), cost_penalty)}
