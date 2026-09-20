"""How much the expert system is allowed to promote at once.

Triage answers "is this finding worth doing". It cannot answer "is this the
tenth thing I have said yes to in one run", because it sees one finding at a
time. Without a throttle a scan that turns up 78 findings promotes every one
that clears the floor, and the factory hands a session more work than a window
holds — the exact failure the thing is meant to prevent.

Five limits, each with a threshold a person can read and change in
`cfg.expert.throttle`:

  max_promotions   how many findings one run may promote at all
  max_tokens       the estimated token bill those promotions may add up to
  per_detector     how many any ONE detector may contribute, so a noisy
                   detector cannot spend the whole budget on itself
  per_detector_open  how many OPEN rows one detector may hold on the board
                   before it stops being promoted at all
  cooldown_runs    how many runs a detector sits out after its work was
                   judged broken, so a bad rule stops costing money

`per_detector` is per RUN, and that is why it stopped holding. A detector four
rows at a time over ten runs is forty rows on a board nobody can close, and the
limit never fired once: measured on this tree, `duplicate-blocks` had 285 open
rows and `oversight:duplication` 200, together 55% of a 875-row board, while
every run stayed inside its budget. Deduplicating two 40-line windows means
choosing an abstraction and deciding where it lives, which no actuator will
guess at, so the rule was producing rows with no close path and the throttle
could not see it.

`per_detector_open` is the limit that can. A detector at or over it reports as a
COUNT rather than as work: its rows stay open, stay countable and stay in
`bb findings`, and they stop being compiled into units. Forty is ten runs of
that detector's own per-run budget, which is long enough that a rule still at
the cap is not being closed by anybody.

A row whose actuator CLOSES it is exempt, and that exemption is the argument
rather than a softener: the problem is a board with no close path, and an
actuator that edits is the close path. A `plan-` actuator is not one. Seven of
them write the plan behind a decision and leave the finding open for the person
who makes it, which is the correct behaviour and is also why the duplication
rules pile up: lifting two 40-line windows means choosing an abstraction and
deciding where it lives, and nothing here will guess at that.

Nothing is dropped: what does not fit is DEFERRED with the limit that stopped
it, and the next run reconsiders it first. `suppressed` names every detector a
board-level limit silenced and how many rows it is holding, because a finding
that stops being promoted must still be countable. The order is priority, then
expected value, so the throttle never quietly reorders by scan order.
"""
from __future__ import annotations

THROTTLE = {
    "max_promotions": 12,
    "max_tokens": 120000,
    "per_detector": 4,
    "per_detector_open": 40,
    "cooldown_runs": 3,
}


def closes(auto_fix: str | None) -> bool:
    """Does this actuator CLOSE the finding, or only write the plan behind it?
    The `plan-` prefix is the convention `src/actuators/index.js` already keeps,
    and the distinction is the one `per_detector_open` turns on."""
    name = str(auto_fix or "")
    return bool(name) and not name.startswith("plan-")


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
    history: {detector: {cooldown, open}} — `open` is the detector's open rows on
    the board, which is the count `per_detector_open` reads.
    Returns the same rows, each with `throttled` and a reason when deferred."""
    lim = limits(cfg)
    hist = history or {}
    suppressed: dict = {}
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
        open_rows = int((hist.get(det) or {}).get("open", 0) or 0)
        cap = lim["per_detector_open"]
        if cool > 0:
            why = f"{det} is in cooldown for {cool} more run(s): its last work was judged broken"
        elif cap and open_rows >= cap and not closes(d.get("auto_fix")):
            why = (f"{det} holds {open_rows} open finding(s), at or over per_detector_open={cap}; "
                   "it reports as a count until that board is closed")
            suppressed[det] = {"open": open_rows, "limit": cap, "deferred": suppressed.get(det, {}).get("deferred", 0) + 1}
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
    sup = sum(v["deferred"] for v in suppressed.values())
    note = "" if not suppressed else (
        "; " + ", ".join(f"{d} suppressed at {v['open']} open" for d, v in sorted(suppressed.items())))
    return {"promoted": kept, "deferred": deferred, "held": held, "limits": lim,
            "tokens": spent, "by_detector": n_by_detector, "suppressed": suppressed,
            "summary": f"{len(kept)} promoted, {len(deferred)} deferred ({sup} board-suppressed), {len(held)} held; {spent} of {lim['max_tokens']} tokens{note}"}


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
