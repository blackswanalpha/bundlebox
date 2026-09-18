// bench/arms.js — the two ways to answer the same task, both measured.
//
// The claim "bundlebox saves tokens" is only worth making if the arm it is
// compared against is the one a session actually runs. So:
//
//   BARE    what a session does with no factory in front of it: grep the tree
//           for the task's terms, read the lines the search printed, then open
//           a RANGE around the first hit in each of the top files. Every token
//           of the search output and of every range it opens, counted by the
//           same estimator the rest of the box uses.
//   PACKED  what `bb pinpoint` hands the same session for the same task: one
//           prompt naming the files, the regions inside them, the evidence
//           already on file and the gate that closes it.
//
// Neither arm calls a model. Both are MEASURED over text that exists, which is
// what makes the difference reproducible: run it twice on the same tree and
// the same number comes back.
//
// The bare arm used to open the top N files WHOLE. Measured against 18 real
// Claude Code runs on 2026-09-18, that model was not wrong by a little: the
// agent read 16 tokens of fresh input across all 18, and the ratio the bench
// printed (13.3x at cap 10, 19.6x at cap 25) climbed with the cap because the
// cap widened the strawman. A real agent greps and reads ranges, and delivered
// 1.36x. This arm models the agent that was measured, and widening `cap` now
// adds ranges, not files.
import { readText } from "../core/fs.js";
import { rel, abs } from "../core/paths.js";
import { codeFiles } from "../snapgen/tables.js";
import * as estimate from "../tokens/estimate.js";
import { terms as termsOf } from "../pinpoint/index.js";

/** How many files a bare session opens before it starts editing. Ten is the
 *  measured median over this box's own transcripts; it is a parameter and the
 *  report prints it, because a bench that hides its constant is an assertion. */
export const BARE_READ_CAP = 10;
/** Lines a bare session reads around a hit: one ranged read, hit near the top
 *  quarter. Eighty is the median `offset`/`limit` span in the measured
 *  transcripts; printed with the run for the same reason as the cap. */
export const BARE_RANGE = 80;
/** Search-output lines a session reads before it opens anything. A grep that
 *  prints more scrolls past; the session opens files instead. */
export const BARE_GREP_LINES = 60;

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Files ranked the way a search ranks them: hit count, then path, so the run
 *  is stable. Explicit files the task names always come first — a session told
 *  which file to open still opens that file. `matches` is the search output
 *  itself, in path order, capped at what a session reads of it. */
export function searchHits(problem, { files = [], cap = BARE_READ_CAP, grepLines = BARE_GREP_LINES } = {}) {
  const ts = termsOf(problem).filter((t) => t.length >= 4 && !t.includes("/")).slice(0, 6);
  const explicit = files.map((f) => rel(f));
  const ranked = [];
  const matches = [];
  if (ts.length) {
    const rx = new RegExp(ts.map(escape).join("|"), "i");
    for (const p of codeFiles()) {
      const r = rel(p);
      if (explicit.includes(r)) continue;
      let hits = 0, first = 0;
      readText(p).split("\n").forEach((line, i) => {
        if (!rx.test(line)) return;
        hits++;
        if (!first) first = i + 1;
        if (matches.length < grepLines) matches.push({ file: r, line: i + 1, text: line.trim().slice(0, 160) });
      });
      if (hits) ranked.push({ file: r, hits, first });
    }
    ranked.sort((a, b) => b.hits - a.hits || (a.file < b.file ? -1 : 1));
  }
  const read = [...explicit.map((f) => ({ file: f, hits: null, first: 0, explicit: true })), ...ranked].slice(0, cap);
  return { terms: ts, considered: ranked.length + explicit.length, read, matches };
}

/** The range a session opens for one hit: the hit sits a quarter of the way
 *  down, clamped to the file. A file the task named with no hit is read from
 *  the top. */
export function rangeAround(first, lineCount, range = BARE_RANGE) {
  const from = Math.max(1, (first || 1) - Math.floor(range / 4));
  const to = Math.min(lineCount, from + range - 1);
  return { from, to };
}

/** The bare arm: the problem statement, the search output, and one range per
 *  file the search returned. `considered` is how many the search found; `read`
 *  is how many a session with a window gets through. Both are reported. */
export function bare(problem, { files = [], cap = BARE_READ_CAP, range = BARE_RANGE } = {}) {
  const s = searchHits(problem, { files, cap });
  const grep = s.matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n");
  const search = grep ? estimate.text(grep, "code") : 0;
  const per = s.read.map((h) => {
    const lines = readText(abs(h.file)).split("\n");
    const { from, to } = rangeAround(h.first, lines.length, range);
    return { ...h, from, to, tokens: estimate.text(lines.slice(from - 1, to).join("\n"), "code") };
  });
  const payload = per.reduce((a, f) => a + f.tokens, 0);
  const statement = estimate.text(problem, "prose");
  return { tokens: payload + search + statement, payload, search, statement, files: per,
    considered: s.considered, read: per.length, cap, range, grep_lines: s.matches.length, terms: s.terms };
}

/** The packed arm: what pinpoint writes for the same problem. Measured off the
 *  prompt it produces, not off a description of it. */
export async function packed(problem, { files = [], maxFiles = 6 } = {}) {
  const pinpoint = await import("../pinpoint/index.js");
  const b = await pinpoint.build(problem, { files, maxFiles, kind: "fix" });
  return { tokens: estimate.text(b.prompt, "prose"), scope: b.scope, candidates: b.candidates || [],
    anchors: b.anchors.length, verdict: b.verdict, projected: b.projected, path: b.path };
}
