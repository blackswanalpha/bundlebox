"""Was the locate right? Scored against what the session actually edited.

Twenty-six detectors score the code. Nothing scored whether `bb pinpoint`
pointed at the right files, so `ambiguity()` could only ask presence questions —
`no-location` fires when NOTHING matched, and a locate that matched three
irrelevant symbols reports no ambiguity at all.

The labels for the missing answer are already on disk. A brief records the scope
it located, the files it CUT to fit the window and the candidates it ranked but
did not scope; a transcript records every edit. Join them and every locate this
box has made has a ground truth.

**The confound is the whole methodology.** The brief says "Scope — the only files
you may edit", so an obedient agent edits inside the scope by construction and a
precision taken over every edit reads high for a reason that has nothing to do
with the locate being right. An in-scope edit is therefore not scored at all.
Only the EXCEPTION rows carry signal, and there are three kinds:

    from_cut          the ranker found it, the budget cut it, the work went
                      there anyway. The locate was right and the ceiling was
                      wrong.
    from_candidates   named below the scope line under the "say which one you
                      opened and why" rule, and opened.
    unnamed           the locate never mentioned it. This is the miss.

So `recall` here is: of the edits that went outside the scope, how many the
locate had already found and ranked. `precision` is: of the files it offered
below the line, how many were used. Neither is a claim about in-scope work and
neither should be read as one.

Reverted edits are dropped first. A file changed and changed back inside one
window is a wrong turn, not a target, and `oscillate` already settled that a
returning hash is the signal for it.

Rule 2 of the echos doctrine holds: too few exception rows returns `unknown`,
never a figure. A small-sample number that reads like a measured one is worse
than no number.
"""
from __future__ import annotations

import posixpath
import re

from . import confidence

#: Exception rows needed before the pair of numbers is a measurement.
MIN_ROWS = 12
#: Briefs that produced at least one exception row, needed for the same reason:
#: twelve rows out of one odd task is one task, not an error rate.
MIN_WINDOWS = 4


def thresholds(cfg: dict | None = None) -> dict:
    """Defaults merged with `cfg.pinpoint.locate`. Printed with every result,
    because a threshold nobody can see is an assertion."""
    user = ((cfg or {}).get("pinpoint") or {}).get("locate") or {}
    out = {"min_rows": MIN_ROWS, "min_windows": MIN_WINDOWS}
    for k in out:
        if k in user:
            try:
                out[k] = max(1, int(user[k]))
            except (TypeError, ValueError):
                pass
    return out


def reverted(edits: list) -> set:
    """Files whose content returned to a value it already held in this window.

    Keyed on the hash of the text WRITTEN, which is the only value this box
    records: nothing on disk says what a file held between two edits. An edit
    with no hash — a shell write, which carries no path either — cannot be
    judged and is not counted on either side."""
    seen: dict = {}
    back: set = set()
    for e in edits:
        f, h = str(e.get("file") or ""), str(e.get("hash") or "")
        if not f or not h:
            continue
        if h in seen.setdefault(f, set()):
            back.add(f)
        seen[f].add(h)
    return back


#: The guard's own test pattern, ported from `writeVerdict` in
#: `src/grapple/detect.js`, not the wider one in `detectors/_shared.js`: a row
#: the guard would deny but this figure drops is the flattering direction.
GUARD_TEST = re.compile(r"(^|/)test/|\.test\.[jt]sx?$|_test\.(py|go|rs)$|(^|/)tests?/")


def excluded(file: str, created: bool = False) -> str:
    """Why an exception row is not the locate's to answer for, or "" when it is.

    The first three mirror `writeVerdict` in `src/grapple/detect.js` exactly,
    and they have to: that guard is what this figure is read to decide, and a
    denominator holding rows the guard exempts measures something nobody acts
    on. The fourth is the locate's own — a file that did not exist when the
    brief was written could not have been ranked, so counting it as a miss
    charges the ranker for a file it could not see.

    Mirrors `excluded` in `src/pinpoint/locate.js`; `test/pinpoint.test.js` and
    `expert/tests/test_locate.py` pin the two to the same answers."""
    f = str(file or "")
    if not f:
        return ""
    if posixpath.isabs(f) or f.startswith("..") or (len(f) > 1 and f[1] == ":"):
        return "outside-workspace"
    if f == ".bundlebox" or f.startswith(".bundlebox/") or f.startswith(".bundlebox\\") or f == "GATES.md":
        return "generated"
    if GUARD_TEST.search(f.replace("\\", "/")):
        return "test"
    if created:
        return "created"
    return ""


def classify(win: dict) -> dict:
    """One brief's window, split into the four buckets above, with the rows
    nobody can be scored on lifted out first.

    Files, not edits: a session that touched one file eleven times learned one
    thing about the locate, and counting the eleven would let one busy file
    outweigh ten quiet ones."""
    scope = {str(x) for x in win.get("scope") or []}
    cut = {str(x) for x in win.get("cut") or []}
    cand = {str(x) for x in win.get("candidates") or []}
    edits = list(win.get("edits") or [])
    back = reverted(edits)
    touched, order, born = set(), [], set()
    for e in edits:
        f = str(e.get("file") or "")
        if not f or f in back or f in touched:
            continue
        touched.add(f)
        if e.get("created"):
            born.add(f)
        order.append(f)
    buckets = {"in_scope": [], "from_cut": [], "from_candidates": [], "unnamed": [], "excluded": []}
    for f in order:
        # In scope first: an obedient edit is unscored either way, and reporting
        # it as excluded would hide how much of the window the brief did aim at.
        if f in scope:
            buckets["in_scope"].append(f)
            continue
        why = excluded(f, f in born)
        if why:
            buckets["excluded"].append({"file": f, "why": why})
            continue
        if f in cut:
            buckets["from_cut"].append(f)
        elif f in cand:
            buckets["from_candidates"].append(f)
        else:
            buckets["unnamed"].append(f)
    named = len(buckets["from_cut"]) + len(buckets["from_candidates"])
    missed = len(buckets["unnamed"])
    return {
        "session": str(win.get("session") or ""),
        "at": win.get("at") or 0,
        "brief": str(win.get("brief") or ""),
        "offered": len(cut | cand),
        "scope": len(scope),
        "reverted": sorted(back),
        "named": named,
        "missed": missed,
        "rows": named + missed,
        **buckets,
    }


def replay(windows: list, cfg: dict | None = None) -> dict:
    """The baseline: what the lexical locate is worth, with `n` beside it.

    `for_rule` does the blending. `held` is an exception row the locate had
    already ranked and `broken` is one it never mentioned, so `hold_rate` is
    recall over the exception rows and `confidence` is that recall shrunk
    toward the method's own precision at `settled / (settled + SHRINKAGE)` —
    three samples cannot override the method and zero samples report neither 0
    nor 1."""
    th = thresholds(cfg)
    rows = [classify(w) for w in windows or []]
    scored = [r for r in rows if r["rows"] > 0]
    n = sum(r["rows"] for r in scored)
    named = sum(r["named"] for r in scored)
    missed = sum(r["missed"] for r in scored)
    offered = sum(r["offered"] for r in scored)
    # Counted over EVERY window, not just the scored ones: a window whose only
    # exception rows were excluded scores nothing, and leaving it out of this
    # tally would hide why the sample is smaller than the edit count suggests.
    by_why: dict = {}
    for r in rows:
        for x in r.get("excluded") or []:
            by_why[x["why"]] = by_why.get(x["why"], 0) + 1
    base = {
        "windows_seen": len(rows),
        "windows_scored": len(scored),
        "n": n,
        "named": named,
        "missed": missed,
        "offered": offered,
        "in_scope_unscored": sum(len(r["in_scope"]) for r in rows),
        "reverted": sum(len(r["reverted"]) for r in rows),
        "excluded": sum(by_why.values()),
        "excluded_by": by_why,
        "thresholds": th,
    }
    if n < th["min_rows"] or len(scored) < th["min_windows"]:
        return dict(
            base,
            verdict="unknown",
            precision=None,
            recall=None,
            confidence=None,
            detail=(
                f"{n} exception row(s) over {len(scored)} brief(s); "
                f"{th['min_rows']} rows over {th['min_windows']} brief(s) are needed before the locate's aim is a "
                "measurement rather than one odd task. An in-scope edit is not evidence: the brief told the session "
                "to make it."
                + (f" {base['excluded']} further edit(s) are not counted here ("
                   + ", ".join(f"{v} {k}" for k, v in by_why.items())
                   + "): the write guard exempts the first three and the ranker could not have seen the fourth."
                   if base["excluded"] else "")
            ),
        )
    conf = confidence.for_rule("lexical", held=named, broken=missed)
    precision = round(named / offered, 4) if offered else None
    recall = round(named / n, 4)
    return dict(
        base,
        verdict="measured",
        precision=precision,
        recall=recall,
        confidence=conf["confidence"],
        blend=conf,
        detail=(
            f"of {n} edit(s) that went outside the located scope across {len(scored)} brief(s), the locate had "
            f"already ranked {named} and never mentioned {missed} (recall {recall}). "
            + (f"{named} of {offered} file(s) offered below the scope line were opened (precision {precision}). "
               if offered else "no file was offered below the scope line, so precision is not defined. ")
            + f"Confidence {conf['confidence']}, blended from {conf['settled']} sample(s) toward the method's "
              f"{conf['base']}."
            + (f" {base['excluded']} further edit(s) were outside this figure ("
               + ", ".join(f"{v} {k}" for k, v in by_why.items())
               + "): the write guard exempts the first three and the ranker could not have seen the fourth."
               if base["excluded"] else "")
        ),
    )
