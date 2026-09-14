// pinpoint/index.js — one problem, one focused prompt, nothing else in the window.
//
// A session spends its first turns finding out where a problem lives. This
// does that part for nothing: terms from the problem statement, files ranked
// from the snapgen symbol tables (explicit file +10, symbol hit +3, a bounded
// grep +1 only when the tables are nearly silent), regions located by the
// kernel's `anchor` or the anchors parser, a cut loop until the read set FITS,
// and the evidence already on file. The prompt is written before anything is
// spawned (doctrine 5). Everything quoted comes from stored artefacts; the
// oversight scan is never recomputed here, because a pinpoint must be instant.
import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT, rel, abs } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { out, emit, warn } from "../core/log.js";
import { human, slug, stamp } from "../core/util.js";
import * as store from "../core/store.js";
import * as estimate from "../tokens/estimate.js";
import * as anchorsMod from "../compile/anchors.js";
import * as context from "../compile/context.js";
import { detectGates } from "../compile/compiler.js";
import * as snapgen from "../snapgen/index.js";
import { kcall, codeFiles } from "../snapgen/tables.js";
import { latest as oversightLatest } from "../oversight/rules.js";

export const DIR = path.join(OUT, "pinpoint");
const EDGE = () => [path.join(ROOT, ".bundlebox", "edge-cases.md"), path.join(ROOT, "docs", "edge-cases.md")].find((p) => fs.existsSync(p)) || null;
const RECS = () => path.join(OUT, "learn", "recommendations.md");

// Glue plus the verbs every task statement carries; neither names a file.
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "that", "this", "with", "when", "not",
  "does", "do", "be", "are", "as", "at", "by", "from", "into", "no", "but", "so", "if", "then", "than", "its", "their", "his", "her",
  "them", "our", "we", "you", "should", "must", "never", "always", "after", "before", "every", "all", "any", "one", "was", "were",
  "has", "have", "had", "can", "could", "would", "will", "there", "here", "what", "why", "how", "where", "which", "who", "get", "set",
  "fix", "bug", "issue", "make", "add", "remove", "change", "update", "implement", "refactor", "write", "build", "create", "delete",
  "check", "verify", "test", "tests", "investigate", "handle", "support", "use", "using", "via", "new", "old", "file", "files",
  "function", "method", "code", "error", "errors", "wrong", "broken", "fails", "failing", "failed", "work", "works", "working"]);

/** Words of three or more letters minus the stoplist, plus the camel/snake
 *  parts of each, so "userToken" also hits `token`. */
export function terms(problem) {
  const seen = new Set(), out = [];
  const push = (w) => { const l = w.toLowerCase(); if (l.length < 3 || STOP.has(l) || seen.has(l)) return; seen.add(l); out.push(w); };
  for (const w of String(problem || "").match(/[A-Za-z_][A-Za-z0-9_./-]{2,}/g) || []) {
    push(w);
    for (const p of w.match(/[A-Z]?[a-z0-9]+/g) || []) if (p.length > 3) push(p);
  }
  return out;
}
const pathHits = (ts) => ts.filter((t) => t.includes("/") || /\.[a-z]{1,4}$/.test(t)).map((t) => abs(t)).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }).map(rel);

/** A bounded content search for the longest terms, only when the tables were
 *  nearly silent: at most `cap` files, first hit per file. */
export function grepHits(ts, { cap = 12 } = {}) {
  const long = ts.filter((t) => t.length >= 6 && !t.includes("/")).sort((p, q) => q.length - p.length).slice(0, 4);
  if (!long.length) return [];
  const rx = new RegExp(long.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const hits = [];
  for (const p of codeFiles()) {
    const lines = readText(p).split("\n");
    const i = lines.findIndex((l) => rx.test(l));
    if (i >= 0) hits.push({ file: rel(p), line: i + 1, text: lines[i].trim().slice(0, 100) });
    if (hits.length >= cap) break;
  }
  return hits;
}

/** Kernel `anchor` first, anchors.locate second. Both return the same shape;
 *  the kernel's has no token count, so it is added here. */
export function locate(file, symbol) {
  const k = kcall("anchor", { path: abs(file), symbol });
  if (k && k.line_start) {
    const text = String(k.text || "");
    return { path: rel(file), symbol, line_start: k.line_start, line_end: k.line_end, text, tokens: estimate.text(text, "code"), via: "kernel" };
  }
  const a = anchorsMod.locate(abs(file), symbol);
  return a ? { ...a, via: "js" } : null;
}

function traps(scope, ts) {
  const p = EDGE();
  if (!p) return [];
  const want = new Set([...ts.map((t) => t.toLowerCase()), ...scope.flatMap((f) => [path.basename(f).toLowerCase(), f.split("/")[0].toLowerCase()])]);
  const rows = [];
  for (const line of readText(p).split("\n")) {
    if (!/^\|\s*E\d+\s*\|/.test(line)) continue;
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    const text = cells.slice(1).join(" ").toLowerCase();
    if ([...want].some((w) => w.length >= 3 && text.includes(w))) rows.push(`${cells[0]}: ${cells.slice(1, 3).join(" — ")}`);
  }
  return rows.slice(0, 8);
}
function processRules() {
  const p = RECS();
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const block of readText(p).split("```")) { const b = block.trim(); if (b.startsWith("- ")) out.push(...b.split("\n").filter((l) => l.startsWith("- "))); }
  if (!out.length) out.push(...readText(p).split("\n").filter((l) => /^- /.test(l)));
  return out.slice(0, 5);
}
function evidence(scope, ts) {
  const set = new Set(scope);
  const tl = ts.map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return store.openFindings()
    .filter((f) => (f.files || []).some((x) => set.has(x)) || set.has(f.path) || tl.some((t) => String(f.title || "").toLowerCase().includes(t)))
    .sort((p, q) => (rank[p.severity] ?? 4) - (rank[q.severity] ?? 4))
    .slice(0, 8)
    .map((f) => ({ id: f.id, detector: f.detector, severity: f.severity, title: String(f.title).slice(0, 160), fix_hint: String(f.fix_hint || "").slice(0, 160) }));
}
/** What the STORED oversight scan says about the scope. Never recomputed. */
function oversight(scope) {
  const doc = oversightLatest();
  if (!doc) return null;
  const set = new Set(scope);
  const guidelines = (doc.findings || []).filter((f) => (f.files || []).some((x) => set.has(x))).slice(0, 5)
    .map((f) => ({ rule: f.detector.replace(/^oversight:/, ""), title: f.title, hint: f.fix_hint }));
  const notes = [];
  for (const m of doc.files || []) if (set.has(m.path) && doc.capacity && m.tokens / doc.capacity >= 0.35) notes.push(`\`${m.path}\` is ${human(m.tokens)} tokens whole (${Math.round((100 * m.tokens) / doc.capacity)}% of one payload): read the region, not the file`);
  for (const p of doc.dupes?.pairs || []) {
    const a = rel(p.a), b = rel(p.b);
    for (const [near, far] of [[a, b], [b, a]]) if (set.has(near) && !set.has(far)) notes.push(`\`${near}\` shares ${p.shared_lines} lines with \`${far}\`: a fix here probably has to land there too`);
  }
  return { at: String(doc.at || "").slice(0, 10), guidelines, notes: notes.slice(0, 5) };
}

/** The whole plan for one problem. `files` are explicit paths (rel or abs). */
export async function build(problem, { files = [], maxFiles = 6, kind = "fix" } = {}) {
  const ts = terms(problem);
  const explicit = [...files.map((f) => rel(abs(f))), ...pathHits(ts)];
  const sym = await snapgen.symbolHits(ts);
  const grep = sym.length < 3 ? grepHits(ts) : [];
  const score = new Map();
  const bump = (f, n) => score.set(f, (score.get(f) || 0) + n);
  for (const f of explicit) bump(f, 10);
  for (const h of sym) bump(h.file, 3);
  for (const h of grep) bump(h.file, 1);
  let scope = [...score].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(([f]) => f).slice(0, maxFiles);
  let anchors = [];
  const seen = new Set();
  for (const h of sym) {
    if (anchors.length >= 8 || !scope.includes(h.file) || seen.has(`${h.file}|${h.symbol}`)) continue;
    seen.add(`${h.file}|${h.symbol}`);
    const a = locate(h.file, h.symbol);
    if (a) anchors.push(a);
  }
  const evalOf = () => context.evaluate(scope, { brief: problem, anchors: anchors.length ? anchors : null, kind });
  let ev = evalOf();
  const cut = [];
  // The lowest-ranked file goes first; the loop stops at FITS or at one file.
  while (ev.verdict !== "FITS" && scope.length > 1) {
    cut.push(scope.pop());
    anchors = anchors.filter((a) => scope.includes(a.path));
    ev = evalOf();
  }
  const gates = detectGates(ROOT);
  const b = {
    problem: String(problem).trim(), kind, terms: ts, scope, cut, anchors,
    symbols: sym.filter((h) => scope.includes(h.file)).slice(0, 12), grep: grep.slice(0, 6),
    evidence: evidence(scope, ts), gates, traps: traps(scope, ts), oversight: oversight(scope), process: processRules(),
    projected: ev.projected, ceiling: ev.ceiling, verdict: ev.verdict, headroom: ev.headroom, payload_saved: ev.payload_saved,
    tables: await tablesFor(),
    via: { symbols: snapgen.symbolIndex().via, anchors: anchors.length ? (anchors.every((a) => a.via === "kernel") ? "kernel" : anchors.some((a) => a.via === "kernel") ? "mixed" : "js") : null },
  };
  b.prompt = prompt(b);
  b.path = write(b);
  return b;
}
/** The tables the prompt points at, built when absent: a prompt that names a
 *  table the session cannot open sends it back to searching. */
async function tablesFor() {
  const reg = snapgen.registry();
  const names = ["layout", "routes", "commands", ...reg.names("symbols")].filter((n) => reg.has(n));
  const missing = names.filter((n) => !fs.existsSync(reg.path(n)));
  if (missing.length) await snapgen.build({ only: missing });
  return names.filter((n) => fs.existsSync(reg.path(n))).map((n) => `\`${rel(reg.path(n))}\` ~${human(estimate.file(reg.path(n)))}`);
}

export function prompt(b) {
  const L = [`# ${b.problem}`, "", "Touch nothing outside **Scope**. Everything below was located already; spend turns on the change, not on finding it.", "",
    "## Where — located already, do not search"];
  for (const h of b.symbols) L.push(`- \`${h.file}:${h.line}\` — \`${h.symbol}\``);
  for (const h of b.grep) L.push(`- \`${h.file}:${h.line}\` — ${h.text}`);
  if (!b.symbols.length && !b.grep.length) L.push(`- nothing in the symbol tables matched the problem's words; the scope below is the best path match. Read the symbols tables under \`${rel(snapgen.DIR)}/\` before any grep.`);
  L.push("", "## The regions this touches — quoted, current, do not re-read the files");
  if (b.anchors.length) for (const a of b.anchors.slice(0, 6)) L.push("", `\`${a.path}\` lines ${a.line_start}-${a.line_end} (~${a.tokens} tokens)`, "```", anchorsMod.excerpt(a, 900), "```");
  else L.push("- no region located; the scope files are costed whole");
  L.push("", "## Scope — the only files you may edit");
  for (const f of b.scope) L.push(`- \`${f}\` (~${human(estimate.file(abs(f)))} tokens)`);
  if (b.cut.length) L.push(`- ask before opening these: ${b.cut.map((c) => `\`${c}\``).join(", ")} (cut for budget)`);
  L.push("", "## Evidence already on file — do not re-derive");
  if (b.evidence.length) for (const e of b.evidence) L.push(`- [${e.detector}/${e.severity}] ${e.title}${e.fix_hint ? ` → ${e.fix_hint}` : ""}`);
  else L.push("- no open finding touches this scope");
  L.push("", "## Done when");
  const g = b.gates || {};
  if (g.quick) L.push(`    ${g.quick}`);
  if (g.full && g.full !== g.quick) L.push(`    ${g.full}   # before the PR`);
  if (!g.quick && !g.full) L.push("    (no gate detected: state in one line what you ran to prove the change; the unit is unproven until then)");
  L.push("", "State what changed and why in under 120 words.");
  L.push("", "## Traps");
  if (b.traps.length) for (const t of b.traps) L.push(`- ${t}`);
  else L.push("- none recorded for these files (`.bundlebox/edge-cases.md` or `docs/edge-cases.md`, rows `| E<n> |`)");
  const ov = b.oversight;
  L.push("", `## What is already known about these files (bb oversight, ${ov?.at || "no scan on file"})`);
  if (ov && (ov.guidelines.length || ov.notes.length)) {
    for (const gl of ov.guidelines) L.push(`- **${gl.rule}** — ${gl.title}${gl.hint ? `. ${gl.hint}` : ""}`);
    for (const n of ov.notes) L.push(`- ${n}`);
  } else L.push(ov ? "- nothing measured against these files" : "- run `bb oversight scan` to fill this");
  L.push("", "## Process rules this workspace measured itself needing");
  if (b.process.length) L.push(...b.process);
  else L.push("- none yet (`bb learn` writes `.bundlebox/out/learn/recommendations.md`)");
  L.push("", "## Do not",
    "- read a file outside Scope without saying which and why, in one line, first",
    "- run a test suite the change does not touch; one file's tests is the ceiling before the gate",
    "- `git stash`, `git checkout` on a shared checkout, `--no-verify`, or a commit outside the scope",
    "- widen into cleanup, refactor or docs. One problem, one diff.",
    "", `Reference tables, read instead of searching: ${b.tables.length ? b.tables.join(", ") : "(none built; `bb snapgen build`)"}`);
  return L.join("\n") + "\n";
}

export function write(b) {
  fs.mkdirSync(DIR, { recursive: true });
  const p = path.join(DIR, `${stamp()}-${slug(b.problem) || "problem"}.md`);
  fs.writeFileSync(p, b.prompt || prompt(b));
  return rel(p);
}

export function report(b) {
  return [`  PINPOINT — ${b.scope.length} files in scope · ${b.symbols.length} symbols · ${b.anchors.length} regions · ${b.evidence.length} findings`,
    `  budget: ${b.verdict}  projected ~${human(b.projected)} of ${human(b.ceiling)}${b.cut.length ? `  (cut ${b.cut.length}: ${b.cut.join(", ")})` : ""}`,
    `  terms:  ${b.terms.slice(0, 12).join(", ")}`,
    `  via:    symbols ${b.via.symbols}, anchors ${b.via.anchors || "-"}`,
    `  wrote:  ${b.path}`].join("\n");
}

const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
export const commands = {
  pinpoint: {
    help: "one problem, one focused prompt: where, regions, scope, evidence, gate (no tokens)",
    usage: "bb pinpoint \"<problem>\" [--files a,b] [--max-files N] [--kind fix|verify|investigate|build|write] [--print] [--json]",
    run: async ({ _, flags }) => {
      const problem = _.join(" ").trim();
      if (!problem) { warn(commands.pinpoint.usage); return 2; }
      const b = await build(problem, { files: list(flags.files), maxFiles: Number(flags.maxFiles) || 6, kind: flags.kind ? String(flags.kind) : "fix" });
      if (flags.json) { emit(b); return 0; }
      out(report(b));
      if (flags.print) out("", b.prompt.trimEnd());
      return 0;
    },
  },
};
