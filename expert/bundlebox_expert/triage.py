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


def triage(finding: dict, cfg: dict | None = None, history: dict | None = None) -> dict:
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
        "ev_floor": C.floor(promote_at),
    }
    out = infer(RS, facts)
    return {k: out.get(k) for k in ("promote", "reason", "model", "kind", "priority", "ev", "ev_floor", "confidence", "actuator")} | {"steps": out["_fired"], "history": conf}
