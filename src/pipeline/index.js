// pipeline/index.js — `bb pipeline`: run a declared gear, list them, read past
// runs, and ask the graph whether the declared order still agrees with the
// measured one.
import * as store from "../core/store.js";
import { out, emit, warn } from "../core/log.js";
import { load } from "./spec.js";
import { runGear, report, listText, runsText, suggest, suggestText } from "./runner.js";

export { runGear, report, suggest } from "./runner.js";
export { holds, evaluate, load } from "./spec.js";

async function pipelineCmd({ _, flags }) {
  const sub = _[0] || "list";
  const { gears, warnings } = await load();
  if (sub === "list") {
    if (flags.json) { emit({ gears: Object.values(gears).map((g) => ({ ...g, stages: g.stages.map((s) => ({ ...s, inputs: s.inputs ? "fn" : null })) })), warnings }); return 0; }
    out(listText(gears, warnings));
    return 0;
  }
  if (sub === "run") {
    const name = _[1];
    if (!name) { warn("which gear? bb pipeline run <gear> [--apply] [--verbose]"); return 2; }
    for (const w of warnings) warn(w);
    const r = await runGear(name, { apply: !!flags.apply, verbose: !!flags.verbose, quiet: !!flags.quiet || !!flags.q, gears });
    if (flags.json) { emit(r); return r.rc || 0; }
    out(report(r, { verbose: !!flags.verbose }));
    if (!flags.apply && r.would_run) out("   dry run: nothing ran. --apply runs the stages marked ?");
    return r.rc || 0;
  }
  if (sub === "runs") {
    const rows = store.rows("gear_runs", { limit: Number(flags.limit) || 20 }).filter((r) => !r.chained_update);
    if (flags.json) { emit({ runs: rows }); return 0; }
    out(runsText(rows));
    return 0;
  }
  if (sub === "suggest") {
    const s = suggest(gears);
    if (flags.json) { emit(s); return s.error ? 2 : 0; }
    out(suggestText(s));
    return s.error ? 2 : 0;
  }
  warn(`unknown pipeline sub-verb: ${sub}. run | list | runs | suggest`);
  return 2;
}

export const commands = {
  pipeline: {
    help: "run declared gears (pipelines of local verbs) with gates and freshness",
    usage: "bb pipeline run <gear> [--apply] [--verbose] | list | runs [--limit N] | suggest [--json]",
    long: "  A gear is an ordered list of verbs with a gate in front of each. Without\n  --apply every stage is `would-run`. Stages skip when their gate is false or\n  their inputs are unchanged since last run; a gate that cannot be evaluated\n  runs the stage. User gears: .bundlebox/gears.json.",
    run: pipelineCmd,
  },
};
