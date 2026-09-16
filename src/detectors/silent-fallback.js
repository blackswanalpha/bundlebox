// silent-fallback — a failure branch that returns a value the caller cannot
// tell from a real answer.
//
// This is the sibling `swallowed-errors` cannot see. There the error is dropped
// and the catch is empty; here the failure IS noticed, tested for, and answered
// with a substitute that looks exactly like success:
//
//     const r = gitx(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
//     const ref = r.rc === 0 ? r.out.trim() : "";
//     return ref ? ref.split("/").pop() : "main";
//
// A caller receiving "main" cannot distinguish "the default branch is main"
// from "git did not answer". Every decision downstream is made against a fact
// nobody established, and nothing anywhere records that it was invented.
//
// The rule turns on WHICH literal, not on whether there is one. `null`, `false`,
// `0`, `""`, `[]` and `{}` are how a function says it has nothing, and a caller
// tests for them. A non-empty string, a non-zero number, `true` and a filled
// object are answers. Returning one of those from a failure branch is the bug.
//
// Quiet on a fallback somebody decided on: a clause on the line saying why is
// the same convention `swallowed-errors` already honours.
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";
import { EXPLAINED, bodyOf, failureBranches, indistinct } from "./_failure.js";

const LANGS = new Set(["js", "ts", "py", "go", "rust", "java", "kotlin", "php", "ruby"]);
// `return <literal>`, `?? <literal>`, `|| <literal>` and the else arm of a
// ternary whose test is an error test.
const RETURNS = /\breturn\s+([^;\n]+)/;
const COALESCE = /(?:\?\?|\|\|)\s*([^;,)\n]+)/;
const FALLIBLE = /\b(?:read|fetch|exec|run|git|parse|load|query|request|stat)\w*\s*\(/i;

export default {
  name: "silent-fallback", precision: "heuristic", severity: "medium",
  description: "a failure branch that returns a substitute value a caller cannot tell from a real answer",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    for (const r of codeRels(ctx, { tests: false })) {
      const lang = langOf(r);
      if (!LANGS.has(lang)) continue;
      const src = text.get(r);
      const lines = src.split("\n");
      const hits = [];

      // 1. A literal returned from inside a branch that tested for failure.
      for (const b of failureBranches(src, lang)) {
        const body = bodyOf(lines, b);
        // The head line as well as the body: the convention is a clause ON the
        // line, and a one-line branch's body is a slice that excludes it.
        if (EXPLAINED.test(b.head) || EXPLAINED.test(body)) continue;              // somebody wrote down why
        const m = RETURNS.exec(body);
        if (!m || !indistinct(m[1])) continue;
        hits.push({ line: b.line, kind: b.kind, value: snippet(m[1], 40), snippet: snippet(b.head) });
      }

      // 2. A coalesce on a call that can fail: the test and the fallback are
      //    one expression, so there is no branch to scan.
      //
      //    A ternary is NOT read here. `r.rc === 0 ? r.out : "main"` tests for
      //    SUCCESS, so its fallback is the else arm, while `x.error ? … : …`
      //    tests for failure and its fallback is the then arm. Telling those
      //    apart is dataflow, and guessing costs a false positive on every
      //    ternary in the tree.
      lines.forEach((line, i) => {
        if (EXPLAINED.test(line)) return;
        if (hits.some((h) => h.line === i + 1)) return;
        if (!FALLIBLE.test(line)) return;
        const m = COALESCE.exec(line);
        if (!m || !indistinct(m[1])) return;
        hits.push({ line: i + 1, kind: "coalesce", value: snippet(m[1], 40), snippet: snippet(line) });
      });

      if (!hits.length) continue;
      out.push(finding({
        severity: hits.length >= 4 ? "medium" : "low",
        files: [r], key: r,
        auto_fix: "plan-fallback-contracts",
        title: `${r}: ${hits.length} failure branch(es) returning a value a caller reads as real`,
        detail: hits.slice(0, 15).map((h) => `  L${h.line}  ${h.kind.padEnd(8)} -> ${h.value}\n          ${h.snippet}`).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length },
        fix_hint: "Return the failure, or say on the line why this substitute is right. `null` and `false` are answers a caller can test; \"main\" and 30 are answers a caller believes.",
      }));
    }
    return out;
  },
};
