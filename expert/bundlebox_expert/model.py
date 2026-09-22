"""Logistic regression over episode features, trained by SGD, held out by
TIME. It refuses to steer until it beats the base rate on the holdout; until
then `predict` returns the base rate and says so. One `featurize()` serves
both training and prediction — the original built the two feature sets in
different places and they drifted.
"""
from __future__ import annotations
import math
import re
from collections import Counter

FEATURE_BUCKETS = {"inputs": (0, 5, 50, 500), "open_findings": (0, 5, 25, 100),
                   "est_tokens": (0, 2000, 10000, 50000), "n_files": (0, 1, 4, 12)}


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


def _sgd(xs: list, ys: list, epochs: int = 60, lr: float = 0.1, l2: float = 0.01) -> dict:
    """One pass of plain SGD over sparse feature dicts. Every head in this file
    trains through here, so a change to the optimiser is one change."""
    w: dict = {}
    for _ in range(epochs):
        for x, y in zip(xs, ys):
            g = _sigmoid(sum(w.get(k, 0.0) * v for k, v in x.items())) - y
            for k, v in x.items():
                w[k] = w.get(k, 0.0) - lr * (g * v + l2 * w.get(k, 0.0))
    return w


def _score(w: dict, x: dict) -> float:
    return _sigmoid(sum(w.get(k, 0.0) * v for k, v in x.items()))


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
    w = _sgd([featurize(e, lift) for e in tr], [e["useful"] for e in tr], epochs, lr, l2)
    def score(e):
        return _score(w, featurize(e, lift))
    ho_scores = [score(e) for e in ho]
    ho_labels = [e["useful"] for e in ho]
    acc = sum(1 for s, y in zip(ho_scores, ho_labels) if (s >= 0.5) == (y == 1)) / len(ho) if ho else 0.0
    majority = 1 if base_p >= 0.5 else 0
    base_acc = sum(1 for y in ho_labels if y == majority) / len(ho) if ho else 0.0

    auc = _auc(ho_scores, ho_labels)
    # C32: the label used to be a function of the verb, and the verb is a
    # feature — a model can score well by memorising the gear chain and steer
    # nothing. So the verb gets its own baseline: predict each holdout row with
    # the majority label of its verb in training. If the real model cannot beat
    # THAT, it has learned the chain, not the work, and it does not get to vote.
    verb_major: dict = {}
    for e in tr:
        v = e.get("verb") or "?"
        c = verb_major.setdefault(v, [0, 0])
        c[e["useful"]] += 1
    def verb_guess(e):
        c = verb_major.get(e.get("verb") or "?")
        return majority if c is None else (1 if c[1] > c[0] else 0)
    verb_acc = sum(1 for e, y in zip(ho, ho_labels) if verb_guess(e) == y) / len(ho) if ho else 0.0
    beats = acc > base_acc + 0.02 and acc > verb_acc + 0.02 and (auc is None or auc > 0.55)
    # collinearity: ≥3 features sharing an identical weight are one column wearing three names
    groups = Counter(round(v, 6) for v in w.values())
    collinear = [[k for k, v in w.items() if round(v, 6) == val] for val, c in groups.items() if c >= 3 and val != 0.0]
    why = ""
    if not beats:
        why = ("does not beat a verb-only guess on the time-split holdout: the label is still a function of the verb"
               if acc <= verb_acc + 0.02 else "does not beat the base rate on the time-split holdout")
    return {"useful": beats, "n": n, "train": len(tr), "holdout": len(ho), "accuracy": round(acc, 3), "base_accuracy": round(base_acc, 3),
            "verb_accuracy": round(verb_acc, 3),
            "auc": round(auc, 3) if auc is not None else None, "base_rate": round(base_p, 3),
            "weights": {k: round(v, 4) for k, v in sorted(w.items(), key=lambda kv: -abs(kv[1]))},
            "collinear": collinear, "why": why}


def predict(model: dict, ep: dict, lift: dict | None = None) -> dict:
    if not model or not model.get("useful"):
        return {"p": model.get("base_rate", 0.5) if model else 0.5, "source": "base-rate", "why": (model or {}).get("why", "no model")}
    x = featurize(ep, lift)
    w = model.get("weights", {})
    return {"p": round(_sigmoid(sum(w.get(k, 0.0) * v for k, v in x.items())), 3), "source": "model"}


# ── the second and third heads ──────────────────────────────────────────────
#
# prompt4.md: a fitted coefficient table is not a model dependency. The head
# above scores a pipeline stage; the two below score a PROMPT (is this worth a
# locate?) and a FINDING (how much is this detector's verdict worth here?).
# Same contract as `train`: one feature function each, SGD, a holdout by time,
# and a refusal to steer until the fit beats the base rate on that holdout.

MIN_ROWS = 12


def fit_head(rows: list, featurize_fn, label_fn, time_fn, epochs: int = 60, lr: float = 0.1, l2: float = 0.01) -> dict:
    """Generic: label 0/1 per row, 80/20 split by time, accuracy and AUC on the
    holdout against the majority guess. `useful` is the only field a caller may
    steer on; everything else is provenance."""
    rows = sorted([r for r in rows if label_fn(r) in (0, 1)], key=time_fn)
    n = len(rows)
    if n < MIN_ROWS:
        return {"useful": False, "why": f"{n} labelled rows; need {MIN_ROWS}", "n": n, "weights": {}, "base_rate": None}
    cut = max(1, int(n * 0.8))
    tr, ho = rows[:cut], rows[cut:]
    ys = [label_fn(r) for r in tr]
    base_p = sum(ys) / len(tr)
    w = _sgd([featurize_fn(r) for r in tr], ys, epochs, lr, l2)
    ho_scores = [_score(w, featurize_fn(r)) for r in ho]
    ho_labels = [label_fn(r) for r in ho]
    acc = sum(1 for s, y in zip(ho_scores, ho_labels) if (s >= 0.5) == (y == 1)) / len(ho) if ho else 0.0
    majority = 1 if base_p >= 0.5 else 0
    base_acc = sum(1 for y in ho_labels if y == majority) / len(ho) if ho else 0.0
    auc = _auc(ho_scores, ho_labels)
    beats = acc > base_acc + 0.02 and (auc is None or auc > 0.55)
    return {"useful": beats, "n": n, "train": len(tr), "holdout": len(ho), "accuracy": round(acc, 3),
            "base_accuracy": round(base_acc, 3), "auc": round(auc, 3) if auc is not None else None,
            "base_rate": round(base_p, 3),
            "weights": {k: round(v, 4) for k, v in sorted(w.items(), key=lambda kv: -abs(kv[1]))},
            "holdout_scores": [round(x, 4) for x in ho_scores], "holdout_labels": ho_labels,
            "why": "" if beats else "does not beat the base rate on the time-split holdout"}


# ── prompt head: is this prompt a task worth a locate? ──────────────────────

TASK_VERBS = ("fix", "add", "implement", "refactor", "change", "update", "write", "remove", "migrate", "debug",
              "investigate", "make", "build", "wire", "optimise", "optimize", "ensure", "analyse", "analyze",
              "audit", "port", "rename")
_TASK_RE = re.compile(r"\b(" + "|".join(TASK_VERBS) + r")\b", re.I)
_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_PATH_RE = re.compile(r"[A-Za-z0-9_-]+/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(js|py|rs|md|json|ts)\b")
_SYMBOL_RE = re.compile(r"`[^`]+`|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z]+_[a-z0-9_]+\b")
_BB_RE = re.compile(r"\bbb [a-z]+")
#: Three prompts every table carries with their features, so the JS mirror of
#: `prompt_featurize` can prove it agrees before it trusts the weights.
PROBES = ("fix the pre-read guard in src/wire/hooks.js so `isTask` returns nothing below the threshold",
          "what does this design imply for the similarity() in heap.js?",
          "ok")


def prompt_featurize(prompt) -> dict:
    """Cheap, ASCII-only, and mirrored line for line by `promptFeatures` in
    `src/wire/hooks.js`. Keep both in step: the table carries PROBES so a drift
    is detected, not guessed at."""
    s = str(prompt or "").strip()
    words = _WORD_RE.findall(s)
    first = words[0].lower() if words else ""
    return {
        "@bias": 1.0,
        "len~log": round(math.log1p(len(s)) / 10, 4),
        "task_shaped": 1.0 if _TASK_RE.search(s) else 0.0,
        "imperative": 1.0 if first in TASK_VERBS else 0.0,
        "question": 1.0 if "?" in s else 0.0,
        "path": 1.0 if _PATH_RE.search(s) else 0.0,
        "symbol": 1.0 if _SYMBOL_RE.search(s) else 0.0,
        "bb_verb": 1.0 if _BB_RE.search(s) else 0.0,
        "pasted": 1.0 if "<pasted_content" in s else 0.0,
    }


#: The side the threshold errs on. A suppressed fire on a real task costs the
#: session its locate; a fire on a question costs one band of context. So the
#: threshold is the HIGHEST value that still catches 90% of the edited prompts
#: on the holdout, floored at 0.2, and never above 0.5.
RECALL_FLOOR = 0.9


def train_prompts(rows: list, **kw) -> dict:
    """rows: [{prompt, edited: 0|1, at}] — the prompt the hook fired on, joined
    to whether that session went on to edit a file."""
    m = fit_head(rows, lambda r: prompt_featurize(r.get("prompt")), lambda r: r.get("edited"), lambda r: str(r.get("at") or ""), **kw)
    m["errs"] = "toward firing"
    m["probes"] = [{"prompt": p, "features": prompt_featurize(p)} for p in PROBES]
    thr = 0.2
    if m.get("useful"):
        pos = [s for s, y in zip(m["holdout_scores"], m["holdout_labels"]) if y == 1]
        for t in (0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2):
            if pos and sum(1 for s in pos if s >= t) / len(pos) >= RECALL_FLOOR:
                thr = t
                break
    m["threshold"] = thr
    m["fires"] = len([r for r in rows if r.get("edited") in (0, 1)])
    m["edited"] = sum(1 for r in rows if r.get("edited") == 1)
    return m


def predict_prompt(model: dict, prompt) -> dict:
    if not model or not model.get("useful"):
        return {"p": model.get("base_rate") if model else None, "fire": None, "source": "base-rate", "why": (model or {}).get("why", "no model")}
    p = _score(model.get("weights", {}), prompt_featurize(prompt))
    return {"p": round(p, 3), "fire": p >= float(model.get("threshold", 0.2)), "source": "model"}


# ── intent head: which KIND of unit is this prompt? ─────────────────────────
#
# `is this a task` and `what kind of task` are the same question asked of the
# same string, so this reuses `prompt_featurize` rather than growing a second
# featurizer. A second one would be a second thing to keep in step with the JS
# mirror, and the mirror is the only reason PROBES exists.
#
# Five one-vs-rest heads, not one multiclass fit: each kind then carries its
# own `useful`, and a kind the join never labelled falls back on its own
# instead of taking the other four down with it. The caller argmaxes over the
# kinds that beat their base rate and defaults for the rest.

KINDS = ("fix", "verify", "investigate", "build", "write")

#: A kind may only decide once it has been seen this often, and seen this often
#: in the holdout. `fit_head`'s MIN_ROWS is a floor on the join as a whole; with
#: an 80/20 split that leaves a two-row holdout, on which a perfect AUC is luck.
#: A kind that decides here moves ~28k of window, so the bar is its own: enough
#: positives to fit on, and enough held back to have been wrong on.
MIN_KIND_ROWS = 12
MIN_KIND_HOLDOUT = 4


def train_intent(rows: list, **kw) -> dict:
    """rows: [{prompt, kind, at, via}] — the prompt the hook located, against
    the kind that session turned out to be.

    `via` is "behaviour" when the transcript proved the kind and "jev" when
    only an opinion split it. Both are fitted; the counts are carried
    separately so a table resting on opinion is visible as one rather than
    reading like measurement."""
    labelled = [r for r in rows if r.get("kind") in KINDS]
    heads, useful = {}, []
    for k in KINDS:
        h = fit_head(labelled, lambda r: prompt_featurize(r.get("prompt")),
                     lambda r, kind=k: 1 if r.get("kind") == kind else 0,
                     lambda r: str(r.get("at") or ""), **kw)
        pos = sum(1 for r in labelled if r.get("kind") == k)
        ho_pos = sum(h.get("holdout_labels") or [])
        h["positives"] = pos
        h["holdout_positives"] = ho_pos
        # Thin evidence is not a verdict. Beating a base rate of 0.83 on six
        # rows is what one lucky row looks like, and the cost of believing it is
        # a budget decided backwards on every prompt until the next fit.
        if h.get("useful") and (pos < MIN_KIND_ROWS or ho_pos < MIN_KIND_HOLDOUT):
            h["useful"] = False
            h["why"] = f"{pos} rows ({ho_pos} in holdout); need {MIN_KIND_ROWS} and {MIN_KIND_HOLDOUT}"
        # The holdout vectors are what `train_prompts` picks a threshold from.
        # This head argmaxes instead, so they are provenance nobody reads, and
        # five copies of them is five times a table that a hook parses.
        h.pop("holdout_scores", None)
        h.pop("holdout_labels", None)
        heads[k] = h
        if h.get("useful"):
            useful.append(k)
    return {"kinds": heads,
            "useful": bool(useful),
            "useful_kinds": useful,
            "n": len(labelled),
            "by_kind": {k: sum(1 for r in labelled if r.get("kind") == k) for k in KINDS},
            "by_via": {v: sum(1 for r in labelled if (r.get("via") or "behaviour") == v)
                       for v in ("behaviour", "jev")},
            "probes": [{"prompt": p, "features": prompt_featurize(p)} for p in PROBES],
            "why": "" if useful else f"no kind beat its base rate on the time-split holdout ({len(labelled)} rows)"}


# ── finding head: a per-finding prior for `confidence.for_rule` ─────────────

_TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|[._-](test|spec)\.[a-z]+$|^test_")


def finding_featurize(f: dict) -> dict:
    files = [str(x) for x in (f.get("files") or [])]
    x = {"@bias": 1.0,
         f"detector={f.get('detector') or '?'}": 1.0,
         f"severity={f.get('severity') or '?'}": 1.0,
         f"precision={f.get('precision') or 'heuristic'}": 1.0,
         _bucket("est_tokens", f.get("est_tokens")): 1.0,
         _bucket("n_files", len(files)): 1.0,
         "auto_fix": 1.0 if f.get("auto_fix") else 0.0,
         "tests": 1.0 if any(_TEST_PATH.search(p) for p in files) else 0.0,
         "seen~log": round(math.log1p(float(f.get("seen_count") or 0)) / 5, 4)}
    return x


def finding_time(f: dict) -> str:
    return str(f.get("resolved_at") or f.get("last_seen") or f.get("first_seen") or "")


def finding_label(f: dict):
    if f.get("status") == "open" or f.get("closed_by") in ("unknown", "", None):
        return None
    return 1 if f.get("closed_by") == "acted_on" else 0


def train_findings(findings: list, **kw) -> dict:
    return fit_head(findings, finding_featurize, finding_label, finding_time, **kw)


def predict_finding(model: dict, f: dict) -> float | None:
    if not model or not model.get("useful"):
        return None
    return round(_score(model.get("weights", {}), finding_featurize(f)), 4)
