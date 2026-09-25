// sentinel — the overseer. Everything that can be done without a model is
// done first; only what is left reaches an agent, and only inside a budget.
//
//   bb sentinel [plan]                 what a run would do, and the measured d
//   bb sentinel run [--apply] [--spend] [--top N]
//   bb sentinel sync [--apply]         PR outcomes -> episodes and the autonomy ladder
//   bb sentinel status [--json]
//
// One run, in order:
//
//   sync       read what happened to earlier auto-fix PRs          free   A4 A5
//   scan       every detector                                      free
//   rank       free / local / agent tiers, top N of the last       free   A6
//   autofix    certain fixes on bb/auto-fix/<date>, gated, draft   free   A1
//              PR; ironguard judges the diff before any push
//   sprint     the agent tier as lanes, --apply --pr, inside the   paid   A2
//              daily ceilings; foreman's verdict can veto a PR
//   review     PRs that asked for changes or failed CI get one     paid   A3
//              more lane on their own branch, up to max_rounds
//
// The paid phases need `--spend` AND the three keys. The row this writes to
// `sentinel-runs.jsonl` carries `d`, the share of the open backlog the free
// path could close: the savings a run can claim are bounded by 1/(1-d).
import { load } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { table } from "../core/util.js";
import * as store from "../core/store.js";
import { rank } from "./rank.js";
import { autoFix } from "./autofix.js";
import * as autonomy from "./autonomy.js";
import { sync } from "./outcomes.js";

export const RUNS = "sentinel-runs";

async function scan() {
  const { commands } = await import("../scan.js");
  return commands.scan.run({ _: [], flags: { quiet: true } });
}

/** The measured share, over every recorded run: closures the free path made
 *  against closures plus units handed to an agent. */
export function measured(rows = store.rows(RUNS)) {
  const free = rows.reduce((a, r) => a + (Number(r.free_closed) || 0), 0);
  const agent = rows.reduce((a, r) => a + (Number(r.agent_sent) || 0), 0);
  return { runs: rows.length, free, agent, d: free + agent ? Math.round((free / (free + agent)) * 1000) / 1000 : null };
}

export async function plan({ top, cfg = load() } = {}) {
  const r = rank(store.get("findings", []), { top: top || cfg.sentinel?.top || 5, cfg });
  const af = autoFix({ candidates: r.free, apply: false, cfg });
  const { permission } = await import("../sprint/index.js");
  return { rank: r, autofix: af, spend: permission(), autonomy: autonomy.ledger(), measured: measured() };
}

export async function runOnce({ apply = false, spend = false, top, cfg = load() } = {}) {
  const t0 = Date.now();
  const row = { apply, spend };
  const s = sync({ apply, cfg });
  row.sync = s.ok ? s.events.length : `skipped: ${s.why}`;
  await scan();
  const r = rank(store.get("findings", []), { top: top || cfg.sentinel?.top || 5, cfg });
  Object.assign(row, { open: r.open, free: r.free.length, local: r.local.length, agent_ranked: r.agent.length, held: r.held, d_backlog: r.d });
  const af = autoFix({ candidates: r.free, apply, cfg });
  row.autofix = af.state;
  row.free_closed = af.fixed?.length || 0;
  row.pr = af.pr?.url || "";
  let sprint = null, review = null;
  if (spend) {
    const sp = await import("../sprint/index.js");
    sprint = await sp.handoff({ apply, top: top || cfg.sentinel?.top, cfg });
    review = await sp.review({ apply, cfg });
    row.sprint = sprint.state;
    row.agent_sent = apply && sprint.state === "ran" ? sprint.lanes || 0 : 0;
    row.review = review.state;
  } else row.agent_sent = 0;
  row.seconds = Math.round((Date.now() - t0) / 1000);
  if (apply) {
    store.append(RUNS, row);
    store.append("episodes", { kind: "sentinel", verb: "sentinel run", features: { free: r.free.length, agent: r.agent.length, spend }, rc: af.state === "error" ? 1 : 0,
      seconds: row.seconds, produced: row.free_closed, useful: row.free_closed > 0 ? 1 : 0, detail: `autofix ${af.state}` });
  }
  return { ...row, rank: r, autofix_result: af, sprint_result: sprint, review_result: review };
}

function printPlan(p) {
  const r = p.rank;
  out(`  ${r.open} open: ${r.free.length} free (certain actuator), ${r.local.length} local (actuator, a person applies), ${r.agent.length} for agents now, ${r.held} held back`);
  out(`  d over the backlog: ${r.d}  (the free path could close that share without a model; cost falls by at most ${r.d < 1 ? (1 / (1 - r.d)).toFixed(2) : "∞"}x)`);
  if (p.measured.runs) out(`  d measured over ${p.measured.runs} run(s): ${p.measured.d ?? "-"} (${p.measured.free} closed free, ${p.measured.agent} sent to agents)`);
  if (r.detectors.length) out(table(r.detectors.slice(0, 10).map((d) => [d.detector, String(d.open), String(d.closable), String(d.certain)]), { header: ["detector", "open", "closable", "certain"] }));
  out(`  autofix: ${p.autofix.state}${p.autofix.branch ? ` on ${p.autofix.branch}` : ""}${p.autofix.count ? `, ${p.autofix.count} finding(s)` : ""}${p.autofix.why ? ` (${p.autofix.why})` : ""}`);
  out(`  spend: ${p.spend.ok ? "permitted inside the daily ceilings" : `refused, ${p.spend.missing.join(", ")} not set`}`);
  const types = Object.entries(p.autonomy);
  if (types.length) out(table(types.map(([t, v]) => [t, v.level, String(v.streak), String(v.merged), String(v.rejected), String(v.reverted)]), { header: ["fix type", "level", "streak", "merged", "rejected", "reverted"] }));
}

export const commands = {
  sentinel: {
    help: "the overseer: the free path first (certain fixes on a branch, gated, draft PR), agents only for the rest",
    usage: "bb sentinel [plan] [--top N] | run [--apply] [--spend] [--top N] | sync [--apply] | status [--json]",
    long: [
      "  run without --apply reports what it would do and writes nothing. With --apply the free phases",
      "  run: certain fixes on bb/auto-fix/<date>, `sentinel.gate` must pass, ironguard judges the diff,",
      "  a draft PR opens. --spend adds the paid phases (sprint lanes, review rounds), refused unless",
      "  bridge.enabled, bridge.daily_budget_usd and lanes.daily_budget_usd are set.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "plan";
      const cfg = load();
      if (sub === "plan" || sub === "status") {
        const p = await plan({ top: flags.top, cfg });
        if (flags.json) { emit({ ...p, rank: { ...p.rank, free: p.rank.free.map((f) => f.id), local: p.rank.local.map((f) => f.id), agent: p.rank.agent.map((f) => f.id) }, rounds: store.get("sentinel-rounds", {}) }); return 0; }
        printPlan(p);
        return 0;
      }
      if (sub === "sync") {
        const s = sync({ apply: Boolean(flags.apply), cfg });
        if (flags.json) { emit(s); return s.ok ? 0 : 1; }
        if (!s.ok) { warn(`sync: ${s.why}`); return 1; }
        out(s.events.length ? table(s.events.map((e) => [`#${e.pr}`, e.outcome, e.types.join(",")]), { header: ["pr", "outcome", "types"] }) : "  no new outcomes");
        if (!s.applied && s.events.length) out("  dry run; --apply records them");
        return 0;
      }
      if (sub === "run") {
        const r = await runOnce({ apply: Boolean(flags.apply), spend: Boolean(flags.spend), top: flags.top, cfg });
        if (flags.json) { emit({ ...r, rank: { open: r.rank.open, free: r.rank.free.length, local: r.rank.local.length, agent: r.rank.agent.map((f) => f.id), d: r.rank.d } }); return r.autofix === "error" ? 1 : 0; }
        out(`  ${r.open} open, d ${r.d_backlog}; autofix ${r.autofix}${r.autofix_result.why ? `: ${r.autofix_result.why}` : ""}`);
        if (r.sprint_result) out(`  sprint ${r.sprint_result.state}${r.sprint_result.why ? `: ${r.sprint_result.why}` : ""}; review ${r.review_result.state}${r.review_result.why ? `: ${r.review_result.why}` : ""}`);
        if (!r.apply) out("  dry run; --apply runs the free phases, --spend adds the paid ones");
        return r.autofix === "error" ? 1 : 0;
      }
      warn(`unknown: bb sentinel ${sub}`); return 2;
    },
  },
};
