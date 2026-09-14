"""Logistic regression over episode features, trained by SGD, held out by
TIME. It refuses to steer until it beats the base rate on the holdout; until
then `predict` returns the base rate and says so. One `featurize()` serves
both training and prediction — the original built the two feature sets in
different places and they drifted.
"""
from __future__ import annotations
import math
from collections import Counter

FEATURE_BUCKETS = {"inputs": (0, 5, 50, 500), "open_findings": (0, 5, 25, 100)}


def _bucket(name, v):
    edges = FEATURE_BUCKETS[name]
    v = float(v or 0)
    for i, e in enumerate(edges):
        if v <= e:
            return f"{name}~{i}"
    return f"{name}~{len(edges)}"


def featurize(ep: dict, lift: dict | None = None) -> dict:
    """The one feature function. Only facts knowable BEFORE the stage ran."""
    f = {"@bias": 1.0}
    verb, prev = ep.get("verb") or "?", ep.get("prev") or "-"
    f[f"verb={verb}"] = 1.0
    f[f"prev={prev}"] = 1.0
    feat = ep.get("features") or {}
    f[_bucket("inputs", feat.get("inputs"))] = 1.0
    f[_bucket("open_findings", feat.get("open_findings"))] = 1.0
    f["dirty"] = 1.0 if feat.get("dirty") else 0.0
    f["optional"] = 1.0 if feat.get("optional") else 0.0
    f["since_min~log"] = math.log1p(float(feat.get("since_min") or 0)) / 10
    if lift:
        f["edge_lift"] = float(lift.get(f"{prev}>{verb}", 1.0)) - 1.0
    return f


def _sigmoid(z):
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def _auc(scores, labels):
    pos = [s for s, y in zip(scores, labels) if y == 1]
    neg = [s for s, y in zip(scores, labels) if y == 0]
    if not pos or not neg:
        return None
    wins = sum(1 for p in pos for n in neg if p > n) + 0.5 * sum(1 for p in pos for n in neg if p == n)
    return wins / (len(pos) * len(neg))


def train(episodes: list, lift: dict | None = None, epochs: int = 60, lr: float = 0.1, l2: float = 0.01) -> dict:
    rows = [e for e in episodes if e.get("useful") in (0, 1)]
    rows.sort(key=lambda e: e.get("at") or "")
    n = len(rows)
    if n < 12:
        return {"useful": False, "why": f"{n} labelled episodes; need 12", "n": n, "weights": {}}
    cut = max(1, int(n * 0.8))
    tr, ho = rows[:cut], rows[cut:]
    base_p = sum(e["useful"] for e in tr) / len(tr)
    w: dict = {}
    for _ in range(epochs):
        for e in tr:
            x = featurize(e, lift)
            z = sum(w.get(k, 0.0) * v for k, v in x.items())
            g = _sigmoid(z) - e["useful"]
            for k, v in x.items():
                w[k] = w.get(k, 0.0) - lr * (g * v + l2 * w.get(k, 0.0))
    def score(e):
        x = featurize(e, lift)
        return _sigmoid(sum(w.get(k, 0.0) * v for k, v in x.items()))
    ho_scores = [score(e) for e in ho]
    ho_labels = [e["useful"] for e in ho]
    acc = sum(1 for s, y in zip(ho_scores, ho_labels) if (s >= 0.5) == (y == 1)) / len(ho) if ho else 0.0
    majority = 1 if base_p >= 0.5 else 0
    base_acc = sum(1 for y in ho_labels if y == majority) / len(ho) if ho else 0.0
    auc = _auc(ho_scores, ho_labels)
    beats = acc > base_acc + 0.02 and (auc is None or auc > 0.55)
    # collinearity: ≥3 features sharing an identical weight are one column wearing three names
    groups = Counter(round(v, 6) for v in w.values())
    collinear = [[k for k, v in w.items() if round(v, 6) == val] for val, c in groups.items() if c >= 3 and val != 0.0]
    return {"useful": beats, "n": n, "train": len(tr), "holdout": len(ho), "accuracy": round(acc, 3), "base_accuracy": round(base_acc, 3),
            "auc": round(auc, 3) if auc is not None else None, "base_rate": round(base_p, 3),
            "weights": {k: round(v, 4) for k, v in sorted(w.items(), key=lambda kv: -abs(kv[1]))},
            "collinear": collinear, "why": "" if beats else "does not beat the base rate on the time-split holdout"}


def predict(model: dict, ep: dict, lift: dict | None = None) -> dict:
    if not model or not model.get("useful"):
        return {"p": model.get("base_rate", 0.5) if model else 0.5, "source": "base-rate", "why": (model or {}).get("why", "no model")}
    x = featurize(ep, lift)
    w = model.get("weights", {})
    return {"p": round(_sigmoid(sum(w.get(k, 0.0) * v for k, v in x.items())), 3), "source": "model"}
