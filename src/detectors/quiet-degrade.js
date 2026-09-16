// quiet-degrade — a capability switched off by a failure, and nothing records
// that it was.
//
// The third answer a failure branch can give: not a wrong value and not a false
// verdict, but less of the product, decided at runtime and never mentioned. A
// cache that stops caching, a probe that stops probing, an index that falls
// back to a scan. Each is the right behaviour and each is invisible, so the box
// runs for a month at a fraction of its speed and every measurement taken in
// that month is of a system nobody knew they were measuring.
//
// The bar is deliberately one thing: does ANYTHING record it. A log line, a
// warning, an appended episode, a comment saying this is fine. A branch that
// records is a decision; a branch that does not is a surprise waiting for
// somebody to profile it.
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";
import { EXPLAINED, RECORDS, bodyOf, failureBranches } from "./_failure.js";

const LANGS = new Set(["js", "ts", "py", "go", "rust", "java", "kotlin", "php", "ruby"]);
/** Turning a capability off. The name carries the claim: these are the words a
 *  codebase uses for things that can be on. */
const SWITCHES_OFF = /\b\w*(?:enabled|active|available|supported|installed|ready|cached|use[A-Z]\w*|has[A-Z]\w*)\s*=\s*(?:false|None|nil|0)\b|\b(?:disable|degrade|skip|bypass|turn_?off)\w*\s*\(/i;

export default {
  name: "quiet-degrade", precision: "heuristic", severity: "low",
  description: "a failure branch that switches a capability off and records nothing",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    for (const r of codeRels(ctx, { tests: false })) {
      const lang = langOf(r);
      if (!LANGS.has(lang)) continue;
      const src = text.get(r);
      const lines = src.split("\n");
      const hits = [];
      for (const b of failureBranches(src, lang)) {
        const body = bodyOf(lines, b);
        // The head line as well as the body: the convention is a clause ON the
        // line, and a one-line branch's body is a slice that excludes it.
        if (EXPLAINED.test(b.head) || EXPLAINED.test(body)) continue;
        if (RECORDS.test(body)) continue;            // somebody can read what happened
        const m = SWITCHES_OFF.exec(body);
        if (!m) continue;
        hits.push({ line: b.line, kind: b.kind, off: snippet(m[0], 40), snippet: snippet(b.head) });
      }
      if (!hits.length) continue;
      out.push(finding({
        severity: hits.length >= 4 ? "medium" : "low",
        files: [r], key: r,
        auto_fix: "plan-fallback-contracts",
        title: `${r}: ${hits.length} capabilit(y/ies) switched off by a failure with nothing recording it`,
        detail: hits.slice(0, 15).map((h) => `  L${h.line}  ${h.kind.padEnd(8)} ${h.off}\n          ${h.snippet}`).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length },
        fix_hint: "One line saying what stopped working and why. Degrading is usually right; degrading silently means the next person to measure this box measures a different one.",
      }));
    }
    return out;
  },
};
