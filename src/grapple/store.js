// store.js — grapple's memory: an append-only event log and an answer store.
//
// Two key shapes, and the reason one is not enough. An INSTANCE answer is
// about one place — one unsettled item of one brief, or one finding row — and
// is keyed like `findingId`: a hash of what it is about, plus the fingerprint
// of the code it was answered against. When the fingerprint moves the answer
// expires and the question is askable again. A PATTERN answer is about a
// shape — "a swallowed error in a hook handler is deliberate" — and carries no
// path, so it reaches every row of that shape and survives the file it was
// first seen in. A question declares which one it is asking under.
//
// State lives under `.bundlebox/var/` through the shared store, because an
// answer somebody typed is not a derived artefact. `.bundlebox/out/grapple/`
// is the readable mirror, written by `mirror()` and never read back.
import fs from "node:fs";
import path from "node:path";
import { VAR, OUT, ensureDirs } from "../core/paths.js";
import { sha1, now } from "../core/util.js";
import * as store from "../core/store.js";

export const EVENTS = "grapple-events";     // .bundlebox/var/grapple-events.jsonl
export const ANSWERS = "grapple-answers";   // .bundlebox/var/grapple-answers.json
export const QUESTIONS = "grapple-questions";
export const DIR = () => path.join(OUT, "grapple");
export const MAX_EVENTS = 20000;

export const SHAPES = ["instance", "pattern"];
export const STATES = ["open", "answered", "expired-unanswered"];
export const PHASES = ["off", "observe", "enforce"];

/** The grapple section of the config, normalised. The defaults live in
 *  `core/config.js` and `load()` has already merged them; this only refuses a
 *  phase that is not one of the three and folds `enabled: false` into `off`. */
export function settings(cfg) {
  const g = { ...(cfg && cfg.grapple && typeof cfg.grapple === "object" ? cfg.grapple : {}) };
  if (!PHASES.includes(g.phase)) g.phase = "observe";
  if (g.enabled === false) g.phase = "off";
  return g;
}

/** What a pattern question is about, with the parts that differ per file
 *  removed: a path, a line number, a count. Two rows of the same detector with
 *  the same normalised title are the same question. */
export function normaliseShape(s) {
  return String(s || "").toLowerCase()
    .replace(/[a-z0-9_./-]+\.[a-z]{1,5}(:\d+)?/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ").trim();
}

export const instanceKey = (about, key) => sha1(`${about}|${key}`).slice(0, 12);
export const patternKey = (detector, shape) => sha1(`${detector}|${normaliseShape(shape)}`).slice(0, 12);

// ── events ──────────────────────────────────────────────────────────────────

/** One row per thing grapple saw or did. `kind` is the only required field;
 *  the rest is whatever the detector had. Never throws: an event log that can
 *  break a hook is a hook that stops being installed. */
export function record(kind, fields = {}) {
  try { return store.append(EVENTS, { kind: String(kind), ...fields }); } catch { return null; }  // never throws, see above
}
export function events({ limit = 0, kind = "", session = "" } = {}) {
  let rows = store.rows(EVENTS, { limit });
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (session) rows = rows.filter((r) => String(r.session_id || "") === session);
  return rows;
}
export function rotate({ max = MAX_EVENTS } = {}) {
  const rows = store.rows(EVENTS);
  if (rows.length <= max) return rows.length;
  const keep = rows.slice(-Math.floor(max / 2));
  ensureDirs();
  fs.writeFileSync(path.join(VAR, `${EVENTS}.jsonl`), keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return keep.length;
}

// ── answers ─────────────────────────────────────────────────────────────────

const doc = () => { const d = store.get(ANSWERS, {}); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; };
export const answers = () => doc();

/** Record one answer under its declared shape. Same key, same fingerprint:
 *  one record, overwritten, never two. */
export function answer({ shape, key, fingerprint = "", value, reason = "", by = "operator", question = "", detector = "" }) {
  if (!SHAPES.includes(shape)) throw new Error(`answer shape must be one of ${SHAPES.join(", ")}`);
  const rec = { shape, key, fingerprint: shape === "instance" ? String(fingerprint || "") : "", value, reason: String(reason || ""), by, question, detector, at: now() };
  store.update(ANSWERS, (d) => ({ ...(d && typeof d === "object" && !Array.isArray(d) ? d : {}), [key]: rec }), {});
  record("answered", { shape, key, value, reason: rec.reason, question, detector });
  return rec;
}

/** The answer that reaches a question, or null.
 *
 *  An instance answer is live only under the fingerprint it was given against.
 *  A pattern answer has no fingerprint to move and stands until it is
 *  overridden. Instance first, because a person who answered THIS row said
 *  something more specific than the shape. */
export function lookup({ instance = "", pattern = "", fingerprint = "" } = {}, d = doc()) {
  if (instance && d[instance] && d[instance].shape === "instance") {
    const a = d[instance];
    if (!fingerprint || a.fingerprint === fingerprint) return { ...a, via: "instance" };
  }
  if (pattern && d[pattern] && d[pattern].shape === "pattern") return { ...d[pattern], via: "pattern" };
  return null;
}

/** Instance answers whose fingerprint no longer matches what the caller sees.
 *  Reported, not deleted: the record is the reason the question comes back. */
export function stale(current = {}, d = doc()) {
  return Object.values(d).filter((a) => a.shape === "instance" && current[a.key] !== undefined && current[a.key] !== a.fingerprint);
}

// ── questions ───────────────────────────────────────────────────────────────

const qdoc = () => { const d = store.get(QUESTIONS, {}); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; };
export const questions = () => qdoc();

/** Add or refresh a question. Keyed by the answer key it asks under, so the
 *  same unsettled item across sessions is one row.
 *
 *  An answered row is left alone while its answer is live. When the caller
 *  brings a different fingerprint the answer has expired, and the row goes
 *  back to open under the new fingerprint with a fresh `asked_at`: the same
 *  question, asked again against different code. An expired-unanswered row
 *  stays expired; `reopen()` is the only way back, so the state means what it
 *  says across every observe pass in between. */
export function putQuestion(q) {
  const key = String(q.key);
  return store.update(QUESTIONS, (d) => {
    const cur = (d && typeof d === "object" && !Array.isArray(d) ? d : {});
    const old = cur[key];
    if (old && old.state === "expired-unanswered") return cur;
    if (old && old.state === "answered") {
      const moved = old.shape === "instance" && q.fingerprint && q.fingerprint !== old.fingerprint;
      if (!moved) return cur;
      return { ...cur, [key]: { ...old, ...q, key, state: "open", asked_at: now(), seen: (old.seen || 0) + 1, answered_at: undefined, value: undefined, reason: undefined, reasked_from: old.fingerprint } };
    }
    return { ...cur, [key]: { ...(old || {}), ...q, key, state: "open", asked_at: old?.asked_at || now(), seen: (old?.seen || 0) + 1 } };
  }, {})[key];
}

/** Ask an expired question again: open, with a fresh clock. */
export function reopen(key) {
  const q = questions()[key];
  if (!q || q.state !== "expired-unanswered") return null;
  record("reopened", { key });
  return setState(key, "open", { asked_at: now(), expired_at: undefined, seen: (q.seen || 0) + 1 });
}

export function setState(key, state, fields = {}) {
  if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
  return store.update(QUESTIONS, (d) => {
    const cur = (d && typeof d === "object" && !Array.isArray(d) ? d : {});
    if (!cur[key]) return cur;
    return { ...cur, [key]: { ...cur[key], ...fields, state } };
  }, {})[key];
}

/** Open questions past their TTL move to `expired-unanswered`, a state that is
 *  never `answered`: review has to tell "nobody said" from "somebody said no",
 *  and one field that means both would be worse than the queue never expiring. */
export function expire({ ttlHours = 72, at = Date.now() } = {}) {
  const out = [];
  store.update(QUESTIONS, (d) => {
    const cur = (d && typeof d === "object" && !Array.isArray(d) ? d : {});
    for (const [k, q] of Object.entries(cur)) {
      if (q.state !== "open") continue;
      const age = (at - Date.parse(q.asked_at || 0)) / 3600000;
      if (Number.isFinite(age) && age > ttlHours) { cur[k] = { ...q, state: "expired-unanswered", expired_at: new Date(at).toISOString() }; out.push(k); }
    }
    return { ...cur };
  }, {});
  for (const k of out) record("expired", { key: k });
  return out;
}

// ── the readable mirror ─────────────────────────────────────────────────────

const writeText = (name, text) => { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(path.join(DIR(), name), text); };
const writeJsonOut = (name, obj) => writeText(name, JSON.stringify(obj, null, 2) + "\n");

/** Plain files: a question is readable without bundlebox open. */
export function mirror({ status = null } = {}) {
  const qs = Object.values(qdoc()).sort((a, b) => (b.ev || 0) - (a.ev || 0));
  const as = doc();
  writeJsonOut("questions.json", qs);
  writeJsonOut("answers.json", as);
  const L = ["# grapple — the handoff queue", "", `${qs.filter((q) => q.state === "open").length} open, ${qs.filter((q) => q.state === "answered").length} answered, ${qs.filter((q) => q.state === "expired-unanswered").length} expired unanswered.`, ""];
  L.push("| state | shape | key | question | reaches |", "|---|---|---|---|---|");
  for (const q of qs) L.push(`| ${q.state} | ${q.shape} | \`${q.key}\` | ${String(q.text || "").replace(/\|/g, "\\|").slice(0, 160)} | ${q.reaches || 1} |`);
  L.push("", "Answer one: `bb grapple ask --answer <key> --value yes|no --reason \"...\"`.", "");
  writeText("questions.md", L.join("\n"));
  if (status) writeJsonOut("status.json", status);
  return path.join(DIR(), "questions.md");
}
export { writeText, writeJsonOut };
