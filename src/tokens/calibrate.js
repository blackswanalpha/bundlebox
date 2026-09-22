// calibrate.js — correct the estimator with the thing it estimates.
//
// Two independent measurements, each the one place a transcript states
// "this exact string cost this many tokens":
//
//   prose   assistant turns that are ONLY text (no tools, no thinking): their
//           `output_tokens` is the true count of that text.
//   code    the window delta across a single large tool result (see
//           ledger.windowDeltas): the true count of a code payload.
//
// The scale is the MEDIAN of per-sample ratios against the SHIPPED base
// coefficients, never against the current fitted ones: scaling a scale is how
// a refit drifts a little further every time it runs. Least squares is not
// used because a handful of very large samples would decide it and make the
// estimate worse for the thousands of small ones that fill a window.
import { DEFAULTS, load, readJson, writeJson, calibrationPath } from "../core/config.js";
import { ROOT, abs } from "../core/paths.js";
import { now, human, median } from "../core/util.js";
import * as store from "../core/store.js";
import * as estimate from "./estimate.js";
import { transcripts, read, windowDeltas } from "./ledger.js";

const MIN_SAMPLES = 30;
/** Three shipped constants had no refit at all, so every brief in every
 *  workspace was budgeted with the numbers one box measured once. These are the
 *  floors below which a fit is a coincidence — lower than MIN_SAMPLES because a
 *  session is a coarser unit than a turn and no workspace has thousands. */
const MIN_CHURN = 8;
const MIN_WIDEN = 6;
const MIN_RESERVE = 5;

export function proseSamples(root = ROOT, cap = 4000) {
  const out = [];
  for (const t of transcripts(root)) {
    const tr = read(t);
    if (!tr) continue;
    for (const u of tr.turns) {
      if (u.thinking || u.toolUses.length || !u.text || u.output < 20) continue;
      const pred = estimate.text(u.text, "prose", true);
      if (pred) out.push([pred, u.output]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export function codeSamples(root = ROOT, cap = 4000) {
  const out = [];
  for (const t of transcripts(root)) {
    const tr = read(t);
    if (!tr) continue;
    for (const d of windowDeltas(tr.turns)) {
      if (d.text == null) continue;
      const pred = estimate.text(d.text, "code", true);
      if (pred >= 100) out.push([pred, d.delta]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Median ratio, clamped to [0.4, 2.5]: outside that the samples are not
 *  measuring what the estimator estimates. */
export function scale(samples) {
  if (samples.length < MIN_SAMPLES) return { ok: false, samples: samples.length };
  const ratios = samples.filter(([p]) => p).map(([p, y]) => y / p).sort((a, b) => a - b);
  const m = Math.min(Math.max(ratios[ratios.length >> 1], 0.4), 2.5);
  const errs = (f) => samples.map(([p, y]) => Math.abs(f * p - y) / y).sort((a, b) => a - b);
  const before = errs(1), after = errs(m);
  return { ok: true, samples: samples.length, scale: Math.round(m * 1e4) / 1e4,
    p25: Math.round(ratios[ratios.length >> 2] * 1e3) / 1e3, p75: Math.round(ratios[(3 * ratios.length) >> 2] * 1e3) / 1e3,
    err_before: Math.round(before[before.length >> 1] * 1000) / 10, err_after: Math.round(after[after.length >> 1] * 1000) / 10 };
}

export function fit({ root = ROOT, sample = 4000 } = {}) {
  const prose = scale(proseSamples(root, sample));
  const code = scale(codeSamples(root, sample));
  if (!prose.ok && !code.ok) return { ok: false, why: "no clean samples", prose, code };
  const base = DEFAULTS.tokens;
  const tokens = { ...base };
  if (prose.ok) for (const k of ["prose_w", "prose_p", "prose_s"]) tokens[k] = Math.round(base[k] * prose.scale * 1e4) / 1e4;
  if (code.ok) for (const k of ["code_w", "code_p", "code_s"]) tokens[k] = Math.round(base[k] * code.scale * 1e4) / 1e4;
  return { ok: true, prose, code, tokens, samples: (prose.samples || 0) + (code.samples || 0) };
}

// ── churn: how many times a session pays for one file ───────────────────────
//
// A lane is budgeted as `overhead + brief + payload * churn + reserve`, and
// `churn_factor` was the term everything else rested on: 2.4, measured once on
// one box's transcripts, shipped as a default, and never refitted anywhere.
// `bb doctor` has been reporting "calibration fitted 2026-09-14" for days with
// nothing on the box able to move it.
//
// It is measurable here and it is measurable for free. A session opens a set of
// DISTINCT files; it then reads, edits and re-reads them. The ratio of what it
// was billed for those tool results to what the files themselves cost is
// exactly the factor the budget means by churn.

/** Per session: (tokens of every read/edit result) / (tokens of the distinct
 *  files behind them). One sample per session, because churn is a property of
 *  how a session works and not of one call. */
export function churnSamples(root = ROOT, { cap = 400 } = {}) {
  const out = [];
  for (const t of transcripts(root)) {
    const tr = read(t);
    if (!tr || !tr.turns?.length) continue;
    const distinct = new Map();
    let paid = 0;
    for (const turn of tr.turns) {
      for (const u of turn.toolUses || []) {
        const name = String(u.name || "");
        if (!/^(Read|Edit|MultiEdit|Write|NotebookRead|NotebookEdit)$/.test(name)) continue;
        const p = String(u.input?.file_path || u.input?.path || "");
        if (!p) continue;
        if (!distinct.has(p)) distinct.set(p, estimate.file(abs(p)) || 0);
      }
      for (const r of turn.toolResults || []) {
        if (typeof r.text !== "string" || !r.text) continue;
        if (!/^(Read|Edit|MultiEdit|Write|NotebookRead|NotebookEdit)$/.test(String(r.tool || ""))) continue;
        paid += estimate.text(r.text, "code");
      }
    }
    const base = [...distinct.values()].reduce((a, b) => a + b, 0);
    // A session that opened three tiny files has no churn to measure: the ratio
    // is dominated by whatever the harness wraps a result in.
    if (base < 2000 || paid <= 0) continue;
    out.push({ session: tr.sessionId, files: distinct.size, base, paid, ratio: paid / base });
    if (out.length >= cap) break;
  }
  return out;
}

/** Median churn, clamped to [1, 6]. Below 1 a session read less than the files
 *  it opened, which means the estimator and the transcript disagree rather than
 *  that churn is negative; above 6 one session re-read one file forty times and
 *  budgeting every lane for that would halve every scope in the workspace. */
export function fitChurn(root = ROOT) {
  const s = churnSamples(root);
  if (s.length < MIN_CHURN) return { ok: false, samples: s.length, need: MIN_CHURN };
  const rs = s.map((x) => x.ratio).sort((a, b) => a - b);
  const m = Math.min(Math.max(median(rs), 1), 6);
  return { ok: true, samples: s.length, churn_factor: Math.round(m * 100) / 100,
    p25: Math.round(rs[rs.length >> 2] * 100) / 100, p75: Math.round(rs[(3 * rs.length) >> 2] * 100) / 100,
    files_median: median(s.map((x) => x.files)) };
}

// ── anchor_widen: how much of the rest of an anchored file gets read ─────────

/** Per anchored unit that actually ran: (tokens read of the file beyond its
 *  anchored regions) / (tokens of the rest of the file).
 *
 *  The stored units carry their anchors; the episodes carry what ran. Where the
 *  two meet is the only place this factor is observable without asking a
 *  session to report on itself. */
export function widenSamples() {
  const units = store.get("units", []);
  const out = [];
  for (const u of Array.isArray(units) ? units : []) {
    const anchors = u.anchors || [];
    if (!anchors.length) continue;
    for (const a of anchors) {
      const file = String(a.file || a.path || "");
      if (!file) continue;
      const whole = estimate.file(abs(file)) || 0;
      const region = Number(a.tokens) || 0;
      if (whole <= 0 || region <= 0 || region >= whole) continue;
      out.push({ file, region, rest: whole - region, share: region / whole });
    }
  }
  return out;
}

/** The widen fit, and the one place this file refuses to invent a number.
 *
 *  What a unit's anchors cover is measurable; what a session then read of the
 *  REST of that file is not, from anything on disk — no transcript says "this
 *  read was the remainder of an anchored file". So the fit is the median share
 *  the anchors do NOT cover, bounded to the band the default sits in, and it is
 *  labelled `bounded` rather than `measured` for exactly that reason. */
export function fitWiden() {
  const s = widenSamples();
  if (s.length < MIN_WIDEN) return { ok: false, samples: s.length, need: MIN_WIDEN };
  const rest = s.map((x) => 1 - x.share).sort((a, b) => a - b);
  // Half the uncovered remainder: a unit anchored to a tenth of a file does not
  // read the other nine tenths, and one anchored to most of it reads nearly all.
  const m = Math.min(Math.max(median(rest) / 2, 0.05), 0.9);
  return { ok: true, kind: "bounded", samples: s.length, anchor_widen: Math.round(m * 100) / 100,
    uncovered_median: Math.round(median(rest) * 100) / 100 };
}

// ── reserve_by_kind: what a session of each kind actually writes ────────────

/** Output tokens per session, grouped by the kind of unit that ran in it.
 *
 *  `fix` writes a patch and a sentence; `investigate` writes an argument. The
 *  shipped table says 12k and 40k and nothing has ever checked either. */
export function reserveSamples() {
  const eps = store.rows("episodes", { limit: 8000 });
  const kindOf = new Map();
  for (const e of eps) {
    const sid = String(e.session_id || "");
    const kind = String(e.kind || e.unit_kind || "");
    if (sid && kind && !kindOf.has(sid)) kindOf.set(sid, kind);
  }
  // A located prompt is not an episode: no lane packed it, so it carries no
  // unit kind. Its kind is what `bb intent` decided, and without these rows the
  // reserve table is only checkable against the sessions a lane ran — which are
  // the `fix` ones, which is the half of the table nobody doubted. Episodes
  // still win where both exist: a unit that ran is a stronger claim about what
  // the session was than a classifier's opinion of the prompt that opened it.
  for (const r of store.rows("intent", { limit: 8000 })) {
    const sid = String(r.session_id || "");
    const kind = String(r.kind || "");
    if (sid && kind && !kindOf.has(sid)) kindOf.set(sid, kind);
  }
  const by = {};
  for (const r of store.rows("usage")) {
    const kind = kindOf.get(String(r.session_id || ""));
    if (!kind) continue;
    const o = Number(r.output) || 0;
    if (o <= 0) continue;
    (by[kind] ||= { kind, turns: 0, sessions: new Set(), out: [] });
    by[kind].turns += 1;
    by[kind].sessions.add(r.session_id);
    by[kind].out.push(o);
  }
  return Object.values(by).map((b) => ({ kind: b.kind, turns: b.turns, sessions: b.sessions.size, out: b.out }));
}

/** Reserve per kind at the 90th percentile of what that kind actually wrote in
 *  one session, clamped to [4k, 60k]. p90 and not the median: a reserve is
 *  headroom, and sizing it at the middle means half of that kind's sessions
 *  compact. */
export function fitReserve(cfg = load()) {
  const s = reserveSamples();
  const base = cfg.budget?.reserve_by_kind || DEFAULTS.budget.reserve_by_kind;
  const fitted = {};
  const rows = [];
  for (const b of s) {
    if (base[b.kind] === undefined) continue;               // a kind the budget has no line for
    if (b.sessions < MIN_RESERVE) { rows.push({ ...b, ok: false, out: undefined }); continue; }
    const sorted = [...b.out].sort((x, y) => x - y);
    // Per SESSION, not per turn: the reserve holds back what one session's
    // whole output costs, and a p90 over turns would size it for one message.
    const perSession = Math.round(sorted.reduce((a, x) => a + x, 0) / b.sessions);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    const want = Math.min(Math.max(Math.max(perSession, p90), 4000), 60000);
    fitted[b.kind] = Math.round(want / 500) * 500;
    rows.push({ kind: b.kind, sessions: b.sessions, turns: b.turns, per_session: perSession, p90, fitted: fitted[b.kind], was: base[b.kind], ok: true });
  }
  return { ok: Object.keys(fitted).length > 0, reserve_by_kind: fitted, rows, need: MIN_RESERVE };
}

/** Every per-repo factor, fitted in one pass. What `bb tokens calibrate --apply`
 *  runs and what a cron line can run unattended: it reads stored rows and
 *  transcripts and calls nothing. */
export function fitAll({ root = ROOT, sample = 4000, cfg = load() } = {}) {
  return { at: now(), tokens: fit({ root, sample }), churn: fitChurn(root), widen: fitWiden(), reserve: fitReserve(cfg) };
}

/** READ-MERGE all of it into var/calibration.json. Read-merge and not a write:
 *  the probe, the token fit, the churn fit and the reserve table live in one
 *  file and a whole-object write is how one of them erases another. */
export function writeAll(a) {
  const p = calibrationPath();
  const cal = readJson(p, {}) || {};
  const wrote = [];
  if (a.tokens?.ok) { cal.tokens = a.tokens.tokens; cal.fit = { prose: a.tokens.prose, code: a.tokens.code }; wrote.push("tokens"); }
  if (a.churn?.ok) { cal.churn_factor = a.churn.churn_factor; cal.fit_churn = a.churn; wrote.push("churn_factor"); }
  if (a.widen?.ok) { cal.anchor_widen = a.widen.anchor_widen; cal.fit_widen = a.widen; wrote.push("anchor_widen"); }
  if (a.reserve?.ok) {
    cal.reserve_by_kind = { ...(cal.reserve_by_kind || {}), ...a.reserve.reserve_by_kind };
    cal.fit_reserve = { rows: a.reserve.rows };
    wrote.push("reserve_by_kind");
  }
  if (!wrote.length) return { path: p, wrote: [] };
  cal.calibrated_at = now();
  writeJson(p, cal);
  return { path: p, wrote };
}

export function reportAll(a, cfg = load()) {
  const L = [report(a.tokens), ""];
  const c = a.churn;
  L.push(c.ok
    ? `  churn   ${String(c.samples).padStart(5)} sessions   ${cfg.budget.churn_factor} -> ${c.churn_factor}   p25-p75 ${c.p25}-${c.p75}   (median files per session ${c.files_median})`
    : `  churn   ${String(c.samples).padStart(5)} sessions   too few to fit (need ${c.need}); keeping ${cfg.budget.churn_factor}`);
  const w = a.widen;
  L.push(w.ok
    ? `  widen   ${String(w.samples).padStart(5)} anchors    ${cfg.budget.anchor_widen} -> ${w.anchor_widen}   BOUNDED, not measured: no transcript says a read was the remainder of an anchored file`
    : `  widen   ${String(w.samples).padStart(5)} anchors    too few to fit (need ${w.need}); keeping ${cfg.budget.anchor_widen}`);
  if (a.reserve.rows.length) {
    for (const r of a.reserve.rows) {
      L.push(r.ok
        ? `  reserve ${String(r.sessions).padStart(5)} sessions   ${String(r.kind).padEnd(12)} ${r.was} -> ${r.fitted}   (p90 turn ${human(r.p90)}, per session ${human(r.per_session)})`
        : `  reserve ${String(r.sessions).padStart(5)} sessions   ${String(r.kind).padEnd(12)} too few to fit (need ${a.reserve.need})`);
    }
  } else {
    L.push("  reserve     0 sessions   nothing names a kind for a measured session yet (no episode, no `bb intent` row); the shipped table stands");
  }
  return L.join("\n");
}

/** READ-MERGE into var/calibration.json: the probe and the churn fit live in
 *  the same file and must not erase each other. */
export function write(f) {
  const p = calibrationPath();
  const cal = readJson(p, {}) || {};
  cal.tokens = f.tokens;
  cal.calibrated_at = now();
  cal.fit = { prose: f.prose, code: f.code };
  writeJson(p, cal);
  return p;
}

export function report(f) {
  if (!f.ok) return `  calibration: ${f.why} (prose ${f.prose?.samples || 0}, code ${f.code?.samples || 0} samples; need ${MIN_SAMPLES} of either)`;
  const row = (name, s) => (s.ok
    ? `  ${name.padEnd(6)} ${String(s.samples).padStart(5)} samples   scale ${s.scale}   p25-p75 ${s.p25}-${s.p75}   median err ${s.err_before}% -> ${s.err_after}%`
    : `  ${name.padEnd(6)} ${String(s.samples).padStart(5)} samples   too few to fit`);
  const t = f.tokens;
  return [row("prose", f.prose), row("code", f.code), `  coefficients  code ${t.code_w}/${t.code_p}/${t.code_s}   prose ${t.prose_w}/${t.prose_p}/${t.prose_s}   (${human(f.samples)} samples, MEASURED against shipped base)`].join("\n");
}
