// echos/fallback.js — the same seven echos, in JavaScript, for a box with no
// compiled `arc`.
//
// This is a deliberate second implementation and it mirrors `arc/src/echos/`
// rule for rule. The precedent is `src/arc/read.js`, which reads the binary
// index the Rust side writes, for the same reason: the Rust is faster and the
// JavaScript is always there, and a verb that answers "install a toolchain" to
// a question it could have answered is a verb nobody runs.
//
// The contract both sides implement is the payload and the result shape:
//
//   in   { events: [{at, session, kind, shape, file, hash, tokens, tools, scope}],  file is repo-relative
//          thresholds: {...}, only: [id...] }
//   out  { echos: [{id, verdict, session, support, severity, detail, evidence}],
//          events, sessions, thresholds, registry, hits, ms }
//
// `test/echos.test.js` runs both over one stream and asserts they agree, which
// is the only thing that keeps two implementations equal.

const IDS = ["spin", "oscillate", "drift", "diminishing", "converge", "stray", "batching"];

/** Mirrors `human` in arc/src/echos/mod.rs: 33374161 in a sentence is a number
 *  nobody checks, 33.4M is one they can. */
const human = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

/** Mirrors `MIN_EDITS_PER_HALF` in arc/src/echos/diminishing.rs. */
const MIN_EDITS_PER_HALF = 3;
/** Mirrors `MIN_SESSIONS` in arc/src/echos/diminishing.rs. */
const MIN_SESSIONS = 5;

/** Mirrors `median` in arc/src/echos/diminishing.rs, including the even case. */
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const unknown = (id, detail) => ({ id, verdict: "unknown", session: "", support: 0, severity: "info", detail, evidence: [] });
const ok = (id, detail) => ({ id, verdict: "ok", session: "", support: 0, severity: "info", detail, evidence: [] });

/** Events grouped by session, each in the order they happened. Insertion order
 *  is preserved for equal timestamps, exactly as the Rust stable sort does. */
export function bySession(events) {
  const by = new Map();
  for (const e of events) {
    const key = e.session || "unknown";
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(e);
  }
  for (const g of by.values()) g.sort((a, b) => (a.at || 0) - (b.at || 0));
  return [...by.entries()];
}

function spin(grouped, th) {
  const out = [];
  let looked = 0;
  for (const [session, events] of grouped) {
    const runs = new Map();
    let last = null, streak = 0, editedSince = false;
    for (const e of events) {
      if (e.kind === "edit") { editedSince = true; continue; }
      if (e.kind !== "shape" || !e.shape) continue;
      // Counted before the `polls` check: a polled shape is still evidence the
      // recorder is working, and skipping it from the COUNT as well as from the
      // streak made a session of nothing but `gh pr` report "no command shape
      // has been recorded" — unknown, for a stream full of them.
      looked++;
      // A command whose answer this box does not control is polling, not
      // spinning. Mirrors the `polls` check in arc/src/echos/spin.rs.
      if (e.polls) continue;
      if (last === e.shape && !editedSince) streak++;
      else { streak = 1; last = e.shape; }
      editedSince = false;
      if (streak >= th.spin_repeats) runs.set(e.shape, Math.max(runs.get(e.shape) || 0, streak));
    }
    for (const [shape, n] of runs) {
      out.push({ id: "spin", verdict: "hit", session, support: n,
        severity: n >= th.spin_repeats * 2 ? "high" : "medium",
        detail: `\`${shape}\` ran ${n} times in a row with no file edited between them. The same question cannot return a different answer, and every run of it is a tool result the window carries for the rest of the session.`,
        evidence: [`shape=${shape}`, `consecutive=${n}`, `threshold=${th.spin_repeats}`] });
    }
  }
  if (!looked) return [unknown("spin", "no command shape has been recorded; `lathe.record_shapes` writes them from the PostToolUse hook")];
  return out.length ? out : [ok("spin", `no command repeated ${th.spin_repeats} times without an edit between`)];
}

function oscillate(grouped, th) {
  const out = [];
  let looked = 0;
  for (const [session, events] of grouped) {
    const seen = new Map();
    for (const e of events) {
      if (e.kind !== "edit" || !e.file || !e.hash) continue;
      looked++;
      if (!seen.has(e.file)) seen.set(e.file, { hashes: [], flips: 0 });
      const s = seen.get(e.file);
      if (s.hashes.length && s.hashes[s.hashes.length - 1] === e.hash) continue;
      if (s.hashes.includes(e.hash)) s.flips++;
      s.hashes.push(e.hash);
    }
    for (const [file, s] of seen) {
      if (s.flips < th.oscillate_flips) continue;
      out.push({ id: "oscillate", verdict: "hit", session, support: s.flips,
        severity: s.flips >= th.oscillate_flips * 2 ? "high" : "medium",
        detail: `${file} came back to a value it already had ${s.flips} time(s) across ${s.hashes.length} edit(s) in one session. Each edit was paid for and the file is where it started; something in the work is undoing itself.`,
        evidence: [`file=${file}`, `returns=${s.flips}`, `distinct_states=${s.hashes.length}`, `threshold=${th.oscillate_flips}`] });
    }
  }
  if (!looked) return [unknown("oscillate", "no edit event carries a content hash; nothing can say whether a file came back to a value it had")];
  return out.length ? out : [ok("oscillate", `no file returned to an earlier value ${th.oscillate_flips} times in one session`)];
}

function drift(grouped, th) {
  const out = [];
  let looked = 0, dark = 0;
  for (const [session, events] of grouped) {
    const turns = events.filter((e) => e.kind === "turn");
    if (!turns.length) continue;
    const edits = events.filter((e) => e.kind === "edit").length;
    const reads = events.filter((e) => e.kind === "read").length;
    const shapes = events.filter((e) => e.kind === "shape").length;
    // Turns but no tool call of any kind is a session this box could not look
    // inside. "Not one edit" there is a zero for something never checked.
    if (!reads && !shapes && !edits) { dark++; continue; }
    looked++;
    if (edits > 0 || turns.length < th.drift_turns) continue;
    const window = turns.reduce((a, e) => a + (Number(e.tokens) || 0), 0);
    out.push({ id: "drift", verdict: "hit", session, support: turns.length,
      severity: turns.length >= th.drift_turns * 2 ? "medium" : "low",
      detail: `${turns.length} turns, ${reads} file(s) opened, ${shapes} command(s) run, and not one edit. Either this is an investigation — which is a kind of work with its own budget — or the session is looking for something it is not going to find this way. ${human(window)} tokens of window went by.`,
      evidence: [`turns=${turns.length}`, `reads=${reads}`, `shells=${shapes}`, "edits=0", `window_tokens=${Math.round(window)}`, `threshold=${th.drift_turns}`] });
  }
  if (!looked) return [unknown("drift", `no session carries a tool call this box can read (${dark} had turns and nothing else); \`bb tokens ledger\` folds them off the transcripts`)];
  if (!out.length) out.push(ok("drift", `every session of ${th.drift_turns} turns or more changed at least one file`));
  if (dark) out.push(unknown("drift", `${dark} session(s) recorded turns but no tool call at all; they were not checked, which is not the same as passing`));
  return out;
}

function diminishing(grouped, th) {
  const rows = [];
  for (const [session, events] of grouped) {
    const turns = events.filter((e) => e.kind === "turn");
    if (turns.length < 6) continue;
    const mid = Math.floor(turns.length / 2);
    const cost = (a) => a.reduce((s, e) => s + (Number(e.tokens) || 0), 0);
    const earlyCost = cost(turns.slice(0, mid));
    const lateCost = cost(turns.slice(mid));
    const splitAt = turns[mid].at || 0;
    const editsEarly = events.filter((e) => e.kind === "edit" && (e.at || 0) < splitAt).length;
    const editsLate = events.filter((e) => e.kind === "edit" && (e.at || 0) >= splitAt).length;
    // Three edits a half: with one, the ratio is decided by whatever that
    // single edit happened to cost. A half with fewer is drift, not
    // diminishing returns, and `drift` is the echo for it.
    if (editsEarly < MIN_EDITS_PER_HALF || editsLate < MIN_EDITS_PER_HALF || earlyCost <= 0) continue;
    const perEarly = earlyCost / editsEarly;
    const perLate = lateCost / editsLate;
    rows.push({ session, turns: turns.length, perEarly, perLate, ratio: perLate / perEarly });
  }
  if (rows.length < MIN_SESSIONS) {
    return [unknown("diminishing", `${rows.length} session(s) carry six turns and three edits a half; ${MIN_SESSIONS} are needed before this workspace has a typical cost per change to compare one against`)];
  }
  const mid = median(rows.map((r) => r.ratio));
  const bar = mid * th.diminishing_ratio;
  const out = [];
  for (const r of rows.filter((x) => x.ratio >= bar)) {
    out.push({ id: "diminishing", verdict: "hit", session: r.session, support: r.turns,
      severity: r.ratio >= bar * 1.5 ? "medium" : "low",
      detail: `the late half of this session cost ${r.ratio.toFixed(1)}x the early half per file changed (${human(r.perLate)} tokens of window per edit, against ${human(r.perEarly)}) — ${(r.ratio / mid).toFixed(1)}x what a session in this workspace usually does (${mid.toFixed(1)}x, median of ${rows.length}). Past that point the window IS the work: it is re-sent on every turn, so a fresh session with \`bb pinpoint\` on what is left starts at the brief instead of at everything read so far.`,
      evidence: [`turns=${r.turns}`, `early_window_per_edit=${Math.round(r.perEarly)}`, `late_window_per_edit=${Math.round(r.perLate)}`,
        `ratio=${r.ratio.toFixed(2)}`, `workspace_median=${mid.toFixed(2)}`, `bar=${bar.toFixed(2)}`, `multiple_of_median=${th.diminishing_ratio}`] });
  }
  if (!out.length) out.push(ok("diminishing", `no session reached ${bar.toFixed(1)}x this workspace's median cost per change (${mid.toFixed(1)}x over ${rows.length} sessions)`));
  return out;
}

/** Jaccard over two file sets. Mirrors `converge::similarity`. */
export function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  let shared = 0;
  for (const x of a) if (B.has(x)) shared++;
  const union = a.length + b.length - shared;
  return union <= 0 ? 0 : shared / union;
}

function converge(grouped, th) {
  const briefs = [];
  for (const [, events] of grouped) for (const e of events) if (e.kind === "brief" && (e.scope || []).length) briefs.push(e);
  briefs.sort((a, b) => (a.at || 0) - (b.at || 0));
  if (briefs.length < th.converge_runs + 1) {
    return [unknown("converge", `${briefs.length} brief(s) with a scope on file; ${th.converge_runs} consecutive pairs are needed before convergence is a measurement rather than a coincidence`)];
  }
  let streak = 0, best = 0, at = null, last = 0;
  for (let i = 1; i < briefs.length; i++) {
    const s = similarity(briefs[i - 1].scope, briefs[i].scope);
    last = s;
    if (s >= th.converge_similarity) { streak++; if (streak > best) { best = streak; at = briefs[i]; } }
    else streak = 0;
  }
  if (best < th.converge_runs) {
    return [ok("converge", `the located scope is still moving: ${best} consecutive pair(s) at or above ${th.converge_similarity}, ${th.converge_runs} needed. Last pair ${last.toFixed(2)}.`)];
  }
  const e = at || briefs[briefs.length - 1];
  return [{ id: "converge", verdict: "hit", session: e.session || "", support: best, severity: "info",
    detail: `the last ${best + 1} briefs located the same ${e.scope.length} file(s) — similarity at or above ${th.converge_similarity} every time. Re-locating this work is no longer producing information; what is left is closing it. The scope is: ${e.scope.join(", ")}.`,
    evidence: [`briefs=${briefs.length}`, `streak=${best}`, `threshold=${th.converge_similarity}`, `runs_needed=${th.converge_runs}`, `scope=${e.scope.join(",")}`] }];
}

/** Mirrors `windows` in arc/src/echos/stray.rs. One window per brief: the edits
 *  that followed it, up to the next brief. Per brief and not per session
 *  because a session locates several tasks and scoring them together would let
 *  a well-located task pay for a badly-located one. */
function strayWindows(grouped) {
  const out = [];
  for (const [session, events] of grouped) {
    let cur = null;
    for (const e of events) {
      if (e.kind === "brief" && (e.scope || []).length) {
        if (cur) out.push(cur);
        cur = { session, scope: e.scope, inn: 0, out: 0, strayed: [] };
        continue;
      }
      // Before the first brief there is nothing to have strayed FROM.
      if (!cur || e.kind !== "edit" || !e.file) continue;
      if (cur.scope.includes(e.file)) cur.inn += 1;
      else { cur.out += 1; if (!cur.strayed.includes(e.file)) cur.strayed.push(e.file); }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function stray(grouped, th) {
  const wins = strayWindows(grouped);
  const scored = wins.filter((w) => w.inn + w.out >= th.stray_edits);
  if (scored.length < th.stray_briefs) {
    return [unknown("stray", `${scored.length} brief(s) followed by ${th.stray_edits} or more edits to a named file; ${th.stray_briefs} are needed before a locator's aim is a measurement rather than one odd task. A shell write carries no path and is counted on neither side.`)];
  }
  const inn = scored.reduce((a, w) => a + w.inn, 0);
  const off = scored.reduce((a, w) => a + w.out, 0);
  const share = off / (inn + off);
  if (share < th.stray_share) {
    return [ok("stray", `the locator is landing: ${off} of ${inn + off} edited file(s) across ${scored.length} brief(s) fell outside the scope that was handed over (${share.toFixed(2)}, under ${th.stray_share}).`)];
  }
  // The worst window, first one on a tie, so both implementations name the same
  // brief for the same stream.
  let worst = scored[0];
  for (const w of scored) if (w.out > worst.out) worst = w;
  const files = worst.strayed.slice(0, 8);
  return [{ id: "stray", verdict: "hit", session: worst.session, support: scored.length, severity: "medium",
    detail: `${off} of ${inn + off} edits across ${scored.length} brief(s) went to files the brief never named (${share.toFixed(2)}, at or over ${th.stray_share}). The located scope is not where the work is, so every session it is handed to pays to find that out again. Worst brief located ${worst.scope.length} file(s) and the work touched ${files.join(", ")}${worst.strayed.length > files.length ? `, +${worst.strayed.length - files.length} more` : ""}.`,
    evidence: [`briefs=${scored.length}`, `in_scope=${inn}`, `strayed=${off}`, `share=${share.toFixed(3)}`,
      `threshold=${th.stray_share}`, `min_edits=${th.stray_edits}`, `worst_scope=${worst.scope.join(",")}`, `worst_strayed=${worst.strayed.join(",")}`] }];
}

/** Mirrors arc/src/echos/batching.rs.
 *
 *  Attempts per decision round, which is the one term of the Dream-RSI replay
 *  objective this box had a name for and no count of: `bb uptake` calls it
 *  "serial-turns-want-batching — one tool per turn is one round trip per fact"
 *  and then nothing measured it.
 *
 *  Pooled across sessions and reported ONCE, because it is a habit and not an
 *  incident. The first version filed one finding per session and on this
 *  workspace that was 22 of 22 — a list in which every row says the same thing
 *  is a list nobody reads, and `diminishing` only avoids it by judging each
 *  session against the workspace median rather than an absolute bar.
 *
 *  Two things keep it from overclaiming. A turn that called no tool is thinking
 *  or answering and is in neither the numerator nor the denominator. And the
 *  ratio a session CAN reach is bounded by how much of its work is independent
 *  — a read whose path comes out of the previous result cannot move earlier —
 *  so a low one is evidence to look at, never proof of waste. */
function batching(grouped, th) {
  const per = [];
  for (const [session, events] of grouped) {
    let turns = 0, calls = 0;
    for (const e of events) {
      if (e.kind !== "turn") continue;
      const n = Number(e.tools) || 0;
      if (n <= 0) continue;
      turns += 1;
      calls += n;
    }
    if (calls >= th.batching_calls) per.push({ session, turns, calls, ratio: calls / turns });
  }
  if (per.length < th.batching_sessions) {
    return [unknown("batching", `${per.length} session(s) have made ${th.batching_calls} or more tool calls with a recorded turn count; ${th.batching_sessions} are needed before a ratio is a habit rather than one session's shape`)];
  }
  const calls = per.reduce((a, x) => a + x.calls, 0);
  const turns = per.reduce((a, x) => a + x.turns, 0);
  const pooled = calls / turns;
  if (pooled > th.batching_ratio) {
    return [ok("batching", `${calls} tool call(s) over ${turns} turn(s) across ${per.length} session(s) — ${pooled.toFixed(2)} per turn, over ${th.batching_ratio}`)];
  }
  // Lowest ratio, then most calls, then first seen: both implementations have
  // to name the same session for the same stream.
  let worst = per[0];
  for (const x of per) if (x.ratio < worst.ratio || (x.ratio === worst.ratio && x.calls > worst.calls)) worst = x;
  return [{ id: "batching", verdict: "hit", session: worst.session, support: calls, severity: "low",
    detail: `${calls} tool call(s) over ${turns} turn(s) that made one, across ${per.length} session(s) — ${pooled.toFixed(2)} per turn, at or under ${th.batching_ratio}. Every turn is a round trip: the window is re-sent and re-read before the next fact arrives, so two independent calls cost one turn together and two apart. Worst session ${worst.calls} call(s) over ${worst.turns} turn(s) at ${worst.ratio.toFixed(2)}.`,
    evidence: [`calls=${calls}`, `turns=${turns}`, `ratio=${pooled.toFixed(2)}`, `sessions=${per.length}`,
      `worst=${worst.ratio.toFixed(2)}`, `threshold=${th.batching_ratio}`, `min_calls=${th.batching_calls}`] }];
}

const REGISTRY = { spin, oscillate, drift, diminishing, converge, stray, batching };

export function run({ events = [], thresholds = {}, only = [] } = {}) {
  const t0 = Date.now();
  const th = {
    spin_repeats: Math.max(2, Number(thresholds.spin_repeats) || 4),
    oscillate_flips: Math.max(2, Number(thresholds.oscillate_flips) || 3),
    drift_turns: Math.max(2, Number(thresholds.drift_turns) || 12),
    diminishing_ratio: Math.max(1, Number(thresholds.diminishing_ratio) || 1.6),
    converge_similarity: Math.min(1, Math.max(0, Number(thresholds.converge_similarity) || 0.95)),
    converge_runs: Math.max(2, Number(thresholds.converge_runs) || 3),
    stray_share: Math.min(1, Math.max(0, thresholds.stray_share == null ? 0.5 : Number(thresholds.stray_share))),
    stray_edits: Math.max(1, Number(thresholds.stray_edits) || 4),
    stray_briefs: Math.max(1, Number(thresholds.stray_briefs) || 2),
    batching_ratio: Math.max(1, Number(thresholds.batching_ratio) || 1.5),
    batching_calls: Math.max(1, Number(thresholds.batching_calls) || 20),
    batching_sessions: Math.max(1, Number(thresholds.batching_sessions) || 3),
  };
  const grouped = bySession(events);
  const echos = [];
  for (const id of IDS) {
    if (only.length && !only.includes(id)) continue;
    echos.push(...REGISTRY[id](grouped, th));
  }
  return { echos, events: events.length, sessions: grouped.length, thresholds: th,
    registry: IDS, hits: echos.filter((e) => e.verdict === "hit").length,
    ms: Date.now() - t0, engine: "fallback" };
}
