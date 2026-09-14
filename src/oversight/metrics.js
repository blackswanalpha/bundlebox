// metrics.js — what a file measurably is, before anyone argues about it.
//
// Every number here is a count or a parse over one file's text. Nothing
// sampled, nothing weighted, no model: a claim about code quality that cannot
// be recomputed from the file is an opinion, and an opinion does not justify
// opening a session.
//
// Three groups. SIZE (lines, tokens, declarations) is what a file costs to
// read. SHAPE (function lengths, nesting) is what it costs to change. MARKS are
// the residue of code that was generated and accepted rather than designed:
// a comment that restates the line under it, a block left commented out, a
// `V2` beside a `V1`, a check switched off, an error dropped, a number nobody
// named. None of them is a defect alone; the rules compare their DENSITY with
// the tree's own median, which is the only comparison that is a measurement.
import fs from "node:fs";
import path from "node:path";
import { VAR, rel, abs } from "../core/paths.js";
import { readText, langOf } from "../core/fs.js";
import { readJson, writeJson } from "../core/config.js";
import { median } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { isTest } from "../detectors/_shared.js";

// ── language facts ───────────────────────────────────────────────────────────

const HASH = new Set(["py", "ruby", "sh", "yaml", "yml", "toml", "r", "perl", "pl", "make", "ex", "exs", "nim"]);
const DASH = new Set(["sql", "lua", "hs", "haskell", "elm", "ada"]);
const INDENT = new Set(["py"]);
const MEASURED = new Set(["js", "ts", "py", "go", "rust", "java", "kotlin", "swift", "csharp", "dart", "c", "cpp", "h", "hpp",
  "scala", "ruby", "php", "sh", "lua", "sql", "ex", "exs", "vue", "svelte", "zig"]);
/** {line, blockOpen, blockClose} comment syntax for a language. */
export function commentSyntax(lang) {
  if (HASH.has(lang)) return { line: "#", blockOpen: null, blockClose: null };
  if (DASH.has(lang)) return { line: "--", blockOpen: "/*", blockClose: "*/" };
  return { line: "//", blockOpen: "/*", blockClose: "*/" };
}
export const measurable = (p) => MEASURED.has(langOf(p));

const ID = "[A-Za-z_$][\\w$]*";
const KW = /^(if|for|while|switch|catch|else|return|do|try|with|elif|except|match|case|when|unless|until|foreach|new|typeof|await|yield|function|super|this)$/;
// Where a function starts, per language family. The brace (or the def line's
// indent) says where it ends; the regex only has to find the opening.
const FUNC = {
  js: [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})?\\s*\\(`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${ID})\\s*=>`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\\s+)*(${ID})\\s*\\([^)]*\\)\\s*(?::[^{;=]+)?\\{\\s*$`)],
  py: [new RegExp(`^([ \\t]*)(?:async\\s+)?def\\s+(${ID})\\s*\\(`)],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)?/],
  rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+"C"\s+)*fn\s+(\w+)/],
  ruby: [/^\s*def\s+(?:self\.)?(\w+)/],
  cfamily: [/^\s*(?:(?:public|private|protected|static|final|abstract|override|async|virtual|inline|const|constexpr|suspend|open|internal|extern)\s+)*(?:fun|func|def)\s+(\w+)/,
    /^\s*(?:(?:public|private|protected|static|final|abstract|override|async|virtual|inline|const|constexpr|suspend|open|internal|extern|unsigned)\s+)*[\w<>\[\]?.,:*&]+\s+\*?(\w+)\s*\([^;{]*\)\s*(?:const\s*|async\s*|throws\s+[\w, .]+\s*)?(?:\{|$)/],
};
const familyOf = (lang) => FUNC[lang] ? lang : lang === "ts" || lang === "vue" || lang === "svelte" ? "js" : ["java", "kotlin", "swift", "csharp", "dart", "c", "cpp", "h", "hpp", "scala", "php", "zig"].includes(lang) ? "cfamily" : null;

// ── the marks ────────────────────────────────────────────────────────────────

export const SUPPRESS = /\/\/\s*ignore(?:_for_file)?:|#\s*type:\s*ignore|#\s*noqa|@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|#\s*pylint:\s*disable|\/\/\s*coverage:\s*ignore|#\s*pragma:\s*no\s*cover|#\[allow\(|@SuppressWarnings|@suppress|\bnolint\b/g;
export const SWALLOW = /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except[^\n:]*:\s*(?:#[^\n]*)?\n\s*(?:pass|\.\.\.)\b|except[^\n:]*:\s*pass\b|rescue\b[^\n]*\n\s*end\b|\bon\s+\w+\s+catch\s*\([^)]*\)\s*\{\s*\}/g;
export const DEFERRED = /\b(?:TODO|FIXME|XXX|HACK)\b/g;
// Where a twin name may stand: after a declaration keyword, or as a snake_case symbol being defined.
const TWIN_DECL = new RegExp(`\\b(class|def|function|const|let|var|fn|func|fun|void|final|struct|enum|type|interface)\\s+(${ID})`, "g");
const FN_KW = /^(class|def|function|fn|func|fun|void|struct|enum|type|interface)$/;
const TWIN_SUFFIX = /^(.*?)(V\d|New|Old|Copy|Temp|Legacy|Backup|_v\d|_new|_old|_copy|_temp|_legacy|_backup|\d)$/;
const MAGIC_OK = new Set([0, 1, 2, -1, 100, 1000]);
// A named constant is an UPPER_CASE binding or a language-level constant form;
// JS `const` alone is not one, or every line in a modern file would be exempt.
const CONSTISH = /\b(?:static\s+final|#define|constexpr|readonly)\b|\b[A-Z][A-Z0-9_]{2,}\s*(?::\s*[\w<>[\]]+\s*)?=[^=]/;
const CODE_LINE = /^(?:(?:return|if|for|while|const|let|var|import|from|def|class|function|print|console\.|self\.|await|export|throw|raise|else|elif|try|catch|switch|case)\b.*[;:{}()=]|[\w.[\]]+\s*=[^=]|[\w.]+\([^)]*\)\s*;?|[{}]\s*|.*[;{}]|\}\s*(?:else|catch).*)$/;
const NOT_CODE = /^\s*(?:TODO|FIXME|XXX|HACK|NOTE|eslint|prettier|@ts|type:|noqa|pylint|ignore|see |https?:)/i;

const stripStrings = (l) => l.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
// Articles and glue carry no meaning to overlap on: "set the user id" is three words of content, not four.
const GLUE = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "is", "it", "this", "that", "with", "we", "now", "then"]);
const words = (s) => (s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9]+/g) || []).filter((w) => w.length >= 2 && !GLUE.has(w));

/** Comment/code classification per line, honouring block comments and the
 *  language's opener. Returns [{kind: code|comment|blank, body}] where body
 *  is the comment text without its opener. */
export function classify(lines, lang) {
  const { line: op, blockOpen, blockClose } = commentSyntax(lang);
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    const st = raw.trim();
    if (!st) { out.push({ kind: "blank", body: "" }); continue; }
    if (inBlock) { out.push({ kind: "comment", body: st.replace(/^\*\s?/, "").replace(/\*\/\s*$/, "") }); if (blockClose && st.includes(blockClose)) inBlock = false; continue; }
    if (blockOpen && st.startsWith(blockOpen)) { inBlock = !st.includes(blockClose); out.push({ kind: "comment", body: st.slice(blockOpen.length).replace(/^[*!]\s?/, "").replace(/\*\/\s*$/, "") }); continue; }
    if (st.startsWith(op) || (lang === "dart" && st.startsWith("///"))) { out.push({ kind: "comment", body: st.replace(/^(\/\/\/?|#|--)\s?/, "") }); continue; }
    out.push({ kind: "code", body: st });
  }
  return out;
}

// ── shape ────────────────────────────────────────────────────────────────────

/** Python's indent unit: a tab is one level; spaces are counted in the smallest
 *  indent the file uses when that is 2 or 4, else 4. Mixed files are what the
 *  tab rule is for: a tab-indented body under a 4-space def still nests once. */
export function indentUnit(lines) {
  let min = Infinity;
  for (const l of lines) {
    const m = /^( +)\S/.exec(l);
    if (m) min = Math.min(min, m[1].length);
  }
  return min === 2 ? 2 : 4;
}
const indentLevel = (l, unit) => { const m = /^([ \t]*)/.exec(l)[1]; const tabs = (m.match(/\t/g) || []).length; return tabs + Math.floor((m.length - tabs) / unit); };

/** Brace depth per line with strings and comments skipped, so a `}` in a string
 *  or a `{` in a comment does not open a block that never closes. Returns
 *  {max, depthAt: [n per line]}. */
export function braceDepth(lines, lang) {
  const { line: op, blockOpen, blockClose } = commentSyntax(lang);
  let depth = 0, max = 0, inBlock = false;
  const depthAt = [];
  for (const raw of lines) {
    let l = raw;
    if (inBlock) { const i = blockClose ? l.indexOf(blockClose) : -1; if (i < 0) { depthAt.push(depth); continue; } l = l.slice(i + blockClose.length); inBlock = false; }
    l = stripStrings(l);
    // A regex literal is told from division by what precedes it, the same rule a tokenizer uses.
    if (lang === "js" || lang === "ts") l = l.replace(/(^|[(=,:[!&|?{};]\s*)\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n[])+\/[gimsuy]*/g, "$1/re/");
    const c = l.indexOf(op);
    if (c >= 0) l = l.slice(0, c);
    if (blockOpen) {
      for (;;) {
        const o = l.indexOf(blockOpen);
        if (o < 0) break;
        const e = l.indexOf(blockClose, o + blockOpen.length);
        if (e < 0) { l = l.slice(0, o); inBlock = true; break; }
        l = l.slice(0, o) + l.slice(e + blockClose.length);
      }
    }
    for (const ch of l) {
      if (ch === "{") { depth++; if (depth > max) max = depth; }
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    depthAt.push(depth);
  }
  return { max, depthAt };
}

/** [{name, line, end, length}] for every function in the file. Braces for the
 *  C family, dedent for Python. */
export function functionSpans(lines, lang) {
  const fam = familyOf(lang);
  if (!fam) return [];
  const rules = FUNC[fam];
  const out = [];
  if (INDENT.has(lang) || fam === "ruby") {
    const unit = indentUnit(lines);
    for (let i = 0; i < lines.length; i++) {
      const m = rules.map((r) => r.exec(lines[i])).find(Boolean);
      if (!m) continue;
      const lvl = indentLevel(lines[i], unit);
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
        if (indentLevel(lines[j], unit) <= lvl) { end = j; break; }
      }
      while (end > i + 1 && !lines[end - 1].trim()) end--;
      out.push({ name: m[2] || m[1] || "", line: i + 1, end, length: end - i });
    }
    return out;
  }
  const { depthAt } = braceDepth(lines, lang);
  for (let i = 0; i < lines.length; i++) {
    const cls = classify([lines[i]], lang)[0];
    if (cls.kind !== "code") continue;
    const m = rules.map((r) => r.exec(lines[i])).find(Boolean);
    if (!m || (m[1] && KW.test(m[1]))) continue;
    // The body opens on this line or the next two; a prototype (`;`) has none.
    let open = -1;
    for (let j = i; j < Math.min(lines.length, i + 3); j++) { if (stripStrings(lines[j]).includes("{")) { open = j; break; } if (/;\s*$/.test(lines[j])) break; }
    if (open < 0) continue;
    // depthAt is end-of-line depth: the first line at or below the depth the
    // body opened from is the line that closed it (a one-liner closes on `open`).
    const base = open === 0 ? 0 : depthAt[open - 1];
    let end = lines.length;
    for (let j = open; j < lines.length; j++) if (depthAt[j] <= base) { end = j + 1; break; }
    out.push({ name: m[1] || "", line: i + 1, end, length: end - i });
  }
  return out;
}

// ── measure ──────────────────────────────────────────────────────────────────

const MARK_CAP = 40;
/** Every metric for one file, or null when the file is not source this measures. */
export function measure(p, text = null) {
  const a = abs(p);
  const lang = langOf(a);
  if (!MEASURED.has(lang)) return null;
  const src = text ?? readText(a);
  if (!src) return null;
  const lines = src.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const r = rel(a);
  const cls = classify(lines, lang);
  const m = { path: r, lang, is_test: isTest(r), lines: lines.length, code_lines: 0, comment_lines: 0, blank_lines: 0,
    tokens: estimate.text(src, "code"), decls: 0, functions: 0, fn_max: 0, fn_median: 0, max_depth: 0, comment_ratio: 0,
    narration: 0, commented_code: 0, twins: 0, deferred: 0, suppressions: 0, swallows: 0, magic: 0, mark_total: 0, mark_density: 0, marks: [] };
  for (const c of cls) m[c.kind === "code" ? "code_lines" : c.kind === "comment" ? "comment_lines" : "blank_lines"]++;
  m.comment_ratio = m.lines ? Math.round((m.comment_lines / m.lines) * 1000) / 1000 : 0;

  const fns = functionSpans(lines, lang);
  m.functions = fns.length;
  m.decls = lines.filter((l) => /^\S/.test(l) && /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|def|const|let|var|fn|struct|enum|type|interface|func|impl|trait|mod|pub)\b/.test(l)).length;
  m.fn_max = fns.reduce((x, f) => Math.max(x, f.length), 0);
  m.fn_median = fns.length ? median(fns.map((f) => f.length)) : 0;
  m.max_depth = INDENT.has(lang) ? Math.max(0, ...lines.filter((l) => l.trim() && !/^\s*#/.test(l)).map((l) => indentLevel(l, indentUnit(lines)))) : braceDepth(lines, lang).max;

  const mark = (line, kind, textLine) => { m[kind === "narration" ? "narration" : kind === "commented-out-code" ? "commented_code" : kind === "twin-symbol" ? "twins" : kind === "deferred" ? "deferred" : kind === "suppression" ? "suppressions" : kind === "swallowed-error" ? "swallows" : "magic"]++;
    if (m.marks.length < MARK_CAP) m.marks.push({ line, kind, text: String(textLine ?? lines[line - 1] ?? "").trim().slice(0, 110) }); };
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  const hits = (re, kind) => { re.lastIndex = 0; let g; while ((g = re.exec(src))) mark(lineOf(g.index), kind); };
  hits(SUPPRESS, "suppression");
  hits(SWALLOW, "swallowed-error");
  hits(DEFERRED, "deferred");

  // Narration: a comment whose words are ≥60% the words of the code line under it.
  // Commented-out code: a comment line shaped like a statement.
  for (let i = 0; i < cls.length; i++) {
    if (cls[i].kind !== "comment") continue;
    const body = cls[i].body;
    if (NOT_CODE.test(body)) continue;
    let j = i + 1;
    while (j < cls.length && cls[j].kind === "blank") j++;
    if (j < cls.length && cls[j].kind === "code") {
      const cw = words(body), kw = new Set(words(cls[j].body));
      if (cw.length >= 2 && cw.filter((w) => kw.has(w)).length / cw.length >= 0.6) { mark(i + 1, "narration"); continue; }
    }
    if (CODE_LINE.test(body) && /[a-z]/i.test(body) && !/^\s*[A-Z][^;{}()=]*[.!?]?$/.test(body)) mark(i + 1, "commented-out-code");
  }

  // Twins: a declared name with a versioning suffix whose base is also declared here
  // (digit suffixes need the base; `sha1` and `utf8` are not twins of anything).
  const declared = new Set();
  const twinCands = [];
  TWIN_DECL.lastIndex = 0;
  let g;
  while ((g = TWIN_DECL.exec(src))) { declared.add(g[2]); twinCands.push({ kw: g[1], name: g[2], line: lineOf(g.index) }); }
  for (const c of twinCands) {
    const t = TWIN_SUFFIX.exec(c.name);
    if (!t || !t[1] || KW.test(c.name)) continue;
    const digit = /^\d$/.test(t[2]);
    // `step1, step2` locals are a series, not a second implementation; a digit
    // twin is only a function-like declaration whose base is also declared.
    if (digit ? (declared.has(t[1]) && FN_KW.test(c.kw)) : true) mark(c.line, "twin-symbol");
  }

  // Magic numbers: literals outside the small set, off constant lines, never in tests.
  if (!m.is_test) {
    lines.forEach((l, i) => {
      if (cls[i].kind !== "code" || CONSTISH.test(l)) return;
      const code = stripStrings(l).replace(/\/\/.*$|#.*$/, "");
      for (const n of code.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)) if (!MAGIC_OK.has(Number(n[0]))) { mark(i + 1, "magic-number"); break; }
    });
  }
  m.mark_total = m.narration + m.commented_code + m.twins + m.deferred + m.suppressions + m.swallows + m.magic;
  m.mark_density = m.code_lines ? Math.round((100 * m.mark_total / m.code_lines) * 100) / 100 : 0;
  // A long file with no functions is a table, not a module; rules about design skip it.
  m.is_data = m.lines > 200 && m.functions <= 2 && m.decls <= 2;
  return m;
}

// ── cache ────────────────────────────────────────────────────────────────────

export const cachePath = () => path.join(VAR, "oversight-cache.json");
let _cache = null, _dirty = false, _touched = new Set();
const loadCache = () => _cache || (_cache = readJson(cachePath(), {}) || {});
/** measure() through the (path, mtime_ns) cache. A changed file is re-measured; an unchanged one costs a stat. */
export function measureCached(p) {
  const a = abs(p);
  let st;
  try { st = fs.statSync(a, { bigint: true }); } catch { return null; }
  const key = `${rel(a)}|${st.mtimeNs}`;
  const c = loadCache();
  _touched.add(key);
  if (c[key]) return c[key];
  const m = measure(a);
  if (m) { c[key] = m; _dirty = true; }
  return m;
}
/** Write the cache with only the keys this run touched, so a deleted or
 *  rewritten file does not leave a stale twin behind. */
export function flushCache() {
  if (!_cache) return;
  const kept = {};
  for (const k of _touched) if (_cache[k]) kept[k] = _cache[k];
  if (_dirty || Object.keys(kept).length !== Object.keys(_cache).length) writeJson(cachePath(), kept);
  _cache = kept; _dirty = false;
}
export function resetCache() { _cache = null; _dirty = false; _touched = new Set(); }
