"""Findings → decisions, as rules a person can read. Mirrors the JS triage in
`src/detectors/index.js` (the selftest pins both to the same answers) but this
is the authoritative, explainable copy: `_fired` is the derivation.

Order: noise floor → judgement (sticky: critical does NOT override it; the
original let it, and an analyzer residue report became an opus lane) →
critical → severity floor → expected-value floor → model tier.
"""
from __future__ import annotations
from . import confidence as C
from .engine import RuleSet, infer

SEVERITY = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
JUDGEMENT = {"todo-census", "big-file", "worktree-hygiene", "stale-evidence", "lockfile-drift"}
MECHANICAL = {"doc-links", "doc-drift", "dead-deps", "merge-markers", "debug-leftovers"}
RS = RuleSet("triage")


@RS.guarded("noise-floor", lambda f: f["severity"] == "info", salience=100, why="info severity never becomes work on its own")
def _noise(f):
    return {"promote": False, "reason": "info severity never becomes work on its own", "decided": True}


@RS.guarded("judgement-call", lambda f: not f.get("decided") and f["detector"] in JUDGEMENT, salience=90, why="a survey is a report, not a task; critical does not override this")
def _judgement(f):
    return {"promote": False, "reason": f"{f['detector']} is a report, not a task", "decided": True}


@RS.guarded("critical-always", lambda f: not f.get("decided") and f["severity"] == "critical", salience=80, why="critical outranks the budget")
def _critical(f):
    return {"promote": True, "reason": "critical outranks the budget", "model": "opus", "kind": "fix", "priority": 0, "decided": True}


@RS.guarded("severity-floor", lambda f: not f.get("decided") and SEVERITY.get(f["severity"], 0) < SEVERITY.get(f["promote_at"], 2), salience=70, why="below the configured floor")
def _floor(f):
    return {"promote": False, "reason": f"{f['severity']} is below promote_at={f['promote_at']}", "decided": True}


@RS.guarded("expected-value", lambda f: not f.get("decided") and f["ev"] < f["ev_floor"], salience=60, why="not worth the tokens at this confidence")
def _ev(f):
    return {"promote": False, "reason": f"ev {f['ev']} < floor {f['ev_floor']}: {f['est_tokens']} tokens for a {f['confidence']} chance", "decided": True}


@RS.guarded("mechanical", lambda f: not f.get("decided") and f["detector"] in MECHANICAL and f.get("n_files", 0) <= 4, salience=50, why="a named list plus a named table is an edit")
def _mech(f):
    return {"promote": True, "reason": "mechanical edit", "model": "sonnet", "kind": "fix", "priority": 2, "decided": True}


@RS.guarded("actuator-priority", lambda f: f.get("decided") and f.get("promote") and f.get("auto_fix"), salience=5, why="a local actuator runs first, for nothing; the lane is the fallback")
def _actuator(f):
    return {"priority": 0, "actuator": f["auto_fix"]}


@RS.guarded("default-model", lambda f: not f.get("decided"), salience=10, why="promoted at the default tier")
def _default(f):
    return {"promote": True, "reason": "above floor and worth the tokens", "model": "sonnet", "kind": f.get("kind") or "fix", "priority": 3, "decided": True}


def triage(finding: dict, cfg: dict | None = None, history: dict | None = None, ev_mult: float = None) -> dict:
    cfg = cfg or {}
    promote_at = (cfg.get("detectors") or {}).get("promote_at", "medium")
    hist = (history or {}).get(finding.get("detector"), {})
    conf = C.for_rule(finding.get("precision", "heuristic"), hist.get("held", 0), hist.get("weak", 0), hist.get("broken", 0))
    n = finding.get("evidence", {}).get("count") if isinstance(finding.get("evidence"), dict) else None
    n = n if isinstance(n, (int, float)) and n > 0 else 1
    facts = {
        "detector": finding.get("detector", ""), "severity": finding.get("severity", "low"), "kind": finding.get("kind"),
        "auto_fix": finding.get("auto_fix"), "n_files": len(finding.get("files") or []), "est_tokens": int(finding.get("est_tokens") or 0), "promote_at": promote_at,
        "confidence": conf["confidence"], "ev": C.value(conf["confidence"], finding.get("severity", "low"), finding.get("est_tokens") or 0, int(n)),
        # `C.floor` carries the shipped 0.6; a replay scales it rather than
        # reaching into confidence.py, so the shipped path is byte-identical.
        "ev_floor": C.floor(promote_at) if ev_mult is None else round(C.floor(promote_at) * ev_mult / 0.6, 4),
    }
    out = infer(RS, facts)
    return {k: out.get(k) for k in ("promote", "reason", "model", "kind", "priority", "ev", "ev_floor", "confidence", "actuator")} | {"steps": out["_fired"], "history": conf}


# ── the replay simulator ────────────────────────────────────────────────────
#
# A closed finding now says WHY it closed, and `acted_on` is the only reason
# that means work happened. That makes a settled finding a labelled decision:
# triage either promoted it or held it, and the label says whether promoting it
# would have been right. Replaying an alternative config costs nothing, because
# promoting a finding does not change whether somebody later fixed it — the
# label was recorded against the world, not against the policy.
#
# That independence is the whole reason this is replayable, and it is worth
# naming because it does not hold everywhere. A selector that changes WHICH
# scenario runs changes what gets recorded; a triage that changes which finding
# is surfaced does not change whether the code was edited.
#
# Scored the way `bb cookbook calibrate` scores: recall of the work that
# actually happened, minus what was spent surfacing work that did not.

#: The shipped policy, as a vector. `ev_mult` is the 0.6 in `confidence.floor`.
POLICY = {"promote_at": "medium", "ev_mult": 0.6}
#: Findings labelled `acted_on` needed before a fit is a fit and not a story.
MIN_ACTED = 12
#: What one point of recall is worth as a share of the whole corpus's tokens
#: spent on findings nobody touched. Printed with every score.
TRIAGE_COST = 0.5
#: A closure that says nothing about whether promoting it was right.
UNSCORABLE = ("unknown", "", None)


def scorable(findings: list) -> list:
    """Closed findings carrying a reason. An open finding has not been decided
    yet and an `unknown` closure is a sample this box does not have."""
    return [f for f in findings
            if f.get("status") != "open" and f.get("closed_by") not in UNSCORABLE]


def replay(findings: list, policy: dict = None, cfg: dict = None,
           history: dict = None, cost_penalty: float = TRIAGE_COST) -> dict:
    """What this policy would have promoted, against what was acted on. Runs
    the real rule engine — a replay that approximates the policy is measuring
    an approximation."""
    p = dict(POLICY, **(policy or {}))
    base = dict(cfg or {})
    base["detectors"] = dict(base.get("detectors") or {}, promote_at=p["promote_at"])
    acted = promoted = caught = 0
    spent = wasted = 0
    # The denominator is every labelled finding's tokens, not the promoted
    # ones'. Normalising by what was promoted makes waste a RATE, and a rate
    # cannot punish promoting more: the first fit on this workspace answered
    # "promote_at low", promoting 114 of 114 for recall 1.0 at the same 0.80
    # rate the shipped rule already had. Against the whole corpus, spending more
    # costs more, which is the thing being traded.
    budget = sum(max(int(f.get("est_tokens") or 0), 0) for f in findings) or 1
    for f in findings:
        worked = f.get("closed_by") == "acted_on"
        acted += 1 if worked else 0
        d = triage(f, base, history, ev_mult=p["ev_mult"])
        if not d.get("promote"):
            continue
        promoted += 1
        cost = int(f.get("est_tokens") or 0)
        spent += cost
        if worked:
            caught += 1
        else:
            wasted += cost
    recall = (caught / acted) if acted else None
    waste = wasted / budget
    return {
        "acted_on": acted, "promoted": promoted, "caught": caught,
        "tokens": spent, "wasted_tokens": wasted, "budget": budget, "waste_share": round(waste, 4),
        "recall": None if recall is None else round(recall, 4),
        "score": None if recall is None else round(recall - cost_penalty * waste, 4),
        "why": "recall %s − %g×waste %.2f" % ("n/a" if recall is None else "%.2f" % recall, cost_penalty, waste),
    }


def _neighbours(p: dict) -> list:
    """One step out from a policy, on every axis. The search below walks these
    rather than enumerating a fixed box: a grid can only ever find what its
    author already thought to list, and every bound in it is a guess about the
    answer. Coordinate descent keeps moving while moving helps and stops when
    it does not, so the space it covers is decided by the data."""
    out = []
    order = ["info", "low", "medium", "high", "critical"]
    i = order.index(p["promote_at"]) if p["promote_at"] in order else 2
    for j in (i - 1, i + 1):
        if 0 <= j < len(order):
            out.append(dict(p, promote_at=order[j]))
    for m in (p["ev_mult"] * 0.75, p["ev_mult"] * 1.5):
        m = round(min(max(m, 0.05), 20.0), 4)
        if m != p["ev_mult"]:
            out.append(dict(p, ev_mult=m))
    return out


def calibrate(findings: list, cfg: dict = None, history: dict = None,
              cost_penalty: float = TRIAGE_COST, min_acted: int = MIN_ACTED,
              max_steps: int = 24) -> dict:
    """Hill-climb from the shipped policy over the labelled findings. The
    shipped vector is the starting point, so the answer is never worse than
    today's; the walk stops when a step stops helping, so the space searched is
    set by the history and not by a list somebody typed."""
    rows = scorable(findings)
    acted = sum(1 for f in rows if f.get("closed_by") == "acted_on")
    shipped = dict(POLICY)
    if acted < min_acted:
        return {"ok": False, "policy": shipped, "labelled": len(rows), "acted_on": acted,
                "need": min_acted, "cost_penalty": cost_penalty,
                "why": "%d finding(s) are labelled `acted_on` (need %d). A closure git could not settle is "
                       "`unknown`, and a policy fitted on %d positive(s) is a description of those %d"
                       % (acted, min_acted, acted, acted)}

    def score(p):
        return replay(rows, p, cfg, history, cost_penalty)["score"]

    cur, best = dict(shipped), score(dict(shipped))
    before, seen, steps = best, {repr(sorted(cur.items()))}, 0
    while steps < max_steps:
        moved = False
        for cand in _neighbours(cur):
            key = repr(sorted(cand.items()))
            if key in seen:
                continue
            seen.add(key)
            s = score(cand)
            # Strictly better, so a tie leaves the shipped policy in place.
            if s is not None and s > best:
                cur, best, moved = cand, s, True
        steps += 1
        if not moved:
            break
    return {"ok": True, "policy": cur, "shipped": shipped,
            "score_before": before, "score_after": best, "changed": cur != shipped,
            "labelled": len(rows), "acted_on": acted, "explored": len(seen), "steps": steps,
            "cost_penalty": cost_penalty,
            "before": replay(rows, shipped, cfg, history, cost_penalty),
            "after": replay(rows, cur, cfg, history, cost_penalty),
            "basis": "%d labelled finding(s), %d of them acted on; %d policy(s) explored by "
                     "hill-climbing from the shipped one" % (len(rows), acted, len(seen))}
