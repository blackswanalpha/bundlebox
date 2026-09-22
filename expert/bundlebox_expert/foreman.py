"""foreman — a policy over calibrated probabilities that watches a coding agent.

The design is thruwire/foreman's: a fast decision model sits above a slower
coding agent. Each RESPONSIBILITY owns a few yes/no CHECKS, Jev answers every
check in one pass as a probability, and a deterministic policy turns those
probabilities into one action from a small vocabulary:

    continue   the agent may carry on
    steer      tell the running agent what is going wrong, once
    stop       the agent is past steering; stop and re-plan
    verify     run the independent check before anything is called done
    resume     an idle agent still has work to do
    finish     every completion bar is cleared
    escalate   a person has to decide

Jev is optional. With no key, `evidence()` derives the same checks from counts
the box already has: grapple's drift window, git's changed files and the last
verification run. Evidence cannot tell whether the job's requirements are met,
so on evidence alone `requirements_satisfied` holds at 0.5 until a passing
verification backs it, and `finish` needs one.

JS decides WHEN to assess and owns the clock, the store and the network. This
module reads no clock, file, environment variable or random number: the same
row is the same decision, which is what lets `replay` re-run a recorded
timeline under new thresholds and count every action that would have moved.
"""
from __future__ import annotations

import re

from . import grapple

# ── responsibilities ────────────────────────────────────────────────────────
# Order is the tie-break when two directives share a priority and confidence:
# instruction drift is named before worker health, as in thruwire.

HUMAN = "core.human-escalation"
INSTRUCTIONS = "repository.instructions"
DOCUMENTATION = "quality.documentation"
HEALTH = "core.worker-health"
COMPLETION = "core.completion"
VERIFICATION = "core.verification"

RESPONSIBILITIES = (
    {"id": HUMAN, "checks": {
        "needs_human": ("Does this situation require human judgment, credentials, clarification, or permission?", 0.80)}},
    {"id": INSTRUCTIONS, "checks": {
        "instructions_drift": ("When repository instructions are present, is the agent's recent work materially inconsistent "
                               "with them? Answer no when no instructions are present or the evidence is insufficient.", 0.80)}},
    {"id": DOCUMENTATION,
     "route": ("Does the job explicitly require creating or updating README content, user guides, API documentation, "
               "release notes, or other documentation delivered with the repository?", 0.70),
     "checks": {
         "documentation_sufficient": ("When documentation is required by the job, is it complete, accurate, and consistent "
                                      "with the implemented behaviour?", 0.75)}},
    {"id": HEALTH, "checks": {
        "meaningful_progress": ("Is the agent making meaningful progress toward the job?", None),
        "worker_stuck": ("Does the agent appear stuck, looping, or unable to advance?", 0.80),
        "work_off_track": ("Is the current work drifting from the job or making unrelated changes?", 0.80)}},
    {"id": COMPLETION, "checks": {
        "implementation_complete": ("Is the implementation work required by the job complete?", 0.75),
        "requirements_satisfied": ("Does the current repository satisfy the job as a whole?", 0.75),
        "ready_to_finish": ("Given all evidence, is the job ready to be declared complete?", 0.75)}},
    {"id": VERIFICATION, "checks": {
        "tests_sufficient": ("Does the work have sufficient relevant test coverage and passing verification?", 0.75),
        "needs_verification": ("Does the current state warrant an independent verification pass before finishing?", 0.65)}},
)

ACTIONS = ("continue", "steer", "stop", "verify", "resume", "finish", "escalate")

DEFAULTS = {
    "max_steers": 1,           # steers per agent before a warning becomes a stop
    "steer_grace_turns": 5,    # turns after a steer before another warning counts
    "max_iterations": 50,      # assessments per run before a person is asked
    "max_retries": 2,          # stop → resume cycles before a person is asked
}

STATE_CHARS = 60000            # the state blob; Jev's ceiling is 32k tokens
FIELD_CHARS = 4000
DIFF_CHARS = 20000
TURNS_SHOWN = 30
COMMITS_SHOWN = 50
DOC_WORDS = re.compile(r"\b(readme|docs?|documentation|user guide|release notes?|changelog)\b", re.I)
DOC_FILE = re.compile(r"(\.mdx?$|\.rst$|(^|/)docs?/)", re.I)
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)/|[._-](test|spec)\.[a-z]+$|(^|/)test_[^/]+\.py$", re.I)


def key(rid: str, cid: str) -> str:
    return f"{rid}__{cid}"


def route_key(rid: str) -> str:
    return f"route__{rid}"


def settings(cfg: dict | None) -> dict:
    cfg = cfg or {}
    s = {k: int(cfg.get(k, v)) for k, v in DEFAULTS.items()}
    s["thresholds"] = {str(k): float(v) for k, v in (cfg.get("thresholds") or {}).items()}
    s["disabled"] = sorted(str(x) for x in (cfg.get("disabled") or []))
    return s


def checks(cfg: dict | None = None) -> list:
    """Every enabled check as `{key, responsibility, check, instructions, min}`,
    with any threshold the config overrides."""
    s = settings(cfg)
    out = []
    for r in RESPONSIBILITIES:
        if r["id"] in s["disabled"]:
            continue
        for cid, (text, lo) in r["checks"].items():
            k = key(r["id"], cid)
            out.append({"key": k, "responsibility": r["id"], "check": cid, "instructions": text,
                        "min": s["thresholds"].get(k, lo)})
    return out


def routes(cfg: dict | None = None) -> list:
    s = settings(cfg)
    return [{"key": route_key(r["id"]), "responsibility": r["id"], "instructions": r["route"][0],
             "min": s["thresholds"].get(route_key(r["id"]), r["route"][1])}
            for r in RESPONSIBILITIES if "route" in r and r["id"] not in s["disabled"]]


# ── the observation, bounded ────────────────────────────────────────────────

def _tail(text: str, limit: int) -> str:
    text = str(text or "")
    if len(text) <= limit:
        return text
    return f"[... {len(text) - limit} earlier characters omitted ...]\n{text[-limit:]}"


def _head(text: str, limit: int) -> str:
    text = str(text or "")
    return text if len(text) <= limit else f"{text[:limit]}\n[... truncated ...]"


def _window(obs: dict) -> dict:
    return {"turns": obs.get("turns") or [], "scope": obs.get("scope") or []}


def state(obs: dict) -> str:
    """The evidence Jev reads, as one bounded text blob. Every field is capped
    on its own so a long diff cannot push the job out of the window."""
    w = _window(obs)
    d = grapple.drift(w)
    g = obs.get("git") or {}
    ins = obs.get("instructions") or {}
    ver = obs.get("verification") or {}
    turns = w["turns"][-TURNS_SHOWN:]
    turn_lines = [f"{t.get('tool', '?')} {t.get('file') or ''}{' (edit)' if t.get('edit') else ''}".rstrip() for t in turns]
    parts = [
        "## job", _head(obs.get("job") or "(no job stated)", FIELD_CHARS),
        "## agent", f"active: {bool(obs.get('active'))}; iteration {int(obs.get('iteration') or 0)}; "
                    f"steers {int(obs.get('steers') or 0)}; previous action {obs.get('previous') or 'none'}",
        "## turns", f"counters: {d['counters']}; drift signature: {d['signature']}",
        f"last {len(turns)} of {len(w['turns'])}:", "\n".join(turn_lines) or "(none)",
        "## scope", "\n".join(w["scope"]) or "(no scope stated)",
        "## git status", _tail(g.get("status") or "(clean)", FIELD_CHARS),
        f"## commits since {g.get('base') or 'the run began'}", "\n".join((g.get("commits") or [])[:COMMITS_SHOWN]) or "(none)",
        "## changed files since then, committed or not", "\n".join((g.get("files") or [])[:200]) or "(none)",
        "## verification", (f"command: {ver.get('command')}; ok: {ver.get('ok')}; after last change: {ver.get('current')}\n"
                            + _tail(ver.get("output") or "", FIELD_CHARS)) if ver.get("command") else "(never run)",
        f"## repository instructions ({ins.get('path') or 'none'})", _head(ins.get("text") or "(none)", FIELD_CHARS),
        "## diff since then, committed or not", _tail(g.get("diff") or "(none)", DIFF_CHARS),
    ]
    # The diff is last, so the cap cuts the diff and never the job.
    return _head("\n".join(parts), STATE_CHARS)


def questions(obs: dict, cfg: dict | None = None) -> dict:
    """`{state, questions, keys}` for one Jev pass: every check plus every
    routing question, so a routed responsibility costs no second call."""
    qs = {c["key"]: {"type": "noul", "instructions": c["instructions"]} for c in checks(cfg)}
    for r in routes(cfg):
        qs[r["key"]] = {"type": "noul", "instructions": r["instructions"]}
    return {"state": state(obs), "questions": qs, "keys": sorted(qs)}


# ── evidence: the checks without a model ────────────────────────────────────

def evidence(obs: dict, cfg: dict | None = None) -> dict:
    """Every check derived from counts. Each value is a rule over the window,
    not a probability anyone calibrated; `via` says so on every row."""
    d = grapple.drift(_window(obs))
    c, p = d["counters"], d["parts"]
    files = [str(f) for f in ((obs.get("git") or {}).get("files") or [])]
    commits = (obs.get("git") or {}).get("commits") or []
    ver = obs.get("verification") or {}
    verified = bool(ver.get("command")) and ver.get("ok") is True and bool(ver.get("current"))
    failed = bool(ver.get("command")) and ver.get("ok") is False
    changed = bool(files)
    # A commit in the run is an edit the window may not hold: a session that
    # opens on committed work has no Edit turns and still has a change.
    implemented = changed and (bool(commits) or (c["edits"] > 0 and p["since_edit"] < 1.0))
    tested = any(TEST_FILE.search(f) for f in files)
    satisfied = 0.8 if verified and implemented else 0.5
    v = {
        key(HUMAN, "needs_human"): 0.0,
        key(INSTRUCTIONS, "instructions_drift"): 0.0,
        key(DOCUMENTATION, "documentation_sufficient"): 0.9 if any(DOC_FILE.search(f) for f in files) else 0.1,
        key(HEALTH, "meaningful_progress"): round(1.0 - p["since_edit"], 4) if c["edits"] else 0.0,
        key(HEALTH, "worker_stuck"): round(max(p["repeats"], p["since_edit"]), 4),
        key(HEALTH, "work_off_track"): p["out_of_scope"] if obs.get("scope") else 0.0,
        key(COMPLETION, "implementation_complete"): 0.8 if implemented else 0.1,
        key(COMPLETION, "requirements_satisfied"): satisfied,
        key(COMPLETION, "ready_to_finish"): satisfied,
        key(VERIFICATION, "tests_sufficient"): 0.0 if failed else (0.9 if verified and tested else (0.6 if verified else 0.2)),
        key(VERIFICATION, "needs_verification"): 0.9 if changed and not verified else 0.1,
        route_key(DOCUMENTATION): 0.9 if DOC_WORDS.search(str(obs.get("job") or "")) else 0.0,
    }
    wanted = {x["key"] for x in checks(cfg)} | {x["key"] for x in routes(cfg)}
    return {"scores": {k: v[k] for k in sorted(v) if k in wanted}, "via": "evidence", "drift": d}


def merge(jev: dict | None, ev: dict) -> dict:
    """Jev's answer where it gave one, evidence where it did not. `sources`
    names which one every score came from; a replay needs to know."""
    scores, sources = {}, {}
    for k, e in ev["scores"].items():
        j = (jev or {}).get(k)
        if isinstance(j, (int, float)) and not isinstance(j, bool) and j == j:
            scores[k], sources[k] = round(min(max(float(j), 0.0), 1.0), 4), "jev"
        else:
            scores[k], sources[k] = e, "evidence"
    via = "jev" if all(s == "jev" for s in sources.values()) else ("evidence" if not jev else "mixed")
    return {"scores": scores, "sources": sources, "via": via}


# ── policy ──────────────────────────────────────────────────────────────────

def _d(rid: str, action: str, reason: str, priority: int, confidence: float | None = None) -> dict:
    return {"responsibility": rid, "action": action, "reason": reason, "priority": priority, "confidence": confidence}


def _warning(st: dict, s: dict, rid: str, reason: str, confidence: float):
    """A worker warning becomes a steer, a stop, or a wait inside the grace
    window after the last steer. No running agent, no warning."""
    if not st.get("active"):
        return None
    since = st.get("turns_since_steer")
    if since is not None and int(since) < s["steer_grace_turns"]:
        return _d(rid, "continue", "inside the grace window after the last steer", 900, confidence)
    if int(st.get("steers") or 0) < s["max_steers"]:
        return _d(rid, "steer", reason, 900, confidence)
    return _d(rid, "stop", f"{reason}; already steered {int(st.get('steers') or 0)} time(s)", 900, confidence)


def proposals(scores: dict, st: dict, cfg: dict | None = None) -> list:
    s = settings(cfg)
    on = {c["key"]: c for c in checks(cfg)}
    sc = lambda rid, cid: float(scores.get(key(rid, cid), 0.0))
    lo = lambda rid, cid: on[key(rid, cid)]["min"]
    enabled = lambda rid: rid not in s["disabled"]
    active = bool(st.get("active"))
    out = []

    if enabled(HUMAN) and sc(HUMAN, "needs_human") >= lo(HUMAN, "needs_human"):
        out.append(_d(HUMAN, "escalate", "the evidence needs human judgment, credentials or permission", 1000, sc(HUMAN, "needs_human")))

    if enabled(INSTRUCTIONS) and sc(INSTRUCTIONS, "instructions_drift") >= lo(INSTRUCTIONS, "instructions_drift"):
        w = _warning(st, s, INSTRUCTIONS, "the agent is drifting from the repository instructions", sc(INSTRUCTIONS, "instructions_drift"))
        if w:
            out.append(w)

    if enabled(DOCUMENTATION) and not active:
        routed = float(scores.get(route_key(DOCUMENTATION), 0.0)) >= next(r["min"] for r in routes(cfg) if r["responsibility"] == DOCUMENTATION)
        if routed and sc(DOCUMENTATION, "documentation_sufficient") < lo(DOCUMENTATION, "documentation_sufficient"):
            out.append(_d(DOCUMENTATION, "resume", "the job asks for documentation and it is incomplete", 750, sc(DOCUMENTATION, "documentation_sufficient")))

    if enabled(HEALTH):
        hits = []
        if sc(HEALTH, "work_off_track") >= lo(HEALTH, "work_off_track"):
            hits.append((sc(HEALTH, "work_off_track"), "the agent is working off track"))
        if sc(HEALTH, "worker_stuck") >= lo(HEALTH, "worker_stuck"):
            hits.append((sc(HEALTH, "worker_stuck"), "the agent is stuck"))
        if hits:
            conf, reason = max(hits, key=lambda h: h[0])
            w = _warning(st, s, HEALTH, reason, conf)
            if w:
                out.append(w)

    if enabled(COMPLETION) and not active:
        if st.get("previous") == "stop":
            out.append(_d(COMPLETION, "resume", "the stopped agent resumes with a fresh plan", 800))
        else:
            ready = (sc(COMPLETION, "ready_to_finish") >= lo(COMPLETION, "ready_to_finish")
                     and sc(COMPLETION, "requirements_satisfied") >= lo(COMPLETION, "requirements_satisfied")
                     and (not enabled(VERIFICATION) or sc(VERIFICATION, "tests_sufficient") >= lo(VERIFICATION, "tests_sufficient")))
            resolved = (not enabled(VERIFICATION) or bool(st.get("verification_completed"))
                        or sc(VERIFICATION, "needs_verification") < lo(VERIFICATION, "needs_verification"))
            if ready and resolved:
                out.append(_d(COMPLETION, "finish", "every completion bar is cleared", 700))
            else:
                out.append(_d(COMPLETION, "resume", "meaningful implementation work remains", 500))

    if (enabled(VERIFICATION) and enabled(COMPLETION) and not active and not st.get("verification_started")
            and sc(VERIFICATION, "needs_verification") >= lo(VERIFICATION, "needs_verification")
            and sc(COMPLETION, "implementation_complete") >= lo(COMPLETION, "implementation_complete")):
        out.append(_d(VERIFICATION, "verify", "the change warrants an independent verification run", 600))
    return out


def decide(scores: dict, st: dict, cfg: dict | None = None) -> dict:
    """One action, the directive it came from, and every directive proposed.
    Iteration and retry limits are runtime invariants, not responsibilities."""
    s = settings(cfg)
    proposed = proposals(scores, st, cfg)
    if int(st.get("iteration") or 0) >= s["max_iterations"]:
        proposed.append(_d("foreman.runtime", "escalate", f"{s['max_iterations']} assessments without finishing", 950))
    if not proposed:
        selected = _d("foreman.runtime", "continue", "nothing crossed a bar", 0)
    else:
        # `max` returns the first of equals, so RESPONSIBILITIES order breaks ties.
        selected = max(proposed, key=lambda x: (x["priority"], x["confidence"] if x["confidence"] is not None else -1.0))
    if selected["action"] == "resume" and st.get("previous") == "stop" and int(st.get("retries") or 0) >= s["max_retries"]:
        selected = _d("foreman.runtime", "escalate", f"{s['max_retries']} stop and resume cycles already", selected["priority"])
        proposed.append(selected)
    return {"action": selected["action"], "reason": selected["reason"], "responsibility": selected["responsibility"],
            "confidence": selected["confidence"], "proposed": proposed}


def assess(obs: dict, jev: dict | None = None, cfg: dict | None = None) -> dict:
    """Evidence, merged with Jev's answers when there are any, then the policy."""
    ev = evidence(obs, cfg)
    m = merge(jev, ev)
    st = {k: obs.get(k) for k in ("active", "iteration", "steers", "turns_since_steer", "previous", "retries")}
    ver = obs.get("verification") or {}
    st["verification_started"] = bool(ver.get("command")) and bool(ver.get("current"))
    st["verification_completed"] = st["verification_started"] and ver.get("ok") is not None
    return dict(decide(m["scores"], st, cfg), scores=m["scores"], sources=m["sources"], via=m["via"],
                drift=ev["drift"]["signature"], state=st)


# ── replay: what a threshold change would have done ─────────────────────────

def replay(rows: list, cfg: dict | None = None) -> dict:
    """Re-decide recorded assessments under `cfg`. A row carries the scores
    and state it was decided on and the action it got, and may carry a
    `label` of "right" or "wrong" given afterwards. A change on a wrong row is
    a candidate fix; a change on a right row is a candidate regression."""
    changed, by, fixes, breaks, labelled = [], {}, 0, 0, 0
    for i, r in enumerate(rows):
        now = decide(r.get("scores") or {}, r.get("state") or {}, cfg)["action"]
        was = str(r.get("action") or "")
        by[now] = by.get(now, 0) + 1
        label = r.get("label")
        labelled += label in ("right", "wrong")
        if now != was:
            changed.append({"i": i, "was": was, "now": now, "label": label})
            fixes += label == "wrong"
            breaks += label == "right"
    return {"n": len(rows), "agree": len(rows) - len(changed), "changed": changed, "by_action": dict(sorted(by.items())),
            "labelled": labelled, "candidate_fixes": fixes, "candidate_regressions": breaks}


def dispatch(inp: dict) -> dict:
    op = str(inp.get("op") or "")
    cfg = inp.get("cfg")
    if op == "questions":
        return questions(inp.get("observation") or {}, cfg)
    if op == "assess":
        return assess(inp.get("observation") or {}, inp.get("jev"), cfg)
    if op == "decide":
        return decide(inp.get("scores") or {}, inp.get("state") or {}, cfg)
    if op == "replay":
        return replay(inp.get("rows") or [], cfg)
    if op == "checks":
        return {"checks": checks(cfg), "routes": routes(cfg), "settings": settings(cfg), "actions": list(ACTIONS)}
    return {"error": f"unknown foreman op {op!r}", "ops": ["questions", "assess", "decide", "replay", "checks"]}
