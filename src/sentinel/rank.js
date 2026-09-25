// rank.js — A6: cut the backlog before automating on it.
//
// Every open finding lands in exactly one tier, by who can close it:
//
//   free    a CERTAIN actuator closes it, unattended (A1)
//   local   another actuator closes it for nothing, but a person applies it
//   agent   only a model can, and only the top few promotable ones go (A2)
//
// `d` is the share of the open backlog the free path can close without a
// model. It is the number the savings claim rests on: a run's cost falls by at
// most 1/(1-d), so it is measured here and reported, never assumed.
import { ACTUATORS, CERTAIN, DESTRUCTIVE } from "../actuators/index.js";
import { PLAN_ONLY } from "../actuators/_plan.js";
import { SEVERITY, triage } from "../detectors/index.js";
import { load } from "../core/config.js";

export function tierOf(f) {
  const a = f.auto_fix;
  if (a && CERTAIN.has(a)) return "free";
  if (a && ACTUATORS[a] && !PLAN_ONLY.has(a) && !DESTRUCTIVE.has(a)) return "local";
  return "agent";
}

const sev = (f) => SEVERITY[f.severity] ?? 0;

/** `{ open, free, local, agent, held, detectors, d }`. `agent` is the top
 *  `top` promotable findings, most severe first and cheapest first within a
 *  severity, because a lane that fits is a lane that finishes. */
export function rank(findings, { top = 5, cfg = load() } = {}) {
  const open = (findings || []).filter((f) => f.status === "open");
  const by = { free: [], local: [], agent: [] };
  for (const f of open) by[tierOf(f)].push(f);
  let promotable = by.agent;
  try { promotable = by.agent.filter((f) => triage(f, cfg).promote); } catch { /* no triage: every agent-tier finding competes */ }
  promotable.sort((a, b) => sev(b) - sev(a) || (Number(a.est_tokens) || 0) - (Number(b.est_tokens) || 0) || String(a.id).localeCompare(String(b.id)));
  const n = Math.max(0, Number(top) || 0);
  const agent = promotable.slice(0, n);
  const counts = new Map();
  for (const f of open) {
    const c = counts.get(f.detector) || { detector: f.detector, open: 0, closable: 0, certain: 0 };
    c.open += 1;
    const t = tierOf(f);
    if (t !== "agent") c.closable += 1;
    if (t === "free") c.certain += 1;
    counts.set(f.detector, c);
  }
  const detectors = [...counts.values()].sort((a, b) => b.certain - a.certain || b.closable - a.closable || b.open - a.open);
  return {
    open: open.length, free: by.free, local: by.local, agent,
    held: by.agent.length - agent.length,
    detectors,
    d: open.length ? Math.round(((by.free.length + by.local.length) / open.length) * 1000) / 1000 : 0,
  };
}
