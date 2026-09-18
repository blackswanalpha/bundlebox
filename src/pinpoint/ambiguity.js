// ambiguity.js — what this brief does NOT settle, counted before it is sent.
//
// A brief that is under-specified does not fail. It comes back as work that
// answers a different question, and the cost is a second session plus the
// review that caught it. The difference between the two is visible before
// anything is spawned, and every signal below is already measured elsewhere in
// the factory — this file only reads them and refuses to average them into one
// number without saying which ones fired.
//
// The score is a fraction of the weight that fired, so it is comparable across
// briefs; the reasons are the part worth acting on. A brief with a score of 0
// still prints "nothing unresolved", because a silent section reads as "not
// checked" rather than "nothing to say".

/** Each signal is a name, what it costs when it is true, and the sentence the
 *  brief prints. Data, so adding one is a row rather than a branch. */
export const SIGNALS = [
  { id: "no-gate", weight: 3,
    test: (b) => !b.gates?.quick && !b.gates?.full,
    say: () => "no gate was detected, so nothing here can be proven finished. State in one line what you ran." },
  { id: "no-location", weight: 3,
    test: (b) => !b.symbols?.length && !b.grep?.length,
    say: () => "nothing in the symbol tables matched the problem's words. The scope is a path match, not a located symbol." },
  { id: "no-region", weight: 2,
    test: (b) => !b.anchors?.length,
    say: (b) => `no region was located inside ${b.scope?.length === 1 ? "the scope file" : "the scope files"}, so they are costed whole.` },
  { id: "no-evidence", weight: 2,
    test: (b) => !b.evidence?.length,
    say: () => "no open finding touches this scope, so the problem statement is the only description of what is wrong." },
  { id: "does-not-fit", weight: 3,
    test: (b) => b.verdict && b.verdict !== "FITS",
    say: (b) => `the scope is ${b.verdict}, not FITS: ${b.projected} projected against a ceiling of ${b.ceiling}.` },
  { id: "cut-for-budget", weight: 1,
    test: (b) => (b.cut?.length || 0) > 0,
    say: (b) => `${b.cut.length} file(s) were cut to fit the window and may be where the change actually belongs: ${b.cut.slice(0, 3).join(", ")}.` },
  { id: "thin-statement", weight: 2,
    test: (b) => (b.terms?.length || 0) < 2,
    say: (b) => `the problem statement carries ${b.terms?.length || 0} usable term(s) after the stoplist, which is not enough to locate anything.` },
  { id: "wide-scope", weight: 1,
    test: (b) => (b.scope?.length || 0) > 4,
    say: (b) => `${b.scope.length} files are in scope; a change that touches more than a handful is usually two changes.` },
];

const TOTAL = SIGNALS.reduce((a, s) => a + s.weight, 0);

/** { score, band, reasons: [{id, why}] }. Never throws: a brief that cannot be
 *  scored is reported unscored, not scored zero — a zero here reads as "nothing
 *  unresolved" and the truth would be "nobody looked". */
export function ambiguity(b) {
  const reasons = [];
  let fired = 0;
  for (const s of SIGNALS) {
    let hit = false;
    try { hit = !!s.test(b); } catch { continue; }
    if (!hit) continue;
    fired += s.weight;
    let why = "";
    try { why = s.say(b); } catch { why = s.id; }
    reasons.push({ id: s.id, weight: s.weight, why });
  }
  const score = Math.round((fired / TOTAL) * 100) / 100;
  return { score, band: score >= 0.5 ? "high" : score >= 0.25 ? "some" : "low", fired, of: TOTAL, reasons };
}

/** The section the prompt carries. Stated rather than resolved: a brief that
 *  guesses at what it does not know produces work about the guess. */
export function lines(a) {
  if (!a) return ["- not scored"];
  if (!a.reasons.length) return ["- nothing unresolved"];
  return [
    `Ambiguity ${a.score} (${a.band}). Do not fill one in by guessing; if one blocks you, say which and stop.`,
    "",
    ...a.reasons.map((r) => `- **${r.id}** — ${r.why}`),
  ];
}
