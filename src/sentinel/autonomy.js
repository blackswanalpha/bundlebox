// autonomy.js — A5: autonomy is earned per fix type, and lost in one revert.
//
//   draft   every PR of this type opens as a draft and a person merges it
//   auto    the type merged cleanly `sentinel.autonomy_after` times in a row;
//           its PRs are marked ready and set to merge when CI passes
//
// A rejection breaks the streak and drops the type to draft. A revert does the
// same, and it is the only outcome that can move a type DOWN from auto after
// the fact. Nothing here merges anything: it answers whether a type may.
import * as store from "../core/store.js";
import { load } from "../core/config.js";
import * as policy from "./policy.js";

export const DOC = "sentinel-autonomy";
export const OUTCOMES = new Set(["merged", "rejected", "reverted"]);
const blank = () => ({ streak: 0, merged: 0, rejected: 0, reverted: 0, level: "draft", last: "" });

export const threshold = (cfg = load()) => Math.max(1, Number(cfg.sentinel?.autonomy_after) || 5);

/** The next state of one type after one outcome. Pure. */
export function step(t, outcome, k) {
  const n = { ...blank(), ...(t || {}) };
  if (outcome === "merged") { n.merged += 1; n.streak += 1; }
  else if (outcome === "rejected") { n.rejected += 1; n.streak = 0; }
  else if (outcome === "reverted") { n.reverted += 1; n.streak = 0; }
  n.level = n.streak >= k ? "auto" : "draft";
  n.last = outcome;
  return n;
}

export const ledger = () => { const d = store.get(DOC, {}); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; };

/** Record outcomes for the fix types one PR carried. Returns the new rows. */
export function observe(types, outcome, { cfg = load(), apply = true } = {}) {
  if (!OUTCOMES.has(outcome)) throw new Error(`outcome must be one of ${[...OUTCOMES].join(", ")}`);
  const k = threshold(cfg);
  // The Python expert decides each transition; `step` above is its mirror.
  const cur = ledger();
  const decided = Object.fromEntries(types.map((t) => [t, policy.step(cur[t], outcome, k, step)]));
  if (!apply) return decided;
  store.update(DOC, (d) => {
    const doc = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    for (const t of types) doc[t] = decided[t];
    return doc;
  }, {});
  return decided;
}

/** May a PR carrying these types auto-merge? Every type must be at `auto`. */
export function earned(types, led = ledger()) {
  return types.length > 0 && types.every((t) => led[t]?.level === "auto");
}
