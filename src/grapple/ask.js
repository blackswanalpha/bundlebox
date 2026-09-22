// ask.js — the question queue: emission, answers, and the labels an answer
// becomes.
//
// Two sources feed it. The brief prints "what this brief does not settle" and
// then nobody asks; each of those lines is an INSTANCE question keyed to the
// brief and the fingerprint of its scope. The findings board holds rows whose
// precision is `heuristic` — a question a regex cannot answer — and those are
// asked per PATTERN, one question per detector shape, because 82 rows of
// `swallowed-errors` are one question with 82 places it lands.
//
// The order is the expert's `rank` when an interpreter is there. Without one
// the queue is still ordered, by the documented fallback: severity, then rework
// cost, then key. Nothing here refuses to run.
//
// Before either ranks, Jev (`jev.js`) gives each pattern item one calibrated
// probability that its shape is deliberate. That probability replaces the
// per-detector prior as the item's uncertainty: a shape Jev is sure about sinks
// below the floor, a shape it cannot call is asked first.
//
// The same number has a second reader. `priorByFinding` hands it to triage as a
// per-finding prior on the method constant, which is what decides whether a
// heuristic finding is worth a lane at all. Both readings are CONFIDENCE, never
// a verdict: Jev writes no answer, no label and no event of record, and a human
// answer on a shape retires Jev's opinion of it rather than being blended with
// it.
import fs from "node:fs";
import { sha1 } from "../core/util.js";
import * as core from "../core/store.js";
import * as expert from "../core/expert.js";
import { similarity } from "../bench/gate.js";
import * as gs from "./store.js";
import * as jev from "./jev.js";
import { priors as priorsOf } from "./harvest.js";

export const ASK_TOKENS = 1000;            // a question inside an open session is under 1k
const SEV = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const AMBIGUITY_SEVERITY = { 3: "high", 2: "medium", 1: "low" };
const PRIOR = { exact: 0.95, probe: 0.80, heuristic: 0.60 };   // mirrors confidence.PRECISION; the expert's own numbers win when it answers

export const briefId = (rec) => sha1(`${rec.path || ""}|${rec.problem || ""}`).slice(0, 12);
export const scopeFingerprint = (rec) => core.witness({ files: rec.scope || [] });

/** The unsettled items of a brief: from the record when the builder attached
 *  them, otherwise parsed off the brief's own markdown. The section is
 *  `- **id** — why`, one per line, and the parse is exact on that shape. */
export function unsettled(rec) {
  if (!rec) return [];
  if (rec.ambiguity && Array.isArray(rec.ambiguity.reasons)) return rec.ambiguity.reasons.map((r) => ({ id: String(r.id), weight: Number(r.weight) || 1, why: String(r.why || "") }));
  let md = "";
  try { md = fs.readFileSync(String(rec.path || ""), "utf8"); } catch { return []; }
  const i = md.indexOf("## What this brief does not settle");
  if (i < 0) return [];
  const body = md.slice(i).split("\n## ")[0];
  const out = [];
  for (const m of body.matchAll(/^- \*\*([a-z0-9-]+)\*\* — (.+)$/gm)) out.push({ id: m[1], weight: /\bcut\b|wide-scope/.test(m[1]) ? 1 : /no-region|no-evidence|thin/.test(m[1]) ? 2 : 3, why: m[2].trim() });
  return out;
}

/** The contested rows: open findings the method cannot settle on its own. */
export const contested = (rows = core.get("findings", [])) => rows.filter((f) => f.status === "open" && f.precision === "heuristic");

/** Group contested rows into pattern questions, one per detector shape. */
export function patterns(rows = contested()) {
  const by = new Map();
  for (const f of rows) {
    const key = gs.patternKey(f.detector, f.title || f.key || "");
    const g = by.get(key) || { key, shape: "pattern", detector: f.detector, text: "", rows: [], severity: "low", est_tokens: 0 };
    g.rows.push(f);
    if ((SEV[f.severity] || 0) > (SEV[g.severity] || 0)) g.severity = f.severity;
    g.est_tokens = Math.max(g.est_tokens, Number(f.est_tokens) || 0);
    by.set(key, g);
  }
  for (const g of by.values()) {
    const ex = g.rows[0];
    g.text = `${g.detector}: is this deliberate? ${gs.normaliseShape(ex.title || ex.key || "")} — ${g.rows.length} row(s), e.g. ${ex.path || ex.key}. ${String(ex.fix_hint || "").slice(0, 140)}`;
    g.reaches = g.rows.length;
    g.paths = g.rows.map((r) => r.path || r.key).slice(0, 12);
    g.precision = "heuristic";
    g.n = g.rows.length;
  }
  return [...by.values()];
}

/** Jev's stored word on each contested finding, as `{ id: { p, n } }` for
 *  `detectors.expectedValue` to read as a prior. `{}` when Jev never ran.
 *
 *  Jev answers per PATTERN and a pattern covers every row of one detector
 *  shape, so the lookup goes back through the `patternKey` the queue was built
 *  with and every row of the shape inherits the one opinion. `n` is capped at
 *  the windows Jev actually read, not the rows the pattern reaches, because the
 *  shrinkage downstream is about evidence seen and Jev saw at most three.
 *
 *  Answered and expired questions are skipped. A shape a human settled has a
 *  label, and a label outranks an opinion: leaving it out here is what keeps
 *  the two from being blended into one number nobody can take apart. */
export function priorByFinding(rows = core.get("findings", []), stored = gs.questions()) {
  const out = {};
  for (const f of contested(rows)) {
    const q = stored[gs.patternKey(f.detector, f.title || f.key || "")];
    if (!q || q.state !== "open") continue;
    const p = q.jev && q.jev.p;
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    out[f.id || core.findingId(f)] = { p, n: Math.min(Math.max(Number(q.n) || 1, 1), jev.ROWS_PER_ITEM) };
  }
  return out;
}

/** Every askable item, before ranking: instance items from the brief, pattern
 *  items from the board. */
export function items({ rec = null, rows = core.get("findings", []) } = {}) {
  const out = [];
  if (rec) {
    const about = briefId(rec), fp = scopeFingerprint(rec);
    for (const u of unsettled(rec)) {
      out.push({ key: gs.instanceKey(about, u.id), shape: "instance", about, fingerprint: fp, detector: "brief", id: u.id,
        text: `${u.id}: ${u.why}`, severity: AMBIGUITY_SEVERITY[u.weight] || "low", precision: "heuristic", est_tokens: Number(rec.projected) || 0, n: 1, reaches: 1, brief: rec.path || "" });
    }
  }
  for (const p of patterns(contested(rows))) out.push({ key: p.key, shape: "pattern", detector: p.detector, text: p.text, severity: p.severity, precision: "heuristic", est_tokens: p.est_tokens, n: p.n, reaches: p.reaches, paths: p.paths,
    rows: p.rows.slice(0, jev.ROWS_PER_ITEM).map((r) => ({ path: r.path || "", key: r.key || "" })) });   // where Jev reads its window; stripped before the queue is written
  return out;
}

/** The documented total order when no interpreter answers: severity, then
 *  rework cost, then key. Suppression is the same as the expert's: a live
 *  instance answer, or a pattern answer that covers the item. */
export function fallbackRank(list, answers = gs.answers()) {
  const live = (it) => Boolean(gs.lookup({ instance: it.shape === "instance" ? it.key : "", pattern: it.shape === "pattern" ? it.key : (it.pattern || ""), fingerprint: it.fingerprint || "" }, answers));
  const uncertainty = (it) => (it.jev && typeof it.jev.uncertainty === "number" ? it.jev.uncertainty : 1 - (PRIOR[it.precision] ?? PRIOR.heuristic));
  const asked = list.filter((it) => !live(it)).map((it) => ({ ...it, ev: Math.round((uncertainty(it) * (SEV[it.severity] || 1) * Math.max(it.n || 1, 1) * 100000 / Math.max(Number(it.est_tokens) || 0, ASK_TOKENS)) * 100) / 100 }));
  // With a Jev opinion on any item the per-item value is a measurement and
  // leads; without one it is severity by another name, so the documented
  // order stands unchanged.
  const measured = asked.some((it) => it.jev);
  asked.sort((a, b) => (measured ? b.ev - a.ev : 0) || (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || (Number(b.est_tokens) || 0) - (Number(a.est_tokens) || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { asked, dropped: list.filter(live).map((it) => ({ key: it.key, why: "answered" })), via: "fallback" };
}

/** Order the queue, expert first. `opinions` is Jev's word on the pattern
 *  items, fetched here unless the caller brought its own; null when Jev is off
 *  or did not answer, and then nothing about the order changes. */
export function rank(list, { answers = gs.answers(), priors = priorsOf(), opinions = jev.opinions(list) } = {}) {
  const items = opinions ? list.map((it) => (opinions.by[it.key] ? { ...it, jev: opinions.by[it.key] } : it)) : list;
  const j = opinions ? { asked: opinions.asked, answered: opinions.answered, tokens: opinions.tokens, ms: opinions.ms } : null;
  const r = expert.call("grapple", { op: "rank", items, answers, ask_tokens: ASK_TOKENS, priors: priors.by || {} });
  if (r && Array.isArray(r.asked)) return { ...r, via: "expert", priors: priors.via, jev: j };
  return { ...fallbackRank(items, answers), priors: "none", jev: j };
}

/** Emit the queue for this brief. Pattern questions first when the ranks tie,
 *  because one of them settles dozens. `cap` is per session; the rest stays on
 *  disk, ordered, for `bb grapple ask` to print.
 *
 *  Nothing here injects anything, in any phase: the queue is a file, and the
 *  event is always `would_ask`. An `asked` event is written by whatever puts a
 *  question in front of the agent, and until that exists the log must not say
 *  it happened. An expired-unanswered question is dropped from the head, not
 *  re-asked: `reopen` is the deliberate act that brings one back. */
export function emit({ rec = null, rows = core.get("findings", []), cap = 2, session = "" } = {}) {
  const ranked = rank(items({ rec, rows }));
  const stored = gs.questions();
  const expired = ranked.asked.filter((it) => stored[it.key]?.state === "expired-unanswered");
  const asked = ranked.asked.filter((it) => stored[it.key]?.state !== "expired-unanswered");
  const put = [];
  for (const { rows: _rows, ...it } of asked) put.push(gs.putQuestion({ ...it, ev: it.ev }));
  const head = asked.slice(0, cap);
  if (ranked.jev) gs.record("jev", { session_id: session, ...ranked.jev });
  gs.record("would_ask", { session_id: session, keys: head.map((q) => q.key), of: asked.length, via: ranked.via, jev: ranked.jev ? ranked.jev.answered : 0 });
  return { asked, head, dropped: [...ranked.dropped, ...expired.map((it) => ({ key: it.key, why: "expired-unanswered" }))], via: ranked.via, put: put.length };
}

/** The labels a pattern answer becomes on rows it was not asked about.
 *  Distance is one minus the fitted similarity (files first, title after),
 *  never a fourth scorer; the decay is the expert's `propagate`, and the
 *  fallback is the same linear blend toward the method's prior. */
export function propagate(a, rows, { detector = "" } = {}) {
  const seed = rows.find((r) => a.paths && a.paths.includes(r.path)) || rows[0];
  const withDistance = rows.filter((r) => !detector || r.detector === detector).map((r) => ({
    id: r.id || core.findingId(r), path: r.path || r.key, detector: r.detector, precision: r.precision || "heuristic", severity: r.severity,
    distance: seed ? Math.round((1 - similarity({ files: [seed.path], title: seed.title }, { files: [r.path], title: r.title })) * 1000) / 1000 : 1,
  }));
  const r = expert.call("grapple", { op: "propagate", answer: { value: a.value, confidence: Number(a.confidence) || 0.9 }, rows: withDistance });
  if (r && Array.isArray(r.labels)) return { labels: r.labels, via: "expert" };
  const prior = PRIOR.heuristic;
  return { labels: withDistance.map((r) => ({ id: r.id, path: r.path, value: a.value, confidence: Math.round(((Number(a.confidence) || 0.9) * (1 - r.distance) + prior * r.distance) * 10000) / 10000, distance: r.distance })), via: "fallback" };
}

export const LABELS = "grapple-labels";      // .bundlebox/var/grapple-labels.json: what answers settled, for the harvest

/** A pattern question asks "is this deliberate?". Yes means the rows are not
 *  defects, which is also an OVERRIDE of the detector for that shape — the
 *  event the retire path in `promote` counts. No means the detector held. */
const labelOf = (value) => (String(value).toLowerCase() === "yes" ? "not-a-defect" : "defect");

/** Record an answer and what it settled. Every answer is a label, and the
 *  labels are stored where the harvest reads them, because a queue that
 *  closes handoffs and produces no corpus has done half its job. */
export function answer(key, { value, reason = "", by = "operator", rows = core.get("findings", []) } = {}) {
  const q = gs.questions()[key];
  if (!q) return { error: `no question ${key}` };
  const rec = gs.answer({ shape: q.shape, key, fingerprint: q.fingerprint || "", value, reason, by, question: String(q.text || "").slice(0, 200), detector: q.detector || "" });
  gs.setState(key, "answered", { answered_at: rec.at, value, reason });
  let labels = [];
  if (q.shape === "pattern") {
    const mine = contested(rows).filter((f) => f.detector === q.detector);
    const p = propagate({ value, confidence: 0.9, paths: q.paths || [] }, mine, { detector: q.detector });
    labels = p.labels.map((l) => ({ id: l.id, detector: q.detector, path: l.path, label: labelOf(value), source: `answer:${key}`, confidence: l.confidence, distance: l.distance }));
    gs.record("labelled", { key, detector: q.detector, n: labels.length, via: p.via, source: "answer" });
    gs.record(labelOf(value) === "not-a-defect" ? "override" : "held", { detector: q.detector, key, reaches: labels.length });
  } else {
    labels = [{ id: key, detector: "brief", path: q.brief || "", label: `brief:${q.id || ""}=${value}`, source: `answer:${key}`, confidence: 1, distance: 0 }];
    gs.record("labelled", { key, detector: "brief", n: 1, via: "answer", source: "answer" });
  }
  core.update(LABELS, (d) => {
    const cur = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    const kept = (cur.labels || []).filter((l) => l.source !== `answer:${key}`);   // re-answered: the old labels go
    return { ...cur, at: rec.at, labels: [...kept, ...labels] };
  }, {});
  return { answer: rec, labels, reaches: labels.length };
}

/** The labels answers produced, as the harvest reads them. */
export { answeredLabels as answered } from "./harvest.js";
