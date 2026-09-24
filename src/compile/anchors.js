// anchors.js — the region of a file a unit actually needs, not the whole file.
//
// This is the single largest token lever in the factory, and it is a
// measurement rather than an opinion. In the reference workspace one file was
// 55,465 tokens and the table a finding was about was 892 tokens at lines
// 2716-2741. Across seven areas the tables were 3.5% of the files the compiler
// was naming as scope, so a brief that says "scope: auth.mjs" asks a session to
// read thirty times what it needs and then pays the churn multiplier on all of it.
//
// An anchor is that region, located exactly:
//
//     {path, symbol, line_start, line_end, tokens, text}
//
// Two things use it. The BRIEF pastes the region inline, so the common case is a
// session that never opens the file at all. The ESTIMATOR costs the region plus
// a widening allowance instead of the file, so the router stops splitting lanes
// that were never large.
//
// The allowance is the honest part. A fix sometimes has to touch the code that
// SERVES the table, not just the table, and that code is outside the anchor. So
// the scope stays the whole file (a lane may widen) while the budget assumes it
// usually will not. `budget.anchor_widen` is that bet, and `bb savings` is where
// it gets checked against what lanes really spent.
import fs from "node:fs";
import { load } from "../core/config.js";
import { abs, rel } from "../core/paths.js";
import { kindOf, langOf, readText } from "../core/fs.js";
import * as estimate from "../tokens/estimate.js";
import { slug } from "../core/util.js";

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Languages whose line comment is `#`. Everything else gets `//` and `/* */`.
// C's `#define` is not a comment and C is not in this set.
const HASH_COMMENT = new Set(["py", "ruby", "sh", "yaml", "yml", "toml", "r", "pl", "perl", "make", "ex", "exs"]);
const INDENT_BODY = new Set(["py"]);
const CONTROL = "(?!\\s*(?:return|if|else|for|while|switch|case|throw|await|yield|new|do|try|catch)\\b)";

// Declaration shapes per language family. Order matters: keyword forms first,
// then typed/assignment forms, because "SYM(" alone also matches a call site
// and the keyword forms cannot.
function patterns(lang, sym) {
  const S = esc(sym);
  if (lang === "js" || lang === "ts" || lang === "vue" || lang === "svelte") {
    return [
      `^[ \\t]*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*${S}\\s*[(<]`,
      `^[ \\t]*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+${S}\\b`,
      `^[ \\t]*(?:export\\s+(?:declare\\s+)?)?(?:const|let|var)\\s+${S}\\s*(?::[^=\\n]+)?=`,
      `^[ \\t]*(?:export\\s+(?:declare\\s+)?)?(?:interface|type|enum|namespace)\\s+${S}\\b`,
      `^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s+${S}\\s*\\(`,
      `^[ \\t]*(?:(?:public|private|protected|static|readonly|async|override|get|set)\\s+)*\\*?\\s*${S}\\s*(?:<[^>\\n]*>)?\\s*\\([^)\\n]*\\)\\s*(?::\\s*[^{\\n]+)?\\s*\\{`,
      `^[ \\t]*${S}\\s*:\\s*(?:async\\s*)?(?:function\\b|\\()`,
    ];
  }
  if (lang === "py") {
    return [
      `^[ \\t]*(?:async\\s+)?def\\s+${S}\\s*\\(`,
      `^[ \\t]*class\\s+${S}\\b`,
      `^[ \\t]*${S}\\s*(?::[^=\\n]+)?=(?!=)`,
    ];
  }
  if (lang === "go") {
    return [
      `^func\\s*(?:\\([^)]*\\)\\s*)?${S}\\s*[(\\[]`,
      `^type\\s+${S}\\b`,
      `^(?:var|const)\\s+${S}\\b`,
      `^[ \\t]*${S}\\s+[\\w.*\\[\\]]+(?:\\s*=|\\s*$|\\s+\`)`,
    ];
  }
  // dart, java, kotlin, rust, c, cpp, csharp, swift, php, scala, and anything brace-shaped.
  return [
    `^[ \\t]*(?:[\\w@]+(?:\\([^)\\n]*\\))?\\s+)*(?:class|struct|enum|interface|trait|mixin|extension|object|record|typedef|protocol|namespace|union|mod|impl(?:<[^>\\n]*>)?(?:\\s+[\\w<>:,]+\\s+for)?|fn|fun|func|def|type)\\s+${S}\\b`,
    `^[ \\t]*#\\s*define\\s+${S}\\b`,
    `^[ \\t]*${CONTROL}(?:[\\w@.]+(?:\\([^)\\n]*\\))?(?:<[^=\\n({]*>)?[\\[\\]*&?!]*\\s+)+${S}\\s*(?:<[^>\\n]*>)?\\s*[(=:{]`,
    `^[ \\t]*${S}\\s*\\([^)\\n]*\\)\\s*(?:async\\s*|const\\s*)?\\{`,
  ];
}

const lineStartOf = (src, i) => src.lastIndexOf("\n", i - 1) + 1;
const lineEndOf = (src, i) => { const j = src.indexOf("\n", i); return j < 0 ? src.length : j; };

function findClose(src, from, q) {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src.startsWith(q, i)) return i + q.length;
    i++;
  }
  return src.length;
}
function sameLineClose(src, from, q) {
  let i = from;
  while (i < src.length && src[i] !== "\n") {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === q) return i;
    i++;
  }
  return -1;
}

/** End index (exclusive, at a newline or EOF) of the statement that starts at
 *  `from`: the first line boundary reached with every bracket closed. Braces
 *  inside strings and comments are skipped, because one `{` in a doc comment
 *  otherwise makes the "region" run to the end of the file and the anchor
 *  silently costs the whole file it was meant to avoid. */
export function scanEnd(src, from, lang) {
  const hash = HASH_COMMENT.has(lang);
  const n = src.length;
  let depth = 0, i = from;
  while (i < n) {
    const c = src[i];
    if (hash && c === "#") { i = lineEndOf(src, i); continue; }
    if (!hash && c === "/" && src[i + 1] === "/") { i = lineEndOf(src, i); continue; }
    if (!hash && c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const triple = c !== "`" && src.startsWith(c.repeat(3), i);
      if (triple || c === "`") { i = findClose(src, i + (triple ? 3 : 1), triple ? c.repeat(3) : c); continue; }
      // A quote that does not close on its line is not a string (a Rust
      // lifetime, an apostrophe). Treating it as one swallows the file.
      const j = sameLineClose(src, i + 1, c);
      i = j >= 0 ? j + 1 : i + 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth = Math.max(0, depth - 1);
    else if (c === "\n" && depth === 0) {
      // Allman braces: `void f()` on one line, `{` on the next.
      if (/^[ \t]*\{/.test(src.slice(i + 1, i + 80))) { i++; continue; }
      return i;
    }
    i++;
  }
  return n;
}

function indentOf(line) { return /^[ \t]*/.exec(line)[0].length; }

/** Python-style body: after the header line(s), every following line that is
 *  blank or indented deeper than the declaration belongs to it. */
function indentBodyEnd(src, headerEnd, declIndent) {
  const lines = src.slice(headerEnd + 1).split("\n");
  let keep = 0;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) <= declIndent) break;
    keep = k + 1;
  }
  if (!keep) return headerEnd;
  let end = headerEnd;
  for (let k = 0; k < keep; k++) end += lines[k].length + 1;
  return end;
}

function region(p, src, c0, c1, symbol) {
  let text = src.slice(c0, c1);
  text = text.replace(/\s+$/, "");
  const line_start = src.slice(0, c0).split("\n").length;
  const line_end = line_start + text.split("\n").length - 1;
  return { path: rel(p), symbol, line_start, line_end, text, tokens: estimate.text(text, kindOf(p)) };
}

function markdownLocate(p, src, symbol) {
  const lines = src.split("\n");
  const want = symbol.trim().toLowerCase();
  const wantSlug = slug(symbol);
  let fence = false, hit = -1, level = 0;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (!m) continue;
    if (hit < 0) {
      const t = m[2].trim();
      if (t.toLowerCase() === want || slug(t) === wantSlug) { hit = k; level = m[1].length; }
      continue;
    }
    if (m[1].length <= level) {
      return sectionRegion(p, lines, hit, k - 1, symbol);
    }
  }
  return hit < 0 ? null : sectionRegion(p, lines, hit, lines.length - 1, symbol);
}
function sectionRegion(p, lines, from, to, symbol) {
  while (to > from && lines[to].trim() === "") to--;
  const text = lines.slice(from, to + 1).join("\n");
  return { path: rel(p), symbol, line_start: from + 1, line_end: to + 1, text, tokens: estimate.text(text, kindOf(p)) };
}

/** Where `symbol` is declared in `path`, as a costed region.
 *
 *  Returns null rather than guessing. A missing anchor falls the unit back to
 *  whole-file costing, which is the old behaviour and is merely expensive. A
 *  WRONG anchor under-budgets a lane, which is the failure that costs a whole
 *  session twice. */
export function locate(p, symbol) {
  if (!symbol || !p) return null;
  const a = abs(p);
  try { if (!fs.statSync(a).isFile()) return null; } catch { return null; } // not on disk: no anchor
  const src = readText(a);
  if (!src) return null;
  const lang = langOf(a);
  if (lang === "md" || lang === "markdown" || lang === "mdx") return markdownLocate(a, src, symbol);

  for (const pat of patterns(lang, symbol)) {
    let m;
    try { m = new RegExp(pat, "m").exec(src); } catch { continue; } // a pattern the symbol broke matches nothing
    if (!m) continue;
    const c0 = lineStartOf(src, m.index);
    let c1 = scanEnd(src, m.index, lang);
    if (INDENT_BODY.has(lang)) c1 = indentBodyEnd(src, c1, indentOf(src.slice(c0, lineEndOf(src, c0))));
    return region(a, src, c0, c1, symbol);
  }
  return null;
}

/** A region built from line numbers, for findings whose subject is a scattering
 *  of lines (a doc's broken links) rather than one declaration. */
export function lineAnchor(p, line, radius = 3) {
  const lines = (Array.isArray(line) ? line : [line]).map(Number).filter(Number.isInteger);
  if (!lines.length || !p) return null;
  const a = abs(p);
  try { if (!fs.statSync(a).isFile()) return null; } catch { return null; } // not on disk: no anchor
  const src = readText(a).split("\n");
  const want = new Set();
  for (const n of lines) for (let k = Math.max(1, n - radius); k <= Math.min(src.length, n + radius); k++) want.add(k);
  const kept = [...want].sort((x, y) => x - y);
  if (!kept.length) return null;
  const text = kept.map((n) => `${n}: ${src[n - 1]}`).join("\n");
  return { path: rel(a), symbol: `${lines.length} site${lines.length === 1 ? "" : "s"}`,
    line_start: kept[0], line_end: kept[kept.length - 1], text, tokens: estimate.text(text, kindOf(a)) };
}

/** A region named by explicit line numbers, for a HAND-FILED finding whose
 *  filer already read the file. Out-of-range numbers return null for the same
 *  reason `locate` does. */
export function rangeAnchor(p, start, end, symbol = "") {
  if (!p) return null;
  const a = abs(p);
  try { if (!fs.statSync(a).isFile()) return null; } catch { return null; } // not on disk: no anchor
  // A range the filer did not state as two integers is not a range. Coercing
  // "abc" to line 1 would anchor the top of the file and under-budget the lane.
  if (!Number.isInteger(Number(start)) || !Number.isInteger(Number(end))) return null;
  const src = readText(a).split("\n");
  const s = Math.max(1, Number(start)), e = Math.min(src.length, Number(end));
  if (e < s) return null;
  const out = [];
  for (let n = s; n <= e; n++) out.push(`${n}: ${src[n - 1]}`);
  const text = out.join("\n");
  return { path: rel(a), symbol: symbol || `lines ${s}-${e}`, line_start: s, line_end: e, text, tokens: estimate.text(text, kindOf(a)) };
}

// ── deriving anchors from a finding ───────────────────────────────────────────

function forFinding(f) {
  const ev = f.evidence || {};
  const primary = f.path || (f.files || [])[0] || "";
  const out = [];
  const push = (a) => { if (a) out.push(a); };
  try {
    // evidence.regions: [{path, from, to, symbol?}] — the filer named the range.
    for (const r of Array.isArray(ev.regions) ? ev.regions : []) {
      if (r && typeof r === "object") push(rangeAnchor(r.path || primary, r.from, r.to, r.symbol || ""));
    }
    if (out.length) return out;
    // evidence.symbols: ["name", ...] | [{path, symbol}] | {symbol: path}
    const syms = ev.symbols;
    if (Array.isArray(syms)) {
      for (const s of syms) {
        if (typeof s === "string") push(locate(primary, s));
        else if (s && typeof s === "object") push(locate(s.path || primary, s.symbol || s.name));
      }
    } else if (syms && typeof syms === "object") {
      for (const [s, where] of Object.entries(syms)) push(locate(typeof where === "string" ? where : (Array.isArray(where) ? where[0] : primary), s));
    }
    // evidence.lines: [12, 40] | [{path, line}] | {path: [lines]}
    const ls = ev.lines;
    const byFile = new Map();
    const add = (pth, n) => { if (pth && Number.isInteger(n)) { if (!byFile.has(pth)) byFile.set(pth, []); byFile.get(pth).push(n); } };
    if (Array.isArray(ls)) for (const x of ls) { if (typeof x === "number") add(primary, x); else if (x && typeof x === "object") add(x.path || x.file || primary, x.line); }
    else if (ls && typeof ls === "object") for (const [pth, arr] of Object.entries(ls)) for (const n of Array.isArray(arr) ? arr : [arr]) add(pth, n);
    for (const [pth, nums] of byFile) push(lineAnchor(pth, nums));
  } catch {
    // An anchor is an optimisation. A throw here must never fail a compile.
    return [];
  }
  return out;
}

/** Deduplicated anchors across a unit's findings, largest first. Empty means
 *  "cost the files whole". */
export function forFindings(findings) {
  const seen = new Map();
  for (const f of findings || []) {
    for (const a of forFinding(f)) {
      const k = `${a.path}|${a.symbol}|${a.line_start}`;
      if (!seen.has(k)) seen.set(k, a);
    }
  }
  return [...seen.values()].sort((x, y) => y.tokens - x.tokens);
}

/** What this unit's files cost, given the regions it actually needs. An
 *  anchored file is costed at its region plus `budget.anchor_widen` of the rest
 *  of the file; an unanchored file is costed whole, unchanged. */
export function payload(scope, anchors) {
  const widen = load().budget.anchor_widen ?? 0.15;
  const est = estimate.files(scope || []);
  const byPath = new Map();
  for (const a of anchors || []) { if (!byPath.has(a.path)) byPath.set(a.path, []); byPath.get(a.path).push(a); }
  const files = {};
  let saved = 0;
  for (const [p, whole] of Object.entries(est.files)) {
    const regions = byPath.get(p);
    if (!regions) { files[p] = whole; continue; }
    const regionCost = regions.reduce((s, a) => s + (a.tokens || 0), 0);
    const cost = Math.min(whole, Math.floor(regionCost + Math.max(0, whole - regionCost) * widen));
    files[p] = cost;
    saved += whole - cost;
  }
  return { files, total: Object.values(files).reduce((s, n) => s + n, 0), whole_total: est.total, saved,
    missing: est.missing, bytes: est.bytes, anchored: [...byPath.keys()].filter((p) => p in files).sort() };
}

/** The region as it goes into a brief. Truncated by LINES, never mid-token:
 *  half a map literal in a brief is worse than a pointer to the whole file. */
export function excerpt(a, maxTokens = 1600) {
  const head = `${a.path}:${a.line_start}-${a.line_end}  (${a.symbol})`;
  if (!a.text) return head;
  if ((a.tokens || 0) <= maxTokens) return `${head}\n${a.text}`;
  const lines = a.text.split("\n");
  let keep = Math.max(8, Math.floor(lines.length * maxTokens / Math.max(1, a.tokens)));
  // A dense region can be over budget in fewer than 8 lines. The original
  // printed "... -3 more lines" here; there is nothing to cut by lines, so
  // quote it whole rather than lie about a remainder.
  if (keep >= lines.length) return `${head}\n${a.text}`;
  const rest = lines.length - keep;
  return `${head}\n${lines.slice(0, keep).join("\n")}\n... ${rest} more lines — read ${a.path} offset ${a.line_start + keep} limit ${rest}`;
}
