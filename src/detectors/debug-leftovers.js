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

export default {
  name: "debug-leftovers", precision: "exact", severity: "low",
  description: "console.log/debugger/pdb/pry/dd in non-test source outside CLI, logging, bin and scripts",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    for (const r of codeRels(ctx, { tests: false })) {
      if (SKIP_PATH.test(r)) continue;
      const rules = RULES[langOf(r)];
      if (!rules) continue;
      const hits = [];
      text.get(r).split("\n").forEach((line, i) => {
        if (COMMENT.test(line)) return;
        for (const re of rules) if (re.test(line)) { hits.push({ line: i + 1, snippet: snippet(line) }); return; }
      });
      if (!hits.length) continue;
      out.push(finding({
        severity: "low", files: [r], key: r,
        title: `${r}: ${hits.length} debug statement(s)`,
        detail: hits.slice(0, 15).map((h) => `  L${h.line}  ${h.snippet}`).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length },
        fix_hint: "Delete the line, or route it through the project's logger so it can be silenced.",
      }));
    }
    return out;
  },
};
