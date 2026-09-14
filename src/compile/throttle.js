// throttle.js — how much the factory is allowed to promote in one run.
//
// Triage answers "is this finding worth doing". It cannot answer "is this the
// tenth thing I have said yes to", because it sees one finding at a time.
// Without this, a scan that turns up 78 findings compiles every one that clears
// the floor and hands a session more work than a window holds.
//
// The authoritative, explainable copy is `expert/bundlebox_expert/throttle.py`;
// this is the JS mirror the zero-token path uses, and the selftest pins the two
// to the same answers. Nothing is dropped: what does not fit is DEFERRED with
// the limit that stopped it, and the next run reconsiders it first.
import * as store from "../core/store.js";

export const THROTTLE = { max_promotions: 12, max_tokens: 120000, per_detector: 4, cooldown_runs: 3 };

/** Defaults merged with `cfg.expert.throttle`. A typo cannot disable a limit. */
export function limits(cfg = {}) {
  const user = cfg?.expert?.throttle || {};
  const out = { ...THROTTLE };
  for (const k of Object.keys(THROTTLE)) {
    const v = Number(user[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  return out;
}

/** A detector whose most recent scored lane was broken sits out N runs. */
export function cooldowns(rows = null, runs = THROTTLE.cooldown_runs) {
  const outcomes = rows || store.rows("outcomes");
  const latest = new Map();
  for (const o of outcomes || []) {
    const at = o?.scored_at || o?.ended || "";
    for (const det of o?.detectors || []) {
      const prev = latest.get(det);
      if (!prev || at >= prev.at) latest.set(det, { at, verdict: o.verdict });
    }
  }
  const out = {};
  for (const [det, { verdict }] of latest) out[det] = { cooldown: verdict === "broken" ? runs : 0, last_verdict: verdict };
  return out;
}

/** decisions: [{id, detector, promote, priority, ev, est_tokens}] → same rows,
 *  each with `throttled`, and `throttle_reason` when deferred. */
export function apply(decisions, cfg = {}, history = null) {
  const lim = limits(cfg);
  const hist = history || cooldowns();
  const promoted = decisions.filter((d) => d.promote);
  const held = decisions.filter((d) => !d.promote).map((d) => ({ ...d, throttled: false }));
  // Priority first (0 most urgent), then expected value, then id: a stable
  // order, so two runs over the same findings defer the same ones.
  promoted.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || (Number(b.ev) || 0) - (Number(a.ev) || 0) || String(a.id).localeCompare(String(b.id)));
  const kept = [], deferred = [], byDetector = {};
  let spent = 0;
  for (const d of promoted) {
    const det = d.detector || "";
    const cool = Number(hist[det]?.cooldown || 0);
    const tok = Number(d.est_tokens) || 0;
    let why = null;
    if (cool > 0) why = `${det} is in cooldown for ${cool} more run(s): its last work was judged broken`;
    else if (kept.length >= lim.max_promotions) why = `run is at max_promotions=${lim.max_promotions}`;
    else if ((byDetector[det] || 0) >= lim.per_detector) why = `${det} is at per_detector=${lim.per_detector} for this run`;
    else if (spent + tok > lim.max_tokens) why = `run is at max_tokens=${lim.max_tokens} (${spent} spent, ${tok} more)`;
    if (why) { deferred.push({ ...d, promote: false, throttled: true, throttle_reason: why, deferred: true }); continue; }
    kept.push({ ...d, throttled: false });
    byDetector[det] = (byDetector[det] || 0) + 1;
    spent += tok;
  }
  return { promoted: kept, deferred, held, limits: lim, tokens: spent, by_detector: byDetector,
    summary: `${kept.length} promoted, ${deferred.length} deferred, ${held.length} held; ${spent} of ${lim.max_tokens} tokens` };
}
