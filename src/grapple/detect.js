// detect.js — the handoff detectors. Every one is a set operation, a counter or
// a hash comparison over artefacts that already exist. None calls a model.
//
//   collision   two lane scope lists that share a file: a merge somebody pays for
//   writeVerdict a write outside the brief's scope list, at the one moment the
//               agent has committed nothing
//   drift       repeated low-information calls, turns since the last edit, scope
//               delta against the brief — counters, scored by the expert when it
//               is there and reported raw when it is not
//   noProgress  the drift score's yes/no
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel } from "../core/paths.js";
import { sha1 } from "../core/util.js";
import * as brief from "../wire/brief.js";
import * as gs from "./store.js";

// ── agreement: scope intersection at route time ─────────────────────────────

/** The files two scope lists share. A set intersection: zero cost, zero calls. */
export function collision(a, b) {
  const A = new Set((a || []).map((f) => rel(String(f))));
  const out = [];
  for (const f of new Set((b || []).map((x) => rel(String(x))))) if (A.has(f)) out.push(f);
  return out.sort();
}

/** Every active brief record, one per session. */
export function lanes({ maxAgeMin = 45 } = {}) {
  const out = [];
  const files = [brief.GLOBAL()];
  try { for (const n of fs.readdirSync(brief.DIR())) if (n.endsWith(".json")) files.push(path.join(brief.DIR(), n)); } catch { /* no per-session dir yet */ }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!r || r.v !== 1 || !Array.isArray(r.scope)) continue;
      const age = (Date.now() - Date.parse(r.at || 0)) / 60000;
      if (!Number.isFinite(age) || age > maxAgeMin) continue;
      out.push(r);
    } catch { /* one record */ }
  }
  return out;
}

/** Pairs of lanes that would merge into each other. */
export function collisions(recs = lanes()) {
  const out = [];
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const shared = collision(recs[i].scope, recs[j].scope);
    if (shared.length) out.push({ a: recs[i].session_id || "cli", b: recs[j].session_id || "cli", shared, problems: [recs[i].problem, recs[j].problem].map((p) => String(p || "").slice(0, 80)) });
  }
  return out;
}

// ── the scope guard ─────────────────────────────────────────────────────────

/** Where a write may land under a brief.
 *
 *  null means "nothing to say" — no brief, or the file is in scope. A file the
 *  brief CUT for budget is `ask`: the brief already said to name it first. A
 *  file in neither list is `deny`, with the scope quoted so the fix is one
 *  line away. Files under `.bundlebox/` and the ledger are never fenced: the
 *  box writes its own artefacts under every brief. */
export function writeVerdict(rec, filePath) {
  if (!rec || !Array.isArray(rec.scope) || !rec.scope.length || !filePath) return null;
  const f = rel(String(filePath));
  if (f.startsWith("..") || path.isAbsolute(f)) return null;         // outside the workspace is not this guard's question
  if (f === ".bundlebox" || f.startsWith(".bundlebox/") || f.startsWith(".bundlebox\\") || f === "GATES.md") return null;
  const scope = rec.scope.map((s) => rel(String(s)));
  if (scope.includes(f)) return null;
  const isTest = /(^|\/)test\/|\.test\.[jt]sx?$|_test\.(py|go|rs)$|(^|\/)tests?\//.test(f);
  if (isTest) return null;                                             // a gate for the change is part of the change
  const shown = scope.slice(0, 8).join(", ") + (scope.length > 8 ? `, +${scope.length - 8}` : "");
  if ((rec.cut || []).map((s) => rel(String(s))).includes(f)) {
    return { permissionDecision: "ask", permissionDecisionReason: `bundlebox grapple: ${f} was cut from the pinpoint scope to make the unit fit one window. The brief says to name it and why before touching it. Scope: ${shown}.` };
  }
  return { permissionDecision: "deny", permissionDecisionReason: `bundlebox grapple: ${f} is outside the brief's scope (${shown}). If the change belongs there, say which file and why in one line, then \`bb pinpoint "${String(rec.problem || "").slice(0, 60).replace(/"/g, "'")}" --files ${f}\` re-budgets the unit with it in scope.` };
}

// ── drift: counters over what the session did ───────────────────────────────

/** A tool call reduced to what a counter can read: which tool, which file,
 *  whether it edited, and a hash of the input so a repeat is a repeat. */
export function turnOf(payload) {
  const tool = String(payload?.tool_name || "");
  const inp = payload?.tool_input || {};
  const file = inp.file_path || inp.path || inp.notebook_path || "";
  const edit = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool);
  const read = /^(Read|Grep|Glob|Bash)$/.test(tool);
  const key = tool === "Bash" ? String(inp.command || "").slice(0, 200) : `${file}:${inp.offset || 0}:${inp.limit || 0}:${inp.pattern || ""}`;
  return { tool, file: file ? rel(String(file)) : "", edit, read, hash: sha1(`${tool}|${key}`).slice(0, 10) };
}

/** What the hook records on every tool call: sixty bytes, no decision. The
 *  log is rotated on a one-in-a-hundred draw, the same way lathe's shapes
 *  are, so a month of sessions does not become a file every observe pass
 *  parses whole. */
export function observeTool(payload) {
  const t = turnOf(payload);
  if (!t.tool) return null;
  const r = gs.record("tool", { session_id: String(payload?.session_id || ""), ...t });
  if (r && Math.random() < 0.01) gs.rotate();
  return r;
}

/** The raw counters. Every one is a fact about the window; the score is the
 *  expert's business, and `fallback` is what stands in when there is none. */
export function counters(turns, scope = []) {
  const S = new Set((scope || []).map((s) => rel(String(s))));
  const seen = new Map();
  let repeats = 0, sinceEdit = 0, edits = 0, outOfScope = 0, touched = new Set();
  for (const t of turns) {
    const n = (seen.get(t.hash) || 0) + 1;
    seen.set(t.hash, n);
    if (n > 1) repeats += 1;
    if (t.edit) { edits += 1; sinceEdit = 0; } else sinceEdit += 1;
    if (t.file) { touched.add(t.file); if (S.size && !S.has(t.file)) outOfScope += 1; }
  }
  return { turns: turns.length, repeats, since_edit: sinceEdit, edits, out_of_scope: outOfScope, files: touched.size, scope: S.size };
}

/** The documented fallback when no interpreter answers: a fraction of the
 *  three counters that fired, each against a fixed bar, and the signature is
 *  the names of the ones that fired. The expert's `drift()` returns the same
 *  shape from a fitted score; the caller cannot tell them apart except by
 *  `via`. */
export const BARS = { repeats: 3, since_edit: 12, out_of_scope: 4 };
export function fallbackDrift(c) {
  const fired = Object.keys(BARS).filter((k) => (c[k] || 0) >= BARS[k]).sort();
  return { score: Math.round((fired.length / Object.keys(BARS).length) * 100) / 100, signature: fired.join("+") || "none", counters: c, via: "fallback" };
}

export const noProgress = (d, at = 0.67) => Boolean(d && d.score >= at);

/** The window `drift()` scores: the session's turns since the brief. */
export function windowOf(events, { scope = [], session = "" } = {}) {
  const turns = events.filter((e) => e.kind === "tool" && (!session || String(e.session_id || "") === session))
    .map((e) => ({ tool: e.tool, file: e.file || "", edit: !!e.edit, read: !!e.read, hash: e.hash }));
  return { turns, scope: (scope || []).map((s) => rel(String(s))) };
}
export const workspace = () => ROOT;
