// run/index.js — `bb run` and `bb agents`. Dry-run by default: the prompts and
// commands are written and printed, nothing is spawned until --apply.
import * as store from "../core/store.js";
import { load } from "../core/config.js";
import { out, emit, warn } from "../core/log.js";
import { human, table } from "../core/util.js";
import { ORDER, ADAPTERS, detect } from "../adapters/index.js";
import { execute } from "./runner.js";

/** The plan for a run id, assembled from the store: lanes (with their units)
 *  grouped into waves. A `plans` doc with explicit waves wins when present. */
export function loadPlan(runId = "") {
  const lanes = store.get("lanes", []);
  if (!lanes.length) return null;
  const id = !runId || runId === "latest" ? lanes[lanes.length - 1].run_id : String(runId);
  const mine = lanes.filter((l) => l.run_id === id);
  if (!mine.length) return null;
  const units = new Map(store.get("units", []).map((u) => [u.id, u]));
  const full = mine.map((l) => ({ ...l, units: (l.unit_ids || []).map((u) => units.get(u)).filter(Boolean) }));
  const stored = (store.get("plans", []) || []).find((p) => p.run_id === id);
  let waves = stored?.waves?.length ? stored.waves : null;
  if (!waves) {
    const by = new Map();
    for (const l of full) { const w = Number(l.wave) || 1; if (!by.has(w)) by.set(w, []); by.get(w).push(l.id); }
    waves = [...by.keys()].sort((a, b) => a - b).map((w) => by.get(w));
  }
  return { run_id: id, lanes: full, waves };
}

async function runCmd({ flags }) {
  const plan = loadPlan(flags.plan ? String(flags.plan) : "latest");
  if (!plan) { warn("no plan in the store — run `bb route` first"); return 2; }
  const apply = Boolean(flags.apply);
  const r = await execute(plan, { apply, pr: Boolean(flags.pr), maxParallel: flags.maxParallel || 0, adapter: flags.agent ? String(flags.agent) : "" });
  if (flags.json) { emit(r); return r.rc; }
  if (r.why) { warn(r.why); return r.rc; }
  out(`  run ${r.run_id}   agent ${r.agent}   ${apply ? "APPLIED" : "DRY RUN — add --apply to spawn"}   ${r.wire}`);
  for (const l of r.results) {
    if (l.dry_run) out(`  ${l.lane}  ${l.cmd_file}   ${l.why}`);
    else out(`  ${l.lane}  rc ${l.rc}${l.why ? ` (${l.why})` : ""}  peak ${human(l.peak)}  ${l.turns || 0} turns  ${l.seconds || 0}s${l.unproven ? `  unproven: ${l.unproven.join(",")}` : ""}${l.pr ? `  pr: ${l.pr.ok ? l.pr.url : l.pr.why}` : ""}`);
  }
  if (!apply) out("  prompts and commands are under .bundlebox/var/runs/" + r.run_id);
  else if (r.unproven.length) out(`  ${r.unproven.length} unit(s) have no acceptance and are UNPROVEN, not passed`);
  return r.rc;
}

async function agentsCmd({ flags }) {
  const installed = detect();
  const cfg = load();
  if (flags.json) { emit({ picked: cfg.lanes.agent, installed, adapters: ORDER.map((n) => ({ name: n, bin: ADAPTERS[n].bin, lean: ADAPTERS[n].leanFlags(), verified: ADAPTERS[n].verified || null })) }); return 0; }
  const have = new Map(installed.map((d) => [d.name, d]));
  const rows = ORDER.map((n) => { const d = have.get(n); const a = ADAPTERS[n]; return [n, d ? d.path : "-", d?.version || "-", a.leanFlags().join(" ") || "(no lean stack)", a.verified?.flags?.length ? "verified" : "unverified"]; });
  out(table(rows, { header: ["agent", "path", "version", "lean flags", "flags"] }));
  out(`  lanes.agent = ${cfg.lanes.agent}${cfg.lanes.custom_command ? `   custom: ${cfg.lanes.custom_command}` : ""}`);
  return 0;
}

export const commands = {
  run: { help: "execute the routed plan as agent lanes (dry-run by default)", usage: "bb run [--plan <run_id>|latest] [--apply] [--pr] [--agent <name>] [--max-parallel N] [--json]", run: runCmd },
  agents: { help: "which agent CLIs are installed, and the lean flag stack for each", usage: "bb agents [--json]", run: agentsCmd },
};
