// janitor/sweep.js — dead code elimination for memory.
//
// Three ways out of the live set, and none of them is deletion.
//
//   contradict   two live objects making incompatible claims. The newer one
//                wins and the older is RETRACTED, carrying the id that beat it.
//                This is the Graphiti/Zep move and the reason it matters is
//                narrow: a deleted fact gets re-learned from the same bad
//                source next week, and a retracted one does not. It also keeps
//                the answer to "what did this agent believe in March", which is
//                the only question worth asking about a session that went
//                wrong six months ago.
//   quarantine   the anchor is gone. The claim is not known to be false, so
//                retracting it would be a lie; it is known to be UNCHECKABLE,
//                so emitting it into a window is how a stale line gets quoted
//                with full confidence. Held out of the window, kept on disk,
//                listed for a human.
//   age out      unreached, past its half-life, and of a kind the policy lets
//                go. Rules are never in this set at any age. This is the only
//                edge where time alone decides anything, and it only ever
//                fires on an object the mark phase already failed to reach.
//
// Everything this pass does is a PLAN until `--apply`. The plan is the same
// data structure either way, which is what makes the dry run trustworthy: the
// thing printed is the thing that would be written.
import { POLICY, HALF_LIFE, ageDays, isLive, similarity, terms, tombstone, diag, normalize } from "./heap.js";

// Negation is the cheapest polarity signal there is, and over normative text it
// is a good one: rules are written in the imperative and the imperative negates
// with a small closed vocabulary.
const NEG_RE = /\b(never|not|no|don't|do not|cannot|can't|must not|shall not|without|avoid|forbidden|refuse|skip|stop)\b/i;
const polarity = (t) => (NEG_RE.test(String(t)) ? -1 : 1);

// Versions and counts are the other free contradiction: same subject, two
// different numbers, and nothing in the heap says which is current.
const NUMS = (t) => (String(t).match(/\bv?\d+(?:\.\d+){1,2}\b|\b\d{2,}\b/g) || []).map(String);

const newer = (a, b) => (Date.parse(a.valid_from || a.learned_at || 0) >= Date.parse(b.valid_from || b.learned_at || 0) ? a : b);

/** Pairs worth comparing. Comparing every object against every other is
 *  quadratic and most pairs share no term at all, so objects are bucketed by
 *  their rarest terms first and only same-bucket pairs are scored. */
function candidates(objects, { minSim = 0.55, maxPairs = 200000 } = {}) {
  const df = new Map();
  const bags = new Map();
  for (const o of objects) {
    const t = terms(o.text);
    bags.set(o.id, t);
    for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  }
  const buckets = new Map();
  for (const o of objects) {
    // The three rarest terms: a bucket keyed on a common word is the whole heap.
    const rare = [...bags.get(o.id)].sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0)).slice(0, 3);
    for (const w of rare) {
      if ((df.get(w) || 0) > Math.max(40, objects.length * 0.08)) continue;
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(o);
    }
  }
  const seen = new Set();
  const pairs = [];
  for (const group of buckets.values()) {
    if (group.length < 2 || group.length > 400) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (pairs.length >= maxPairs) return pairs;
      const sim = similarity(bags.get(a.id), bags.get(b.id));
      if (sim >= minSim) pairs.push({ a, b, sim });
    }
  }
  return pairs;
}

/** Two objects making incompatible claims, decided without a model.
 *  Returns null when they merely resemble each other, which is the common case
 *  and is the compactor's business, not this one's. */
export function contradicts(a, b, sim) {
  if (normalize(a.text) === normalize(b.text)) return null;         // a duplicate, not a conflict
  if (polarity(a.text) !== polarity(b.text) && sim >= 0.6) {
    return { why: "same subject, opposite polarity" };
  }
  const na = NUMS(a.text), nb = NUMS(b.text);
  if (sim >= 0.7 && na.length && nb.length && na.join() !== nb.join() && !na.some((x) => nb.includes(x))) {
    return { why: `same subject, different numbers (${na.slice(0, 2).join(",")} vs ${nb.slice(0, 2).join(",")})` };
  }
  // Two facts anchored at the same place saying different things: one of them
  // is describing a file that has since changed under it.
  if (sim >= 0.65 && a.anchor && b.anchor && a.anchor.file && a.anchor.file === b.anchor.file
      && a.kind === "fact" && b.kind === "fact" && a.source !== b.source) {
    return { why: `two sources describe ${a.anchor.file} differently` };
  }
  return null;
}

/**
 * @param {object[]} objects  the marked, resolved heap
 * @param {object}   opt      ageFactor: how many half-lives of silence before an
 *                            unreached object is let go. 1 is aggressive, 3 is
 *                            the default and means a note has to be untouched
 *                            for nine months before anything happens to it.
 */
export function sweep(objects, { ageFactor = 3, minSim = 0.55, at = Date.now(), keepQuarantined = true } = {}) {
  const diags = [];
  const retract = new Map();      // id -> reason
  const quarantine = new Map();
  const live = objects.filter((o) => isLive(o, at));

  // ── contradictions ────────────────────────────────────────────────────────
  let conflicts = 0;
  for (const { a, b, sim } of candidates(live, { minSim })) {
    if (retract.has(a.id) || retract.has(b.id)) continue;
    const c = contradicts(a, b, sim);
    if (!c) continue;
    conflicts++;
    const win = newer(a, b);
    const lose = win === a ? b : a;
    // Two rules in conflict is never resolved silently. The newer one is not
    // obviously right — one of them may be the safety rule and the other the
    // convenience that quietly overrode it — so both stay and a human decides.
    if (a.kind === "rule" && b.kind === "rule") {
      diags.push(diag("error", "rule-conflict",
        `two live rules conflict (${c.why}); neither was retracted — ${sim.toFixed(2)} similar`, a,
        { other: b.id, other_source: `${b.source}:${b.line}`, fix: "delete one, or scope them so they cannot both apply" }));
      continue;
    }
    retract.set(lose.id, `superseded by ${win.id} — ${c.why}`);
    diags.push(diag("warning", "contradiction",
      `${c.why}; retracting the older claim in favour of ${win.id}`, lose,
      { winner: win.id, winner_source: `${win.source}:${win.line}`, similarity: Number(sim.toFixed(2)) }));
  }

  // ── quarantine and age-out ────────────────────────────────────────────────
  let aged = 0;
  for (const o of live) {
    if (retract.has(o.id)) continue;
    const pol = POLICY[o.kind] || POLICY.note;

    if (pol.quarantine && o.resolution === "dead") {
      quarantine.set(o.id, "anchor no longer exists");
      continue;
    }
    if (!pol.age_out || o.reached) continue;
    const hl = HALF_LIFE[o.kind];
    if (!Number.isFinite(hl)) continue;
    const age = ageDays(o, at);
    if (age < hl * ageFactor) continue;
    aged++;
    retract.set(o.id, `unreached for ${Math.round(age)} days, ${(age / hl).toFixed(1)} half-lives`);
  }

  // ── the plan ──────────────────────────────────────────────────────────────
  const next = objects.map((o) => {
    if (retract.has(o.id)) return tombstone(o, retract.get(o.id));
    if (quarantine.has(o.id)) return { ...o, meta: { ...o.meta, quarantined: quarantine.get(o.id) } };
    return o;
  });

  const kept = next.filter((o) => isLive(o, at) && !(o.meta && o.meta.quarantined));
  const heldOut = next.filter((o) => o.meta && o.meta.quarantined);

  return {
    objects: next,
    kept: keepQuarantined ? kept : kept,
    quarantined: heldOut,
    retracted: next.filter((o) => retract.has(o.id)),
    diags,
    stats: {
      in: objects.length, live: live.length, kept: kept.length,
      retracted: retract.size, quarantined: quarantine.size,
      conflicts, aged, tokens_reclaimed: next.filter((o) => retract.has(o.id) || quarantine.has(o.id)).reduce((a, o) => a + (o.tokens || 0), 0),
    },
  };
}
