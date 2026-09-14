"""coverage.py — of everything the world can do, what does no scenario touch?

Every other question in this package is about the product. This one is about
the CORPUS. A green board over a corpus exercising half the system is the most
expensive kind of green there is, and nothing else measures it.

The split that makes it cheap: choosing WHICH scenario to write next is a set
difference and costs nothing. Writing it — the voice, the rule block, the
assertions — is a judgement and costs a session. `plan()` produces the first
half already derived, so the agent is told what to write rather than asked what
is missing.

The matcher is positional. A path is covered when a call lands on it segment by
segment, with a parameter segment consuming exactly one and a catch-all
consuming at least one. Prefix matching reported `/tasks` as covered because
somebody had tested `/tasks/{id}`; a literal comparison reported 126 calls with
query strings as hitting routes nobody declared. Both are silent and both point
the wrong way.
"""
from __future__ import annotations

import re

PARAM = re.compile(r"^(?:\{[^}]*\}|:[^/]+|<[^>]+>|\*)$")
CATCHALL = re.compile(r"^(?:\{[^}]*:\s*path\}|\*\*|\*)$")
TIER_WEIGHT = {"simple": 1, "complex": 2, "complicated": 3}
SEVERITY_OF_TIER = {"simple": "low", "complex": "medium", "complicated": "high"}


def segments(path: str):
    return [s for s in path.split("?", 1)[0].split("/") if s != ""]


def match_route(declared: str, called: str) -> bool:
    d, c = segments(declared), segments(called)
    i = j = 0
    while i < len(d):
        seg = d[i]
        if CATCHALL.match(seg):
            # A catch-all consumes AT LEAST one segment: without that floor,
            # `/files/{p:path}` reports `/files` itself as covered.
            return len(c) - j >= 1 and i == len(d) - 1
        if j >= len(c):
            return False
        if not PARAM.match(seg) and seg != c[j]:
            return False
        i += 1
        j += 1
    return j == len(c)


def _steps(corpus: dict):
    for sc in corpus.get("scenarios", []):
        for st in sc.get("steps", []):
            yield sc, st


def exercised(corpus: dict) -> dict:
    """Every capability the corpus addresses, and how deeply.

    A step asserting only `status` proves the route exists, not that it works,
    so depth is tracked separately: a route can be covered and shallow, and the
    plan says so rather than counting it done.
    """
    http, cmds, files = [], {}, {}
    for sc, st in _steps(corpus):
        spec = str(st.get("do") or "")
        keys = set((st.get("expect") or {}).keys())
        deep = bool(keys - {"status", "status_in", "max_ms"})
        if spec:
            parts = spec.split()
            if len(parts) >= 2:
                http.append({"method": parts[0].upper(), "path": parts[1], "scenario": sc.get("id", ""), "deep": deep})
        cmd = str(st.get("run") or "")
        if cmd:
            cmds.setdefault(cmd.split()[0] if cmd.split() else cmd, []).append(sc.get("id", ""))
        stat = st.get("static") or {}
        if stat.get("file"):
            files.setdefault(stat["file"], []).append(sc.get("id", ""))
    return {"http": http, "cmds": cmds, "files": files}


def plan(world: dict, corpus: dict, limit: int = 40) -> dict:
    ex = exercised(corpus)
    rules = world.get("rules", [])
    by_surface = {}
    for r in rules:
        by_surface.setdefault(r.get("surface", ""), []).append(r)

    covered, shallow, specs = [], [], []
    calls_unmatched = list(ex["http"])
    for cap in world.get("capabilities", []):
        if cap["kind"] == "http":
            hits = [h for h in ex["http"] if h["method"] == cap["method"] and match_route(cap["path"], h["path"])]
        elif cap["kind"] == "cmd":
            head = cap["cmd"].split()[0] if cap["cmd"].split() else cap["cmd"]
            hits = [{"scenario": s, "deep": True} for s in ex["cmds"].get(head, [])]
        else:
            hits = []
        for h in hits:
            if h in calls_unmatched:
                calls_unmatched.remove(h)
        if hits:
            row = {"id": cap["id"], "scenarios": sorted({h["scenario"] for h in hits}), "deep": any(h.get("deep") for h in hits)}
            covered.append(row)
            if not row["deep"]:
                shallow.append(row)
            continue
        surface = cap.get("surface", "")
        tier = cap.get("tier") or ("complex" if cap["kind"] == "cmd" else "simple")
        cited = by_surface.get(surface, [])
        path_rules = [r for r in rules if cap.get("path") and cap["path"] in r["text"]]
        score = TIER_WEIGHT.get(tier, 1) * 2 + min(len(cited), 6) + (3 if path_rules else 0)
        specs.append({
            "capability": cap["id"],
            "kind": cap["kind"],
            "surface": surface,
            "tier": tier,
            "severity": SEVERITY_OF_TIER.get(tier, "low"),
            "score": score,
            "why": "%s, declared at %s, no scenario addresses it%s" % (
                tier, cap.get("why", "?"), "" if not cited else "; %d rule(s) on this surface" % len(cited)),
            "cite": [{"id": r["id"], "text": r["text"], "line": r["line"]} for r in (path_rules or cited)[:4]],
            "skeleton": skeleton(cap, tier),
        })
    specs.sort(key=lambda s: (-s["score"], s["capability"]))

    declared = len(world.get("capabilities", []))
    return {
        "declared": declared,
        "covered": len(covered),
        "shallow": len(shallow),
        "coverage_pct": round(100.0 * len(covered) / declared, 1) if declared else None,
        "deep_pct": round(100.0 * (len(covered) - len(shallow)) / declared, 1) if declared else None,
        "phantom_calls": sorted({"%s %s" % (c["method"], c["path"]) for c in calls_unmatched if "method" in c}),
        "shallow_capabilities": [s["id"] for s in shallow],
        "specs": specs[:limit],
        "specs_total": len(specs),
    }


def skeleton(cap: dict, tier: str) -> list:
    """The step shape the tier forces. Not a scenario — the frame one goes in.

    The read-back in `complex` is the point of the tier: a 200 that stored
    nothing is the defect a write-only scenario cannot see.
    """
    if cap["kind"] == "cmd":
        return [{"name": "it runs and says what it did", "run": cap["cmd"], "expect": {"rc": 0, "stdout_contains": "<a string only a working run prints>"}}]
    method, path = cap.get("method", "GET"), cap.get("path", "/")
    if tier == "simple":
        return [{"name": "the shape it returns", "do": "%s %s" % (method, path),
                 "expect": {"status": 200, "json_type": {"<field>": "list"}, "json_present": ["<field>"]}}]
    if tier == "complex":
        return [
            {"name": "PRECONDITION: the thing this acts on exists", "precondition": True,
             "do": "POST <the route that creates it>", "expect": {"status": 201}, "save": {"subject": "id"}},
            {"name": "the write", "do": "%s %s" % (method, path.replace("{id}", "{{subject}}")),
             "body": {"<field>": "<value>"}, "expect": {"status": 200}},
            {"name": "read it back — a 200 that stored nothing looks identical from here",
             "do": "GET %s" % path.replace("{id}", "{{subject}}"), "expect": {"json": {"<field>": "<value>"}}},
        ]
    return [
        {"name": "PRECONDITION: two actors exist in the same place", "precondition": True,
         "do": "GET <the route that proves both are signed in>", "expect": {"status": 200}},
        {"name": "the first actor writes", "as": "<actor-a>", "do": "%s %s" % (method, path),
         "body": {"<field>": "<value>"}, "expect": {"status": 200}, "save": {"subject": "id"}},
        {"name": "the second actor may not read it", "as": "<actor-b>",
         "do": "GET %s" % path, "expect": {"status_in": [403, 404], "json_absent": ["<the first actor's field>"]}},
    ]
