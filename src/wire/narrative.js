// narrative.js — what this session was doing, written from the record at the
// moment the conversation is compacted, and put back after.
//
// A compaction summary is a model's paraphrase of a transcript. It keeps what
// looked important and drops the rest, and the rest is where the task lives:
// which files were the scope, which were already edited, which command last
// ran, which gate is still open, which question nobody answered. Every one of
// those is on disk, written by the guards and the hooks while the session ran,
// and none of them needs a summariser. So this file reads them and writes one
// page: the task, the scope, the progress, the gates, the open handoffs.
//
// Frozen at PreCompact so the summary and the record are of the same moment,
// and re-injected on the first event after — SessionStart(compact) where the
// harness fires one, the next prompt where it does not. The rules band from
// the janitor still goes back verbatim; this is the other half, the work.
import fs from "node:fs";
import path from "node:path";
import { VAR, OUT, ROOT, ensureDirs } from "../core/paths.js";
import { now } from "../core/util.js";
import * as brief from "./brief.js";

export const DIR = () => path.join(VAR, "narrative");
export const PATH = (sessionId = "") => path.join(DIR(), `${String(sessionId || "cli").replace(/[^A-Za-z0-9_.-]/g, "_")}.md`);
export const LATEST = () => path.join(OUT, "narrative", "latest.md");
export const MAX_FILES = 12;
export const MAX_COMMANDS = 8;
export const MAX_QUESTIONS = 3;

const readJsonl = (p) => {
  let text; try { text = fs.readFileSync(p, "utf8"); } catch { return []; }
  const out = [];
  for (const l of text.split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* a torn row */ } }
  return out;
};

/** What the ledger says: every gate row, and which are still open. */
export function ledger(text) {
  const gates = [];
  for (const m of String(text || "").matchAll(/^- \[( |x|X)\] ([^:\n]+): (.+)$/gm)) gates.push({ id: m[2].trim(), outcome: m[3].trim(), met: m[1] !== " " });
  return { gates, unmet: gates.filter((g) => !g.met) };
}

/** The session's own progress, off the grapple event log: one row per tool
 *  call, written by the post-tool hook. Edits per file, in order of last
 *  touch; writes the scope guard refused; the count of reads. */
export function progress(events, sessionId = "") {
  const edits = new Map();
  let reads = 0;
  const refused = new Set();
  for (const e of events) {
    if (sessionId && String(e.session_id || "") !== sessionId) continue;
    if (e.kind === "tool") {
      if (e.edit && e.file) edits.set(e.file, (edits.get(e.file) || 0) + 1);
      else if (e.read) reads += 1;
    } else if (e.kind === "write_verdict" && e.decision === "deny" && e.file) refused.add(e.file);
  }
  return { edited: [...edits.entries()].reverse().slice(0, MAX_FILES).map(([file, n]) => ({ file, n })), reads, refused: [...refused].slice(0, MAX_FILES) };
}

/** The shapes of the last commands this session ran, newest last, from
 *  lathe's record. Shapes, never arguments, for the same reason lathe keeps
 *  only shapes. */
export function commands(rows, sessionId = "", max = MAX_COMMANDS) {
  const mine = rows.filter((r) => !sessionId || String(r.s || "") === sessionId.slice(0, 36));
  const flat = [];
  for (const r of mine) for (const v of (Array.isArray(r.v) ? r.v : [])) flat.push(String(v));
  const seen = [];
  for (const c of flat.reverse()) { if (!seen.includes(c)) seen.push(c); if (seen.length >= max) break; }
  return seen.reverse();
}

/** Everything the narrative reads, gathered in one place so `build` is pure
 *  over it and a test can hand it a fixture. */
export function gather({ sessionId = "", maxAgeMin = 24 * 60 } = {}) {
  const rec = brief.current({ maxAgeMin, sessionId });
  const events = readJsonl(path.join(VAR, "grapple-events.jsonl"));
  const shapes = readJsonl(path.join(VAR, "shapes.jsonl"));
  let gatesMd = ""; try { gatesMd = fs.readFileSync(path.join(ROOT, "GATES.md"), "utf8"); } catch { /* no ledger */ }
  let questions = {}; try { questions = JSON.parse(fs.readFileSync(path.join(VAR, "grapple-questions.json"), "utf8")) || {}; } catch { /* no queue */ }
  let unsettled = [];
  if (rec && rec.ambiguity && Array.isArray(rec.ambiguity.reasons)) unsettled = rec.ambiguity.reasons.map((r) => `${r.id}: ${r.why}`);
  else if (rec && rec.path) {
    try {
      const md = fs.readFileSync(rec.path, "utf8");
      const i = md.indexOf("## What this brief does not settle");
      if (i >= 0) for (const m of md.slice(i).split("\n## ")[0].matchAll(/^- \*\*([a-z0-9-]+)\*\* — (.+)$/gm)) unsettled.push(`${m[1]}: ${m[2].trim()}`);
    } catch { /* the brief file is gone; the record still stands */ }
  }
  return { sessionId, rec, events, shapes, gatesMd, questions, unsettled };
}

/** The page. Pure over `gather()`'s output: the same inputs give the same
 *  text, so a test can assert it and a person can diff two of them. Every
 *  section is either present with facts or absent; no section says "none". */
export function build(g) {
  const L = [];
  const rec = g.rec;
  if (rec) {
    L.push(`task: ${String(rec.problem || "").slice(0, 300)}`);
    if (rec.scope?.length) L.push(`scope — the only files to edit: ${rec.scope.join(", ")}`);
    if (rec.cut?.length) L.push(`cut for budget, name before opening: ${rec.cut.slice(0, 6).join(", ")}`);
    const anchors = (rec.anchors || []).filter((a) => a.path).slice(0, 10);
    if (anchors.length) L.push(`located: ${anchors.map((a) => `${a.path}:${a.line_start}${a.symbol ? ` (${a.symbol})` : ""}`).join(", ")}`);
    const gates = [rec.gates?.quick, rec.gates?.full].filter(Boolean);
    if (gates.length) L.push(`done when: ${gates.join("  /  ")}`);
    if (rec.path) L.push(`brief: ${rec.path}`);
  }
  const p = progress(g.events, g.sessionId);
  if (p.edited.length) L.push(`edited this session (last touched first): ${p.edited.map((e) => `${e.file}${e.n > 1 ? ` x${e.n}` : ""}`).join(", ")}`);
  if (p.refused.length) L.push(`writes refused as outside the scope: ${p.refused.join(", ")}`);
  const c = commands(g.shapes, g.sessionId);
  if (c.length) L.push(`last commands: ${c.join("; ")}`);
  const led = ledger(g.gatesMd);
  if (led.gates.length) L.push(`ledger (GATES.md): ${led.unmet.length} of ${led.gates.length} gate(s) unmet${led.unmet.length ? ` — ${led.unmet.slice(0, 6).map((x) => x.id).join(", ")}` : ""}`);
  if (g.unsettled.length) L.push(`not settled by the brief, do not guess: ${g.unsettled.slice(0, 4).join(" | ")}`);
  const open = Object.values(g.questions || {}).filter((q) => q && q.state === "open").sort((a, b) => (b.ev || 0) - (a.ev || 0)).slice(0, MAX_QUESTIONS);
  if (open.length) L.push(`open questions (bb grapple ask): ${open.map((q) => `${q.key} ${String(q.text || "").slice(0, 80)}`).join(" | ")}`);
  return L.join("\n");
}

/** The text that goes back into the window. */
export function band(text) {
  if (!String(text || "").trim()) return "";
  return "bundlebox: the conversation was just compacted. This is the record of what this session was doing, written at the moment of compaction from files on disk and not from the summary. Where the summary and this record disagree, the record is right.\n"
    + text + "\nResume from here. The scope above is still the scope; the brief still quotes the regions; the gate still has to be run.";
}

/** Freeze the page at compaction time. Returns the path, or "" when there was
 *  nothing to say — a session with no brief, no edits and no ledger has no
 *  record to lose. */
export function write({ sessionId = "" } = {}) {
  const text = build(gather({ sessionId }));
  if (!text.trim()) return "";
  ensureDirs();
  fs.mkdirSync(DIR(), { recursive: true });
  const p = PATH(sessionId);
  fs.writeFileSync(p, `# narrative — ${sessionId || "cli"} — frozen ${now()}\n\n${text}\n`);
  try { fs.mkdirSync(path.dirname(LATEST()), { recursive: true }); fs.writeFileSync(LATEST(), `# narrative — ${sessionId || "cli"} — frozen ${now()}\n\n${text}\n`); } catch { /* the mirror is a courtesy */ }
  return p;
}

/** The frozen page for this session, without its heading, or "" . */
export function read({ sessionId = "" } = {}) {
  try {
    const raw = fs.readFileSync(PATH(sessionId), "utf8");
    return raw.replace(/^# narrative[^\n]*\n\n?/, "").trim();
  } catch { return ""; }
}

/** What to inject after a compaction: the frozen page if one was written,
 *  otherwise the page as it stands now — a harness that fires no PreCompact
 *  still has the record, it just was not frozen. */
export function afterCompaction({ sessionId = "" } = {}) {
  const frozen = read({ sessionId });
  return band(frozen || build(gather({ sessionId })));
}
