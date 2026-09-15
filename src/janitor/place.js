// janitor/place.js — register allocation, where the registers are positions in
// a context window and the machine has a known dead zone in the middle.
//
// Chroma's Context Rot report evaluated 18 models — Claude 4, GPT-4.1, Gemini
// 2.5, Qwen3 among them — and the result that matters here is not that long
// inputs are worse. It is that models do not use their context UNIFORMLY, the
// degradation starts far below the token limit, and it gets sharply worse as
// the needle's similarity to the question drops and as distractors rise.
//
// Every layer of the stack above this one treats the window as a flat array. It
// is not. It has a front, a back, and a stretch in between where a correct fact
// placed at the wrong offset is a fact the model will not use. Position is a
// resource, and nothing in the toolchain was allocating it.
//
// So placement is serpentine. Survivors are ranked, then dealt alternately to
// the front and the back of the emitted order, which drives the lowest-valued
// content to the middle and leaves the two high-attention edges holding the
// things most likely to be needed. Content is not reordered by topic, by file
// or by when it was written — none of those correlate with what the model will
// need, and two of them actively cluster the important lines together in one
// place where half of them will sit in the dead stretch.
//
// Rules are the exception and get REPLICATED, not rationed: full text at the
// head, a one-line recall band at the tail. That is the cliff paper's
// TypeDecompose result applied to one window instead of many partitions — an
// in-scope rule belongs in every region that might be attended to, and
// replicating a hundred tokens is cheaper than a violated constraint.
//
// When the budget binds, the cut runs from the MIDDLE OUTWARD. Everything else
// cuts the tail, which throws away a high-attention position while keeping the
// dead one.
import { value } from "./heap.js";

export const DEFAULT_BUDGET = 12000;
// The middle share of the emitted order treated as low-attention. 0.4 is a
// deliberate under-claim: the reports differ on where the trough sits and this
// only has to be directionally right to beat allocating position at random.
export const DEAD_ZONE = 0.4;

const tokensOf = (o) => Math.max(1, Number(o.tokens) || Math.ceil(String(o.text || "").length / 4));

/** One line of recall for a rule: enough to re-fire the constraint at the tail
 *  without paying for the whole statement twice. */
const recall = (o) => ({
  ...o, id: `${o.id}~r`, tokens: Math.ceil(tokensOf(o) * 0.35),
  text: o.text.length > 120 ? `${o.text.slice(0, 117)}...` : o.text,
  meta: { ...o.meta, band: "recall", recalls: o.id },
});

/**
 * @param {object[]} objects  survivors of sweep+compact, already resolved and marked
 * @param {object}   opt      budget in tokens; replicateRules doubles rules at
 *                            a 35% tail cost; inDegree from the mark pass
 */
export function place(objects, { budget = DEFAULT_BUDGET, replicateRules = true, inDegree = new Map(), at = Date.now() } = {}) {
  const scored = objects
    .filter((o) => !o.retracted_at && !(o.meta && o.meta.quarantined))
    .map((o) => ({ o, v: value(o, { inDegree: inDegree.get ? (inDegree.get(o.id) || 0) : 0, at }), t: tokensOf(o) }))
    .sort((a, b) => b.v - a.v || b.t - a.t);

  const rules = scored.filter((s) => s.o.kind === "rule");
  const rest = scored.filter((s) => s.o.kind !== "rule");

  // ── deal ──────────────────────────────────────────────────────────────────
  // Head band is the rules in full; then the ranked remainder is dealt
  // alternately front/back so rank order maps to distance from the middle.
  const front = [];
  const back = [];
  for (let i = 0; i < rest.length; i++) (i % 2 === 0 ? front : back).push(rest[i]);
  back.reverse();

  const head = rules.map((s) => ({ ...s, band: "head" }));
  const tail = replicateRules ? rules.map((s) => ({ o: recall(s.o), v: s.v, t: recall(s.o).tokens, band: "tail" })) : [];

  let order = [...head, ...front.map((s) => ({ ...s, band: "front" })), ...back.map((s) => ({ ...s, band: "back" })), ...tail];

  // ── budget ────────────────────────────────────────────────────────────────
  // Cut from the middle outward. The middle is the cheapest position to lose
  // because it is the position the model reads worst; cutting the tail to fit
  // would surrender a high-attention slot and keep a low-attention one.
  const dropped = [];
  const overflow = [];
  let total = order.reduce((a, s) => a + s.t, 0);
  // Phase one: everything that is not a full-text rule, from the middle out.
  while (total > budget && order.length) {
    let idx = -1;
    const mid = Math.floor(order.length / 2);
    for (let d = 0; d < order.length && idx < 0; d++) {
      for (const cand of [mid + d, mid - d]) {
        if (cand < 0 || cand >= order.length) continue;
        if (order[cand].band === "head") continue;
        idx = cand; break;
      }
    }
    if (idx < 0) break;
    total -= order[idx].t;
    dropped.push(order[idx].o);
    order = order.filter((_, i) => i !== idx);
  }
  // Phase two: rules alone still overflow. A window four times its budget is
  // not a window, so the lowest-valued rules are cut — loudly. Silently
  // emitting them is the failure mode this whole pass exists to avoid, and
  // silently keeping them hands the caller an image that does not fit.
  while (total > budget) {
    let worst = -1;
    for (let i = 0; i < order.length; i++) if (order[i].band === "head" && (worst < 0 || order[i].v < order[worst].v)) worst = i;
    if (worst < 0) break;
    total -= order[worst].t;
    overflow.push(order[worst].o);
    dropped.push(order[worst].o);
    order = order.filter((_, i) => i !== worst);
  }

  // ── the report that says the placement did something ──────────────────────
  const n = order.length;
  const lo = Math.floor(n * (0.5 - DEAD_ZONE / 2));
  const hi = Math.ceil(n * (0.5 + DEAD_ZONE / 2));
  const band = (a, b) => order.slice(a, b);
  const avg = (xs) => (xs.length ? xs.reduce((a, s) => a + s.v, 0) / xs.length : 0);
  const edges = [...band(0, lo), ...band(hi, n)];
  const middle = band(lo, hi);

  return {
    placed: order.map((s, i) => ({ ...s.o, position: i, band: s.band, value: Number(s.v.toFixed(3)) })),
    dropped, overflow,
    stats: {
      placed: n, dropped: dropped.length, rules_dropped: overflow.length,
      tokens: total, budget, over_budget: Math.max(0, total - budget),
      rules_pinned: rules.length, rules_recalled: tail.length,
      edge_value: Number(avg(edges).toFixed(3)),
      dead_zone_value: Number(avg(middle).toFixed(3)),
      // The one number that says whether this pass earned its place. >1 means
      // the high-attention positions are carrying more value than the dead one.
      lift: middle.length && avg(middle) > 0 ? Number((avg(edges) / avg(middle)).toFixed(2)) : null,
    },
  };
}
