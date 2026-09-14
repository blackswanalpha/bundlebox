"""What the factory has come to believe, as sentences with support.

Three tiers, because a fact about one session and a rule about how to work are
not the same kind of thing and must not compete for the same budget:

  episodic    what happened: this file was re-read, this verb ran, this script
              was used. Regenerated from the rows every derive.
  semantic    what that adds up to: the hot set, the verb portfolio. Built by
              consolidate() from the episodic tier, never written by hand.
  procedural  what to do about it: a fired rule with an actuator. The tier that
              compounds, so it decays slowest and is recalled first.

Episodic and semantic claims are REGENERATED from the data on every derive, not
accumulated: run it twice on the same rows and you get the same memory. What
survives a derive is the reinforcement a claim earned — how often it was
recalled, how often it was marked useful — because that is feedback, not data.

A claim leaves five ways: decay (a half-life per tier, measured from the last
time it was RE-DERIVED, never from the last time it was written), contradiction
(contra >= 2), supersession by key (the newer text wins and the older is kept as
a tombstone, so state is auditable and retrieval is unambiguous), eviction when
the store is over MAX_CLAIMS, and a path that no longer exists.
"""
from __future__ import annotations
import os
import time

# Procedural memory is where performance compounds, so it is the last to fade;
# an episode is a fact about one week and should not outlive it by much.
HALF_LIFE_DAYS = {"episodic": 21.0, "semantic": 45.0, "procedural": 90.0}
DEFAULT_HALF_LIFE = 21.0
TIER_PRIOR = {"procedural": 1.35, "semantic": 1.15, "episodic": 1.0}
CONTRA_DROP = 2
RECALL_FLOOR = 0.05
MAX_CLAIMS = 400
MAX_TOMBSTONES = 200
CONSOLIDATE_AT = 3          # episodic claims of one family before a semantic one is worth it
REINFORCE_STEP = 0.06       # what one recall adds to salience, before the cap
REINFORCE_CAP = 0.30
USEFUL_STEP = 0.10          # what one "that helped" adds, before the same cap


def _age_days(iso: str, now: float) -> float | None:
    try:
        t = time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))
        return max(0.0, (now - t) / 86400)
    except (ValueError, TypeError):
        return None


def half_life(claim: dict) -> float:
    return HALF_LIFE_DAYS.get(claim.get("tier", "episodic"), DEFAULT_HALF_LIFE)


def reinforcement(claim: dict) -> float:
    """Salience a claim earned by being recalled and by being marked useful.
    Capped, so a claim cannot become immortal by being retrieved in a loop."""
    uses = int(claim.get("uses", 0) or 0)
    useful = int(claim.get("useful", 0) or 0)
    return min(REINFORCE_CAP, uses * REINFORCE_STEP + useful * USEFUL_STEP)


def decayed(claim: dict, now: float | None = None) -> float:
    now = now or time.time()
    age = _age_days(claim.get("last_seen", ""), now)
    if age is None:
        return 0.0  # unparseable timestamp: treat as fully decayed, never immortal
    base = float(claim.get("confidence", 0.5)) + reinforcement(claim)
    return min(0.99, base) * (0.5 ** (age / half_life(claim)))


def _exists(root: str, path: str) -> bool:
    if os.path.isabs(path):
        return os.path.exists(path)
    return os.path.exists(os.path.join(root, path))


def derive(signals: dict, episodes: list, scripts: list, root: str, now_iso: str,
           recommendations: list | None = None) -> list:
    """Fresh claims from the data. Each has a key; reconcile() merges with the old set."""
    out = []
    hot = []
    for path, n in (signals.get("top_reread_files") or [])[:10]:
        if not _exists(root, path):
            continue
        hot.append((path, n))
        out.append({"key": f"file/{path}", "tier": "episodic",
                    "claim": f"{path} was re-read {n} times across recent sessions; hand it as a signature view, not a file",
                    "evidence": {"rereads": n}, "confidence": min(0.95, 0.5 + 0.05 * n), "tokens": 30, "source": "signals"})
    by_verb: dict = {}
    for e in episodes:
        v = e.get("verb")
        if not v:
            continue
        b = by_verb.setdefault(v, {"n": 0, "turns": 0, "useful": 0, "labelled": 0})
        b["n"] += 1
        b["turns"] += int(e.get("turns_saved") or 0)
        if e.get("useful") in (0, 1):
            b["labelled"] += 1
            b["useful"] += e["useful"]
    for v, b in by_verb.items():
        if b["n"] >= 3 and b["turns"]:
            out.append({"key": f"verb/{v}", "tier": "episodic",
                        "claim": f"`bb {v}` has run {b['n']} times and displaced {b['turns']} agent turns" + (f"; useful {b['useful']}/{b['labelled']} times" if b["labelled"] else ""),
                        "evidence": dict(b), "confidence": min(0.95, 0.6 + 0.02 * b["n"]), "tokens": 28, "source": "episodes"})
    for s in scripts:
        p = s.get("path") or ""
        if int(s.get("runs") or 0) >= 3 and p and _exists(root, p):
            out.append({"key": f"script/{s.get('tag')}", "tier": "episodic",
                        "claim": f"{p} ({s.get('tag')}) has run {s['runs']} times: {s.get('title') or ''}".strip(),
                        "evidence": {"runs": s["runs"], "last_rc": s.get("last_rc")}, "confidence": 0.7, "tokens": 26, "source": "scripts"})
    # Procedural: a rule that fired is an instruction, and it is the tier that
    # changes how the next session works rather than describing the last one.
    for r in (recommendations or []):
        rid = r.get("id")
        if not rid:
            continue
        act = (r.get("actuator") or "").strip()
        out.append({"key": f"rule/{rid}", "tier": "procedural",
                    "claim": f"{r.get('title') or rid}" + (f" — run `{act}`" if act else ""),
                    "evidence": {"why": r.get("why", "")[:200], "actuator": act},
                    "confidence": 0.75, "tokens": 34, "source": "rules"})
    out.extend(consolidate(hot, by_verb, now_iso))
    for c in out:
        c.setdefault("tier", "episodic")
        c["support"] = 1
        c["contra"] = 0
        c["uses"] = 0
        c["useful"] = 0
        c["first_seen"] = now_iso
        c["last_seen"] = now_iso
        c["derived_at"] = now_iso
    return out


def consolidate(hot: list, by_verb: dict, now_iso: str) -> list:
    """Many episodic rows → one semantic sentence. The point is the token bill:
    ten file claims cost 300 tokens to say what one line says for 34."""
    out = []
    if len(hot) >= CONSOLIDATE_AT:
        names = ", ".join(p for p, _ in hot[:6])
        total = sum(n for _, n in hot)
        out.append({"key": "set/hot", "tier": "semantic",
                    "claim": f"the hot set is {len(hot)} files ({total} re-reads): {names}; `bb snapgen build --only hot` covers all of them in one table",
                    "evidence": {"files": [p for p, _ in hot], "rereads": total},
                    "confidence": min(0.92, 0.6 + 0.03 * len(hot)), "tokens": 40, "source": "consolidation",
                    "consolidates": [f"file/{p}" for p, _ in hot]})
    earners = sorted(((v, b) for v, b in by_verb.items() if b["turns"] > 0), key=lambda kv: -kv[1]["turns"])
    if len(earners) >= CONSOLIDATE_AT:
        turns = sum(b["turns"] for _, b in earners)
        top = ", ".join(f"bb {v}" for v, _ in earners[:5])
        out.append({"key": "set/verbs", "tier": "semantic",
                    "claim": f"{len(earners)} verbs have displaced {turns} agent turns here; the earners are {top}",
                    "evidence": {"verbs": [v for v, _ in earners], "turns": turns},
                    "confidence": min(0.92, 0.6 + 0.03 * len(earners)), "tokens": 36, "source": "consolidation",
                    "consolidates": [f"verb/{v}" for v, _ in earners]})
    return out


def reconcile(old: list, fresh: list, now_iso: str, now: float | None = None,
              tombstones: list | None = None) -> dict:
    """Merge the fresh derivation into the kept set. Returns claims AND the
    tombstones, because a superseded claim is evidence of what changed."""
    now = now or time.time()
    by_key = {c["key"]: c for c in old}
    tombs = list(tombstones or [])
    out = []
    seen = set()
    for c in fresh:
        seen.add(c["key"])
        o = by_key.get(c["key"])
        if o:
            # Recency wins, but the old sentence is kept when it actually
            # changed: retrieval stays unambiguous, the audit stays possible.
            if (o.get("claim") or "") != c["claim"]:
                tombs.append({"key": c["key"], "claim": o.get("claim", ""), "tier": o.get("tier", "episodic"),
                              "invalidated_at": now_iso, "reason": "superseded", "first_seen": o.get("first_seen") or now_iso})
            c["support"] = int(o.get("support", 0)) + 1
            c["contra"] = 0
            c["uses"] = int(o.get("uses", 0) or 0)          # reinforcement is feedback, it survives regeneration
            c["useful"] = int(o.get("useful", 0) or 0)
            c["first_seen"] = o.get("first_seen") or now_iso
            c["last_seen"] = now_iso  # re-derived: the only event that moves last_seen
        out.append(c)
    for o in old:
        if o["key"] in seen:
            continue
        o = dict(o)
        o["contra"] = int(o.get("contra", 0)) + 1
        # NOT re-derived: last_seen stays where it was, so decay measures real age
        if o["contra"] >= CONTRA_DROP:
            tombs.append({"key": o["key"], "claim": o.get("claim", ""), "tier": o.get("tier", "episodic"),
                          "invalidated_at": now_iso, "reason": "contradicted", "first_seen": o.get("first_seen") or now_iso})
            continue
        if decayed(o, now) < RECALL_FLOOR:
            tombs.append({"key": o["key"], "claim": o.get("claim", ""), "tier": o.get("tier", "episodic"),
                          "invalidated_at": now_iso, "reason": "decayed", "first_seen": o.get("first_seen") or now_iso})
            continue
        out.append(o)
    out, evicted = evict(out, now)
    for e in evicted:
        tombs.append({"key": e["key"], "claim": e.get("claim", ""), "tier": e.get("tier", "episodic"),
                      "invalidated_at": now_iso, "reason": "evicted", "first_seen": e.get("first_seen") or now_iso})
    return {"claims": out, "tombstones": tombs[-MAX_TOMBSTONES:],
            "by_tier": {t: sum(1 for c in out if c.get("tier") == t) for t in ("episodic", "semantic", "procedural")}}


def evict(claims: list, now: float | None = None) -> tuple:
    """Bound the store. Lowest salience goes first, so what is kept is what is
    still being retrieved rather than what happens to be oldest."""
    if len(claims) <= MAX_CLAIMS:
        return claims, []
    ranked = sorted(claims, key=lambda c: -(decayed(c, now) * TIER_PRIOR.get(c.get("tier", "episodic"), 1.0)))
    return ranked[:MAX_CLAIMS], ranked[MAX_CLAIMS:]


def recall(claims: list, about: str, budget_tokens: int = 1100, limit: int = 12,
           now: float | None = None, tiers: list | None = None) -> dict:
    """The read path: term overlap x tier prior x decayed salience, inside a
    token budget. A consolidated claim suppresses the episodic rows it folds,
    so the budget is never spent saying the same thing twice."""
    now = now or time.time()
    want = set(tiers) if tiers else None
    terms = {t.lower() for t in about.replace("/", " ").replace("_", " ").replace("-", " ").split() if len(t) >= 3}
    scored = []
    for c in claims:
        if want and c.get("tier", "episodic") not in want:
            continue
        d = decayed(c, now)
        if d < RECALL_FLOOR:
            continue
        text = (c.get("claim", "") + " " + c.get("key", "")).lower()
        hits = sum(1 for t in terms if t in text)
        score = (hits * 2 + d) * TIER_PRIOR.get(c.get("tier", "episodic"), 1.0)
        scored.append((score, c, d))
    scored.sort(key=lambda x: (-x[0], x[1].get("key", "")))
    covered = set()
    for score, c, _d in scored:
        if c.get("consolidates"):
            covered.update(c["consolidates"])
    chosen, spent, suppressed = [], 0, 0
    for score, c, d in scored:
        if c["key"] in covered and c.get("tier") == "episodic":
            suppressed += 1
            continue
        if len(chosen) >= limit or spent + int(c.get("tokens", 30)) > budget_tokens:
            break
        chosen.append({**c, "decayed": round(d, 3), "score": round(score, 3),
                       "hedge": "believed" if d >= 0.5 else "weak"})
        spent += int(c.get("tokens", 30))
    return {"claims": chosen, "tokens": spent, "considered": len(scored), "suppressed": suppressed,
            "by_tier": {t: sum(1 for c in chosen if c.get("tier") == t) for t in ("episodic", "semantic", "procedural")}}


def reinforce(claims: list, keys: list, useful: bool = False, now_iso: str | None = None) -> dict:
    """Retrieval (and a 'that helped') is the only thing that raises salience.
    Called on the keys a recall actually handed to a session."""
    ks = set(keys or [])
    n = 0
    for c in claims:
        if c.get("key") not in ks:
            continue
        c["uses"] = int(c.get("uses", 0) or 0) + 1
        if useful:
            c["useful"] = int(c.get("useful", 0) or 0) + 1
        if now_iso:
            c["last_used"] = now_iso
        n += 1
    return {"claims": claims, "reinforced": n}
