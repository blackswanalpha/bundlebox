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
//   SPECIFICITY    a term that names a symbol in thirty files says nothing about
//                  which file the task is about. Measured on this tree: the
//                  prompt "wire the pre-read guard so it denies a read the
//                  pinpoint brief already quotes" scored `slop/index.js`,
//                  `tokens/ledger.js` and `auditor/charter.js` at the top,
//                  because each declares a symbol EXACTLY called `read`, worth
//                  the full 9 — while `wire/hooks.js`, the file holding every
//                  line the task was about, never entered the scope. Three of
//                  the statement's words (`read`, `guard`, `brief`, `wire`) are
//                  common symbol names here, and an exact match on a common
//                  name is not evidence.
//
//                  The correction is the standard one: inverse document
//                  frequency, computed over the candidate set rather than a
//                  corpus, so it needs no index of its own. A term matching one
//                  file of forty keeps its full weight; a term matching most of
//                  them keeps MIN_TERM of it. That single multiplier is what
//                  lets a loose match on a rare word outrank an exact match on
//                  a word the tree uses everywhere.
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
/** A file the caller named is not scored against the others; it is PINNED to
 *  the front, in the order it was given. The score is kept so an explicit file
 *  with no hits still enters the ranking, but the pin is what holds:
 *  specificity and path evidence together can beat any fixed constant, and
 *  losing an argument to the ranker is not something a human naming a file
 *  should have to do. The cut loop pops from the end, so pinning also means an
 *  explicit file is the last thing dropped for budget. */
export const EXPLICIT = 10;
export const TEST_WEIGHT = 0.34;
/** What a term matching every candidate file is still worth. Not zero: a
 *  single-term problem statement whose one term is common would otherwise
 *  score every file identically, and an arbitrary order is worse than a weak
 *  one. */
export const MIN_TERM = 0.2;
/** A term at or above this weight is evidence about WHICH file. Below it the
 *  hit is a coincidence of vocabulary, and the caller should go and look at
 *  file contents instead of trusting the index. */
export const INFORMATIVE = 0.45;

/** term -> weight in [MIN_TERM, 1], from how many distinct files that term
 *  matched. Smoothed IDF, normalised by the most a term could score on this
 *  candidate set, so the scale does not move with the number of hits. */
export function termWeights(sym) {
  const files = new Set(), byTerm = new Map();
  for (const h of sym) {
    const t = String(h.term || "").toLowerCase();
    if (!t) continue;
    files.add(h.file);
    if (!byTerm.has(t)) byTerm.set(t, new Set());
    byTerm.get(t).add(h.file);
  }
  const n = files.size;
  const w = new Map();
  if (!n) return w;
  const most = Math.log((n + 1) / 1);                       // a term in exactly one file
  for (const [t, fs] of byTerm) {
    const idf = Math.log((n + 1) / fs.size);
    const norm = most > 0 ? idf / most : 1;
    w.set(t, MIN_TERM + (1 - MIN_TERM) * Math.max(0, Math.min(1, norm)));
  }
  return w;
}

/** What one term naming a component of a file's PATH is worth.
 *
 *  This is the signal the ranker was missing entirely, and it cost the worst
 *  miss measured on this tree. For "wire the pre-read guard so it denies a read
 *  the pinpoint brief already quotes", every word that mattered pointed at
 *  `src/wire/hooks.js`: the directory is named `wire`, the handler is named
 *  `preRead`, the config key is `guard_reads`. What the symbol index offered
 *  instead was three files declaring a symbol exactly called `read`, `guard` or
 *  `brief` — a coincidence of vocabulary in three unrelated subsystems — and
 *  those won, because a path was worth nothing and a name was worth nine.
 *
 *  A directory name is a deliberate statement about what a file is for. It is
 *  weighted like a strong symbol match and specificity-weighted the same way,
 *  so "src" (every file) collapses to MIN_TERM and contributes nothing, while
 *  "wire" (four files) keeps almost all of it. */
export const PATH_TERM = 8;

/** The components a term can name: each directory on the way down, and the
 *  basename without its extension. */
export function components(file) {
  const parts = String(file).split("/").filter(Boolean);
  const base = parts.pop() || "";
  return [...parts, base.replace(/\.[^.]+$/, "")].map((x) => x.toLowerCase());
}

/** term -> weight over path components, and the files each term names. Same
 *  smoothed IDF as `termWeights`, measured against the whole candidate
 *  universe rather than the hit set, because a path match is checked against
 *  every file and not only the ones a symbol already matched. */
export function pathWeights(terms, universe) {
  const n = universe.length, hits = new Map(), w = new Map();
  if (!n) return { hits, w };
  const tl = [...new Set(terms.map((t) => String(t).toLowerCase()).filter((t) => t.length >= 3))];
  const comps = universe.map((f) => [f, new Set(components(f))]);
  const most = Math.log(n + 1);
  for (const t of tl) {
    const fs = comps.filter(([, c]) => c.has(t)).map(([f]) => f);
    if (!fs.length) continue;
    const norm = most > 0 ? Math.log((n + 1) / fs.length) / most : 1;
    hits.set(t, fs);
    w.set(t, MIN_TERM + (1 - MIN_TERM) * Math.max(0, Math.min(1, norm)));
  }
  return { hits, w };
}

/** How many of these hits are about WHICH file rather than about vocabulary.
 *  `bb pinpoint` uses it to decide whether the symbol tables actually answered
 *  the question: a hundred hits on `read` and `wire` are not an answer, and the
 *  bounded content grep is a better use of the next 40ms than trusting them. */
export function informative(sym) {
  const w = termWeights(sym);
  return sym.filter((h) => (w.get(String(h.term || "").toLowerCase()) || 0) >= INFORMATIVE).length;
}

/** [file] most likely first. `explicit` are files the problem or the caller
 *  named, `sym` are symbol-table hits, `grep` is the bounded fallback. */
export function rank(problem, { explicit = [], sym = [], grep = [], terms = [], universe = [] } = {}) {
  const wantsTests = /\btest(s|ing|ed)?\b|\bfixture|\bpytest|\bassert/i.test(String(problem));
  const weight = (f) => (!wantsTests && isTest(rel(f)) ? TEST_WEIGHT : 1);
  const score = new Map();
  const bump = (f, n) => score.set(f, (score.get(f) || 0) + n * weight(f));
  for (const f of explicit) bump(f, EXPLICIT);
  const tw = termWeights(sym);
  const evidence = (h) => quality(h) * (tw.get(String(h.term || "").toLowerCase()) || 1);
  const byFile = new Map();
  for (const h of sym) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h); }
  for (const [f, hits] of byFile) {
    hits.sort((a, b) => evidence(b) - evidence(a));
    hits.forEach((h, i) => bump(f, evidence(h) * Math.pow(DECAY, i)));
  }
  for (const h of grep) bump(h.file, 1);
  // A file the path evidence names enters the ranking whether or not a symbol
  // matched: "wire the pre-read guard" is about `src/wire/`, and requiring a
  // symbol hit first is what kept the answer out of the candidate set.
  if (terms.length && universe.length) {
    const { hits, w } = pathWeights(terms, universe);
    for (const [t, files] of hits) for (const f of files) bump(f, PATH_TERM * w.get(t));
  }
  for (const f of [...score.keys()]) score.set(f, score.get(f) + centrality(f));
  const pinned = [...new Set(explicit)];
  const pin = new Set(pinned);
  return [...pinned, ...[...score].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(([f]) => f).filter((f) => !pin.has(f))];
}
