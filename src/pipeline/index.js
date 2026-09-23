// pipeline/index.js — `bb pipeline`: run a declared gear, list them, read past
// runs, and ask the graph whether the declared order still agrees with the
// measured one.
import * as store from "../core/store.js";
import { out, emit, warn } from "../core/log.js";
import { load } from "./spec.js";
import { runGear, report, listText, runsText, suggest, suggestText } from "./runner.js";
import { follow, line, runs } from "./usage.js";

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
  if (sub === "tail") return tail(flags);
  if (sub === "suggest") {
    const s = suggest(gears);
    if (flags.json) { emit(s); return s.error ? 2 : 0; }
    out(suggestText(s));
    return s.error ? 2 : 0;
  }
  warn(`unknown pipeline sub-verb: ${sub}. run | list | runs | tail | suggest`);
  return 2;
}

/** Print gear runs and their stages as the runner writes them, until Ctrl-C.
 *  `--json` is one row per line so another process can read the stream. */
function tail(flags) {
  const gear = typeof flags.gear === "string" ? flags.gear : null;
  const show = (r) => !!r.gear && (!gear || r.gear === gear) &&
    (r.kind !== "stage" || !!flags.verbose || (r.state && r.state !== "skipped"));
  const print = (r) => (flags.json ? process.stdout.write(JSON.stringify(r) + "\n") : console.log(line(r)));
  // History shows each run once; live, a chained gear prints again when its chain finishes.
  for (const r of runs(store.rows("gear_runs")).filter(show).slice(-(Number(flags.limit) || 10))) print(r);
  if (!flags.json) console.log(`  -- following gear runs${gear ? ` of ${gear}` : ""}${flags.verbose ? " and every stage" : " and stages that ran"}; Ctrl-C stops`);
  const f = follow(["episodes", "gear_runs"], (name, r) => {
    if (name === "episodes" && r.kind !== "stage") return;
    if (show(r)) print(r);
  }, { interval: Number(flags.interval) * 1000 || 1000 });
  return new Promise((resolve) => process.once("SIGINT", () => { f.close(); resolve(0); }));
}

export const commands = {
  pipeline: {
    help: "run declared gears (pipelines of local verbs) with gates and freshness",
    usage: "bb pipeline run <gear> [--apply] [--verbose] | list | runs [--limit N] | tail [--gear g] [--limit N] [--verbose] [--json] | suggest [--json]",
    long: "  A gear is an ordered list of verbs with a gate in front of each. Without\n  --apply every stage is `would-run`. Stages skip when their gate is false or\n  their inputs are unchanged since last run; a gate that cannot be evaluated\n  runs the stage. User gears: .bundlebox/gears.json.\n\n  bb pipeline tail   the last runs, then every gear run and stage as it is\n  written, until Ctrl-C. --verbose adds skipped stages, --json one row a line.",
    run: pipelineCmd,
  },
};
