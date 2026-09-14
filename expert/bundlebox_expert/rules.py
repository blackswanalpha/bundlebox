"""Where a signal becomes a recommendation. Change the number in THRESHOLDS
(or `cfg.learn.thresholds`), not the rule: a rule is a sentence about what a
signal means, the threshold is where it starts mattering. Every threshold key
is read by at least one rule — a test enforces it, because the original
carried three numbers nobody read.
"""
from __future__ import annotations
from .engine import RuleSet, infer

THRESHOLDS = {
    "reread_ratio": 0.12, "repeat_cmd_ratio": 0.04, "fat_chars_share": 0.35, "fat_result_ratio": 0.06,
    "singleton_turn_ratio": 0.55, "retry_ratio": 0.25, "ctx_slope_per_turn": 1800, "long_session_share": 0.30,
    "interrupts_per_session": 1.0, "compactions_per_session": 0.8, "searches_per_session": 12,
}
RS = RuleSet("learn")


def _ge(f, key, tkey=None):
    v = f.get(key)
    t = f["_t"].get(tkey or key)
    return v is not None and t is not None and v >= t


def _rec(f, key, title, why, actuator, evidence, cost=""):
    recs = list(f.get("recommendations", []))
    recs.append({"id": key, "title": title, "why": why, "actuator": actuator, "evidence": evidence, "cost": cost})
    return {"recommendations": recs}


@RS.guarded("rereads-want-a-table", lambda f: _ge(f, "reread_ratio") and f.get("top_reread_files"), salience=50, why="a file read twice was a table the session did not have")
def _rereads(f):
    return _rec(f, "snapgen-hot", f"{int(f['reread_ratio']*100)}% of reads are re-reads — snapshot the hot files",
                "a re-read is the window paying for the same lines twice; a snapgen table hands the session a signature view once and stays fresh by fingerprint",
                "bb snapgen build --only hot", {"reread_ratio": f["reread_ratio"], "files": f["top_reread_files"][:10]}, "0 tokens; seconds")


@RS.guarded("fat-results-want-a-filter", lambda f: _ge(f, "fat_chars_share") or _ge(f, "fat_result_ratio"), salience=45, why="most of the bytes a session reads come from a few commands")
def _fat(f):
    return _rec(f, "wire-filter", f"{int((f.get('fat_chars_share') or 0)*100)}% of tool-result bytes are in oversized results",
                "bound the output of every acceptance and test command (tail -c 4000), and put the compression proxy on the wire for what still gets through",
                "bb headroom start --apply", {"fat_chars_share": f.get("fat_chars_share"), "fat_result_ratio": f.get("fat_result_ratio")}, "0 tokens; local")


@RS.guarded("serial-turns-want-batching", lambda f: _ge(f, "singleton_turn_ratio"), salience=40, why="one tool per turn is one round trip per fact")
def _serial(f):
    return _rec(f, "batch-calls", f"{int(f['singleton_turn_ratio']*100)}% of tool turns run exactly one tool",
                "every turn re-sends the window; independent calls issued together cost one send instead of N. One instruction line, measurable next run",
                "bb wire (instruction block)", {"singleton_turn_ratio": f["singleton_turn_ratio"]}, "one line of guidance")


@RS.guarded("retries-want-a-preflight", lambda f: _ge(f, "retry_ratio") and (f.get("error_ratio") or 0) > 0.01, salience=35, why="a retried failure is a check the tool could have made first")
def _retries(f):
    return _rec(f, "preflight-hook", f"{int(f['retry_ratio']*100)}% of failed calls are retried with the same input",
                "a PreToolUse hook that refuses the known-bad shape turns a paid failure into a free one", "bb wire --apply (hooks)",
                {"retry_ratio": f["retry_ratio"], "error_ratio": f.get("error_ratio")}, "a hook")


@RS.guarded("repeat-commands-want-a-verb", lambda f: _ge(f, "repeat_cmd_ratio"), salience=30, why="a command run twice in one session is state the session should hold")
def _repeats(f):
    return _rec(f, "bb-verb", f"{int(f['repeat_cmd_ratio']*100)}% of tool calls repeat an earlier command verbatim",
                "the repeated commands are the shape of a missing detector or a missing snapgen table: the answer was computed and then forgotten",
                "bb snapgen build", {"top_repeat_cmds": f.get("top_repeat_cmds")})


@RS.guarded("window-compounds", lambda f: _ge(f, "ctx_slope_median", "ctx_slope_per_turn") or _ge(f, "long_session_share") or _ge(f, "compactions_per_session"), salience=25, why="the window grows faster than the work")
def _compound(f):
    return _rec(f, "split-lanes", f"the median window grows {int(f.get('ctx_slope_median') or 0)} tokens per turn; {int((f.get('long_session_share') or 0)*100)}% of sessions run long; {round(f.get('compactions_per_session') or 0, 2)} compactions per session",
                "past ~150 turns most of what is sent is history. `bb route` packs a unit to one window; a session that will not fit is two lanes, not one long one",
                "bb route", {"ctx_slope_median": f.get("ctx_slope_median"), "ctx_peak_median": f.get("ctx_peak_median"), "compactions_per_session": f.get("compactions_per_session")})


@RS.guarded("searches-want-an-index", lambda f: _ge(f, "searches_per_session"), salience=20, why="a search is a table lookup the session had to build itself")
def _searches(f):
    return _rec(f, "snapgen-symbols", f"{round(f['searches_per_session'], 1)} searches per session",
                "a symbols table (name -> file:line) answers most of them from one read; `bb pinpoint` reads it for the session", "bb snapgen build --only symbols",
                {"searches_per_session": f["searches_per_session"]})


@RS.guarded("interrupts-want-shorter-steps", lambda f: _ge(f, "interrupts_per_session"), salience=15, why="a person stopped the session; the step was too big or wrong")
def _interrupts(f):
    return _rec(f, "shorter-steps", f"{f['interrupts_per_session']} interrupts per session",
                "an interrupted turn is a turn paid for and thrown away. The brief should name the first observable step and its acceptance", "bb wire (instruction block)",
                {"interrupts_per_session": f["interrupts_per_session"]})


@RS.rule("summary", salience=-10, why="one line for the board")
def _summary(f):
    recs = f.get("recommendations", [])
    return {"verdict": "compounding" if len(recs) >= 3 else ("watch" if recs else "lean"), "recommendation_count": len(recs)}


def decide(signals: dict, thresholds: dict | None = None) -> dict:
    f = dict(signals)
    f["_t"] = {**THRESHOLDS, **(thresholds or {})}
    out = infer(RS, f)
    return {"verdict": out.get("verdict"), "recommendations": out.get("recommendations", []), "fired": out["_fired"], "thresholds": f["_t"]}
