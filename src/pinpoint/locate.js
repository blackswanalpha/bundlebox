// pinpoint/locate.js — was the locate right? Scored against what was edited.
//
// Every detector here scores the code. Nothing scored whether this file's own
// sibling pointed at the right files, so `ambiguity()` could only ask presence
// questions: `no-location` fires when NOTHING matched, and a locate that
// matched three irrelevant symbols off two words in the problem statement
// reports no ambiguity at all.
//
// The labels already exist and nothing joined them. A brief records the scope
// it located, the files it CUT to fit the window and the candidates it ranked
// but did not scope; a transcript records every edit. `bb echos` already merges
// both into one time-ordered stream for `stray`, so the join below costs a walk
// over rows that were read anyway.
//
// The confound is the whole methodology. The brief says "scope — the only files
// to edit", so an obedient agent edits inside the scope by construction and a
// precision taken over every edit reads high for a reason unrelated to the
// locate being right. An in-scope edit is not scored. Only the exception rows
// carry signal — an edit to a cut file, to a candidate, or to a file the locate
// never mentioned — and a file changed and changed back inside one window is a
// wrong turn rather than a target, so it is dropped first.
//
// `expert/bundlebox_expert/locate.py` is the authoritative copy and explains
// the same split at length; this is the JS mirror the zero-token path uses, and
// `test/pinpoint.test.js` pins the two to the same answers. Below the support
// floor both return `unknown` rather than a figure, which is rule 2 of the
// echos doctrine: a small-sample number that reads like a measured one is worse
// than no number.
import fs from "node:fs";
import path from "node:path";
import { OUT } from "../core/paths.js";

/** Exception rows, and briefs that produced one, before the pair of numbers is
 *  a measurement. Twelve rows out of one odd task is one task, not an error
 *  rate. Mirrors `locate.MIN_ROWS` / `locate.MIN_WINDOWS`. */
export const MIN_ROWS = 12;
export const MIN_WINDOWS = 4;
/** The method's own precision and the shrinkage that blends it toward observed
 *  recall. Mirrors `confidence.PRECISION.lexical` and `confidence.SHRINKAGE`;
 *  the Python copy is the one to change. */
export const LEXICAL = 0.5;
export const SHRINKAGE = 4;

export const CACHE = () => path.join(OUT, "pinpoint", "locate.json");

export function thresholds(cfg = {}) {
  const user = cfg?.pinpoint?.locate || {};
  const out = { min_rows: MIN_ROWS, min_windows: MIN_WINDOWS };
  for (const k of Object.keys(out)) {
    const v = Number(user[k]);
    if (Number.isFinite(v) && v >= 1) out[k] = Math.floor(v);
  }
  return out;
}

/** One brief and the edits that followed it, up to the next brief in the same
 *  session. Per BRIEF and not per session: a session locates several tasks, and
 *  pooling them lets a well-located task pay for a badly-located one. Edits
 *  before the first brief are ignored — there is nothing to have missed yet. */
export function windows(events = []) {
  const bySession = new Map();
  for (const e of events) {
    const s = String(e.session || "");
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s).push(e);
  }
  const out = [];
  for (const [session, rows] of bySession) {
    let cur = null;
    for (const e of rows) {
      if (e.kind === "brief" && (e.scope || []).length) {
        if (cur) out.push(cur);
        cur = { session, at: e.at || 0, brief: String(e.path || ""), scope: (e.scope || []).map(String),
          cut: (e.cut || []).map(String), candidates: (e.candidates || []).map(String), edits: [] };
        continue;
      }
      // A shell write carries no path and no hash, so it is evidence of neither
      // aim nor miss and is counted on neither side.
      if (!cur || e.kind !== "edit" || !e.file) continue;
      cur.edits.push({ file: String(e.file), hash: String(e.hash || "") });
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Files whose content returned to a value they already held in this window.
 *  Keyed on the hash of the text WRITTEN, which is the only value recorded:
 *  nothing on disk says what a file held between two edits. */
export function reverted(edits = []) {
  const seen = new Map();
  const back = new Set();
  for (const e of edits) {
    if (!e.file || !e.hash) continue;
    if (!seen.has(e.file)) seen.set(e.file, new Set());
    if (seen.get(e.file).has(e.hash)) back.add(e.file);
    seen.get(e.file).add(e.hash);
  }
  return back;
}

/** One window, split into the four buckets. Files, not edits: a session that
 *  touched one file eleven times learned one thing about the locate. */
export function classify(w) {
  const scope = new Set((w.scope || []).map(String));
  const cut = new Set((w.cut || []).map(String));
  const cand = new Set((w.candidates || []).map(String));
  const back = reverted(w.edits || []);
  const order = [];
  const touched = new Set();
  for (const e of w.edits || []) {
    const f = String(e.file || "");
    if (!f || back.has(f) || touched.has(f)) continue;
    touched.add(f);
    order.push(f);
  }
  const b = { in_scope: [], from_cut: [], from_candidates: [], unnamed: [] };
  for (const f of order) {
    if (scope.has(f)) b.in_scope.push(f);
    else if (cut.has(f)) b.from_cut.push(f);
    else if (cand.has(f)) b.from_candidates.push(f);
    else b.unnamed.push(f);
  }
  const named = b.from_cut.length + b.from_candidates.length;
  const missed = b.unnamed.length;
  const offered = new Set([...cut, ...cand]).size;
  return { session: String(w.session || ""), at: w.at || 0, brief: String(w.brief || ""),
    offered, scope: scope.size, reverted: [...back].sort(), named, missed, rows: named + missed, ...b };
}

/** Recall over exception rows, shrunk toward the method's own precision at
 *  `settled / (settled + SHRINKAGE)`, so three samples cannot override the
 *  method and zero samples report neither 0 nor 1. */
export function blend(named, missed) {
  const settled = named + missed;
  if (!settled) return { confidence: LEXICAL, base: LEXICAL, hold_rate: null, settled: 0, weight: 0 };
  const hold = named / settled;
  const w = settled / (settled + SHRINKAGE);
  return { confidence: Math.round(((1 - w) * LEXICAL + w * hold) * 1e4) / 1e4, base: LEXICAL,
    hold_rate: Math.round(hold * 1e4) / 1e4, settled, weight: Math.round(w * 1e4) / 1e4 };
}

/** The baseline, with `n` beside it. `unknown` under the floor, never a
 *  figure: the whole point of the number is that somebody can check it. */
export function score(wins = [], cfg = {}) {
  const th = thresholds(cfg);
  const rows = wins.map(classify);
  const scored = rows.filter((r) => r.rows > 0);
  const sum = (k, xs) => xs.reduce((a, r) => a + (Array.isArray(r[k]) ? r[k].length : r[k]), 0);
  const n = sum("rows", scored);
  const named = sum("named", scored);
  const missed = sum("missed", scored);
  const offered = sum("offered", scored);
  const base = { windows_seen: rows.length, windows_scored: scored.length, n, named, missed, offered,
    in_scope_unscored: sum("in_scope", rows), reverted: sum("reverted", rows), thresholds: th };
  if (n < th.min_rows || scored.length < th.min_windows) {
    return { ...base, verdict: "unknown", precision: null, recall: null, confidence: null,
      detail: `${n} exception row(s) over ${scored.length} brief(s); ${th.min_rows} rows over ${th.min_windows} brief(s) are needed before the locate's aim is a measurement rather than one odd task. An in-scope edit is not evidence: the brief told the session to make it.` };
  }
  const conf = blend(named, missed);
  const precision = offered ? Math.round((named / offered) * 1e4) / 1e4 : null;
  const recall = Math.round((named / n) * 1e4) / 1e4;
  return { ...base, verdict: "measured", precision, recall, confidence: conf.confidence, blend: conf,
    detail: `of ${n} edit(s) that went outside the located scope across ${scored.length} brief(s), the locate had already ranked ${named} and never mentioned ${missed} (recall ${recall}). `
      + (offered ? `${named} of ${offered} file(s) offered below the scope line were opened (precision ${precision}). `
        : "no file was offered below the scope line, so precision is not defined. ")
      + `Confidence ${conf.confidence}, blended from ${conf.settled} sample(s) toward the method's ${conf.base}.` };
}

/** Score the stream and store the result where a brief can read it in one
 *  stat. Called from `bb echos`, which already holds the events: building them
 *  again inside `pinpoint.build` would put a transcript walk inside a 15s hook
 *  budget, and the number does not move between two briefs. */
export function measure(events = [], { cfg = {}, expert = null } = {}) {
  const wins = windows(events);
  let r = null;
  if (expert) {
    try { r = expert.call("locate-replay", { windows: wins, cfg }); } catch { r = null; }
  }
  const out = { ...(r || score(wins, cfg)), engine: r ? "expert" : "js" };
  try {
    fs.mkdirSync(path.dirname(CACHE()), { recursive: true });
    fs.writeFileSync(CACHE(), JSON.stringify(out, null, 2) + "\n");
  } catch { /* a lost baseline costs a signal, never the brief */ }
  return out;
}

/** What the last measurement said, for the brief. `null` when nothing has
 *  measured it here yet, so the signal that reads this stays quiet rather than
 *  reporting an unmeasured locate as a good one. */
export function cached() {
  try {
    const r = JSON.parse(fs.readFileSync(CACHE(), "utf8"));
    return r && r.verdict ? r : null;
  } catch { return null; }
}
