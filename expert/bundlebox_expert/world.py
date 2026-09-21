"""world.py — a genesis document, read into a world model.

The input is whatever a person already wrote: a PRD, a spec, a README, a
pasted prompt. The output is the half of a scenario corpus that is derivable
rather than judged — the surfaces, the actors, the rules the prose states, and
every capability the document names — so the expensive half (the persona's
voice, the assertions) is the only part a session is asked for.

Three properties keep this honest:

**Every item carries the line it came from.** A surface with no `why` is a
guess, and a corpus built on guesses reds about the corpus.

**What could not be settled is listed, not filled in.** `unknown` is part of
the output. A derivation that invents a base URL produces a corpus that is red
everywhere for a reason that has nothing to do with the product.

**Nothing here writes a scenario.** Choosing WHAT to write is a set difference
and costs nothing; writing it is a judgement and costs a session.
"""
from __future__ import annotations

import re

HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")
SETEXT = re.compile(r"^(=+|-{3,})\s*$")
NUMBERED = re.compile(r"^\s{0,3}(\d+(?:\.\d+)*)[.)]\s+(\S.*)$")
ROUTE = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:https?://[^\s`\"')]+)?/[^\s`\"',;)>\]]*)")
CONST = re.compile(r"\b([A-Z][A-Z0-9_]{3,})\s*(?:=|:)\s*([0-9]+(?:\.[0-9]+)?|\"[^\"]{1,40}\"|'[^']{1,40}')")
FENCE = re.compile(r"^\s*```+\s*([\w+-]*)\s*$")
INLINE_CMD = re.compile(r"`([a-z][\w.-]*(?:\s+[-\w./=:@{}]+){1,6})`")
ACTOR_AS = re.compile(r"\bas an?\s+([a-z][\w' -]{2,40}?)\s*,?\s*(?:i|they|we)\s+(?:want|need|can|should|must)\b", re.I)
ACTOR_BOLD = re.compile(r"\*\*([A-Z][\w' .-]{1,40})\*\*\s*[—:,-]\s*(?:an?\s+)?([a-z][\w' -]{3,60})")

MODALITY = [
    ("must_not", re.compile(r"\b(?:must not|may not|cannot|can not|shall not|is not allowed to|never)\b", re.I)),
    ("must", re.compile(r"\b(?:must|shall|is required to|has to|always|will always)\b", re.I)),
    ("refuses", re.compile(r"\b(?:refuses?|rejects?|denies|returns 4\d\d|returns 5\d\d|errors? with)\b", re.I)),
    ("should", re.compile(r"\b(?:should|ought to|is expected to|by default)\b", re.I)),
]
GENERIC_HEADING = {
    "overview", "introduction", "intro", "contents", "table-of-contents", "summary", "abstract",
    "appendix", "glossary", "references", "changelog", "license", "notes", "background",
    "goals", "non-goals", "about", "index", "requirements", "scope", "terminology", "faq",
}
# A path segment that names a relationship between two parties is where leaks,
# races and cross-tenant reads live, whatever the verb.
MULTI_PARTY = ("tenant", "member", "invite", "share", "grant", "role", "permission", "assign",
               "delegat", "owner", "team", "org", "workspace", "collaborat", "transfer")
SHELLS = {"bash", "sh", "shell", "console", "zsh", "terminal", ""}


def slug(s: str, n: int = 40) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))[:n]


def _clean_cmd(raw: str) -> str:
    """A command line out of prose, or "".

    Four things are rejected rather than kept: an inline comment (everything
    from ` #`); any line holding an arrow or a run of spaces, which is a
    formatted table rather than something you can execute; an assignment or an
    equation, which is a formula the document is stating (`projected = overhead
    + brief + ...` became a capability no corpus could ever run); and a
    placeholder argument in angle brackets or a documented stand-in such as
    `cd your-repo`, which names a directory only the reader has.

    Each of those produced a capability that stayed permanently uncovered and
    pulled the coverage percentage down for a reason that had nothing to do
    with the corpus.
    """
    cmd = raw.strip().lstrip("$ ").strip()
    cmd = re.split(r"\s+#", cmd)[0].strip()
    if not cmd or len(cmd) > 160 or "->" in cmd or "  " in cmd or "|" in cmd:
        return ""
    # `a = b` and `a == b` are statements about values, not programs to run.
    if re.search(r"(?<![!<>=])=(?!=)", cmd.split()[0] if cmd.split() else cmd) or " = " in cmd:
        return ""
    # `cd` changes the shell's directory and exercises nothing.
    if re.match(r"^cd\b", cmd):
        return ""
    if not re.match(r"^[a-z][\w.\-/]*\s", cmd):
        return ""
    # A comma is prose. Fenced blocks in a README hold diagrams and prose lines
    # as often as they hold commands, and `and the scenario runner, the load
    # simulator` matched every rule above it while being a sentence.
    if "," in cmd or cmd.startswith(("and ", "or ", "the ", "a ", "an ", "with ", "for ", "plus ", "then ")):
        return ""
    return cmd


def _sentences(block):
    """(sentence, line) over a paragraph given as [(line_no, text)].

    Sentences are split over the JOINED paragraph, not per line: a rule wrapped
    across two lines was otherwise extracted as the fragment "It never calls a".
    The line reported is the one the sentence STARTS on, which is where a reader
    looks.
    """
    joined, offsets, pos = [], [], 0
    for line_no, text in block:
        joined.append(text)
        offsets.append((pos, line_no))
        pos += len(text) + 1
    text = " ".join(joined)
    at = 0
    for part in re.split(r"(?<=[.!?])\s+", text):
        start = text.find(part, at)
        at = start + len(part) if start >= 0 else at
        t = part.strip(" -*\t")
        if not t:
            continue
        line = next((ln for off, ln in reversed(offsets) if off <= max(start, 0)), block[0][0])
        yield t, line


def derive(text: str, name: str = "", base: str = "") -> dict:
    lines = text.splitlines()
    surfaces: dict = {}
    order = []
    heading_at = {}          # line index -> surface id, for "nearest heading above"
    current = ""
    rules = []
    caps: dict = {}
    consts = {}
    actors: dict = {}
    in_fence = None
    para: list = []
    para_surface = ""

    def _flush(block, surface):
        if not block:
            return
        for sent, line in _sentences(block):
            if len(sent) < 12 or len(sent) > 400:
                continue
            for modality, rx in MODALITY:
                if rx.search(sent):
                    rules.append({
                        "id": "R%d" % (len(rules) + 1),
                        "text": re.sub(r"\s+", " ", sent).strip(),
                        "modality": modality,
                        "surface": surface,
                        "line": line,
                        "why": "line %d" % line,
                        "constants": [c for c in consts.values() if c["name"] in sent],
                    })
                    break

    def add_surface(title, i, why):
        sid = slug(title)
        if not sid or sid in GENERIC_HEADING or len(sid) < 3:
            return ""
        if sid not in surfaces:
            surfaces[sid] = {"id": sid, "title": title.strip(), "why": why, "line": i + 1, "rules": 0, "capabilities": 0}
            order.append(sid)
        return sid

    for i, raw in enumerate(lines):
        line = raw.rstrip()
        fence = FENCE.match(line)
        if fence:
            _flush(para, para_surface or current)
            para, para_surface = [], ""
            in_fence = None if in_fence is not None else (fence.group(1) or "").lower()
            continue
        if in_fence is not None:
            if in_fence in SHELLS and not line.lstrip().startswith(("#", "<", ">")):
                cmd = _clean_cmd(line)
                if cmd:
                    cid = "cmd:" + cmd
                    caps.setdefault(cid, {"id": cid, "kind": "cmd", "cmd": cmd, "surface": current, "line": i + 1, "why": "line %d, %s block" % (i + 1, in_fence or "code")})
            for m in ROUTE.finditer(line):
                _route(caps, m, current, i)
            for m in CONST.finditer(line):
                consts.setdefault(m.group(1), {"name": m.group(1), "value": m.group(2), "line": i + 1})
            continue

        h = HEADING.match(line)
        if h:
            _flush(para, para_surface or current)
            para, para_surface = [], ""
            current = add_surface(h.group(2), i, f"heading at line {i + 1}") or current
            heading_at[i] = current
            continue
        if SETEXT.match(line) and i and lines[i - 1].strip():
            current = add_surface(lines[i - 1].strip(), i - 1, f"heading at line {i}") or current
            continue

        for m in ROUTE.finditer(line):
            _route(caps, m, current, i)
        for m in INLINE_CMD.finditer(line):
            cmd = _clean_cmd(m.group(1))
            if cmd and re.match(r"^(npm|npx|yarn|pnpm|make|cargo|go|python3?|pip|pytest|node|bb|docker|git|flutter|dart|uv|poetry|bundle|rake|dotnet|mvn|gradle)\b", cmd):
                cid = "cmd:" + cmd
                caps.setdefault(cid, {"id": cid, "kind": "cmd", "cmd": cmd, "surface": current, "line": i + 1, "why": f"line {i + 1}, inline"})
        for m in CONST.finditer(line):
            consts.setdefault(m.group(1), {"name": m.group(1), "value": m.group(2), "line": i + 1})
        for m in ACTOR_AS.finditer(line):
            _actor(actors, m.group(1), "", i)
        for m in ACTOR_BOLD.finditer(line):
            _actor(actors, m.group(1), m.group(2), i)

        if line.strip():
            para.append((i + 1, line.strip()))
            para_surface = para_surface or current
        else:
            _flush(para, para_surface or current)
            para, para_surface = [], ""

    _flush(para, para_surface or current)

    for r in rules:
        if r["surface"] in surfaces:
            surfaces[r["surface"]]["rules"] += 1
    for c in caps.values():
        if c["surface"] in surfaces:
            surfaces[c["surface"]]["capabilities"] += 1

    unknown = []
    if not base and not any(c.get("kind") == "http" and c.get("absolute") for c in caps.values()):
        unknown.append("the base URL the http capabilities are served from — pass --base, nothing in the document says")
    if not actors:
        unknown.append("who the actors are — no 'as a <role>' or named cast in the document; the corpus will run as one anonymous user")
    if not any(c["kind"] == "http" for c in caps.values()) and not any(c["kind"] == "cmd" for c in caps.values()):
        unknown.append("what can be exercised — the document names no route and no command, so a corpus cannot address anything")
    if any(re.search(r"\b(sign ?in|log ?in|authenticat|token|session|bearer)\b", r["text"], re.I) for r in rules) \
            and not any("auth" in c["id"].lower() or "login" in c["id"].lower() or "session" in c["id"].lower() for c in caps.values()):
        unknown.append("how a request authenticates — the rules assume a signed-in caller and no auth route is named; put it in the corpus `setup`")

    kept = [surfaces[s] for s in order if surfaces[s]["rules"] or surfaces[s]["capabilities"]]
    return {
        "name": name or "world",
        "base": base,
        "surfaces": kept,
        "surfaces_dropped": [surfaces[s]["id"] for s in order if surfaces[s] not in kept],
        "actors": list(actors.values()),
        "rules": rules,
        "capabilities": sorted(caps.values(), key=lambda c: (c["kind"], c["id"])),
        "constants": sorted(consts.values(), key=lambda c: c["name"]),
        "unknown": unknown,
        "counts": {"lines": len(lines), "surfaces": len(kept), "rules": len(rules),
                   "capabilities": len(caps), "actors": len(actors), "constants": len(consts)},
    }


def _route(caps: dict, m, surface: str, i: int) -> None:
    method, path = m.group(1).upper(), m.group(2)
    absolute = path.startswith("http")
    if absolute:
        path = "/" + path.split("://", 1)[1].split("/", 1)[1] if "/" in path.split("://", 1)[1] else "/"
    path = path.rstrip(".,;:")
    cid = "http:%s %s" % (method, path)
    caps.setdefault(cid, {"id": cid, "kind": "http", "method": method, "path": path, "surface": surface,
                          "line": i + 1, "why": "line %d" % (i + 1), "absolute": absolute,
                          "tier": tier_of(method, path)})


def _actor(actors: dict, name: str, role: str, i: int) -> None:
    aid = slug(name, 24)
    if not aid or aid in ("user", "users", "system", "admin-user"):
        aid = aid or "actor"
    actors.setdefault(aid, {"id": aid, "title": name.strip(), "role": role.strip(), "why": "line %d" % (i + 1)})


def tier_of(method: str, path: str) -> str:
    """The tier comes from the capability's own shape, not from taste.

    A read with no path parameter cannot be anything but simple. Anything naming
    a relationship between two parties is complicated whether or not somebody
    felt like writing it that way — that is the tier a corpus never grows into
    on its own, and it is where the defects that matter live.
    """
    low = path.lower()
    if any(w in low for w in MULTI_PARTY):
        return "complicated"
    param = "{" in path or ":" in path.split("/", 2)[-1] or re.search(r"/<[^/>]+>", path)
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        return "complex"
    return "complex" if param else "simple"


# ── the other two inlets ────────────────────────────────────────────────────
#
# `derive` above reads prose. A finding row and a pasted ticket are not prose:
# they already carry the three fields a scenario skeleton needs — the path, the
# rule they contradict and the evidence — so reading them as a document throws
# those fields away and then guesses them back out of sentences. What follows is
# the field mapping. The text the fields make still goes through `derive`, for
# the routes, commands and constants the row names; only the surface and the
# rule are set from the fields, because a row has no heading to take them from.


def _text(v) -> str:
    return re.sub(r"\s+", " ", str(v)).strip() if isinstance(v, (str, int, float)) else ""


def _stem(p: str) -> str:
    return re.sub(r"\.\w+$", "", str(p or "").rstrip("/").rsplit("/", 1)[-1])


def _evidence(v, cap: int = 12) -> str:
    """A finding's evidence, flattened to lines. Bounded: the evidence block of
    a duplication finding is hundreds of lines and a world model is not where
    they belong."""
    out: list = []

    def walk(x):
        if len(out) >= cap:
            return
        if isinstance(x, dict):
            for k in sorted(x):
                walk(x[k])
        elif isinstance(x, list):
            for i in x:
                walk(i)
        elif isinstance(x, str) and x.strip():
            out.append(x.strip()[:200])

    walk(v)
    return "\n".join(out[:cap])


def _modality(text: str) -> str:
    for modality, rx in MODALITY:
        if rx.search(text):
            return modality
    # A row states what is wrong, not what is forbidden. `must` is the weakest
    # claim that still makes the scenario assert something, and a stated
    # modality above always wins over it.
    return "must"


def derive_row(row: dict, kind: str = "finding", name: str = "", base: str = "") -> dict:
    """A finding row or a pasted ticket, read into the world shape a document makes."""
    row = row or {}
    title = _text(row.get("title"))
    files = row.get("files") if isinstance(row.get("files"), list) else []
    path = _text(row.get("path")) or _text(files[0] if files else "")
    body = _text(row.get("detail")) or _text(row.get("body"))
    hint = _text(row.get("fix_hint"))
    source = "\n".join(p for p in (title, body, hint, _evidence(row.get("evidence"))) if p)

    w = derive(source, name=name or slug(title or kind), base=base)
    sid = slug(_stem(path)) or slug(_text(row.get("detector"))) or slug(title) or kind
    where = path or title or kind
    caps = [dict(c, surface=sid) for c in w["capabilities"]]

    rule_text = body or title or where
    rules = [{
        "id": "R1", "text": rule_text, "modality": _modality(rule_text), "surface": sid,
        "line": 0, "why": "%s %s" % (kind, _text(row.get("id")) or where),
        "constants": w["constants"],
    }] if rule_text else []

    surfaces = [{"id": sid, "title": where, "line": 0, "rules": len(rules), "capabilities": len(caps),
                 "why": "the %s's %s" % (kind, "path" if path else "title")}] if (rules or caps) else []

    unknown = []
    if not base and not any(c.get("kind") == "http" and c.get("absolute") for c in caps):
        unknown.append("the base URL the http capabilities are served from — pass --base, the %s does not say" % kind)
    unknown.append("who the actors are — a %s row names no cast; the corpus will run as one anonymous user" % kind)
    if not caps:
        unknown.append("what can be exercised — the %s names no route and no command, so a scenario can only "
                       "assert over %s as a file" % (kind, path or "a path it does not carry"))
    if not body:
        unknown.append("what the rule actually is — the row carries no detail, so the rule is its title")

    return {
        "name": name or slug(title or kind) or "world",
        "base": base,
        "surfaces": surfaces,
        "surfaces_dropped": [],
        "actors": [],
        "rules": rules,
        "capabilities": caps,
        "constants": w["constants"],
        "unknown": unknown,
        "row": {"kind": kind, "id": _text(row.get("id")), "path": path, "detector": _text(row.get("detector"))},
        "source": source,
        "counts": {"lines": len(source.splitlines()), "surfaces": len(surfaces), "rules": len(rules),
                   "capabilities": len(caps), "actors": 0, "constants": len(w["constants"])},
    }
