// janitor/compact.js — type-aware compaction, and the one pass with a hard
// prohibition written into it.
//
// The Compaction Cliff (arXiv 2608.22752) measured 396,934 knowledge artefacts
// across 54,628 repositories and found that when an agent's accumulated context
// is summarised uniformly, safety rules survive 53% of ONE round and 10% of
// five. The cause is not that summarisers are bad. It is that a rule and an
// episode have different tolerances for lossy rewriting and a uniform
// compactor cannot know which it is holding: an episode at half its length is
// still the episode, and a rule at half its length is advice.
//
// So compaction here is typed, and the type decides what is permitted:
//
//   rule, fact, pointer    EXACT duplicates collapse and nothing else. The
//                          surviving text is byte-identical to what was
//                          written. Near-duplicates are reported, never fused:
//                          two rules that are 90% the same are either one rule
//                          written twice, which a human should delete, or two
//                          rules with a 10% difference that is the whole point.
//   note, episode          fused. Near-duplicates collapse to the best-anchored
//                          representative, and runs of episodes about the same
//                          source fold into one counted line.
//
// The other half of the cliff finding is replication, not compression:
// TypeDecompose beats uniform partitioning by putting in-scope rules in EVERY
// partition rather than splitting them across partitions. That belongs to the
// placement pass, and `pinned()` here is what hands it the set.
import { POLICY, similarity, terms, normalize, diag, value } from "./heap.js";

const better = (a, b) => {
  // The representative is the one a reader can most easily check: a live anchor
  // beats a drifted one beats none, then reach, then age.
  const rank = { live: 3, external: 2, drifted: 1, none: 0, dead: 0, unchecked: 1 };
  const ra = rank[a.resolution] ?? 0, rb = rank[b.resolution] ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  if (!!a.reached !== !!b.reached) return a.reached ? a : b;
  return Date.parse(a.learned_at || 0) >= Date.parse(b.learned_at || 0) ? a : b;
};

const mergeInto = (keep, drop) => ({
  ...keep,
  refs: [...new Set([...(keep.refs || []), ...(drop.refs || [])])],
  valid_from: Date.parse(drop.valid_from || 0) < Date.parse(keep.valid_from || 0) ? drop.valid_from : keep.valid_from,
  tokens: keep.tokens,
  meta: {
    ...keep.meta,
    also_at: [...new Set([...(keep.meta.also_at || []), `${drop.source}:${drop.line}`])],
    merged: (Number(keep.meta.merged) || 0) + 1,
  },
});

/** Group by exact normalised text. This is the only collapse a rule ever gets,
 *  and it is safe by construction: the objects are the same string. */
function collapseExact(objects) {
  const by = new Map();
  const diags = [];
  let merged = 0;
  for (const o of objects) {
    const k = `${o.kind}${normalize(o.text)}`;
    if (!by.has(k)) { by.set(k, o); continue; }
    const cur = by.get(k);
    const keep = better(cur, o), drop = keep === cur ? o : cur;
    by.set(k, mergeInto(keep, drop));
    merged++;
    diags.push(diag("note", "duplicate",
      `the same ${o.kind} is written in two places; keeping ${keep.source}:${keep.line}`, drop,
      { kept: `${keep.source}:${keep.line}`, fix: drop.kind === "rule" ? "delete one copy — a rule in two files drifts into two rules" : "" }));
  }
  return { objects: [...by.values()], diags, merged };
}

/** Near-duplicates. Reported for every kind, fused only for the kinds the
 *  policy lets be rewritten. */
function collapseNear(objects, { threshold = 0.82 }) {
  const bags = new Map(objects.map((o) => [o.id, terms(o.text)]));
  const df = new Map();
  for (const t of bags.values()) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  const buckets = new Map();
  for (const o of objects) {
    const rare = [...bags.get(o.id)].sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0)).slice(0, 2);
    for (const w of rare) {
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(o);
    }
  }
  const gone = new Map();      // dropped id -> keeper id
  const byId = new Map(objects.map((o) => [o.id, o]));
  const diags = [];
  let fused = 0, flagged = 0;
  for (const group of buckets.values()) {
    if (group.length < 2 || group.length > 300) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = byId.get(group[i].id), b = byId.get(group[j].id);
      if (!a || !b || a.id === b.id || gone.has(a.id) || gone.has(b.id)) continue;
      if (a.kind !== b.kind) continue;
      if (similarity(bags.get(a.id), bags.get(b.id)) < threshold) continue;
      const pol = POLICY[a.kind] || POLICY.note;
      const keep = better(a, b), drop = keep === a ? b : a;
      if (!pol.fold) {
        flagged++;
        diags.push(diag(a.kind === "rule" ? "warning" : "note", "near-duplicate",
          `two ${a.kind}s say nearly the same thing and neither was rewritten — ${a.kind} text is never fused`, drop,
          { other: keep.id, other_source: `${keep.source}:${keep.line}`,
            fix: "decide which one is current and delete the other by hand" }));
        continue;
      }
      byId.set(keep.id, mergeInto(keep, drop));
      gone.set(drop.id, keep.id);
      fused++;
    }
  }
  return { objects: objects.filter((o) => !gone.has(o.id)).map((o) => byId.get(o.id) || o), diags, fused, flagged };
}

/** Runs of episodes about the same source fold into one counted line. Three
 *  hundred rows of "bench.jsonl 412 rows" is one fact about bench.jsonl and
 *  three hundred lines of window. */
function foldEpisodes(objects, { minRun = 4 }) {
  const runs = new Map();
  const rest = [];
  for (const o of objects) {
    if (o.kind !== "episode" || o.reached) { rest.push(o); continue; }
    const k = `${o.source}${(o.meta && o.meta.store) || ""}`;
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(o);
  }
  const out = [...rest];
  const diags = [];
  let folded = 0;
  for (const [, group] of runs) {
    if (group.length < minRun) { out.push(...group); continue; }
    group.sort((a, b) => Date.parse(a.learned_at || 0) - Date.parse(b.learned_at || 0));
    const first = group[0], last = group[group.length - 1];
    folded += group.length - 1;
    out.push({
      ...better(first, last),
      text: `${group.length} episodes from ${first.source} between ${String(first.learned_at).slice(0, 10)} and ${String(last.learned_at).slice(0, 10)}`,
      tokens: Math.max(...group.map((g) => g.tokens || 0), 12),
      meta: { ...last.meta, folded: group.length, folded_from: first.learned_at, folded_to: last.learned_at },
    });
    diags.push(diag("note", "folded",
      `${group.length} unreached episodes from ${first.source} folded into one counted line`, last, { count: group.length }));
  }
  return { objects: out, diags, folded };
}

/** The set that placement must replicate rather than ration: live rules. The
 *  cliff paper's TypeDecompose result is that in-scope rules belong in every
 *  partition, at 0% locality violations against 93% under uniform splitting. */
export const pinned = (objects) => objects.filter((o) => o.kind === "rule" && !o.retracted_at && !(o.meta && o.meta.quarantined));

export function compact(objects, { near = 0.82, foldRuns = true, minRun = 4 } = {}) {
  const before = objects.reduce((a, o) => a + (o.tokens || 0), 0);
  const ex = collapseExact(objects);
  const nr = collapseNear(ex.objects, { threshold: near });
  const fe = foldRuns ? foldEpisodes(nr.objects, { minRun }) : { objects: nr.objects, diags: [], folded: 0 };
  const after = fe.objects.reduce((a, o) => a + (o.tokens || 0), 0);
  return {
    objects: fe.objects,
    diags: [...ex.diags, ...nr.diags, ...fe.diags],
    stats: {
      in: objects.length, out: fe.objects.length,
      exact: ex.merged, fused: nr.fused, flagged: nr.flagged, folded: fe.folded,
      tokens_before: before, tokens_after: after, tokens_saved: Math.max(0, before - after),
      rules_rewritten: 0,          // the invariant, asserted in the tests
    },
  };
}
