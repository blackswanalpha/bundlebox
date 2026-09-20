// brief.js — the ACTIVE pinpoint brief, and the three questions the PreToolUse
// hooks ask it.
//
// `bb uptake` measures the gap this closes. Over 15 sessions on this workspace:
// the MCP tools fired in 0, pinpoint in 3 of 13 sessions that opened five or
// more distinct files, the snapgen tables in 5 of 15 that ran a search. Sessions
// opened 30 to 598 files each. Everything bb wired in front of the agent was
// ADVISORY, and an advisory surface is one the model may decline on a hunch.
//
// So this file holds two changes of kind:
//
//   1. The brief is no longer something the session decides to ask for. The
//      UserPromptSubmit hook runs pinpoint itself (0.47s measured on this tree,
//      against a 15s hook budget) and records the result HERE.
//   2. A read or a search the recorded brief already answers is DENIED, and the
//      answer is handed back in the denial reason. The work is done once, by
//      the side that does it for nothing.
//
// Two rules keep the denials from being hostile:
//
//   - A file in SCOPE is never fully blocked. Claude Code requires a successful
//     Read of a file before it will Edit it, so blocking scope files blocks the
//     change itself. A whole-file read of a scope file whose region is quoted
//     is denied and the RANGE is served; the ranged read then succeeds, unlocks
//     the edit, and costs the quote instead of the file.
//   - Nothing here builds anything. Every answer comes from an artefact already
//     on disk. A handler that fires on every tool call cannot afford a compiler,
//     and `.bundlebox/out` staleness is the snapgen fingerprint's problem.
import fs from "node:fs";
import path from "node:path";
import { VAR, OUT, abs, rel, ensureDirs } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { now, human, shellSegments } from "../core/util.js";
import { file as estimateFile } from "../tokens/estimate.js";
import { clean } from "../slop/index.js";
import * as arc from "../arc/read.js";

// One slot per session, not one slot per workspace.
//
// The first version wrote a single `brief.json`, which is wrong the moment two
// sessions share a checkout — and that is the normal case here, not the edge
// one: `bb uptake` counts fifteen sessions on this tree, and two others were
// running while this paragraph was written. Session B's prompt would overwrite
// session A's brief, A's guards would then see a record belonging to B, refuse
// to answer from it, and silently fall back to advisory. Nothing broke; the
// whole benefit just quietly stopped arriving.
export const DIR = () => path.join(VAR, "brief");
export const GLOBAL = () => path.join(VAR, "brief.json");
const safe = (id) => String(id).replace(/[^\w.-]/g, "").slice(0, 64);
export const PATH = (sessionId = "") => (sessionId ? path.join(DIR(), `${safe(sessionId)}.json`) : GLOBAL());

/** How much of one quoted region the denial reason may carry. A reason the
 *  harness truncates is a reason that served half a function. */
export const QUOTE_CHARS = 2600;
/** Rows of symbol-table answer one denied search gets back. */
export const SEARCH_ROWS = 14;

// ── the preamble every brief opens with ─────────────────────────────────────
//
// One string, byte-identical across tasks and across surfaces, emitted FIRST.
// Measured on 2026-09-18: two pinpoint briefs for different tasks shared 1,594
// of their 3,350 characters, and every shared byte sat AFTER the task-specific
// sections, so no run could ever cache them. Two genesis packs for unrelated
// surfaces were 90% identical. A prefix that does not change bills at the
// cache-read rate; the same bytes after the varying part are prefilled again
// on every run and land on time-to-first-token.
//
// Imperative, with the reasons left out. The packed arm emitted 34% more output
// per turn than the bare arm, and the lines it was acknowledging were the ones
// that explained themselves. The reasons live here, where nobody is billed for
// them.
export const PREAMBLE = [
  "Derived locally from artefacts on disk at 0 model tokens. Do not re-derive or search for anything stated here.",
  "",
  "- Edit only the files under Scope.",
  "- Read a region by range, never a file whole.",
  "- Before reading a file outside Scope, say which and why, in one line.",
  "- Before the gate, one file's tests is the ceiling.",
  "- No `git stash`, no `git checkout` on a shared checkout, no `--no-verify`, no commit outside Scope.",
  "- Do this task only. No cleanup, refactor or docs.",
  "- Report what changed and why in under 120 words.",
].join("\n");

// ── the record ──────────────────────────────────────────────────────────────
//
// Not the brief: a projection of it. The brief on disk is the document a person
// reads; this is the index the guards query, and it is re-read on every tool
// call, so it holds line ranges and quotes and nothing else.

/** A pinpoint result -> the record the guards query. */
export function record(b, { sessionId = "", briefPath = "" } = {}) {
  return {
    v: 1,
    at: now(),
    session_id: String(sessionId || ""),
    problem: String(b.problem || "").slice(0, 400),
    path: briefPath || b.path || "",
    verdict: b.verdict || "",
    projected: b.projected || 0,
    scope: (b.scope || []).map(String),
    cut: (b.cut || []).map(String),
    candidates: (b.candidates || []).map((c) => String(c.file || c)),
    symbols: (b.symbols || []).slice(0, 24).map((h) => ({ file: String(h.file), symbol: String(h.symbol), line: Number(h.line) || 0 })),
    grep: (b.grep || []).slice(0, 8).map((h) => ({ file: String(h.file), line: Number(h.line) || 0, text: String(h.text || "").slice(0, 120) })),
    anchors: (b.anchors || []).slice(0, 10).map((a) => ({
      path: String(a.path), symbol: String(a.symbol || ""), line_start: Number(a.line_start) || 0, line_end: Number(a.line_end) || 0,
      tokens: Number(a.tokens) || 0, text: String(a.text || "").slice(0, 6000),
    })),
    gates: b.gates || {},
    tables: (b.tables || []).map(String),
    // The change the brief carries, when the statement spelled one out and it
    // matched exactly one place. The band names it; the diff stays in the brief.
    proposals: (b.proposals || []).slice(0, 4).map((p) => ({ file: String(p.file), line: Number(p.line) || 0, from: String(p.from).slice(0, 80), to: String(p.to).slice(0, 80) })),
    // Mutated by the guards, never by the builder: what has already been served
    // or refused under this brief. A duplicate is the cheapest waste to prove.
    seen: { reads: {}, searches: {} },
  };
}

// ── the log ─────────────────────────────────────────────────────────────────
//
// The record above is ONE per session, because the guards look it up by session
// id and a second one under the same key answers nothing. That makes the active
// record the wrong thing to learn from: a session that locates four tasks keeps
// only the fourth, and the three it overwrote are the ones worth reading — a
// scope that had to be located again is a scope that was wrong.
//
// So: one line per brief, appended, never overwritten. It carries what the
// scope WAS and nothing the guards need, because it is read once by `bb echos`
// and never on a tool call. Appended from `activate` so the three call sites
// cannot each remember differently.
export const LOG = () => path.join(DIR(), "log.jsonl");
const MAX_LOG = 4000;

/** The logged briefs, oldest first. A torn line is one brief, not the file. */
export function logged({ limit = MAX_LOG } = {}) {
  let text;
  try { text = fs.readFileSync(LOG(), "utf8"); } catch { return []; }
  const out = [];
  for (const l of text.split("\n").filter(Boolean).slice(-limit)) {
    try { const r = JSON.parse(l); if (r && Array.isArray(r.scope)) out.push(r); } catch { /* one brief */ }
  }
  return out;
}

/** Drop the oldest half past the cap, from the same call that appends. */
export function rotateLog({ max = MAX_LOG } = {}) {
  let text;
  try { text = fs.readFileSync(LOG(), "utf8"); } catch { return 0; }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= max) return 0;
  const keep = lines.slice(Math.floor(lines.length / 2));
  try { fs.writeFileSync(LOG(), keep.join("\n") + "\n"); return lines.length - keep.length; } catch { return 0; }
}

/** Never throws and never blocks activation: a brief that failed to log is a
 *  sample lost, and refusing to activate over it would cost the session the
 *  brief itself. */
export function log(rec) {
  try {
    if (!(rec.scope || []).length) return false;   // nothing to score an aim against
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(LOG(), JSON.stringify({
      at: rec.at, session_id: rec.session_id, problem: rec.problem, path: rec.path,
      verdict: rec.verdict, projected: rec.projected, scope: rec.scope, cut: rec.cut,
      // The candidates too, because the locate is scored against them: a file
      // named below the scope line and then edited is the ranker having been
      // right under a budget that was wrong, and dropping the list here would
      // make that indistinguishable from never having found the file at all.
      candidates: rec.candidates,
    }) + "\n");
    rotateLog({});
    return true;
  } catch { return false; }
}

export function activate(rec) {
  try {
    ensureDirs();
    const p = PATH(rec.session_id || "");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + ".tmp" + process.pid, JSON.stringify(rec));
    fs.renameSync(p + ".tmp" + process.pid, p);
    log(rec);
    return true;
  } catch { return false; }
}

const readRec = (p) => { try { const r = JSON.parse(fs.readFileSync(p, "utf8")); return r && r.v === 1 ? r : null; } catch { return null; } };
const fresh = (rec, maxAgeMin) => {
  const age = (Date.now() - Date.parse(rec.at || 0)) / 60000;
  return Number.isFinite(age) && age <= maxAgeMin;
};

/** The active record, or null. A brief older than `maxAgeMin`, or one belonging
 *  to another session, answers nothing: the guards would be quoting a region
 *  located for a different task, which is the exact mistake the janitor's
 *  stale guard exists to prevent. */
export function current({ maxAgeMin = 45, sessionId = "" } = {}) {
  if (sessionId) {
    const own = readRec(PATH(sessionId));
    if (own && fresh(own, maxAgeMin)) return own;
    // A record with no session id was written by the command line — `bb
    // pinpoint next`, a gap handed over deliberately — and belongs to whoever
    // picks it up. One with somebody else's id does not.
    const g = readRec(GLOBAL());
    return g && !g.session_id && fresh(g, maxAgeMin) ? g : null;
  }
  // No session id: the caller is the command line, and what it means by "the
  // active brief" is the newest one anybody is working on.
  const all = [GLOBAL()];
  try { for (const n of fs.readdirSync(DIR())) if (n.endsWith(".json")) all.push(path.join(DIR(), n)); } catch { /* no per-session dir yet */ }
  const best = all.map(readRec).filter((r) => r && fresh(r, maxAgeMin)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return best || null;
}

/** Records for sessions that have ended. The hook cannot know which those are,
 *  so age is the only honest signal. */
export function sweep({ maxAgeMin = 24 * 60 } = {}) {
  let gone = 0;
  try {
    for (const n of fs.readdirSync(DIR())) {
      if (!n.endsWith(".json")) continue;
      const p = path.join(DIR(), n);
      const r = readRec(p);
      if (r && fresh(r, maxAgeMin)) continue;
      try { fs.unlinkSync(p); gone++; } catch { /* next time */ }
    }
  } catch { /* nothing to sweep */ }
  return gone;
}

const save = (rec) => { try { fs.writeFileSync(PATH(rec.session_id || ""), JSON.stringify(rec)); } catch { /* a lost tally costs one duplicate */ } };
const norm = (p) => { try { return rel(abs(String(p))); } catch { return String(p); } };

// ── what goes back into the window ──────────────────────────────────────────

/** The band the UserPromptSubmit hook injects: the MAP, not the regions.
 *
 *  The regions are the expensive part and the guards serve them on demand, at
 *  the moment a read proves the session wants one. Injecting them here would
 *  pay for every region on every task prompt, including the ones the session
 *  never opens. */
export function band(rec) {
  const L = [`bundlebox: \`bb pinpoint\` already ran for this prompt (locally, 0 model tokens). The task is located below — do not search for it.`, ""];
  L.push("located:");
  const shown = new Set();
  for (const h of rec.symbols.slice(0, 10)) { const k = `${h.file}:${h.line}`; if (shown.has(k)) continue; shown.add(k); L.push(`  ${h.file}:${h.line} — ${h.symbol}`); }
  for (const h of rec.grep.slice(0, 4)) { const k = `${h.file}:${h.line}`; if (shown.has(k)) continue; shown.add(k); L.push(`  ${h.file}:${h.line} — ${h.text}`); }
  if (!shown.size) L.push("  nothing in the symbol tables matched; the scope below is the best path match");
  if (rec.anchors.length) {
    L.push("", `${rec.anchors.length} region${rec.anchors.length === 1 ? "" : "s"} are already quoted and will be handed to you when you open the file — you do not need to read the file to get them:`);
    for (const a of rec.anchors.slice(0, 8)) L.push(`  ${a.path}:${a.line_start}-${a.line_end}${a.symbol ? ` (${a.symbol})` : ""}`);
  }
  L.push("", "scope — the only files to edit:");
  for (const f of rec.scope) L.push(`  ${f}`);
  if (rec.cut.length) L.push(`opening these needs a reason first: ${rec.cut.join(", ")}`);
  if (rec.candidates.length) L.push(`not in scope, use only if the scope does not hold it: ${rec.candidates.slice(0, 6).join(", ")}`);
  for (const p of rec.proposals || []) L.push("", `proposed change, as a diff in the brief: ${p.file}:${p.line} — \`${p.from}\` → \`${p.to}\`. Apply it, then run the gate.`);
  const g = rec.gates || {};
  if (g.quick || g.full) L.push("", `done when: ${[g.quick, g.full !== g.quick ? g.full : ""].filter(Boolean).join("  /  ")}`);
  L.push("", `full brief (evidence, traps, guidelines, what it does not settle): ${rec.path}`);
  return clean(L.join("\n"));
}

// ── the read guard ──────────────────────────────────────────────────────────

const overlaps = (a, from, to) => a.line_start <= to && a.line_end >= from;

/** Does the brief already answer this read?
 *
 *  Returns a PreToolUse decision, or null to say nothing and let the read
 *  through. `capacity` is the working window; the share below which a whole
 *  file is too cheap to argue about. */
export function readVerdict(rec, filePath, { offset = 0, limit = 0, capacity = 0, minShare = 0.02 } = {}) {
  if (!rec || !filePath) return null;
  const f = norm(filePath);
  const key = `${f}|${offset}|${limit}`;
  const dup = (rec.seen?.reads || {})[key];
  const inScope = rec.scope.includes(f);
  const mine = rec.anchors.filter((a) => a.path === f);

  // A duplicate is waste whatever the file is: the same bytes, at the same
  // range, already in this window once.
  if (dup) {
    tally(rec, "reads", key);
    return deny(`bundlebox: this exact read already happened in this session (${f}${limit ? ` offset ${offset} limit ${limit}` : " whole file"}, ${dup} time${dup === 1 ? "" : "s"}). It is already in your context — scroll, do not re-read. If it changed because you edited it, the edit result already told you what it says now.`);
  }
  tally(rec, "reads", key);

  if (rec.cut.includes(f)) {
    return { permissionDecision: "ask", permissionDecisionReason: `bundlebox: ${f} was cut from the pinpoint scope to make the unit fit one window (${rec.verdict}, ~${human(rec.projected)} projected). The brief says to name it and why before opening it. Opening it widens the unit past what was budgeted; \`bb pinpoint "${rec.problem.slice(0, 80)}" --files ${f}\` re-budgets the task with it in scope instead.` };
  }

  if (!mine.length) return null;                            // nothing quoted for this file

  const from = offset > 0 ? offset : 1;
  const to = limit > 0 ? from + limit - 1 : Number.MAX_SAFE_INTEGER;
  const hit = mine.filter((a) => overlaps(a, from, to));
  if (!hit.length) return null;                             // a range the brief did not locate

  const whole = !limit;
  const tokens = estimateFile(abs(f)) || 0;
  const share = capacity > 0 ? tokens / capacity : 0;
  // Small file, whole read: the quote saves nothing worth a denial.
  if (whole && capacity > 0 && share < minShare) return null;

  const quoted = hit.map((a) => `${a.path}:${a.line_start}-${a.line_end}${a.symbol ? `  (${a.symbol})` : ""}\n${a.text}`).join("\n\n");
  const body = quoted.length > QUOTE_CHARS ? quoted.slice(0, QUOTE_CHARS) + "\n…" : quoted;
  const cost = whole && tokens ? ` The whole file is ~${human(tokens)} tokens${share ? ` (${Math.round(share * 100)}% of the working window)` : ""}; this region is ~${human(hit.reduce((n, a) => n + a.tokens, 0))}.` : "";
  const next = inScope
    ? `\n\nTo edit outside the quoted lines, read the range you need (offset/limit) — a ranged read is allowed and is enough to unlock Edit on this file.`
    : `\n\nThis file is not in scope. If the quote above is not enough, say which range and why, then read that range.`;
  return deny(`bundlebox: \`bb pinpoint\` already located and quoted this region; here it is, so the read is not needed.${cost}\n\n${body}${next}`);
}

// ── the search guard ────────────────────────────────────────────────────────

/** Terms worth looking up in a symbol table: the literal identifier-shaped
 *  parts of a pattern, with the regex metacharacters and the anchors dropped. */
export function patternTerms(pattern) {
  const p = String(pattern || "");
  const words = p.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || [];
  const seen = new Set(), out = [];
  for (const w of words) { const l = w.toLowerCase(); if (seen.has(l)) continue; seen.add(l); out.push(w); }
  return out;
}

/** The directory a search was restricted to, or "" for the whole tree. A glob
 *  contributes only its fixed leading path: `src/wire/*.js` restricts to
 *  `src/wire/`, while `**` restricts to nothing.
 *
 *  `cwd` is the last word. A shell search with no path argument is scoped by
 *  the directory it runs in, and the harness tells the hook which one that is;
 *  reading it as "the whole tree" is what let this guard answer a search of
 *  `src/finish/vendor/` with rows from `src/tokens/`. */
export function dirFilter(pathArg, glob, cwd = "") {
  const here = cwd ? norm(cwd) : "";
  const base = here && here !== "." && !here.startsWith("/") ? here.replace(/\/$/, "") + "/" : "";
  const inner = innerFilter(pathArg, glob);
  if (!base) return inner;
  if (!inner) return base;
  return inner.startsWith(base) ? inner : base + inner;
}

function innerFilter(pathArg, glob) {
  const p = String(pathArg || "").replace(/^\.\//, "");
  if (p && !p.includes("*")) return p.endsWith("/") || !path.extname(p) ? (p.endsWith("/") ? p : p + "/") : p;
  const g = String(glob || "").replace(/^\.\//, "");
  if (!g) return "";
  const fixed = g.split("/").filter(Boolean).reduce((acc, seg) => (acc.done || seg.includes("*") || seg.includes("?") ? { ...acc, done: true } : { parts: [...acc.parts, seg], done: false }), { parts: [], done: false });
  return fixed.parts.length ? fixed.parts.join("/") + "/" : "";
}

const SYMBOL_TABLES = () => {
  const dir = path.join(OUT, "snapgen");
  try { return fs.readdirSync(dir).filter((n) => /^symbols-.*\.md$/.test(n)).map((n) => path.join(dir, n)); } catch { return []; }
};

/** `name  file:line` rows from the built symbol tables that match any term.
 *  Reads what is on disk and never builds: a hook that compiles is a hook that
 *  gets turned off.
 *
 *  A match must be a WHOLE name or one of its ends, and the term must be five
 *  characters or more. Both rules exist to stop a false denial: with a plain
 *  substring over four characters, a grep for a string literal containing
 *  "read" is answered with every symbol whose name happens to contain it, and
 *  the search that was refused was one the index could not answer. */
export function tableHits(terms, { cap = SEARCH_ROWS, under = "" } = {}) {
  const tl = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 5);
  if (!tl.length) return [];
  // The compiled index answers this in 0.14ms against the markdown scan's
  // 1.80ms — measured on this tree, cold, which is what a hook process pays.
  // `null` means there is no usable index, which is a different answer from an
  // empty result, so the scan below still runs.
  const fast = arc.lookup(tl, { cap, under });
  if (fast) return fast;
  const rx = /^(\S+)\s+(\S+):(\d+)$/;
  const hits = [];
  for (const p of SYMBOL_TABLES()) {
    for (const line of readText(p).split("\n")) {
      const m = rx.exec(line.trim());
      if (!m) continue;
      const sl = m[1].toLowerCase();
      if (!tl.some((t) => sl === t || sl.startsWith(t) || sl.endsWith(t))) continue;
      if (under && !m[2].startsWith(under)) continue;
      hits.push({ symbol: m[1], file: m[2], line: Number(m[3]) });
      if (hits.length >= cap * 3) break;
    }
    if (hits.length >= cap * 3) break;
  }
  return hits.slice(0, cap);
}

/** Does something already on disk answer this search?
 *
 *  Order matters. The active brief is checked first, because it was built for
 *  THIS task and its rows are ranked; the tables answer anything but rank
 *  nothing.
 *
 *  ONE identifier is the whole boundary of what an index may refuse. A
 *  declaration index answers "where is X declared" and nothing else, so it may
 *  only stand in for a search that asks exactly that. Measured, twice, on this
 *  guard's first hour: `grep -n "usage|process.argv|EXIT|exitCode"` was refused
 *  because one of its four alternatives happens to be a symbol name, and the
 *  answer handed back covered a quarter of the question. A partial answer to a
 *  search is not an answer, it is a wrong one with rows attached.
 *
 *  The duplicate check is different and applies to any pattern: running the
 *  same search twice in one window is waste whatever its shape. */
export function searchVerdict(rec, pattern, { glob = "", pathArg = "", cwd = "", stdin = false } = {}) {
  const terms = patternTerms(pattern);
  if (!terms.length) return null;                            // a punctuation search; let it run
  // Filtering a pipe is not searching the tree, and neither the brief nor the
  // index has anything to say about output that did not exist a moment ago.
  if (stdin) return null;
  const lookup = terms.length === 1;                         // one name: a declaration lookup

  if (rec) {
    // The same words over a DIFFERENT target is a different search. Keyed on
    // the words alone, `grep "^export" a.js` made `grep "^export" b.js` a
    // duplicate, and the denial told the session the answer was already in
    // its window when it was not: one wasted turn, then a retry that had to
    // be worded around the guard. Measured on this guard's own author's
    // session, twice in one afternoon.
    const key = `${terms.join("+").toLowerCase()}@${dirFilter(pathArg, glob, cwd) || "*"}`;
    if ((rec.seen?.searches || {})[key]) {
      tally(rec, "searches", key);
      return deny(`bundlebox: this search already ran in this session (${terms.join(", ")}${pathArg || glob ? ` in ${pathArg || glob}` : ""}). Its result is in your context. Re-running it returns the same rows and bills them twice.`);
    }
    tally(rec, "searches", key);
    const tl = lookup ? terms.map((t) => t.toLowerCase()) : [];
    const rows = [
      ...rec.symbols.filter((h) => tl.some((t) => h.symbol.toLowerCase().includes(t))).map((h) => `${h.file}:${h.line} — ${h.symbol}`),
      ...rec.grep.filter((h) => tl.some((t) => h.text.toLowerCase().includes(t))).map((h) => `${h.file}:${h.line} — ${h.text}`),
      ...rec.anchors.filter((a) => tl.some((t) => a.symbol.toLowerCase().includes(t))).map((a) => `${a.path}:${a.line_start}-${a.line_end} — ${a.symbol} (quoted in the brief)`),
    ];
    if (rows.length) {
      return deny(`bundlebox: the active pinpoint brief already located this. ${rows.length} row${rows.length === 1 ? "" : "s"}, ranked for this task:\n${rows.slice(0, SEARCH_ROWS).map((r) => `  ${r}`).join("\n")}\n\nThe brief is at ${rec.path}. Search only for something the brief does not name, and say what.`);
    }
  }

  // A search the caller restricted to a directory is a different question. The
  // declaration index answers "where is X declared"; a grep of `test/` for a
  // name declared in `src/` is asking who CALLS it, and the index has no rows
  // for that. Measured the honest way: this guard denied exactly that search of
  // its own author's, one minute after it was installed.
  if (!lookup) return null;
  const under = dirFilter(pathArg, glob, cwd);
  const hits = tableHits(terms, { under });
  if (!hits.length) return null;                             // the tables do not know; the tree might
  const rows = hits.map((h) => `  ${h.file}:${h.line} — ${h.symbol}`).join("\n");
  const where = glob || pathArg ? ` (your filter: ${[glob, pathArg].filter(Boolean).join(" ")})` : "";
  return deny(`bundlebox: the declarations are already indexed, so this search costs tokens for rows that are on disk. From \`.bundlebox/out/snapgen/symbols-*.md\`${where}:\n${rows}\n\nRead the table for the rest (\`bb_snapgen\` with table=symbols-src, or open the file in a range). Search the tree only for something a declaration index cannot answer — a string literal, a call site, a comment — and say which.`);
}

// ── bash, which is how a session actually reads and searches ────────────────
//
// Half the reads in the measured transcripts are `sed -n`/`cat`/`grep` through
// Bash, not Read and Grep. A guard that only sees the dedicated tools measures
// its own blind spot: uptake already says "a file opened with `sed -n` counts
// exactly as much as one opened with Read".

const READERS = /^(cat|bat|head|tail|less|more|nl)$/;
const SEARCHERS = /^(grep|egrep|fgrep|rg|ag|ack)$/;

/** One shell command -> {kind, file|pattern} for the piece worth guarding, or
 *  null. Deliberately narrow: a compound command is inspected segment by
 *  segment, and anything that is not plainly one read or one search of one
 *  target is left alone. Guessing at shell semantics in a hook is how a guard
 *  starts denying `npm test`. */
/** Re-exported from core: the guard and the automation engine both need one
 *  shell tokenizer, and two copies of a parser are two behaviours. */
export { shellSegments as segments } from "../core/util.js";

export function parseBash(command) {
  const segs = shellSegments(command);
  // Whether a search reads the TREE or a PIPE. `grep X file` and `grep -r X dir`
  // search the tree, and asking the same question twice over an unchanged tree
  // is waste. `npm test | grep fail` filters output that did not exist a moment
  // ago, and refusing it as a duplicate refuses to look at the new result.
  //
  // This is the fourth false denial this guard produced against its own author,
  // and they share one cause: the rule was right about the question and wrong
  // about what the question was pointed at. Position in the pipeline is the
  // cheapest fact that distinguishes the two.
  for (const seg of segs) {
    const parts = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (!parts.length) continue;
    const argv = parts.map((s) => s.replace(/^["']|["']$/g, ""));
    const cmd = path.basename(argv[0] || "");
    const rest = argv.slice(1);
    if (SEARCHERS.test(cmd)) {
      // The first non-flag argument is the pattern; -e/-P/--include take a value.
      let pattern = "", i = 0;
      while (i < rest.length) {
        const a = rest[i];
        if (a === "-e" || a === "-P" || a === "--include" || a === "--exclude" || a === "-m" || a === "-A" || a === "-B" || a === "-C") { if (a === "-e" || a === "-P") { pattern = rest[i + 1] || ""; break; } i += 2; continue; }
        if (a.startsWith("-")) { i++; continue; }
        pattern = a; break;
      }
      // Whatever follows the pattern is where it was told to look, and a search
      // restricted to a directory asks a question the declaration index may not
      // answer. `i` is the pattern's index, so the paths start after it.
      const paths = rest.slice(i + 1).filter((a) => !a.startsWith("-"));
      // A search with no path, arriving after something else in the pipeline, is
      // reading stdin.
      const stdin = !paths.length && seg !== segs[0];
      if (pattern) return { kind: "search", pattern, pathArg: paths[0] || "", stdin };
      continue;
    }
    if (cmd === "sed") {
      // `sed -n 10,40p file` — a ranged read, and the range is the point.
      const n = rest.find((a) => /^\d+,\d+p?$/.test(a));
      const file = rest.filter((a) => !a.startsWith("-") && !/^\d/.test(a) && !/^-?[0-9,]+p?$/.test(a)).pop();
      if (!file) continue;
      const m = n ? /^(\d+),(\d+)/.exec(n) : null;
      return m ? { kind: "read", file, offset: Number(m[1]), limit: Number(m[2]) - Number(m[1]) + 1 } : { kind: "read", file, offset: 0, limit: 0 };
    }
    if (READERS.test(cmd)) {
      const flagged = rest.some((a) => /^-n?\d+$/.test(a) || a === "-n");
      const files = rest.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
      if (files.length !== 1) continue;                      // `cat a b > c` is not a read to serve
      if (flagged) continue;                                 // `head -40 x` is already a ranged read
      return { kind: "read", file: files[0], offset: 0, limit: 0 };
    }
  }
  return null;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function tally(rec, bucket, key) {
  if (!rec.seen) rec.seen = { reads: {}, searches: {} };
  if (!rec.seen[bucket]) rec.seen[bucket] = {};
  rec.seen[bucket][key] = (rec.seen[bucket][key] || 0) + 1;
  save(rec);
}

const deny = (reason) => ({ permissionDecision: "deny", permissionDecisionReason: reason });

/** Prune the brief directory. Auto-pinpoint writes one document per task-shaped
 *  prompt, and a directory nothing prunes is a directory somebody deletes. */
export function prune({ keep = 40 } = {}) {
  const dir = path.join(OUT, "pinpoint");
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return 0; }
  let gone = 0;
  for (const n of names.slice(0, Math.max(0, names.length - keep))) { try { fs.unlinkSync(path.join(dir, n)); gone++; } catch { /* next time */ } }
  return gone;
}
