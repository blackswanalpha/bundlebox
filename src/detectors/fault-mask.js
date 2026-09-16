// fault-mask — a failure branch that reports success.
//
// The sharpest of the three, and the only one that is a lie rather than an
// omission: the code failed, noticed, and set `ok: true` anyway. Everything
// downstream — a gate, a retry, a merge, a green board — reads the verdict and
// not the failure, so the failure has no consequence anywhere and the system
// reports that it is fine.
//
// This is the shape an acceptance gate must never have, which is why the
// severity is high rather than medium: `unproven` collapsing into `passed` is
// the one bug that makes every other measurement in a box worthless.
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";
import { EXPLAINED, bodyOf, failureBranches } from "./_failure.js";

const LANGS = new Set(["js", "ts", "py", "go", "rust", "java", "kotlin", "php", "ruby"]);
/** Claims of success, made from inside a branch that ran because of a failure. */
const CLAIMS_OK = /\b(?:ok|success|passed?|valid|healthy|green)\s*[:=]\s*(?:true|1|"(?:ok|pass(?:ed)?|success|green)")|\breturn\s+true\b|\b(?:rc|code|exitCode|status)\s*[:=]\s*0\b|\bresolve\s*\(\s*\)|\bprocess\.exit\s*\(\s*0\s*\)/;
// A branch that re-tries or falls through to a real attempt has not claimed
// anything yet; the claim it makes later is that attempt's to make.
const RETRIES = /\b(retry|again|attempt|backoff|fallback\w*\s*\(|continue\b)/i;
// A probe: the try returns one boolean and the catch returns the other, so the
// throw IS the answer and neither branch is claiming anything went well.
//
//     try { g.guardArgs([f]); return false; } catch { return true; }
//
// Without this the sharpest rule in the box fires on every feature test in the
// tree, which is how a high-severity detector gets switched off.
const PROBE = /\breturn\s+(true|false)\b[\s\S]{0,400}?\breturn\s+(?!\1\b)(?:true|false)\b/;

export default {
  name: "fault-mask", precision: "heuristic", severity: "high",
  description: "a catch or failure branch that reports success: ok/true/rc 0 returned for something that failed",
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
        if (RETRIES.test(body)) continue;
        // The window the probe shape lives in: the branch, and the try above it.
        if (PROBE.test(lines.slice(Math.max(0, b.line - 3), b.end).join("\n"))) continue;
        const m = CLAIMS_OK.exec(body);
        if (!m) continue;
        hits.push({ line: b.line, kind: b.kind, claim: snippet(m[0], 40), snippet: snippet(b.head) });
      }
      if (!hits.length) continue;
      out.push(finding({
        severity: hits.length >= 3 ? "high" : "medium",
        files: [r], key: r,
        auto_fix: "plan-fallback-contracts",
        title: `${r}: ${hits.length} failure branch(es) that report success`,
        detail: hits.slice(0, 15).map((h) => `  L${h.line}  ${h.kind.padEnd(8)} claims ${h.claim}\n          ${h.snippet}`).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length },
        fix_hint: "Report the failure, or name a third state. A gate that cannot say `unproven` says `passed`, and then nothing it ever reports means anything.",
      }));
    }
    return out;
  },
};
