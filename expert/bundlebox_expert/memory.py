"""What the factory has come to believe, as sentences with support. Claims are
REGENERATED from the data on every derive, not accumulated: run it twice on the
same rows and you get the same memory. A claim forgets three ways — decay
(half-life 21 days, measured from the last time it was RE-DERIVED, never from
the last time it was written), contradiction (contra >= 2), and supersession
by key. A claim naming a path that no longer exists is refused for every scope.
"""
from __future__ import annotations
import math
import os
import time

HALF_LIFE_DAYS = 21.0
CONTRA_DROP = 2
RECALL_FLOOR = 0.05


def _age_days(iso: str, now: float) -> float | None:
    try:
        t = time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))
        return max(0.0, (now - t) / 86400)
    except (ValueError, TypeError):
        return None


def decayed(claim: dict, now: float | None = None) -> float:
    now = now or time.time()
    age = _age_days(claim.get("last_seen", ""), now)
    if age is None:
        return 0.0  # unparseable timestamp: treat as fully decayed, never immortal
    return float(claim.get("confidence", 0.5)) * (0.5 ** (age / HALF_LIFE_DAYS))


def derive(signals: dict, episodes: list, scripts: list, root: str, now_iso: str) -> list:
    """Fresh claims from the data. Each has a key; reconcile() merges with the old set."""
    out = []
    for path, n in (signals.get("top_reread_files") or [])[:10]:
        if not os.path.exists(os.path.join(root, path)) and not os.path.isabs(path):
            continue
        if os.path.isabs(path) and not os.path.exists(path):
            continue
        out.append({"key": f"file/{path}", "claim": f"{path} was re-read {n} times across recent sessions; hand it as a signature view, not a file",
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
            out.append({"key": f"verb/{v}", "claim": f"`bb {v}` has run {b['n']} times and displaced {b['turns']} agent turns" + (f"; useful {b['useful']}/{b['labelled']} times" if b["labelled"] else ""),
                        "evidence": dict(b), "confidence": min(0.95, 0.6 + 0.02 * b["n"]), "tokens": 28, "source": "episodes"})
    for s in scripts:
        p = s.get("path") or ""
        if int(s.get("runs") or 0) >= 3 and p and os.path.exists(os.path.join(root, p)):
            out.append({"key": f"script/{s.get('tag')}", "claim": f"{p} ({s.get('tag')}) has run {s['runs']} times: {s.get('title') or ''}".strip(),
                        "evidence": {"runs": s["runs"], "last_rc": s.get("last_rc")}, "confidence": 0.7, "tokens": 26, "source": "scripts"})
    for c in out:
        c["support"] = 1
        c["contra"] = 0
        c["first_seen"] = now_iso
        c["last_seen"] = now_iso
    return out


def reconcile(old: list, fresh: list, now_iso: str, now: float | None = None) -> list:
    now = now or time.time()
    by_key = {c["key"]: c for c in old}
    out = []
    seen = set()
    for c in fresh:
        seen.add(c["key"])
        o = by_key.get(c["key"])
        if o:
            c["support"] = int(o.get("support", 0)) + 1
            c["contra"] = 0
            c["first_seen"] = o.get("first_seen") or now_iso
            c["last_seen"] = now_iso  # re-derived: the only event that moves last_seen
        out.append(c)
    for o in old:
        if o["key"] in seen:
            continue
        o = dict(o)
        o["contra"] = int(o.get("contra", 0)) + 1
        # NOT re-derived: last_seen stays where it was, so decay measures real age
        if o["contra"] >= CONTRA_DROP or decayed(o, now) < RECALL_FLOOR:
            continue
        out.append(o)
    return out


def recall(claims: list, about: str, budget_tokens: int = 1100, limit: int = 12, now: float | None = None) -> dict:
    now = now or time.time()
    terms = {t.lower() for t in about.replace("/", " ").replace("_", " ").split() if len(t) >= 3}
    scored = []
    for c in claims:
        d = decayed(c, now)
        if d < RECALL_FLOOR:
            continue
        text = (c.get("claim", "") + " " + c.get("key", "")).lower()
        hits = sum(1 for t in terms if t in text)
        scored.append((hits * 2 + d, c, d))
    scored.sort(key=lambda x: -x[0])
    chosen, spent = [], 0
    for score, c, d in scored:
        if len(chosen) >= limit or spent + int(c.get("tokens", 30)) > budget_tokens:
            break
        chosen.append({**c, "decayed": round(d, 3), "score": round(score, 3)})
        spent += int(c.get("tokens", 30))
    return {"claims": chosen, "tokens": spent, "considered": len(scored)}
