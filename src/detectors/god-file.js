// god-file — a file that does too much, measured against this tree's own
// median. Absolute thresholds are somebody else's codebase: 400 lines is a
// god file in a tree of 60-line modules and the norm in a tree of 900-line
// ones, so the bar is a multiple of the median (doctrine 9).
import { langOf } from "../core/fs.js";
import { median } from "../core/util.js";
import { codeRels, corpus, finding, importGraph } from "./_shared.js";

// Thresholds as data. Both arms of the first rule must hold: 3x the median in
// a tree of 20-line files is 60 lines, which is not a god file, hence the
// absolute floor of 400.
export const THRESHOLDS = { lines_x_median: 3, lines_floor: 400, max_functions: 12, fn_x_median: 3 };

const KW = /^(if|for|while|switch|catch|else|return|do|try|with|elif|except|match|case|when|unless|until|foreach)$/;
const DECL = {
  js: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
  py: /^\s*(?:async\s+)?def\s+(\w+)/,
  go: /^func\s+(?:\([^)]*\)\s*)?(\w+)/,
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/,
  kotlin: /^\s*(?:(?:private|public|internal|override|open|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/,
  ruby: /^\s*def\s+(?:self\.)?(\w+)/,
  php: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/,
  cfamily: /^\s*(?:(?:public|private|protected|static|final|abstract|override|async|virtual|inline|const|constexpr)\s+)*[\w<>\[\]?.,]+\s+(\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:async\s*)?(?:\{|=>|$)/,
};
const INDENT_LANGS = new Set(["py", "ruby", "yaml"]);
// Braces inside a string, a comment or a regex character class are not
// blocks: `/[{}]/` counted as a function that never closes and reported a
// 300-line function in a 40-line file. A regex literal is recognised by what
// precedes it, the same heuristic a tokenizer uses to tell it from division.
const stripLiterals = (l) => l
  .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
  .replace(/(^|[(=,:[!&|?{};]\s*)\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n[])+\/[gimsuy]*/g, "$1/re/")
  .replace(/\/\/.*$|\/\*.*?\*\//g, "");
const declRe = (lang) => DECL[lang] || (["ts"].includes(lang) ? DECL.js : ["dart", "java", "csharp", "swift", "c", "cpp", "scala"].includes(lang) ? DECL.cfamily : null);

/** { lines, functions, max_fn, max_depth } for one file. Brace languages are
 *  measured by brace depth, indent languages by indentation. */
export function metrics(r, src) {
  const lang = langOf(r);
  const lines = src.split("\n");
  const re = declRe(lang);
  const decls = [];
  if (re) lines.forEach((l, i) => { const m = re.exec(l); if (m) { const name = m[1] || m[2] || m[3]; if (name && !KW.test(name)) decls.push(i); } });
  const indentOf = (l) => l.length - l.trimStart().length;
  let maxFn = 0;
  for (const i of decls) {
    let end = i;
    if (INDENT_LANGS.has(lang)) {
      const base = indentOf(lines[i]);
      end = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) if (lines[j].trim() && indentOf(lines[j]) <= base) { end = j - 1; break; }
    } else {
      let depth = 0, seen = false;
      outer: for (let j = i; j < lines.length; j++) {
        for (const c of stripLiterals(lines[j])) { if (c === "{") { depth++; seen = true; } else if (c === "}") depth--; if (seen && depth === 0) { end = j; break outer; } }
        if (!seen && j > i + 2) { end = i; break; }   // a one-line arrow function: no block
        end = j;
      }
    }
    maxFn = Math.max(maxFn, end - i + 1);
  }
  let maxDepth = 0;
  if (INDENT_LANGS.has(lang)) {
    const unit = Math.min(...lines.filter((l) => l.trim() && indentOf(l) > 0).map(indentOf), 4) || 4;
    for (const l of lines) if (l.trim()) maxDepth = Math.max(maxDepth, Math.round(indentOf(l) / unit));
  } else {
    let d = 0;
    for (const l of lines) { const s = stripLiterals(l); for (const c of s) { if (c === "{") { d++; maxDepth = Math.max(maxDepth, d); } else if (c === "}") d = Math.max(0, d - 1); } }
  }
  return { lines: lines.length, functions: decls.length, max_fn: maxFn, max_depth: maxDepth };
}

export default {
  name: "god-file", precision: "exact", severity: "medium",
  description: "files 3x the tree's median length (and 400+ lines), or 12+ functions with one 3x the median longest",
  run(ctx) {
    const text = corpus(ctx);
    const { fanIn } = importGraph(ctx);
    const all = codeRels(ctx, { tests: false }).map((r) => ({ r, m: metrics(r, text.get(r)) }));
    if (all.length < 4) return [];   // no median worth trusting
    const medLines = median(all.map((x) => x.m.lines));
    const medFn = median(all.filter((x) => x.m.functions).map((x) => x.m.max_fn));
    const T = THRESHOLDS;
    const out = [];
    for (const { r, m } of all) {
      const byLines = m.lines >= T.lines_x_median * medLines && m.lines >= T.lines_floor;
      const byFns = m.functions > T.max_functions && medFn > 0 && m.max_fn > T.fn_x_median * medFn;
      if (!byLines && !byFns) continue;
      const why = byLines ? `${m.lines} lines vs median ${medLines}` : `${m.functions} functions, longest ${m.max_fn} lines vs median longest ${medFn}`;
      out.push(finding({
        severity: byLines && byFns ? "high" : "medium", kind: "investigate", files: [r], key: r,
        title: `${r}: ${why}`,
        detail: `lines ${m.lines}, functions ${m.functions}, longest function ${m.max_fn}, max nesting ${m.max_depth}, imported by ${fanIn.get(r) || 0} file(s)`,
        evidence: { ...m, fan_in: fanIn.get(r) || 0, median_lines: medLines, median_max_fn: medFn, rule: byLines ? "lines" : "functions", thresholds: T },
        fix_hint: "Split along the seams the imports already show: the callers that use one half never touch the other.",
      }));
    }
    return out;
  },
};
