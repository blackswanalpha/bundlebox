"""The process graph as a feature extractor. Nodes are verbs, edges are
"this verb ran after that one" with counts. A per-stage model cannot represent
"snapgen before pinpoint is worth more than snapgen alone" because the thing
that changed is in the edge, so edge lift becomes a feature the model sees.
"""
from __future__ import annotations
from collections import defaultdict


def build(episodes: list) -> dict:
    edges: dict = defaultdict(int)
    useful_after: dict = defaultdict(lambda: [0, 0])  # edge -> [useful, total]
    verb_useful: dict = defaultdict(lambda: [0, 0])
    for e in episodes:
        v, p = e.get("verb"), e.get("prev")
        u = e.get("useful")
        if u in (0, 1):
            verb_useful[v][1] += 1
            verb_useful[v][0] += u
        if p and v:
            edges[(p, v)] += 1
            if u in (0, 1):
                useful_after[(p, v)][1] += 1
                useful_after[(p, v)][0] += u
    total_useful = sum(x[0] for x in verb_useful.values())
    total_n = sum(x[1] for x in verb_useful.values())
    base = total_useful / total_n if total_n else 0.0
    verbs = sorted({v for e in episodes if (v := e.get("verb"))})
    indeg = defaultdict(int); outdeg = defaultdict(int)
    for (p, v), n in edges.items():
        outdeg[p] += n; indeg[v] += n
    # depth: longest path from a source, over the DAG of first-seen order; reach: nodes downstream
    succ = defaultdict(set)
    for (p, v) in edges:
        succ[p].add(v)
    def reach(v, seen=None):
        seen = seen or set()
        for s in succ[v]:
            if s not in seen:
                seen.add(s); reach(s, seen)
        return seen
    depth: dict = {}
    def dep(v, stack=()):
        if v in depth: return depth[v]
        if v in stack: return 0
        preds = [p for (p, x) in edges if x == v]
        depth[v] = 0 if not preds else 1 + max(dep(p, stack + (v,)) for p in preds)
        return depth[v]
    for v in verbs: dep(v)
    tot_edges = sum(edges.values()) or 1
    features = {}
    for v in verbs:
        r = reach(v)
        features[v] = {
            "centrality": round((indeg[v] + outdeg[v]) / tot_edges, 4),
            "depth": depth.get(v, 0), "reach": len(r),
            "bottleneck": round(indeg[v] / max(outdeg[v], 1), 3),
            "p_useful": round(verb_useful[v][0] / verb_useful[v][1], 3) if verb_useful[v][1] else None,
        }
    lifts = {}
    for (p, v), (u, n) in useful_after.items():
        if n and base:
            lifts[f"{p}>{v}"] = round((u / n) / base, 3)
    return {"verbs": verbs, "edges": [{"from": p, "to": v, "n": n} for (p, v), n in sorted(edges.items(), key=lambda x: -x[1])],
            "features": features, "lift": lifts, "base_rate": round(base, 4), "labelled": total_n}
