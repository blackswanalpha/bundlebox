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
import { kcall, codeFiles, sourceFiles, SYMBOL_SUFFIX } from "../snapgen/tables.js";
import { latest as oversightLatest } from "../oversight/rules.js";
import { clean } from "../slop/index.js";
import { PREAMBLE } from "../wire/brief.js";
import { rankDetailed, informative } from "./rank.js";
import { ambiguity, lines as ambiguityLines } from "./ambiguity.js";
import * as aim from "./locate.js";

export { ambiguity } from "./ambiguity.js";

export const DIR = path.join(OUT, "pinpoint");
// Both, when both exist: `bb genesis practice` writes the first and a person writes the second.
const EDGE = () => [path.join(ROOT, ".bundlebox", "edge-cases.md"), path.join(ROOT, "docs", "edge-cases.md")].filter((p) => fs.existsSync(p));
const RECS = () => path.join(OUT, "buckmaster", "recommendations.md");

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
/** The most files a brief will ever name. Past this the prompt stops being a
 *  located scope and becomes a directory listing, whatever the budget allows. */
export const GROW_CAP = 24;
/** How far down the ranking the grow loop will look for something that fits.
 *  The loop skips what it cannot afford instead of stopping, so it needs a
 *  bound of its own: past forty the candidates are no longer about the problem
 *  and each one costs a read to price. */
export const GROW_TRIES = 40;
/** How many ranked-but-unaffordable files the brief names as pointers. Naming
 *  one costs about fifteen tokens; budgeting one to be read costs its whole
 *  size times the churn factor. Twelve is where the list stops being a lead and
 *  starts being a directory. */
export const CANDIDATE_CAP = 12;

export function terms(problem) {
  const seen = new Set(), out = [];
  const push = (w) => { const l = w.toLowerCase(); if (l.length < 3 || STOP.has(l) || seen.has(l)) return; seen.add(l); out.push(w); };
  for (const w of String(problem || "").match(/[A-Za-z_][A-Za-z0-9_./-]{2,}/g) || []) {
    push(w);
    for (const p of w.match(/[A-Z]?[a-z0-9]+/g) || []) if (p.length > 3) push(p);
  }
  return out;
}
/** What a statement says about which files may change. Drawn from the phrasings
 *  Terminal-Bench 2.0 and 4.0 task statements actually use: "fix in user.cpp
 *  only", "the only edits you may make are to … input.tex", "Do not modify
 *  `build.sh`", "You must not modify the weights.pt file", "The following files
 *  are read-only and must NOT be modified: `a`, `b`". A sentence counts only
 *  when "only", a negation or "read-only" sits with an editing verb, so "the
 *  only source of rules" and "should only encode proteins" draw nothing. A
 *  negated clause holds the paths after its verb up to "but", "instead" or a
 *  comma that does not start another path, so "don't modify the tests, fix
 *  src/foo.py" does not hold src/foo.py. */
const PATHISH = /`?((?:\.{1,2}\/|\/)?[\w@-][\w.@-]*(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})`?/g;
const EDIT_VERB = /\b(edit|edits|edited|editing|modify|modifies|modified|modifying|change|changes|changed|changing|touch|touching|fix|write|writes|written|overwrite|alter|altered|replace)\b/i;
const NEGATED = /\b(do not|don't|dont|must not|mustn't|should not|shouldn't|shall not|never|may not|cannot|can't|not allowed to)\b/i;
const FIRST_PATH = /`?(?:\.{1,2}\/|\/)?[\w@-][\w.@-]*(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}`?/;
const pathsIn = (s) => [...String(s).matchAll(PATHISH)].map((m) => m[1]).filter((p) => /[A-Za-z]/.test(path.basename(p).split(".")[0]) && !/^\d/.test(path.basename(p)));
const upToBreak = (s) => s.split(/\bbut\b|\binstead\b|,(?!\s*(?:(?:or|and)\s+)?`?(?:\.{1,2}\/|\/)?[\w@-][\w.@/-]*\.[A-Za-z])|\band then\b/i)[0];
// "Write a file eval.scm that …", "create a /app/report.jsonl file", "put it in a
// file called /app/headless_terminal.py": a path the task says to make. On
// Terminal-Bench 2.0 and 2.1 all three briefs the hook emitted listed "the only
// files to edit" without the one file the task was graded on.
const CREATE_VERB = /\b(create|creates|write|writes|save|saves|generate|produce|output|put|place|store)\b/i;
// A statement also names things that only look like paths: "e.g.", an email
// address, `re.findall`, `shape.seq`, a `<name>_pb2.py` template. Over the 89
// TB 2.1 statements those were the only false hits, and a file extension a
// task could actually be graded on separates them.
const FILE_EXT = new Set(("py js mjs cjs ts tsx jsx c h cc cpp hpp rs go java kt rb php sh bash zsh R r jl scm lisp ml hs lua pl swift " +
  "txt md rst json jsonl csv tsv parquet yaml yml toml ini cfg conf env xml html css sql sparql proto stan red vim tex bib log out " +
  "pem crt key npy npz pt pth pkl bin db sqlite ics ppm bmp png jpg svg pdf fasta fa mat comp cbl cob asm s wasm").split(" "));
const creatable = (t) => {
  const base = path.basename(t), ext = base.split(".").pop();
  return !t.includes("@") && /^[A-Za-z0-9]/.test(base) && base.includes(".") && FILE_EXT.has(ext);
};
export function bounds(problem) {
  const only = [], keepOut = [], create = [];
  // A wrapped line is one sentence; a list item is its own.
  const text = String(problem || "").replace(/\r/g, "").replace(/\n(?=[ \t]*(?:[-*+]|\d+\.)\s)/g, "\n\n");
  const clauses = text.split(/\n\s*\n/).flatMap((block) => block.replace(/\s*\n\s*/g, " ").split(/;\s+|(?<=[.!?])\s+(?=[A-Z`*(-])/));
  for (const clause of clauses) {
    const verb = CREATE_VERB.exec(clause);
    if (verb && !NEGATED.test(clause)) create.push(...pathsIn(clause.slice(verb.index)).filter(creatable));
    if (!pathsIn(clause).length || !EDIT_VERB.test(clause)) continue;
    if (/\bread-only\b|\bmust not be (modified|edited|changed)\b/i.test(clause)) { keepOut.push(...pathsIn(clause)); continue; }
    const neg = NEGATED.exec(clause);
    if (neg) {
      const after = clause.slice(neg.index);
      // "shall not modify any other file except for user.cpp" names what MAY change.
      const ex = /\bexcept(?:\s+for)?\b/i.exec(after);
      if (ex) { only.push(...pathsIn(upToBreak(after.slice(ex.index + ex[0].length)))); continue; }
      const verb = EDIT_VERB.exec(after);
      if (!verb) continue;
      // The path has to be what the verb acts on: "do not replace the shim in
      // megatron_parallel.py" protects the shim, not the file.
      const tail = upToBreak(after.slice(verb.index + verb[0].length));
      const at = tail.search(FIRST_PATH);
      if (at >= 0 && !/\b(in|inside|within|of|from)\b/i.test(tail.slice(0, at))) keepOut.push(...pathsIn(tail));
      continue;
    }
    const lead = /\bonly\s+(?:edits?|modify|modifications?|change|changes|touch|write)\b/i.exec(clause);
    if (lead) { only.push(...pathsIn(upToBreak(clause.slice(lead.index + lead[0].length)))); continue; }
    for (const m of clause.matchAll(/`?((?:\.{1,2}\/|\/)?[\w@-][\w.@-]*(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})`?\s+only\b/g)) only.push(m[1]);
  }
  return { only: [...new Set(only)], keepOut: [...new Set(keepOut)], create: [...new Set(create)] };
}
/** The tree file a statement's path names: the path itself when it resolves
 *  under the root (so `/app/user.cpp` is `user.cpp` in a tree rooted at /app),
 *  else the one file in `pool` with that basename. Ambiguous is nothing. */
function named(token, pool) {
  let r = ""; try { r = rel(abs(token)); } catch { /* not a path this tree can hold */ }
  if (r && !r.startsWith("..") && fs.existsSync(abs(r))) return r;
  const hits = pool.filter((f) => path.basename(f) === path.basename(token));
  return hits.length === 1 ? hits[0] : null;
}
const pathHits = (ts) => ts.filter((t) => t.includes("/") || /\.[a-z]{1,4}$/.test(t)).map((t) => abs(t)).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }).map(rel);  // a token that names no file is not a path hit

/** How many files the content search names. */
export const GREP_CAP = 12;
/** Long terms it searches for. All of them, not the four longest: the score
 *  below is how many DISTINCT terms a file carries, so dropping terms drops
 *  the only signal that separates one match from another. */
export const GREP_TERMS = 24;
/** A ceiling on the bytes one search reads, so a repository nobody measured
 *  cannot turn a 15s hook budget into a tree walk. The search reports when it
 *  stopped early rather than pretending it saw the whole tree. */
export const GREP_MAX_BYTES = 32 * 1024 * 1024;

/** A bounded content search for the problem's long terms: the `cap` files
 *  carrying the MOST of them, not the first `cap` the walk happened to reach.
 *
 *  The difference is the whole value of this function. It used to take the
 *  first twelve files matching any of the four longest terms and stop, which on
 *  a tree of thousands of files is an arbitrary twelve in directory order.
 *  Measured on SWE-bench Verified, that is exactly how two instances were lost:
 *  `astropy-7166` wants `astropy/utils/misc.py`, which carries nine of the
 *  statement's terms including `InheritDocstrings`, the class the issue is
 *  about, and the old walk stopped before reaching it. Scored by distinct
 *  terms it is the FIRST file of 175 that match. On `django-12325` the two gold
 *  files score 17 and 15 and rank 4th and 11th of 2,005.
 *
 *  Cost measured at the same time: 62ms over astropy's 706 files, 284ms over
 *  django's 2,624. That is affordable inside a locate already measured under a
 *  second, and it is why this now runs on every locate rather than only when
 *  the symbol tables went quiet. */
export function grepHits(ts, { cap = GREP_CAP, maxBytes = GREP_MAX_BYTES } = {}) {
  // Longest first. A long term is a rarer term, and when the cap bites it is
  // the rare ones that carry the localisation: `InheritDocstrings` says which
  // file, `related` does not.
  const long = [...new Set(ts.filter((t) => t.length >= 6 && !t.includes("/")).map((t) => t.toLowerCase()))]
    .sort((x, y) => y.length - x.length).slice(0, GREP_TERMS);
  if (!long.length) return [];
  const idx = new Map(long.map((t, i) => [t, i]));
  // One case-insensitive alternation, one pass per file. The obvious
  // implementation lowercases each file and calls indexOf per term, which
  // allocates a second copy of the whole tree and measured 1.5s on this
  // workspace against a locate that has to stay under a second.
  const rx = new RegExp(long.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const scored = [];
  let bytes = 0, truncated = false;
  for (const p of codeFiles()) {
    let text;
    try { text = readText(p); } catch { continue; }          // one unreadable file is not a failed locate
    bytes += text.length;
    rx.lastIndex = 0;
    let seen = 0, n = 0, first = -1, m;
    while ((m = rx.exec(text)) !== null) {
      const bit = 1 << idx.get(m[0].toLowerCase());
      if (!(seen & bit)) { seen |= bit; n++; if (first < 0) first = m.index; }
      if (n === long.length) break;                          // nothing left to learn about this file
    }
    if (n) scored.push({ path: p, n, first });
    if (bytes > maxBytes) { truncated = true; break; }
  }
  // Most distinct terms first, earliest match breaking the tie.
  scored.sort((a, b) => b.n - a.n || a.first - b.first);
  return scored.slice(0, cap).map((h) => {
    // The line is computed for the named files only. Splitting every file in
    // the tree to display twelve of them is the cost this avoids.
    const lines = readText(h.path).split("\n");
    const i = lines.findIndex((l) => { rx.lastIndex = 0; return rx.test(l); });
    return { file: rel(h.path), line: i + 1, text: (lines[i] || "").trim().slice(0, 100), terms: h.n, truncated };
  });
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
  const files = EDGE();
  if (!files.length) return [];
  const want = new Set([...ts.map((t) => t.toLowerCase()), ...scope.flatMap((f) => [path.basename(f).toLowerCase(), f.split("/")[0].toLowerCase()])]);
  const rows = [];
  for (const line of files.flatMap((p) => readText(p).split("\n"))) {
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
/** Detectors that report the shape of a file rather than a fault in it. A brief
 *  that carries one beside "do this task only, no cleanup" hands the session a
 *  cleanup job and a rule against doing it: the Terminal-Bench re-run's one
 *  brief told a crash fix to delete comments and name magic numbers in
 *  main.cpp. They still ride along when the task's own words are in the title.
 *  A TODO is not on the list: it is the author's note about the file. */
export const HYGIENE = /^(oversight:|anti-slop$|duplicate-blocks$|god-file$|dead-exports$|orphan-files$|debug-leftovers$|ui-generic$|doc-links$|worktree-hygiene$|missing-tests$|dead-config$)/;
const mentions = (title, tl) => tl.some((t) => String(title || "").toLowerCase().includes(t));
// Whether a hygiene finding is about THIS task. Plain words are no evidence: a
// long statement shares "code" and "lines" with every style score, which let
// bloat and vibe-coded ride along on a Terminal-Bench security fix. Two things
// are: an identifier the task names appearing in the title (refreshToken,
// parse_config, v2Handler), or the task using the detector's own words ("remove
// the duplicate blocks", "clean up the debug leftovers").
const IDENT = /[a-z][A-Z]|_|[A-Za-z]\d|\d[A-Za-z]/;
function aboutTask(f, ts) {
  const words = String(f.title || "").replace(/`[^`]*`/g, " ").replace(/\S*\/\S*|\S+\.[A-Za-z]{1,5}\b/g, " ").toLowerCase();
  const ids = ts.filter((t) => t.length >= 4 && IDENT.test(t) && !/[/.]/.test(t)).map((t) => t.toLowerCase());
  if (ids.some((t) => words.includes(t))) return true;
  const said = new Set(ts.map((t) => t.toLowerCase()));
  return String(f.detector || "").replace(/^oversight:/, "").split(/[-:_]/).some((w) => w.length >= 4 && (said.has(w) || said.has(w.replace(/s$/, ""))));
}
function evidence(scope, ts) {
  const set = new Set(scope);
  const tl = ts.map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return store.openFindings()
    .filter((f) => HYGIENE.test(String(f.detector || "")) ? aboutTask(f, ts)
      : mentions(f.title, tl) || (f.files || []).some((x) => set.has(x)) || set.has(f.path))
    .sort((p, q) => (rank[p.severity] ?? 4) - (rank[q.severity] ?? 4))
    .slice(0, 8)
    .map((f) => ({ id: f.id, detector: f.detector, severity: f.severity, title: String(f.title).slice(0, 160), fix_hint: String(f.fix_hint || "").slice(0, 160) }));
}
/** What the STORED oversight scan says about the scope. Never recomputed. */
function oversight(scope, ts = []) {
  const doc = oversightLatest();
  if (!doc) return null;
  const set = new Set(scope);
  // Every oversight rule is a hygiene rule (see HYGIENE): one reaches the
  // brief when the task is about what it measured, not because it sits on a
  // file in scope. The notes below stay: they are about reading the scope.
  const guidelines = (doc.findings || []).filter((f) => (f.files || []).some((x) => set.has(x)) && aboutTask(f, ts)).slice(0, 5)
    .map((f) => ({ rule: f.detector.replace(/^oversight:/, ""), title: f.title, hint: f.fix_hint }));
  const notes = [];
  for (const m of doc.files || []) if (set.has(m.path) && doc.capacity && m.tokens / doc.capacity >= 0.35) notes.push(`\`${m.path}\` is ${human(m.tokens)} tokens whole (${Math.round((100 * m.tokens) / doc.capacity)}% of one payload): read the region, not the file`);
  for (const p of doc.dupes?.pairs || []) {
    const a = rel(p.a), b = rel(p.b);
    for (const [near, far] of [[a, b], [b, a]]) if (set.has(near) && !set.has(far)) notes.push(`\`${near}\` shares ${p.shared_lines} lines with \`${far}\`: a fix here probably has to land there too`);
  }
  return { at: String(doc.at || "").slice(0, 10), guidelines, notes: notes.slice(0, 5) };
}

/** How many ranked files the scope STARTS with, before the cut loop trims it to
 *  FITS and the grow loop fills the headroom.
 *
 *  Twelve, not six, and the reason is cost rather than recall. Measured on the
 *  same 100 SWE-bench Verified instances, the same day, everything else equal:
 *
 *    max_files  in scope        named      packed     ratio
 *    6          82/126 65.1%    83.3%      336.3k     2.6x
 *    12         81/126 64.3%    83.3%      283.3k     3.1x
 *
 *  Recall is flat, one gold file of 126 apart, and the prompt is 16% smaller.
 *  The slice is not what decides the scope — the cut and grow loops are, and a
 *  larger starting slice reaches FITS without the grow loop spending its tries
 *  on files it then has to drop. Three instances gained a gold file and four
 *  lost one, which is the noise this sample can resolve, so this is a cost
 *  change and it is not evidence that a bigger slice localises better. */
export const MAX_FILES = 12;

/** The whole plan for one problem. `files` are explicit paths (rel or abs). */
export async function build(problem, { files = [], maxFiles = MAX_FILES, kind = "fix" } = {}) {
  const ts = terms(problem);
  const explicit = [...files.map((f) => rel(abs(f))), ...pathHits(ts)];
  const sym = await snapgen.symbolHits(ts);
  // Always, not only when the symbol index went quiet.
  //
  // The gate used to be `informative(sym) < 3`, which was written to catch a
  // silent index and then widened to catch a noisy one. It catches neither of
  // the cases that lost files on SWE-bench Verified: `django-12325` returns 661
  // informative symbol hits and still never names the file the fix belongs in,
  // because every one of those hits is a symbol whose name the statement
  // happens to share. An index can be loud and wrong, and a count of its hits
  // cannot tell you which it is.
  //
  // So the content search runs every time and the ranker weighs it against the
  // symbol evidence rather than a gate deciding in advance which one to trust.
  const grep = grepHits(ts);
  const { ranked, adjacent } = rankDetailed(problem, { explicit, sym, grep, terms: ts, universe: codeFiles().map(rel) });
  // `adjacent` earned its place on an import edge from the file this ranker put
  // first, not on anything the statement said. That is worth NAMING below the
  // scope line and not worth reading whole, so it is held out of the opening
  // scope and out of the grow loop, and falls through to the candidates.
  let scope = ranked.filter((f) => !adjacent.has(f)).slice(0, maxFiles);
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
  // ── and then the other direction ──────────────────────────────────────────
  //
  // Shrinking was the only move this had, and on a large tree that is exactly
  // the wrong one. Measured on SWE-bench Verified: the packed prompt came out
  // at 2–5k tokens against a 120k floor, with the ranked candidate immediately
  // below the cut often holding the file the fix belonged in. A window a
  // session has already paid the priming cost for and then uses 3% of is not
  // thrift, it is a miss — `underfilled` has said so since the budget model was
  // written and nothing acted on it.
  //
  // So: take the next-ranked candidate while the unit is under the FLOOR and
  // the addition still FITS. It stops at the floor, at GROW_CAP, or at
  // GROW_TRIES, whichever comes first. Nothing is ever added past FITS, so the
  // budget contract is unchanged.
  //
  // One correction to that, measured: the loop used to stop at the FIRST
  // candidate that did not fit, which on a tree holding one oversized file
  // stops it for every smaller file behind that one — and
  // after a cut the first candidate it tries is precisely the file the cut loop
  // just removed, so any unit that had to cut could never grow at all. Measured
  // on SWE-bench Verified that is where the localisation gap lived: on xarray
  // and seaborn the scope collapsed to 1-8 files at 3% of the window while the
  // gold file sat below the cut, named but not budgeted.
  //
  // So an unaffordable candidate is now SKIPPED, not fatal. The price of a
  // candidate is known before the unit is re-evaluated — payload plus that file
  // against the payload capacity for this kind — so the loop only re-evaluates
  // what it can actually afford, and GROW_TRIES bounds how far it looks.
  const grown = [];
  const payloadCap = context.capacity(kind, { brief: estimate.text(String(problem).trim(), "prose") });
  let tries = 0;
  for (const f of ranked.filter((x) => !adjacent.has(x)).slice(scope.length)) {
    if (!ev.underfilled || scope.length >= GROW_CAP || tries >= GROW_TRIES) break;
    tries++;
    if ((ev.parts?.payload || 0) + estimate.file(abs(f)) > payloadCap) continue;
    scope.push(f);
    const next = evalOf();
    if (next.verdict !== "FITS") { scope.pop(); continue; }
    grown.push(f);
    ev = next;
  }
  // ── what the task itself allows ───────────────────────────────────────────
  //
  // A statement that says "fix in user.cpp only" or "do not modify build.sh"
  // has already drawn part of the scope, and a brief that widens it hands the
  // guards a licence the task withheld. Measured on Terminal-Bench 2.0: asked
  // with both files named, the brief called `main.cpp` "the only files you may
  // edit" beside a task that said user.cpp only. Held files stay readable and
  // are named as held; they are not candidates, which the brief offers as
  // somewhere to go when the scope does not hold the cause.
  const bound = bounds(problem);
  const held = [];
  const pool = [...new Set([...scope, ...explicit, ...ranked])];
  for (const t of bound.keepOut) {
    const f = named(t, pool);
    if (f && scope.includes(f)) { scope.splice(scope.indexOf(f), 1); held.push(f); }
  }
  const allowed = bound.only.map((t) => named(t, pool)).filter((f) => f && !held.includes(f));
  if (allowed.length) {
    for (const f of [...scope]) if (!allowed.includes(f)) { scope.splice(scope.indexOf(f), 1); held.push(f); }
    for (const f of allowed) if (!scope.includes(f)) scope.push(f);
  }
  if (held.length || allowed.length) ev = evalOf();
  // Files the task says to make and the tree does not hold yet. Joined to the
  // scope after the budget is settled: a file that does not exist costs nothing
  // to read, and a scope without it tells the session the file is off limits.
  const creates = [];
  for (const t of bound.create) {
    let r = ""; try { r = rel(abs(t)); } catch { /* not a path this tree can hold */ }
    if (!r || r.startsWith("..") || path.isAbsolute(r) || fs.existsSync(abs(r)) || held.includes(r) || scope.includes(r)) continue;
    creates.push(r);
  }
  scope.push(...creates);
  // ── the candidates the budget could not afford ────────────────────────────
  //
  // Everything below the scope used to be thrown away. That is wrong by an
  // order of magnitude in cost: a file in scope is budgeted to be READ, which
  // costs its whole size times churn, while NAMING one costs about fifteen
  // tokens. Measured on SWE-bench Verified, the file the maintainer actually
  // changed sat just outside the scope on most large-repository instances —
  // the ranker had found it and the budget threw it out silently.
  //
  // So the brief names them, with the line that ranked them and an explicit
  // instruction that they are not in scope. A session that finds the scope does
  // not hold the answer now has somewhere to go that is not a search.
  const inScope = new Set([...scope, ...held]);
  const bestHit = new Map();
  for (const h of sym) if (!bestHit.has(h.file)) bestHit.set(h.file, h);
  const candidates = ranked.filter((f) => !inScope.has(f)).slice(0, CANDIDATE_CAP)
    .map((f) => ({ file: f, symbol: bestHit.get(f)?.symbol || "", line: bestHit.get(f)?.line || 0,
      tokens: estimate.file(abs(f)) }));

  const gates = detectGates(ROOT);
  const b = {
    problem: String(problem).trim(), kind, terms: ts, scope, creates, cut, grown, candidates, held, ranked: ranked.length, anchors,
    symbols: sym.filter((h) => scope.includes(h.file)).slice(0, 12), grep: grep.slice(0, 6),
    evidence: evidence(scope, ts), gates, traps: traps(scope, ts), oversight: oversight(scope, ts), process: processRules(),
    projected: ev.projected, ceiling: ev.ceiling, verdict: ev.verdict, headroom: ev.headroom, payload_saved: ev.payload_saved,
    tables: await tablesFor(),
    via: { symbols: snapgen.symbolIndex().via, anchors: anchors.length ? (anchors.every((a) => a.via === "kernel") ? "kernel" : anchors.some((a) => a.via === "kernel") ? "mixed" : "js") : null },
  };
  // What the last `bb echos` measured about this locate's own aim, read from
  // one stat rather than recomputed: building the join here would put a walk
  // over every transcript inside a 15s hook budget, and the number does not
  // move between two briefs. Null until something has measured it, and the
  // signal that reads it stays quiet on null.
  b.locate = aim.cached();
  // Scored after the cut loop, because cutting for budget is itself one of the
  // things the brief does not settle.
  b.ambiguity = ambiguity(b);
  b.proposals = proposals(b);
  // The locate can only name files in the languages it indexes. On a tree that
  // is mostly something else, what it names is the indexed minority, and a
  // brief that calls that minority "the only files to edit" is confidently
  // wrong: fix-ocaml-gc on Terminal-Bench 2.0 (a C runtime change) was handed
  // gdb.py, lldb.py and the manual's JavaScript. A prompt that names a file
  // still gets its brief; otherwise the scope is dropped, the prompt says why,
  // and the prompt hook's empty-locate rule keeps the band out of the window.
  b.coverage = coverage();
  b.abstain = b.coverage.partial && !explicit.length;
  if (b.abstain) {
    b.scope = []; b.cut = []; b.candidates = []; b.anchors = []; b.symbols = []; b.grep = []; b.proposals = [];
  }
  // Whether the brief says anything the caller did not already know. With no
  // symbol hit, no content hit, no region and no file beyond the ones named,
  // the full brief is 600 tokens of rules and empty sections around the
  // caller's own file list (or the file the task itself says is the only one to change): the one bb_pinpoint call on the Terminal-Bench
  // re-run got exactly that, for two C++ files the index cannot read. Such a
  // brief is two lines, and the prompt hook emits nothing for it.
  const told = new Set([...explicit, ...allowed, ...creates]);
  b.adds = !b.abstain && (b.symbols.length > 0 || b.grep.length > 0 || b.anchors.length > 0 || b.scope.some((f) => !told.has(f)));
  b.prompt = b.abstain ? abstainPrompt(b) : b.adds ? prompt(b) : nothingPrompt(b);
  b.path = write(b);
  return b;
}

/** Code files the locate cannot see. Not a complete list of languages, a list
 *  of the ones whose trees would otherwise be scoped by their few indexed
 *  files: C and C++, Objective-C, OCaml, Lisps, Haskell, Lua, Scala, Elixir,
 *  Erlang, COBOL, Fortran, Julia, R, Zig, Nim, Solidity, Perl, assembly. */
const UNINDEXED = [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".m", ".mm", ".ml", ".mli", ".scm", ".ss", ".rkt",
  ".lisp", ".el", ".clj", ".cljs", ".hs", ".lua", ".scala", ".ex", ".exs", ".erl", ".cbl", ".cob", ".cpy", ".f", ".f90", ".jl",
  ".r", ".zig", ".nim", ".sol", ".pl", ".pm", ".groovy", ".fs", ".vb", ".pas", ".adb", ".ads", ".elm", ".s", ".asm"];
const SEEN = new Set(SYMBOL_SUFFIX);
/** How much of the tree's code the locate can name. `partial` when the files in
 *  unindexed languages outnumber the indexed ones and there are at least ten
 *  of them, so a stray script does not switch a repository off. */
export function coverage(files = sourceFiles()) {
  let indexed = 0;
  const other = {};
  for (const f of files) {
    const e = path.extname(f).toLowerCase();
    if (SEEN.has(e)) indexed++;
    else if (UNINDEXED.includes(e)) other[e] = (other[e] || 0) + 1;
  }
  const unindexed = Object.values(other).reduce((a, n) => a + n, 0);
  const top = Object.entries(other).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4);
  return { indexed, unindexed, partial: unindexed >= 10 && unindexed > indexed, top: top.map(([e, n]) => `${e} ${n}`) };
}

function nothingPrompt(b) {
  const L = [`# ${b.problem}`, "",
    `bundlebox pinpoint found nothing beyond the files named: no symbol or content match for this task's words and no region to quote. Scope stays as named: ${b.scope.length ? b.scope.map((f) => `\`${f}\``).join(", ") : "(none)"}.`];
  if (b.held.length) L.push(`Read, do not edit (the task holds these): ${b.held.map((f) => `\`${f}\``).join(", ")}.`);
  if (b.coverage.partial) L.push(`Most of this tree is in languages the index does not read (${b.coverage.top.join(", ")}); search it directly.`);
  return clean(L.join("\n"));
}

function abstainPrompt(b) {
  const c = b.coverage;
  return clean([`# ${b.problem}`, "",
    `bundlebox pinpoint located nothing for this task: ${c.unindexed} of this tree's ${c.unindexed + c.indexed} code files are in languages it does not index (${c.top.join(", ")}), so any scope it drew would come from the ${c.indexed} it does. Search the tree directly. \`bb context <files>\` still prices a scope you choose, and naming a file in the task gets a brief scoped to it.`].join("\n"));
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

// ── the change, not only the coordinates ────────────────────────────────────
//
// A brief that says where the code is and stops leaves the session to spend
// its next turns working out what to write, and every turn replays the whole
// window (measured: 19,240 tokens of harness prompt per turn, 51% of a bare
// run). When the statement itself spells the edit out — `old` -> `new`,
// "rename `a` to `b`" — and the old text occurs at exactly one place in the
// located regions, the brief carries the diff. Exactly one: two occurrences is
// a choice, and a diff that chose wrong costs the undo on top of the fix,
// which is more than no diff at all.

/** The edits a statement spells out, as {from, to} pairs. Only backticked
 *  spans count: a bare word is a description, a span is a string to match. */
export function statedEdits(problem) {
  const p = String(problem || "");
  const rx = [
    /`([^`\n]+)`\s*(?:->|→|=>)\s*`([^`\n]+)`/g,
    /\b(?:replace|swap)\s+`([^`\n]+)`\s+(?:with|by|for)\s+`([^`\n]+)`/gi,
    /\b(?:rename|change|turn|set|bump|update|raise|lower)\s+`([^`\n]+)`\s+(?:to|into)\s+`([^`\n]+)`/gi,
    /`([^`\n]+)`\s+(?:should|must)\s+(?:be|read|become)\s+`([^`\n]+)`/gi,
  ];
  const seen = new Set(), out = [];
  for (const r of rx) for (const m of p.matchAll(r)) {
    if (m[1] === m[2] || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ from: m[1], to: m[2] });
  }
  return out;
}

/** One unified diff per stated edit whose `from` occurs once, on one line, in
 *  one located region. Anything else is skipped without comment: the section
 *  is absent rather than hedged. */
export function proposals(b, { context = 3 } = {}) {
  const out = [];
  for (const e of statedEdits(b.problem)) {
    const hits = [];
    for (const a of b.anchors || []) {
      const lines = String(a.text || "").split("\n");
      lines.forEach((l, i) => { if (l.includes(e.from)) hits.push({ a, i, lines }); });
    }
    if (hits.length !== 1) continue;
    const { a, i, lines } = hits[0];
    if (lines[i].split(e.from).length !== 2) continue;
    const lo = Math.max(0, i - context), hi = Math.min(lines.length, i + context + 1);
    const start = a.line_start + lo;
    const diff = [
      `--- a/${a.path}`, `+++ b/${a.path}`,
      `@@ -${start},${hi - lo} +${start},${hi - lo} @@`,
      ...lines.slice(lo, i).map((x) => ` ${x}`),
      `-${lines[i]}`, `+${lines[i].replace(e.from, e.to)}`,
      ...lines.slice(i + 1, hi).map((x) => ` ${x}`),
    ].join("\n");
    out.push({ file: a.path, line: a.line_start + i, symbol: a.symbol || "", from: e.from, to: e.to, diff });
  }
  return out;
}

// The order is the cache. Everything that is the same for every task on this
// tree comes first — the preamble, the tables, the workspace's process rules —
// and the problem statement opens the varying part. A run then pays cache-read
// rates on the prefix instead of prefilling it again.
export function prompt(b) {
  const L = [PREAMBLE, "",
    `Reference tables, read instead of searching: ${b.tables.length ? b.tables.join(", ") : "(none built; `bb snapgen build`)"}`];
  if (b.process.length) L.push("", "Process rules this workspace measured itself needing:", ...b.process);
  L.push("", `# ${b.problem}`, "", "## Where — located");
  for (const h of b.symbols) L.push(`- \`${h.file}:${h.line}\` — \`${h.symbol}\``);
  for (const h of b.grep) L.push(`- \`${h.file}:${h.line}\` — ${h.text}`);
  if (!b.symbols.length && !b.grep.length) L.push("- nothing in the symbol tables matched the problem's words; the scope below is the best path match");
  L.push("", "## The regions this touches — quoted, current");
  if (b.anchors.length) for (const a of b.anchors.slice(0, 6)) L.push("", `\`${a.path}\` lines ${a.line_start}-${a.line_end} (~${a.tokens} tokens)`, "```", anchorsMod.excerpt(a, 900), "```");
  else L.push("- no region located; the scope files are costed whole");
  if (b.proposals && b.proposals.length) {
    L.push("", "## Proposed change — apply it, then run the gate");
    for (const p of b.proposals) L.push("", `\`${p.file}:${p.line}\`${p.symbol ? ` in \`${p.symbol}\`` : ""}: \`${p.from}\` → \`${p.to}\`, from the statement, one occurrence in the located regions.`, "```diff", p.diff, "```");
  }
  L.push("", "## Scope — the only files you may edit");
  for (const f of b.scope) L.push((b.creates || []).includes(f) ? `- \`${f}\` (new: the task says to create it)` : `- \`${f}\` (~${human(estimate.file(abs(f)))} tokens)`);
  if (b.cut.length) L.push(`- ask before opening these: ${b.cut.map((c) => `\`${c}\``).join(", ")} (cut for budget)`);
  if (b.held && b.held.length) L.push(`- read, do not edit — the task holds these: ${b.held.map((c) => `\`${c}\``).join(", ")}`);
  if (b.candidates && b.candidates.length) {
    L.push("", "## If the scope does not hold it — ranked, not budgeted", "Not in scope. Open one only if Scope does not hold the cause, and say which.");
    for (const c of b.candidates) L.push(`- \`${c.file}${c.line ? `:${c.line}` : ""}\`${c.symbol ? ` — \`${c.symbol}\`` : ""} (~${human(c.tokens)} tokens whole)`);
  }
  L.push("", "## Evidence already on file");
  if (b.evidence.length) for (const e of b.evidence) L.push(`- [${e.detector}/${e.severity}] ${e.title}${e.fix_hint ? ` → ${e.fix_hint}` : ""}`);
  else L.push("- no open finding touches this scope");
  L.push("", "## Done when");
  const g = b.gates || {};
  if (g.quick) L.push(`    ${g.quick}`);
  if (g.full && g.full !== g.quick) L.push(`    ${g.full}   # before the PR`);
  if (!g.quick && !g.full) L.push("    (no gate detected: state in one line what you ran)");
  L.push("", "## Traps");
  if (b.traps.length) for (const t of b.traps) L.push(`- ${t}`);
  else L.push("- none recorded for these files");
  const ov = b.oversight;
  L.push("", `## What is already known about these files (bb oversight, ${ov?.at || "no scan on file"})`);
  if (ov && (ov.guidelines.length || ov.notes.length)) {
    for (const gl of ov.guidelines) L.push(`- **${gl.rule}** — ${gl.title}${gl.hint ? `. ${gl.hint}` : ""}`);
    for (const n of ov.notes) L.push(`- ${n}`);
  } else L.push(ov ? "- nothing measured against these files" : "- run `bb oversight scan` to fill this");
  L.push("", "## What this brief does not settle");
  for (const l of ambiguityLines(b.ambiguity)) L.push(l);
  // Through the anti-slop pass on the way out. This is the document in this
  // tree with the strongest claim to it: every brief here is READ BY A MODEL
  // AND BILLED, so a hedge is not a style complaint, it is tokens the lane pays
  // for and then has to decide to ignore. `clean` masks fenced blocks and inline
  // spans, so the quoted regions and the gate command come back byte for byte;
  // only the prose around them is touched, and only by deletions and
  // one-for-one replacements.
  return clean(L.join("\n")) + "\n";
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
    usage: "bb pinpoint \"<problem>\" [--files a,b] [--max-files N] [--kind fix|verify|investigate|build|write] [--print] [--json]\n     bb pinpoint gaps [--no-findings] [--no-auditor] [--max N]   every measured gap as a located brief\n     bb pinpoint next [N] [--print]                              make a worklist row the active brief",
    run: async ({ _, flags }) => {
      // The two sub-verbs come first: a worklist row is a problem somebody
      // already stated, and re-stating it on the command line is the work this
      // whole file exists to avoid.
      if (_[0] === "gaps" || _[0] === "next") {
        const w = await import("./worklist.js");
        return w.commands[_[0]].run({ _: _.slice(1), flags });
      }
      const problem = _.join(" ").trim();
      if (!problem) { warn(commands.pinpoint.usage); return 2; }
      const b = await build(problem, { files: list(flags.files), maxFiles: Number(flags.maxFiles) || MAX_FILES, kind: flags.kind ? String(flags.kind) : "fix" });
      if (flags.json) { emit(b); return 0; }
      out(report(b));
      if (flags.print) out("", b.prompt.trimEnd());
      return 0;
    },
  },
};
