"""Closed frequent sequences over what this workspace has already done.

The graph module already gives first-order structure: verb -> verb, with a lift
that says whether the pair happens more than chance. What it cannot give is the
thing worth automating, because that is almost never a pair. `scan` then
`compile` then `route` then `run` is one habit, four turns long, and a
first-order model sees three unremarkable edges.

So this mines SEQUENCES, with four properties that matter for the use. Every one
of them was put here by a measurement on this workspace's own data, not by
taste.

  CONTIGUOUS  Standard sequential mining allows gaps, which is right for
              shopping baskets and wrong here. `test` two turns after `edit` is
              a different act from `test` immediately after it, and a script
              claiming to replace the first would be lying about what it
              replaces. A pattern must appear as an unbroken run.

  PROJECTED   PrefixSpan with a projected database. The first version counted
              each candidate by scanning the whole corpus -- |level| x |alphabet|
              scans per level -- and on a real corpus of sixteen sessions it did
              not finish: four minutes of wall clock and still going. Carrying
              the POSITIONS where a pattern occurs makes an extension cost the
              pattern's own occurrence count, because the only items worth
              trying are the ones that actually follow those positions, and
              counting them builds the next position lists in the same pass.

  CLOSED      A pattern is kept only when no one-item extension, forward or
              backward, has the same support. `scan -> compile` at 40 is not a
              finding when `scan -> compile -> route` is also at 40: they are one
              habit, and reporting the prefix separately proposes two scripts for
              it. This is BIDE's test, and here it is what keeps the emitted set
              small.

  APERIODIC   `grep head grep head grep head` is one habit run three times, not
              a habit six steps long. The base cycle is reported -- the miner
              finds it on its own -- and the repetition is dropped.

Nothing here decides what to DO with a pattern. The caller emits scripts,
snippets and templates; this module counts, and says how confident the count is.
"""
from __future__ import annotations

import math

# A cap on the pattern length, not on the growth.
#
# It used to be 8, and that was wrong in a way only real data showed: the
# pipeline this workspace runs is fourteen verbs long, so every 8-item window of
# it had support 59 and every one of them looked CLOSED -- not because the data
# said so, but because growth stopped at the cap and no 9-item extension existed
# to disprove it. Six rows describing one habit.
#
# Projection makes growth cost the pattern's own occurrence count, so the cap can
# be generous and closedness can do the job it is there for.
MAX_LEN = 24
# Below this many occurrences a pattern is a coincidence of two sessions.
MIN_SUPPORT = 3


def _runs(sequences: list) -> list:
    """The input, normalised: a list of lists of non-empty strings."""
    out = []
    for s in sequences or []:
        if isinstance(s, dict):
            s = s.get("items") or []
        items = [str(x) for x in s if str(x or "").strip()]
        if items:
            out.append(items)
    return out


def period(items: tuple) -> int:
    """The shortest cycle this pattern repeats, or its own length."""
    n = len(items)
    for p in range(1, n // 2 + 1):
        if n % p:
            continue
        if all(items[i] == items[i % p] for i in range(n)):
            return p
    return n


def occurrences(runs: list, pattern: tuple) -> int:
    """How many times this pattern appears as an unbroken run.

    Kept for the tests and for a caller checking one pattern. `mine` never uses
    it: a corpus scan per candidate is the cost the projection exists to remove.
    """
    n = len(pattern)
    if not n:
        return 0
    total = 0
    for r in runs:
        for i in range(len(r) - n + 1):
            if tuple(r[i:i + n]) == pattern:
                total += 1
    return total


def sessions_with(runs: list, pattern: tuple) -> int:
    """How many distinct sequences hold it."""
    n = len(pattern)
    return sum(1 for r in runs if any(tuple(r[i:i + n]) == pattern for i in range(len(r) - n + 1)))


def mine(sequences: list, min_support: int = MIN_SUPPORT, max_len: int = MAX_LEN) -> list:
    """Every closed, aperiodic, contiguous pattern of length >= 2, longest first.

    Each row is {items, support, sessions, confidence, lift}: `support` counts
    occurrences, `sessions` counts the distinct sequences holding it,
    `confidence` is the probability the run continues as the pattern says once
    its first two items have been seen, and `lift` is that against the base rate
    of the last item.
    """
    runs = _runs(sequences)
    if not runs:
        return []
    floor = max(1, int(min_support))
    cap = max(2, int(max_len))

    unigrams = {}
    total_items = 0
    for r in runs:
        for x in r:
            unigrams[x] = unigrams.get(x, 0) + 1
            total_items += 1

    # pattern -> [(run, start)]. The projected database: one entry per occurrence.
    level = {(x,): [] for x, c in unigrams.items() if c >= floor}
    for i, r in enumerate(runs):
        for j, x in enumerate(r):
            key = (x,)
            if key in level:
                level[key].append((i, j))

    found = {}
    # Every pattern visited at any length, with its support. `confidence` needs
    # the support of a pattern's own two-item prefix, and re-counting that with a
    # corpus scan per row was the other half of the original's cost.
    support_of = {}
    while level:
        nxt = {}
        for p, pos in level.items():
            n = len(p)
            support = len(pos)
            support_of[p] = support
            # Forward extensions, counted only where this pattern already is.
            fwd = {}
            for (i, j) in pos:
                k = j + n
                if k < len(runs[i]):
                    fwd.setdefault(runs[i][k], []).append((i, j))
            # Backward, for closedness only: a pattern always preceded by the
            # same item is not closed either, because the longer pattern carries
            # the same support and more information.
            bwd = {}
            for (i, j) in pos:
                if j > 0:
                    bwd[runs[i][j - 1]] = bwd.get(runs[i][j - 1], 0) + 1
            closed = (max((len(v) for v in fwd.values()), default=0) < support
                      and max(bwd.values(), default=0) < support)
            if n >= 2 and closed and period(p) == n:
                found[p] = (support, pos)
            if n < cap:
                for x, where in fwd.items():
                    if len(where) >= floor:
                        nxt[p + (x,)] = where
        level = nxt

    rows = []
    for p, (c, pos) in found.items():
        head = support_of.get(p[:2], 0)
        base = unigrams.get(p[-1], 0) / total_items if total_items else 0.0
        conf = (c / head) if head else 0.0
        rows.append({
            "items": list(p),
            "support": c,
            # Read off the position list; the corpus scan this replaces was the
            # other half of the quadratic.
            "sessions": len({i for (i, _j) in pos}),
            "confidence": round(conf, 4),
            "lift": round(conf / base, 3) if base > 0 else None,
        })
    rows.sort(key=lambda r: (-len(r["items"]), -r["support"], r["items"]))
    return rows


def entropy(counts: dict) -> float:
    """Shannon entropy of a name distribution, in bits.

    What it is for: a prefix whose continuations are one name is worth
    completing, and a prefix with forty equally likely continuations is not.
    Entropy is the number the completion table ranks on, so the caller never has
    to pick an arbitrary "top N".
    """
    total = sum(counts.values())
    if total <= 0:
        return 0.0
    h = 0.0
    for c in counts.values():
        if c <= 0:
            continue
        p = c / total
        h -= p * math.log2(p)
    return round(h, 4)


def completions(names: list, min_prefix: int = 3, max_prefix: int = 12, min_count: int = 2) -> list:
    """Prefixes worth completing, from the tree's own identifiers.

    A prefix earns a row when it has at least `min_count` continuations and its
    entropy is low enough that a completion is a prediction rather than a menu.
    `certain` is the prefix that resolves to exactly one name: the only case
    where a completion cannot be wrong.
    """
    by_prefix = {}
    seen = set()
    for n in names or []:
        s = str(n or "")
        if not s or s in seen:
            continue
        seen.add(s)
        for k in range(min_prefix, min(len(s), max_prefix) + 1):
            by_prefix.setdefault(s[:k], []).append(s)
    rows = []
    for p, group in by_prefix.items():
        if len(group) < min_count:
            continue
        # A prefix that IS the name completes nothing. `out_of_scope ->
        # out_of_scope` was in the first table 400 times over, because the
        # prefix loop runs up to the name's own length.
        if all(len(g) <= len(p) for g in group):
            continue
        counts = {g: 1 for g in group}
        rows.append({
            "prefix": p,
            "n": len(group),
            "entropy": entropy(counts),
            "certain": len(group) == 1,
            "names": sorted(group)[:8],
        })
    # Longest prefix first at equal entropy: a longer prefix is a stronger claim.
    rows.sort(key=lambda r: (r["entropy"], -len(r["prefix"])))
    return rows
