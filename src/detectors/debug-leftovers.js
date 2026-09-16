// debug-leftovers — console.log, debugger, pdb, binding.pry, dd() in code that
// is not a CLI, a logger or a script. Exact: the line is there. Low: it is a
// one-line delete, but it ships noise and, for `debugger`, a stopped process.
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";

const SKIP_PATH = /(^|\/)(bin|scripts?)\/|(^|\/)[^/]*(cli|log)[^/]*(\/|\.[a-z]+$)/i;
const RULES = {
  js: [/\bconsole\.(log|debug|trace)\s*\(/, /^\s*debugger\s*;?\s*$/],
  ts: [/\bconsole\.(log|debug|trace)\s*\(/, /^\s*debugger\s*;?\s*$/],
  py: [/\bprint\s*\(.*#\s*debug\b/i, /\b(pdb|ipdb)\.set_trace\s*\(/, /^\s*breakpoint\s*\(\s*\)/],
  ruby: [/\bbinding\.(pry|irb)\b/, /^\s*byebug\b/],
  php: [/\b(dd|dump|var_dump)\s*\(/],
  dart: [/\bdebugger\s*\(/],
  java: [/\bSystem\.(out|err)\.println\s*\(.*\/\/\s*debug\b/i],
  kotlin: [/\bprintln\s*\(.*\/\/\s*debug\b/i],
  go: [/\bfmt\.Println\s*\(.*\/\/\s*debug\b/i],
  rust: [/\bdbg!\s*\(/],
};
const COMMENT = /^\s*(\/\/|#|\*|\/\*)/;

// A line that is nothing but a debug statement. Deleting one deletes a whole
// statement; deleting anything else deletes part of one. The actuator reads
// this list through `isWholeLineDebug`, because two copies of it is how a fix
// starts removing lines the detector never claimed.
const WHOLE_LINE = [
  /^\s*debugger\s*;?\s*$/,
  /^\s*breakpoint\s*\(\s*\)\s*;?\s*$/,
  /^\s*i?pdb\.set_trace\s*\(\s*\)\s*;?\s*$/,
  /^\s*binding\.(?:pry|irb)\s*$/,
  /^\s*byebug\s*$/,
  /^\s*dbg!\s*\([^;]*\)\s*;?\s*$/,
  /^\s*console\.(?:log|debug|trace)\s*\([^;]*\)\s*;?\s*$/,
];
/** True when the whole line is one debug statement and its parens close on it.
 *  `[^;]` already rejects a line that does work after the call; the balance
 *  check rejects a call that is only starting here and ends three lines down. */
export function isWholeLineDebug(line) {
  const s = String(line ?? "");
  if (!WHOLE_LINE.some((re) => re.test(s))) return false;
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

export default {
  name: "debug-leftovers", precision: "exact", severity: "low",
  description: "console.log/debugger/pdb/pry/dd in non-test source outside CLI, logging, bin and scripts",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    for (const r of codeRels(ctx, { tests: false })) {
      if (SKIP_PATH.test(r)) continue;
      // A shebang says this file IS a command, wherever it lives, and a command's
      // stdout is its product rather than a leftover. Exact, like the path rule
      // above it: the line is there or it is not.
      if (text.get(r).startsWith("#!")) continue;
      const rules = RULES[langOf(r)];
      if (!rules) continue;
      const hits = [];
      text.get(r).split("\n").forEach((line, i) => {
        if (COMMENT.test(line)) return;
        for (const re of rules) if (re.test(line)) { hits.push({ line: i + 1, snippet: snippet(line), whole: isWholeLineDebug(line) }); return; }
      });
      if (!hits.length) continue;
      out.push(finding({
        severity: "low", files: [r], key: r,
        // Only when at least one hit is the whole line. A `console.log` inside
        // an expression has no one-line delete, and claiming an actuator for it
        // would file the finding as free and leave it open forever.
        auto_fix: hits.some((h) => h.whole) ? "strip-debug-line" : null,
        title: `${r}: ${hits.length} debug statement(s)`,
        detail: hits.slice(0, 15).map((h) => `  L${h.line}  ${h.snippet}`).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length },
        fix_hint: "Delete the line, or route it through the project's logger so it can be silenced.",
      }));
    }
    return out;
  },
};
