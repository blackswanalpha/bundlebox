// route/index.js — the verb: route. Units in, a plan of lanes and waves out.
import { out, emit, warn } from "../core/log.js";
import * as store from "../core/store.js";
import { plan, report, persistable } from "./router.js";

export { plan, report, uuid5, slotsTotal } from "./router.js";

/** Persist a plan keyed by run_id. `plans` is an object of run_id -> plan
 *  skeleton; `lanes` is the flat list every other verb reads, with this run's
 *  lanes replacing any earlier lanes of the same run_id and other runs kept. */
export function writePlan(p) {
  const plans = store.get("plans", {});
  const safe = plans && typeof plans === "object" && !Array.isArray(plans) ? plans : {};
  safe[p.run_id] = { run_id: p.run_id, created: new Date().toISOString(), agent: p.agent, max_parallel: p.max_parallel,
    budget: p.budget, waves: p.waves, lane_ids: p.lanes.map((ln) => ln.id), local_unit_ids: p.local.map((u) => u.id) };
  store.put("plans", safe);
  const prev = store.get("lanes", []);
  const kept = (Array.isArray(prev) ? prev : []).filter((ln) => ln.run_id !== p.run_id);
  store.put("lanes", [...kept, ...p.lanes.map(persistable)]);
}

export const commands = {
  route: {
    help: "pack compiled units into lanes and waves (no tokens)",
    usage: "bb route [--write] [--max-parallel N] [--agent name] [--run-id id] [--json]",
    run: async ({ flags }) => {
      const units = (store.get("units", []) || []).filter((u) => ["ready", "local"].includes(u.status));
      if (!units.length) { warn("no ready units: run `bb compile --write` first"); }
      const p = plan(units, { runId: flags.runId ? String(flags.runId) : "", maxParallel: Number(flags.maxParallel) || 0, agent: flags.agent ? String(flags.agent) : "" });
      if (flags.write) writePlan(p);
      if (flags.json) { emit({ ...p, lanes: p.lanes.map(persistable), written: !!flags.write }); return 0; }
      out(report(p));
      if (flags.write) out(`  wrote plan ${p.run_id} (${p.lanes.length} lanes) to .bundlebox/var/plans.json and lanes.json`);
      else if (p.lanes.length) out("  dry-run: add --write to store the plan");
      return 0;
    },
  },
};
