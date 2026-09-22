"""Per-session signals from agent transcripts. The caller passes parsed turns
(`[{msgId, ts, input, output, cacheWrite, cacheRead, toolUses:[{name,input}],
toolResults:[{chars, error}], text}]`); this module never opens a transcript.

Every ratio has a denominator named beside it. A session with no tool turns
produces nulls, never zeros: zero is a claim the data has not made.
"""
from __future__ import annotations
import re
import statistics as st

READ_TOOLS = {"Read", "read_file", "cat", "view", "open"}
SEARCH_TOOLS = {"Grep", "Glob", "grep", "rg", "search", "find", "codebase_search", "WebSearch"}
_CAT = re.compile(r"\b(?:cat|head|tail|sed\s+-n\s+\S+|bat)\s+([^|;&\n]+)")


def _files_in_command(cmd: str) -> list:
    out = []
    for m in _CAT.finditer(cmd or ""):
        for tok in m.group(1).split():
            if tok.startswith("-") or tok in ("|", ";", "&&"):
                continue
            out.append(tok.strip("'\""))
    return out


def _reads(turn: dict) -> list:
    files = []
    for t in turn.get("toolUses") or []:
        name = t.get("name") or ""
        inp = t.get("input") or {}
        if name in READ_TOOLS:
            p = inp.get("file_path") or inp.get("path") or inp.get("target_file")
            if p:
                files.append(str(p))
        elif name in ("Bash", "bash", "shell", "run_terminal_cmd", "execute_command"):
            files.extend(_files_in_command(str(inp.get("command") or inp.get("cmd") or "")))
    return files


def _slope(ys: list) -> float | None:
    """Least-squares slope over turn index, segmented at compaction resets so a
    compaction does not read as a negative slope (the original used two points)."""
    segs, cur = [], []
    for y in ys:
        if cur and y < cur[-1] * 0.6:
            segs.append(cur)
            cur = []
        cur.append(y)
    if cur:
        segs.append(cur)
    slopes, weights = [], []
    for s in segs:
        n = len(s)
        if n < 3:
            continue
        xm = (n - 1) / 2
        ym = sum(s) / n
        den = sum((i - xm) ** 2 for i in range(n))
        slopes.append(sum((i - xm) * (y - ym) for i, y in enumerate(s)) / den if den else 0.0)
        weights.append(n)
    if not slopes:
        return None
    return sum(a * w for a, w in zip(slopes, weights)) / sum(weights)


def session_signals(turns: list) -> dict:
    tool_turns = [t for t in turns if t.get("toolUses")]
    reads, searches, cmds, fat_chars, all_chars, fat_n, results_n, errors, retried = [], 0, [], 0, 0, 0, 0, 0, 0
    seen_cmd, seen_fail = {}, set()
    for t in tool_turns:
        reads.extend(_reads(t))
        for u in t.get("toolUses") or []:
            if u.get("name") in SEARCH_TOOLS:
                searches += 1
            if u.get("name") in ("Bash", "bash", "shell"):
                c = str((u.get("input") or {}).get("command") or "")
                cmds.append(c)
                seen_cmd[c] = seen_cmd.get(c, 0) + 1
        for r in t.get("toolResults") or []:
            ch = int(r.get("chars") or 0)
            results_n += 1
            all_chars += ch
            if ch > 8000:
                fat_n += 1
                fat_chars += ch
            if r.get("error"):
                errors += 1
                key = r.get("key") or ""
                if key in seen_fail:
                    retried += 1
                seen_fail.add(key)
    windows = [int(t.get("input") or 0) + int(t.get("cacheRead") or 0) + int(t.get("cacheWrite") or 0) for t in turns if t.get("msgId")]
    compactions = sum(1 for a, b in zip(windows, windows[1:]) if b < a * 0.6)
    n_tools = sum(len(t.get("toolUses") or []) for t in tool_turns)
    distinct_reads = len(set(reads))
    cache_read = sum(int(t.get("cacheRead") or 0) for t in turns)
    inp = sum(int(t.get("input") or 0) for t in turns) + cache_read + sum(int(t.get("cacheWrite") or 0) for t in turns)
    top_reread = sorted(((p, reads.count(p)) for p in set(reads) if reads.count(p) > 1), key=lambda x: -x[1])[:10]
    return {
        "turns": len(turns), "tool_turns": len(tool_turns), "tool_calls": n_tools,
        "reads": len(reads), "reread_ratio": (len(reads) - distinct_reads) / len(reads) if reads else None,
        "top_reread_files": top_reread,
        "singleton_turn_ratio": sum(1 for t in tool_turns if len(t["toolUses"]) == 1) / len(tool_turns) if tool_turns else None,
        "searches": searches,
        "repeat_cmd_ratio": sum(v - 1 for v in seen_cmd.values()) / n_tools if n_tools else None,
        "top_repeat_cmds": sorted(((c, v) for c, v in seen_cmd.items() if v > 1), key=lambda x: -x[1])[:5],
        "fat_chars_share": fat_chars / all_chars if all_chars else None,
        "fat_result_ratio": fat_n / results_n if results_n else None,
        "error_ratio": errors / results_n if results_n else None,
        "retry_ratio": retried / errors if errors else None,
        "ctx_slope": _slope(windows), "ctx_peak": max(windows) if windows else None, "compactions": compactions,
        "cache_read_ratio": cache_read / inp if inp else None,
        "long": len(turns) > 150,
    }


def aggregate(sessions: list, split: bool = True) -> dict:
    """Medians across sessions; every key a rule reads. None when no session
    could say — a threshold compared against None does not fire.

    `split` adds the same medians per intent kind. "You re-read the same files
    too much" is advice about a habit, and a habit belongs to a kind of work:
    re-reading while investigating is reading, re-reading while fixing is the
    waste the rule was written for. Averaging the two hides both."""
    def med(key):
        xs = [s[key] for s in sessions if s.get(key) is not None]
        return st.median(xs) if xs else None
    reread_files: dict = {}
    for s in sessions:
        for p, n in s.get("top_reread_files") or []:
            reread_files[p] = reread_files.get(p, 0) + n
    repeat_cmds: dict = {}
    for s in sessions:
        for c, n in s.get("top_repeat_cmds") or []:
            repeat_cmds[c] = repeat_cmds.get(c, 0) + n
    n = len(sessions)
    out = {
        "sessions": n,
        "reread_ratio": med("reread_ratio"), "top_reread_files": sorted(reread_files.items(), key=lambda x: -x[1])[:20],
        "singleton_turn_ratio": med("singleton_turn_ratio"),
        "repeat_cmd_ratio": med("repeat_cmd_ratio"), "top_repeat_cmds": sorted(repeat_cmds.items(), key=lambda x: -x[1])[:10],
        "fat_chars_share": med("fat_chars_share"), "fat_result_ratio": med("fat_result_ratio"), "top_fat_sources": [],
        "error_ratio": med("error_ratio"), "retry_ratio": med("retry_ratio"),
        "ctx_slope_median": med("ctx_slope"), "ctx_peak_median": med("ctx_peak"),
        "long_session_share": (sum(1 for s in sessions if s.get("long")) / n) if n else None,
        "compactions_per_session": (sum(int(s.get("compactions") or 0) for s in sessions) / n) if n else None,
        "searches_per_session": (sum(int(s.get("searches") or 0) for s in sessions) / n) if n else None,
        "interrupts_per_session": (sum(int(s.get("interrupts") or 0) for s in sessions) / n) if n else None,
        "cache_read_ratio": med("cache_read_ratio"),
    }
    if split:
        kinds: dict = {}
        for s in sessions:
            k = str(s.get("kind") or "")
            if k:
                kinds.setdefault(k, []).append(s)
        # One kind is not a split. Until `bb intent` has a table that decides,
        # every session carries the same label, and a per-kind table would be
        # the aggregate printed twice under a heading that implies a comparison
        # nobody made. `kinds_seen` says which it was either way.
        out["by_kind"] = {k: aggregate(v, split=False) for k, v in kinds.items()} if len(kinds) > 1 else {}
        out["kinds_seen"] = sorted(kinds)
    return out
