"""grapple — the arithmetic behind the handoff layer.

JS decides WHETHER and WHEN; this module decides HOW MUCH. Four functions,
each one JSON in and one JSON out, none of which reads a clock, a file, an
environment variable or a random number: the same input is the same output on
every run, because `promote.js` groups on what comes back.

Every threshold here is `confidence.py`'s. `value()` is the expected-value unit
`rank` orders by, `PRECISION` is the prior `propagate` decays toward, and
`SHRINKAGE` is the bar `promote` clears — a promotion from three identical
answers is exactly the "three samples cannot override the method" case that
constant exists to refuse.
"""
from __future__ import annotations

from . import confidence

ASK_TOKENS = 1000            # a question inside an open session is under 1k
SEVERITY_ORDER = {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}
DRIFT_BARS = {"repeats": 3, "since_edit": 12, "out_of_scope": 4}


def dispatch(inp: dict) -> dict:
    op = str(inp.get("op") or "")
    if op == "rank":
        return rank(inp.get("items") or [], inp.get("answers") or {}, int(inp.get("ask_tokens") or ASK_TOKENS), inp.get("priors") or {})
    if op == "propagate":
        return propagate(inp.get("answer") or {}, inp.get("rows") or [])
    if op == "drift":
        return drift(inp.get("window") or {})
    if op == "promote":
        return promote(inp.get("tally") or {})
    return {"error": f"unknown grapple op {op!r}", "ops": ["rank", "propagate", "drift", "promote"]}


# ── rank: the expected value of asking ──────────────────────────────────────

def _covered(item: dict, answers: dict) -> str:
    """Why an item need not be asked, or '' when it must be."""
    key = str(item.get("key") or "")
    a = answers.get(key)
    if a and a.get("shape") == "instance" and item.get("shape") == "instance":
        if not item.get("fingerprint") or a.get("fingerprint") == item.get("fingerprint"):
            return "answered"
    if a and a.get("shape") == "pattern":
        return "answered"
    pat = str(item.get("pattern") or "")
    if pat and answers.get(pat, {}).get("shape") == "pattern":
        return "covered-by-pattern"
    return ""


def _prior(item: dict, priors: dict) -> float:
    """The method's base, moved toward the labels this detector has earned at
    `for_rule`'s shrinkage. No labels: the base, exactly as before."""
    p = priors.get(str(item.get("detector") or "")) or {}
    return confidence.for_rule(str(item.get("precision") or "heuristic"), int(p.get("held") or 0), 0, int(p.get("broken") or 0))["confidence"]


def _ev(item: dict, ask_tokens: int, priors: dict) -> float:
    """Disambiguation value per token of asking: what is at stake times how
    uncertain the method is about it, in `value()`'s unit, over the cost of
    the question rather than the cost of the unit."""
    prior = _prior(item, priors)
    at_stake = confidence.value(1.0, str(item.get("severity") or "low"), int(item.get("est_tokens") or 0), int(item.get("n") or 1))
    return round((1.0 - prior) * at_stake * 1000.0 / max(ask_tokens, 1), 2)


def rank(items: list, answers: dict, ask_tokens: int = ASK_TOKENS, priors: dict = None) -> dict:
    priors = priors or {}
    asked, dropped = [], []
    for it in items:
        why = _covered(it, answers)
        if why:
            dropped.append({"key": it.get("key"), "why": why})
            continue
        asked.append(dict(it, ev=_ev(it, ask_tokens, priors), prior=_prior(it, priors)))
    floor = confidence.floor()
    tail = [a for a in asked if a["ev"] < floor]
    asked = [a for a in asked if a["ev"] >= floor]
    # A total order: value, then severity, then the wider reach, then the key —
    # the key is unique, so two distinct inputs never tie.
    asked.sort(key=lambda a: (-a["ev"], -SEVERITY_ORDER.get(str(a.get("severity") or ""), 0), -int(a.get("n") or 1), str(a.get("key"))))
    dropped.extend({"key": t.get("key"), "why": f"below floor {floor}"} for t in tail)
    return {"asked": asked, "dropped": dropped, "floor": floor}


# ── propagate: one answer, N labels ─────────────────────────────────────────

def propagate(answer: dict, rows: list) -> dict:
    """Carry one pattern answer across rows at the distance JS measured with
    the fitted scorer. At distance 0 the label carries the answer's own
    confidence; at distance 1 it carries the method's prior and nothing of the
    answer. Linear between, and no number invented at either end."""
    conf = float(answer.get("confidence") or 0.0)
    labels = []
    for r in rows:
        d = min(max(float(r.get("distance") or 0.0), 0.0), 1.0)
        prior = confidence.PRECISION.get(str(r.get("precision") or "heuristic"), confidence.PRECISION["heuristic"])
        labels.append({"id": r.get("id"), "path": r.get("path"), "value": answer.get("value"),
                       "confidence": round(conf * (1.0 - d) + prior * d, 4), "distance": d})
    labels.sort(key=lambda l: (l["distance"], str(l.get("id"))))
    return {"labels": labels, "n": len(labels)}


# ── drift: one window, one score, one signature ─────────────────────────────

def drift(window: dict) -> dict:
    turns = window.get("turns") or []
    scope = set(str(s) for s in (window.get("scope") or []))
    seen: dict = {}
    repeats = since_edit = out_of_scope = edits = 0
    for t in turns:
        h = str(t.get("hash") or "")
        seen[h] = seen.get(h, 0) + 1
        if seen[h] > 1:
            repeats += 1
        if t.get("edit"):
            edits += 1
            since_edit = 0
        else:
            since_edit += 1
        f = str(t.get("file") or "")
        if f and scope and f not in scope:
            out_of_scope += 1
    counters = {"turns": len(turns), "repeats": repeats, "since_edit": since_edit, "out_of_scope": out_of_scope, "edits": edits}
    # Each counter's share of its bar, capped at one, averaged: a window three
    # turns from its last edit is not a third of the way to drifting, and one
    # thirty turns from it is not three times drifted.
    parts = {k: min(counters[k] / DRIFT_BARS[k], 1.0) for k in DRIFT_BARS}
    score = round(sum(parts.values()) / len(parts), 4)
    fired = sorted(k for k, v in parts.items() if v >= 1.0)
    return {"score": score, "signature": "+".join(fired) or "none", "counters": counters, "parts": {k: round(v, 4) for k, v in parts.items()}}


# ── promote: has a repeated record earned a rule ────────────────────────────

def _bar(support: int) -> dict:
    """The blend `for_rule` gives `support` identical held samples. History
    outweighs the method once its weight reaches one half, which `for_rule`
    reaches at settled == SHRINKAGE and not before."""
    c = confidence.for_rule("heuristic", held=int(support))
    return {"confidence": c["confidence"], "weight": c["weight"], "promote": c["weight"] >= 0.5}


def promote(tally: dict) -> dict:
    rows = []
    for a in tally.get("answers") or []:
        b = _bar(int(a.get("support") or 0))
        rows.append({"kind": "detector", "items": [str(a.get("key")), str(a.get("value"))], "support": int(a.get("support") or 0),
                     "confidence": b["confidence"], "promote": b["promote"],
                     "why": "an answer given identically this often was a decidable fact nobody encoded" if b["promote"] else f"weight {b['weight']} < 0.5: history does not yet outweigh the method"})
    for o in tally.get("overrides") or []:
        b = _bar(int(o.get("support") or 0))
        rows.append({"kind": "retire", "items": [str(o.get("detector"))], "support": int(o.get("support") or 0),
                     "confidence": b["confidence"], "promote": b["promote"],
                     "why": "overridden this often, the rule is wrong for this workspace" if b["promote"] else f"weight {b['weight']} < 0.5"})
    for d in tally.get("drifts") or []:
        b = _bar(int(d.get("support") or 0))
        rows.append({"kind": "monitor", "items": [str(d.get("signature"))], "support": int(d.get("support") or 0),
                     "confidence": b["confidence"], "promote": b["promote"],
                     "why": "a drift shape this workspace keeps producing" if b["promote"] else f"weight {b['weight']} < 0.5"})
    rows.sort(key=lambda r: (-int(r["promote"]), -r["support"], r["kind"], " ".join(r["items"])))
    return {"rows": rows, "shrinkage": confidence.SHRINKAGE}
