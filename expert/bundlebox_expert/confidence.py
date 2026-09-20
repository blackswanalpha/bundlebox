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


def for_rule(precision: str, held: int = 0, weak: int = 0, broken: int = 0) -> dict:
    base = PRECISION.get(precision, PRECISION["heuristic"])
    settled = held + weak + broken
    if settled == 0:
        return {"confidence": base, "base": base, "hold_rate": None, "settled": 0, "weight": 0.0}
    hold = held / settled
    w = settled / (settled + SHRINKAGE)
    return {"confidence": round((1 - w) * base + w * hold, 4), "base": base, "hold_rate": round(hold, 4), "settled": settled, "weight": round(w, 4)}


def value(conf: float, severity: str, est_tokens: int, n: int = 1) -> float:
    cost = max(int(est_tokens or 0), 1000)
    return round(conf * WEIGHT.get(severity, 1.0) * max(n, 1) * 100000 / cost, 2)


def floor(promote_at: str = "medium") -> float:
    return round(WEIGHT.get(promote_at, 2.0) * 0.6 * 100000 / 200000, 2)
