// policy.js — Sentinel's decisions, asked of the Python expert first.
//
// `bundlebox_expert.sentinel` owns tier, step, phases and round. Each call
// here sends it the evidence and takes its answer; with no python3 on the box,
// or a failed call, the JS mirror decides instead and `via` says which one did.
// The two are pinned against each other in test/sentinel.test.js.
import * as expert from "../core/expert.js";
import { load } from "../core/config.js";
import { ACTUATORS, CERTAIN, DESTRUCTIVE } from "../actuators/index.js";
import { PLAN_ONLY } from "../actuators/_plan.js";
import { triage } from "../detectors/index.js";
import { rank } from "./rank.js";

const ask = (op, payload) => {
  if (process.env.BB_SENTINEL_JS === "1" || !expert.available()) return null;
  const r = expert.call("sentinel", { op, ...payload }, { timeout: 30000 });
  return r && !r.error ? r : null;
};

export const SETS = () => ({ certain: [...CERTAIN], actuators: Object.keys(ACTUATORS), plan_only: [...PLAN_ONLY], destructive: [...DESTRUCTIVE] });

/** A6. Same shape as `rank()`: finding objects in each tier. */
export function tier(findings, { top = 5, cfg = load() } = {}) {
  const open = (findings || []).filter((f) => f.status === "open");
  const promote = (f) => { try { return Boolean(triage(f, cfg).promote); } catch { return true; } };
  const slim = open.map((f) => ({ id: f.id, status: f.status, detector: f.detector, auto_fix: f.auto_fix || null, severity: f.severity, est_tokens: f.est_tokens || 0, promote: promote(f) }));
  const r = ask("tier", { findings: slim, sets: SETS(), top });
  if (!r) return { ...rank(findings, { top, cfg }), via: "js" };
  const byId = new Map(open.map((f) => [f.id, f]));
  const pick = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean);
  return { open: r.open, free: pick(r.free), local: pick(r.local), agent: pick(r.agent), held: r.held, detectors: r.detectors, d: r.d, via: "python" };
}

/** A5, one transition. */
export function step(current, outcome, k, fallback) {
  const r = ask("step", { current: current || null, outcome, k });
  return r ? r : fallback(current, outcome, k);
}

/** Which phases a run takes. */
export function phases(state) {
  const r = ask("phases", { state });
  if (r) return { ...r, via: "python" };
  const run = ["sync", "scan", "rank"], skip = {};
  if (state.free > 0 || state.scripts > 0) run.push("autofix");
  else skip.autofix = "no certain finding and no @safe script tagged @fixes for an open detector";
  if (!state.spend) skip.sprint = skip.review = "no --spend";
  else if (!state.spend_ok) skip.sprint = skip.review = `spend keys not set: ${(state.missing || []).join(", ")}`;
  else {
    if (state.agent > 0) run.push("sprint"); else skip.sprint = "nothing in the agent tier";
    run.push("review");
  }
  return { run, skip, via: "js" };
}

/** A3, one PR's next step. */
export function round(state) {
  const r = ask("round", { state });
  if (r) return { ...r, via: "python" };
  if (!state.changes && !state.failed) return { state: "clean", via: "js" };
  if ((state.rounds || 0) >= (state.max || 3)) return { state: "needs-human", why: `${state.rounds} rounds, the cap is ${state.max}`, via: "js" };
  if (state.sig && state.sig === state.last_sig) return { state: "waiting", why: "no new feedback since the last round", via: "js" };
  if (!state.writable) return { state: "refused", why: "not a bb/ branch", via: "js" };
  return { state: "run", round: (state.rounds || 0) + 1, via: "js" };
}
