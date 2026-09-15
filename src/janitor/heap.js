// janitor/heap.js — the IR.
//
// Everything a long-lived agent remembers is scattered across four stores that
// have nothing in common: markdown memory files, instruction blocks and skills,
// transcripts, and this factory's own append-only var store. They rot at
// different rates, they contradict each other, and nothing on the box has ever
// held them in one shape long enough to ask whether a claim is still true.
//
// So: one typed object. Every pass in the compiler reads and writes this and
// nothing else, which is what makes `parse` swappable and `sweep` testable.
//
// Five kinds, because the kind is the retention policy. The Compaction Cliff
// (arXiv 2608.22752) measured what happens when it is not: summarise a safety
// rule at the same rate as an episode and 53% of rules survive one round, 10%
// survive five, because only the rule needs its exact wording to stay
// enforceable. An episode summarised to half its length is still the episode.
// A rule summarised to half its length is advice.
//
//   rule      a normative constraint. Never lossy-compacted, never aged out.
//             Leaves the heap only when something contradicts it.
//   fact      a claim about the tree, carrying an anchor that can be checked.
//             The only kind the resolver can prove or disprove for free.
//   pointer   a reference out of the tree: a URL, an issue, a dashboard.
//   note      a durable observation with no hard anchor. Compacted freely.
//   episode   a record of something that happened. Decays fastest, folds best.
//
// Bitemporal, borrowed from Graphiti/Zep: an object carries BOTH when the claim
// was true in the world (valid_from/valid_to) and when this heap learned about
// it (learned_at/retracted_at). One axis cannot answer "what did the agent
// believe in March", which is the question you ask when a session six months
// old did something inexplicable. Contradicted objects are retracted, never
// deleted, because a deleted fact is re-learned from the same bad source next
// week and a retracted one is not.
import { sha1, now } from "../core/util.js";

export const KINDS = ["rule", "fact", "pointer", "note", "episode"];

// Half-life in days: the age at which an UNREACHED object of this kind has lost
// half its claim on the window. This is the dial the 3-to-12-month complaint
// actually turns. Episodes go first at a fortnight, notes at a quarter, facts
// at half a year, pointers at a year — which is why an agent that was sharp in
// month one is quoting a file layout that changed twice by month ten.
export const HALF_LIFE = { episode: 14, note: 90, fact: 180, pointer: 365, rule: Infinity };

// What the window pays for a kind, before any evidence about this object. A
// rule is worth carrying even unreached; an episode has to earn its place.
export const KIND_WEIGHT = { rule: 1.0, fact: 0.72, pointer: 0.45, note: 0.4, episode: 0.18 };

// Which passes are allowed to touch a kind. `merge` is exact-duplicate collapse
// and is always safe; `fold` is the lossy one that rewrites text.
export const POLICY = {
  rule:    { fold: false, merge: true, age_out: false, quarantine: true },
  fact:    { fold: false, merge: true, age_out: true,  quarantine: true },
  pointer: { fold: false, merge: true, age_out: true,  quarantine: true },
  note:    { fold: true,  merge: true, age_out: true,  quarantine: false },
  episode: { fold: true,  merge: true, age_out: true,  quarantine: false },
};

export const GENERATIONS = ["young", "middle", "old"];

const iso = (v) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const SEP = String.fromCharCode(0);

/** The id is content-addressed over the things that make two objects the same
 *  object: the kind, the store it came from and its normalised text. The same
 *  rule written into two CLAUDE.md files is two objects with two ids and one
 *  duplicate finding; the same rule re-parsed tomorrow is the same id, which is
 *  what lets marks and tombstones survive a rebuild. */
export const idOf = (kind, source, text) =>
  sha1(`${kind}${SEP}${source}${SEP}${normalize(text)}`).slice(0, 12);

/** Lowercased, punctuation-flattened, whitespace-collapsed. Used for the id and
 *  for duplicate detection, never for display. */
export const normalize = (s) =>
  String(s || "").toLowerCase().replace(/[`*_~>#[\]()]/g, " ").replace(/[^a-z0-9/.:_-]+/g, " ").trim().replace(/\s+/g, " ");

/** The bag of terms a duplicate check and a liveness check both work over.
 *  Two-character words are dropped: they carry no evidence and they make every
 *  pair of objects look related. */
export const terms = (s) => new Set(normalize(s).split(/[\s/]+/).filter((w) => w.length > 2));

/** Jaccard over term sets. No dependency, no embedding, no token spent. It is
 *  a weaker signal than a model would give and it is the right one here: a
 *  merge decision that costs an API call is a merge decision that never runs on
 *  a cron at 3am. */
export function similarity(a, b) {
  const A = a instanceof Set ? a : terms(a);
  const B = b instanceof Set ? b : terms(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / (A.size + B.size - hit);
}

/** Build an object. Every field has a defined value, because a pass that has to
 *  test for undefined is a pass with two behaviours. */
export function make({
  kind = "note", text = "", source = "", line = 0, anchor = null,
  valid_from = null, valid_to = null, learned_at = null, retracted_at = null,
  gen = "young", tokens = 0, refs = [], meta = {},
} = {}) {
  const k = KINDS.includes(kind) ? kind : "note";
  const t = String(text || "").trim();
  return {
    id: idOf(k, source, t),
    kind: k,
    text: t,
    source: String(source || ""),
    line: Number(line) || 0,
    anchor,                                    // { file, symbol?, line? } or null
    resolution: anchor ? "unchecked" : "none", // set by resolve: live|drifted|dead
    valid_from: iso(valid_from) || iso(learned_at) || now(),
    valid_to: iso(valid_to),
    learned_at: iso(learned_at) || now(),
    retracted_at: iso(retracted_at),
    gen: GENERATIONS.includes(gen) ? gen : "young",
    tokens: Number(tokens) || 0,
    refs: [...new Set((refs || []).filter(Boolean).map(String))],
    reached: null,                             // set by mark: null | { at, by }
    meta,
  };
}

/** Live means: this heap has not retracted it and the world has not moved past
 *  its validity window. Quarantine is a separate axis — a quarantined object is
 *  still live, it just may not be emitted. */
export const isLive = (o, at = Date.now()) => {
  if (o.retracted_at) return false;
  if (o.valid_to && Date.parse(o.valid_to) <= at) return false;
  return true;
};

export const ageDays = (o, at = Date.now()) =>
  Math.max(0, (at - Date.parse(o.learned_at || 0)) / 86400000);

/** Exponential decay on the kind's half-life, floored by reach. An object a
 *  session touched last week is fresh whatever its birthday says — that is the
 *  whole point of marking before sweeping. */
export function freshness(o, at = Date.now()) {
  const hl = HALF_LIFE[o.kind] ?? 90;
  if (!Number.isFinite(hl)) return 1;
  const reachedAt = o.reached && o.reached.at ? Date.parse(o.reached.at) : 0;
  const days = reachedAt ? Math.max(0, (at - reachedAt) / 86400000) : ageDays(o, at);
  return Math.pow(0.5, days / hl);
}

/** What this object is worth in a window, in [0,1]. Every term is evidence the
 *  factory already holds: no model is asked. */
export function value(o, { inDegree = 0, at = Date.now() } = {}) {
  const base = KIND_WEIGHT[o.kind] ?? 0.4;
  const fresh = freshness(o, at);
  const anchored = o.resolution === "live" ? 1.15 : o.resolution === "drifted" ? 0.7 : o.resolution === "dead" ? 0.25 : 1;
  const linked = 1 + Math.min(0.35, inDegree * 0.08);
  const touched = o.reached ? 1.25 : 1;
  // A rule floors at its base weight: an unreached rule is not a stale rule,
  // it is a rule nothing has tried to break yet.
  const decayed = o.kind === "rule" ? base : base * (0.35 + 0.65 * fresh);
  return Math.max(0, Math.min(1, decayed * anchored * linked * touched));
}

export const tombstone = (o, why, at = now()) => ({
  ...o, retracted_at: at, meta: { ...o.meta, retracted_why: why },
});

/** A diagnostic, in the shape a compiler prints them. `severity` is what makes
 *  `bb janitor` usable from a hook: errors are the ones a human must answer. */
export const diag = (severity, code, message, o = null, extra = {}) => ({
  severity, code, message,
  id: o ? o.id : null,
  source: o ? o.source : (extra.source || ""),
  line: o ? o.line : (extra.line || 0),
  ...extra,
});
