"""How much the expert system is allowed to promote at once.

Triage answers "is this finding worth doing". It cannot answer "is this the
tenth thing I have said yes to in one run", because it sees one finding at a
time. Without a throttle a scan that turns up 78 findings promotes every one
that clears the floor, and the factory hands a session more work than a window
holds — the exact failure the thing is meant to prevent.

Four limits, each with a threshold a person can read and change in
`cfg.expert.throttle`:

  max_promotions   how many findings one run may promote at all
  max_tokens       the estimated token bill those promotions may add up to
  per_detector     how many any ONE detector may contribute, so a noisy
                   detector cannot spend the whole budget on itself
  cooldown_runs    how many runs a detector sits out after its work was
                   judged broken, so a bad rule stops costing money

Nothing is dropped: what does not fit is DEFERRED with the limit that stopped
it, and the next run reconsiders it first. The order is priority, then expected
value, so the throttle never quietly reorders by scan order.
"""
from __future__ import annotations

THROTTLE = {
    "max_promotions": 12,
    "max_tokens": 120000,
    "per_detector": 4,
    "cooldown_runs": 3,
}


def limits(cfg: dict | None = None) -> dict:
    """Defaults merged with `cfg.expert.throttle`. Unknown keys are ignored, so a
    typo in a config file cannot silently disable a limit."""
    user = ((cfg or {}).get("expert") or {}).get("throttle") or {}
    out = dict(THROTTLE)
    for k in THROTTLE:
        if k in user:
            try:
                out[k] = max(0, int(user[k]))
            except (TypeError, ValueError):
                pass
    return out


def apply(decisions: list, cfg: dict | None = None, history: dict | None = None) -> dict:
    """decisions: [{id, detector, promote, priority, ev, est_tokens, ...}].
    Returns the same rows, each with `throttled` and a reason when deferred."""
    lim = limits(cfg)
    hist = history or {}
    promoted = [d for d in decisions if d.get("promote")]
    held = [dict(d, throttled=False) for d in decisions if not d.get("promote")]
    # Priority first (0 is most urgent), then expected value, then id: a stable
    # order, so two runs over the same findings defer the same ones.
    promoted.sort(key=lambda d: (int(d.get("priority", 3)), -float(d.get("ev") or 0), str(d.get("id", ""))))
    kept, deferred = [], []
    n_by_detector: dict = {}
    spent = 0
    for d in promoted:
        det = d.get("detector", "")
        cool = int((hist.get(det) or {}).get("cooldown", 0) or 0)
        tok = int(d.get("est_tokens") or 0)
        why = None
        if cool > 0:
            why = f"{det} is in cooldown for {cool} more run(s): its last work was judged broken"
        elif len(kept) >= lim["max_promotions"]:
            why = f"run is at max_promotions={lim['max_promotions']}"
        elif n_by_detector.get(det, 0) >= lim["per_detector"]:
            why = f"{det} is at per_detector={lim['per_detector']} for this run"
        elif spent + tok > lim["max_tokens"]:
            why = f"run is at max_tokens={lim['max_tokens']} ({spent} spent, {tok} more)"
        if why:
            deferred.append(dict(d, promote=False, throttled=True, throttle_reason=why, deferred=True))
            continue
        kept.append(dict(d, throttled=False))
        n_by_detector[det] = n_by_detector.get(det, 0) + 1
        spent += tok
    return {"promoted": kept, "deferred": deferred, "held": held, "limits": lim,
            "tokens": spent, "by_detector": n_by_detector,
            "summary": f"{len(kept)} promoted, {len(deferred)} deferred, {len(held)} held; {spent} of {lim['max_tokens']} tokens"}


def cooldowns(outcomes: list, runs: int | None = None) -> dict:
    """A detector whose most recent scored lane was broken sits out. Read from
    the outcome rows the factory already writes, never from an opinion."""
    span = THROTTLE["cooldown_runs"] if runs is None else runs
    latest: dict = {}
    for o in outcomes:
        for det in o.get("detectors") or []:
            prev = latest.get(det)
            at = o.get("scored_at") or o.get("ended") or ""
            if prev is None or at >= prev[0]:
                latest[det] = (at, o.get("verdict"))
    return {det: {"cooldown": span if v == "broken" else 0, "last_verdict": v}
            for det, (_at, v) in latest.items()}
