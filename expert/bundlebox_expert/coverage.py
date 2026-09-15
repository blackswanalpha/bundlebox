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


INTERPRETERS = {"node", "npx", "npm", "bun", "deno", "python", "python3", "sh", "bash", "uv", "uvx", "poetry"}
# Wrappers that run something else and are not the capability under test. Their
# own arguments (`timeout 10`, `FOO=bar`) are stripped with them.
WRAPPERS = {"timeout", "time", "env", "nohup", "stdbuf", "nice", "command", "exec"}
SCRIPT_SUFFIX = (".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".rb")
SHELL_SPLIT = re.compile(r"\s*(?:\|\||&&|[;|&\n])\s*")


def canon_cmd(cmd: str) -> tuple:
    """The command as a capability, not as a shell line: (words, flags).

    A document says `bb scan`. A corpus running from a checkout says
    `node bin/bb.js scan`. They are the same capability and a matcher that
    cannot see it reports 0% coverage on a corpus that covers everything, which
    is a worse answer than no coverage number at all.

    So: drop the interpreter and reduce the program to its basename without a
    script suffix. Flags come back separately rather than being discarded,
    because in this box `--apply` is the difference between a report and a
    change, and a matcher that treats them as one capability would report the
    dangerous half as covered by a test of the safe half.
    """
    parts = str(cmd).split()
    words = [w for w in parts if not w.startswith("-")]
    flags = {w.split("=", 1)[0] for w in parts if w.startswith("-")}
    while words and (words[0] in INTERPRETERS or words[0] in WRAPPERS
                     or words[0].replace(".", "", 1).isdigit()
                     or ("=" in words[0] and "/" not in words[0].split("=", 1)[0])):
        words = words[1:]
    if not words:
        return [], flags
    prog = words[0].rsplit("/", 1)[-1]
    for suf in SCRIPT_SUFFIX:
        if prog.endswith(suf):
            prog = prog[: -len(suf)]
            break
    return [prog] + words[1:], flags


def segments_of(line: str) -> list:
    """A step's `run` is a shell line, not a program name. `bb update; test $?`
    invokes two programs and exercises both, so each segment is matched on its
    own -- otherwise a step that checks its own exit code covers nothing."""
    return [seg for seg in SHELL_SPLIT.split(str(line)) if seg.strip()]


def match_cmd(declared: str, called: str) -> bool:
    """A command capability is covered when a step RUNS it, token by token.

    The first token was the original rule and every capability in a CLI shares
    it: one scenario running `bb scan` reported all twenty-three `bb *`
    capabilities as covered, and a corpus with one step read as 100%. So the
    declared words must be a prefix of the called ones -- `bb cookbook` covers
    `bb cookbook run --base x` and does not cover `bb compile` -- and every flag
    the capability declares must actually have been passed.
    """
    d, dflags = canon_cmd(declared)
    if not d:
        return False
    for seg in segments_of(called):
        c, cflags = canon_cmd(seg)
        if len(d) <= len(c) and c[: len(d)] == d and dflags <= cflags:
            return True
    return False


def _asserts_absent(expect: dict) -> bool:
    """Is this step asserting the route is NOT there?

    A 404 probe is the correct way to prove a surface has no write route, and
    the phantom-call check used to report exactly that step as a call against
    something the document does not declare -- turning a deliberate negative
    test into a finding. A step expecting 404 or 405 is asserting absence, and
    absence is not a phantom.
    """
    codes = []
    if "status" in expect:
        codes.append(expect["status"])
    codes.extend(expect.get("status_in") or [])
    return bool(codes) and all(c in (404, 405, 410) for c in codes)


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
        expect = st.get("expect") or {}
        keys = set(expect.keys())
        deep = bool(keys - {"status", "status_in", "max_ms"})
        if spec:
            parts = spec.split()
            if len(parts) >= 2:
                http.append({"method": parts[0].upper(), "path": parts[1], "scenario": sc.get("id", ""),
                             "deep": deep, "absent": _asserts_absent(expect)})
        cmd = str(st.get("run") or "")
        if cmd:
            cmds.setdefault(cmd, []).append(sc.get("id", ""))
        stat = st.get("static") or {}
        if stat.get("file"):
            files.setdefault(stat["file"], []).append(sc.get("id", ""))
    return {"http": http, "cmds": cmds, "files": files}


def out_of_scope(corpus: dict) -> list:
    """What this corpus DECLARES it will not run, and why.

    Not every capability a document states can be exercised by a corpus. `bb run
    --apply` opens a paid agent; `bb kernel install` writes a binary to the
    machine; `npm i -g` changes the box. A corpus that ran them would be a
    corpus nobody dares run, and one that stayed silent about them would report
    the same gap forever with no way to close it.

    So the persona names them with a reason. They leave the denominator and are
    reported on their own line: `covered of in-scope, N declared out of scope`.
    An excluded capability is still visible -- the reason is the point, and a
    corpus that excluded everything would say so in the same sentence.
    """
    rows = []
    for x in corpus.get("excluded", []) or []:
        if isinstance(x, str):
            rows.append({"match": x, "why": ""})
        elif isinstance(x, dict) and x.get("match"):
            rows.append({"match": str(x["match"]), "why": str(x.get("why", ""))})
    return rows


def _excluded_by(cap: dict, rows: list):
    for r in rows:
        if cap["id"] == r["match"] or cap.get("cmd", "") == r["match"] or cap["id"].endswith(":" + r["match"]):
            return r
    return None


def plan(world: dict, corpus: dict, limit: int = 40) -> dict:
    ex = exercised(corpus)
    skipped = out_of_scope(corpus)
    rules = world.get("rules", [])
    by_surface = {}
    for r in rules:
        by_surface.setdefault(r.get("surface", ""), []).append(r)

    covered, shallow, specs, excluded = [], [], [], []
    calls_unmatched = list(ex["http"])
    for cap in world.get("capabilities", []):
        hit = _excluded_by(cap, skipped)
        if hit:
            excluded.append({"id": cap["id"], "why": hit["why"] or "declared out of scope by the persona"})
            continue
        if cap["kind"] == "http":
            hits = [h for h in ex["http"] if h["method"] == cap["method"] and match_route(cap["path"], h["path"])]
        elif cap["kind"] == "cmd":
            hits = [{"scenario": s, "deep": True}
                    for called, ids in ex["cmds"].items() if match_cmd(cap["cmd"], called)
                    for s in ids]
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

    declared = len(world.get("capabilities", [])) - len(excluded)
    return {
        "declared": declared,
        "declared_total": len(world.get("capabilities", [])),
        "covered": len(covered),
        "shallow": len(shallow),
        "excluded": excluded,
        "coverage_pct": round(100.0 * len(covered) / declared, 1) if declared else None,
        "deep_pct": round(100.0 * (len(covered) - len(shallow)) / declared, 1) if declared else None,
        "phantom_calls": sorted({"%s %s" % (c["method"], c["path"])
                                 for c in calls_unmatched if "method" in c and not c.get("absent")}),
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
