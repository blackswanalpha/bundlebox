// pinpoint/rank.js — which files a problem statement is about, in order.
//
// Ranking used to be one line: count the hits. Run against SWE-bench Verified,
// that line put a test file first on almost every real issue and buried the
// implementation, because a test names the thing under test far more often than
// the thing itself does. Three corrections, all derived from what is already on
// disk, all measured on the same twenty public instances:
//
//   TEST WEIGHT    a test file scores a third unless the problem statement is
//                  itself about a test. The tests stay reachable — they are in
//                  the symbol tables the prompt points at — they just stop
//                  displacing the implementation.
//
//   MATCH QUALITY  a symbol that IS one of the problem's words is far stronger
//                  evidence than one that merely contains it. Every hit used to
//                  score the same 3, so `coordinates.py` — holding
//                  `Coordinates`, `DataArrayCoordinates` and
//                  `DatasetCoordinates`, three loose matches on "coordinates" —
//                  outranked `combine.py`, which declares the function the
//                  issue names. The exact match was found every time and then
//                  buried under the loose ones.
//
//   CENTRALITY     a file many others import is more likely to hold a behaviour
//                  than a leaf. Capped, so a hub cannot win on popularity alone.
//
// Hits within one file decay, so a file cannot win on the sheer number of loose
// matches it happens to contain.
import { rel, abs } from "../core/paths.js";
import { isTest } from "../detectors/_shared.js";
import * as graph from "../snapgen/graph.js";

/** How strongly one symbol hit argues that its file is the subject. */
export function quality(h) {
  const s = String(h.symbol || "").toLowerCase(), t = String(h.term || "").toLowerCase();
  if (!s || !t) return 2;
  if (s === t) return 9;
  if (s.replace(/[_.]/g, "") === t.replace(/[_.]/g, "")) return 8;
  if (s.startsWith(t) || s.endsWith(t)) return 5;
  return 2;
}

/** How many files import this one, capped. Never throws: a box with no symbol
 *  index should rank worse, not rank nothing. */
export function centrality(file) {
  try { return Math.min((graph.graph().inn.get(abs(file)) || new Set()).size, 8) * 0.4; }
  catch { return 0; }
}

export const DECAY = 0.55;
export const EXPLICIT = 10;
export const TEST_WEIGHT = 0.34;

/** [file] most likely first. `explicit` are files the problem or the caller
 *  named, `sym` are symbol-table hits, `grep` is the bounded fallback. */
export function rank(problem, { explicit = [], sym = [], grep = [] } = {}) {
  const wantsTests = /\btest(s|ing|ed)?\b|\bfixture|\bpytest|\bassert/i.test(String(problem));
  const weight = (f) => (!wantsTests && isTest(rel(f)) ? TEST_WEIGHT : 1);
  const score = new Map();
  const bump = (f, n) => score.set(f, (score.get(f) || 0) + n * weight(f));
  for (const f of explicit) bump(f, EXPLICIT);
  const byFile = new Map();
  for (const h of sym) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h); }
  for (const [f, hits] of byFile) {
    hits.sort((a, b) => quality(b) - quality(a));
    hits.forEach((h, i) => bump(f, quality(h) * Math.pow(DECAY, i)));
  }
  for (const h of grep) bump(h.file, 1);
  for (const f of [...score.keys()]) score.set(f, score.get(f) + centrality(f));
  return [...score].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(([f]) => f);
}
