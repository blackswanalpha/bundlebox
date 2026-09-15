// bench/arms.js — the two ways to answer the same task, both measured.
//
// The claim "bundlebox saves tokens" is only worth making if the arm it is
// compared against is the one a session actually runs. So:
//
//   BARE    what a session does with no factory in front of it: search the
//           tree for the task's terms and read the files that come back,
//           whole. Every token of every file it opens, counted by the same
//           estimator the rest of the box uses.
//   PACKED  what `bb pinpoint` hands the same session for the same task: one
//           prompt naming the files, the regions inside them, the evidence
//           already on file and the gate that closes it.
//
// Neither arm calls a model. Both are MEASURED over text that exists, which is
// what makes the difference reproducible: run it twice on the same tree and
// the same number comes back.
import { readText } from "../core/fs.js";
import { rel } from "../core/paths.js";
import { codeFiles } from "../snapgen/tables.js";
import * as estimate from "../tokens/estimate.js";
import { terms as termsOf } from "../pinpoint/index.js";

/** How many files a bare session opens before it starts editing. Ten is the
 *  measured median over this box's own transcripts; it is a parameter and the
 *  report prints it, because a bench that hides its constant is an assertion. */
export const BARE_READ_CAP = 10;

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Files ranked the way a search ranks them: hit count, then path, so the run
 *  is stable. Explicit files the task names always come first — a session told
 *  which file to open still reads that file whole. */
export function searchHits(problem, { files = [], cap = BARE_READ_CAP } = {}) {
  const ts = termsOf(problem).filter((t) => t.length >= 4 && !t.includes("/")).slice(0, 6);
  const explicit = files.map((f) => rel(f));
  const ranked = [];
  if (ts.length) {
    const rx = new RegExp(ts.map(escape).join("|"), "i");
    for (const p of codeFiles()) {
      const r = rel(p);
      if (explicit.includes(r)) continue;
      const text = readText(p);
      let hits = 0;
      for (const line of text.split("\n")) if (rx.test(line)) hits++;
      if (hits) ranked.push({ file: r, hits });
    }
    ranked.sort((a, b) => b.hits - a.hits || (a.file < b.file ? -1 : 1));
  }
  const read = [...explicit.map((f) => ({ file: f, hits: null, explicit: true })), ...ranked].slice(0, cap);
  return { terms: ts, considered: ranked.length + explicit.length, read };
}

/** The bare arm: the problem statement plus every file the search returned,
 *  read whole. `considered` is how many the search found; `read` is how many a
 *  session with a window gets through. Both are reported. */
export function bare(problem, { files = [], cap = BARE_READ_CAP } = {}) {
  const s = searchHits(problem, { files, cap });
  const per = s.read.map((h) => ({ ...h, tokens: estimate.file(h.file) }));
  const payload = per.reduce((a, f) => a + f.tokens, 0);
  const statement = estimate.text(problem, "prose");
  return { tokens: payload + statement, payload, statement, files: per,
    considered: s.considered, read: per.length, cap, terms: s.terms };
}

/** The packed arm: what pinpoint writes for the same problem. Measured off the
 *  prompt it produces, not off a description of it. */
export async function packed(problem, { files = [], maxFiles = 6 } = {}) {
  const pinpoint = await import("../pinpoint/index.js");
  const b = await pinpoint.build(problem, { files, maxFiles, kind: "fix" });
  return { tokens: estimate.text(b.prompt, "prose"), scope: b.scope, candidates: b.candidates || [],
    anchors: b.anchors.length, verdict: b.verdict, projected: b.projected, path: b.path };
}
