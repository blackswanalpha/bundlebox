"""How much a detector is worth believing, and whether a promotion is a bet
worth making.

`PRECISION` is what the METHOD can support and never moves. History moves the
blend at `settled / (settled + SHRINKAGE)`, so three samples cannot override the
method and zero samples do not read as 0 or 1 — both are claims the data has
not made. `value()` collapses severity, confidence and cost into expected
severity-points per 100k tokens so a cheap exact fix outranks an expensive
heuristic one, which a severity floor cannot express.
"""
PRECISION = {"exact": 0.95, "probe": 0.80, "heuristic": 0.60, "lexical": 0.50}
# `lexical` is the locate itself, not a detector: a term match against the symbol
# tables, which can return three files off two words in the problem statement and
# report no ambiguity while doing it. 0.50 is the honest prior for a method with
# no measured baseline, and `locate.replay` is what moves it.
WEIGHT = {"info": 0.5, "low": 1.0, "medium": 2.0, "high": 5.0, "critical": 16.0}
SHRINKAGE = 4


def for_rule(precision: str, held: int = 0, weak: int = 0, broken: int = 0, prior: dict | None = None) -> dict:
    """`prior` is the third term (prompt4.md W2): `{"p", "n"}` from the fitted
    finding head in `model.py`, a per-finding probability with the head's
    training sample beside it. It moves the METHOD constant toward `p` by
    `n / (n + SHRINKAGE)` before history is blended on top — the same shrinkage
    history gets, so a head fitted on nine rows cannot outvote the method. `base`
    stays the method constant so a reader can see what the prior moved."""
    base = PRECISION.get(precision, PRECISION["heuristic"])
    start = base
    out = {"base": base}
    if prior and isinstance(prior.get("p"), (int, float)) and int(prior.get("n") or 0) > 0:
        v = int(prior["n"]) / (int(prior["n"]) + SHRINKAGE)
        start = (1 - v) * base + v * float(prior["p"])
        out["prior"] = {"p": round(float(prior["p"]), 4), "n": int(prior["n"]), "weight": round(v, 4), "base": round(start, 4)}
    settled = held + weak + broken
    if settled == 0:
        return {**out, "confidence": round(start, 4), "hold_rate": None, "settled": 0, "weight": 0.0}
    hold = held / settled
    w = settled / (settled + SHRINKAGE)
    return {**out, "confidence": round((1 - w) * start + w * hold, 4), "hold_rate": round(hold, 4), "settled": settled, "weight": round(w, 4)}


def jev_prior(finding: dict) -> dict | None:
    """Jev's stored word on one finding, in the shape `for_rule` takes as
    `prior`, or None when there is none.

    Jev is asked whether a shape is DELIBERATE, so its `p` is the probability
    the detector's claim is NOT a defect — the complement of the confidence
    this module is about. The flip happens here, once, and `for_rule` is handed
    a probability that the finding HOLDS like any other.

    `n` is how many code windows Jev read for the item, never how many rows the
    pattern covers, so an opinion formed on three windows weighs
    3/(3+SHRINKAGE) and cannot outvote the method constant on its own.
    """
    j = finding.get("jev")
    if not isinstance(j, dict):
        return None
    p = j.get("p")
    if not isinstance(p, (int, float)) or isinstance(p, bool):
        return None
    n = j.get("n")
    n = int(n) if isinstance(n, (int, float)) and not isinstance(n, bool) and n > 0 else 1
    return {"p": min(max(1.0 - float(p), 0.0), 1.0), "n": n}

def value(conf: float, severity: str, est_tokens: int, n: int = 1) -> float:
    cost = max(int(est_tokens or 0), 1000)
    return round(conf * WEIGHT.get(severity, 1.0) * max(n, 1) * 100000 / cost, 2)


def floor(promote_at: str = "medium") -> float:
    return round(WEIGHT.get(promote_at, 2.0) * 0.6 * 100000 / 200000, 2)
