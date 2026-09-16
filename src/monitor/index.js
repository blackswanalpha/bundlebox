// monitor/index.js — what this workspace is spending, right now, how long the
// current window lasts at this rate, and what the box saved it.
//
// EVERY PATH IS PER-WORKSPACE. The root is the nearest `.bundlebox` (or git
// root) above cwd, so `bb monitor` run inside any project reports that project
// and no other. The reports say which root they read for that reason: "nothing
// recorded" and "wrong directory" otherwise print the same thing.
//
// The data is the transcript every agent already writes, folded into
// `store.usage` by `bb tokens ledger`. No API call, no polling of a service, no
// estimate where a measurement exists.
//
// The window model matters more than the totals. Claude Code bills in FIVE-HOUR
// ROLLING BLOCKS that start with the first message after a gap, not in calendar
// days, so a daily total answers the wrong question: what a person needs to
// know at 14:40 is how much of the block that started at 11:05 is left. Blocks
// can be back to back and the gap between them is what ends one.
//
// Every number carries where it came from:
//   measured    folded from a transcript, to the token
//   p90         this account's own 90th-percentile block over the last 8 days
//   plan        the published ceiling for a named plan
//   unknown     nothing to read; the verb says so rather than printing a zero
//
// Exit codes make it usable from a hook or a cron line without parsing:
//   0 ok · 10 near the limit · 11 limit reached · 20 indeterminate · 30 error
import path from "node:path";
import { VAR } from "../core/paths.js";
import { writeJson, load as loadCfg } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { rows, blocks, limitOf, burn, snapshot, guard, BLOCK_HOURS, LOOKBACK_HOURS, BURN_MINUTES, NEAR, PLANS, MIN_BURN_SPAN } from "./window.js";
import { titles, titleOf, resetTitles, sessions, TITLES } from "./sessions.js";
import { savings, workspace, spend, CACHE_DISCOUNT } from "./savings.js";
import { statusText, savingsText, sessionsText, blocksText, compact } from "./report.js";
import { setColor } from "./render.js";

export { rows, blocks, limitOf, burn, snapshot, guard, BLOCK_HOURS, LOOKBACK_HOURS, BURN_MINUTES, NEAR, PLANS, MIN_BURN_SPAN } from "./window.js";
export { titles, titleOf, resetTitles, sessions, TITLES } from "./sessions.js";
export { savings, workspace, spend, CACHE_DISCOUNT } from "./savings.js";
export { statusText, savingsText, sessionsText, blocksText, compact } from "./report.js";
export { setColor, coloured } from "./render.js";

export const STATE = () => path.join(VAR, "monitor.json");

// ── reporting ───────────────────────────────────────────────────────────────
// The reports live in report.js and the paint in render.js. `text` stays as the
// name every caller already imports.
export const text = (s, opts = {}) => statusText(s, opts);

export const CODES = { ok: 0, near: 10, hit: 11, indeterminate: 20, error: 30 };

const SUBS = new Set(["status", "savings", "blocks", "sessions", "guard"]);

async function cmd({ _, flags }) {
  const sub = _[0] || "status";
  if (!SUBS.has(sub)) { warn(`unknown subcommand "${sub}". One of: ${[...SUBS].join(", ")}`); return CODES.error; }
  // `--no-color` and `--plain` are the same request; NO_COLOR and a pipe are
  // honoured without either. A report read by a machine is read with --json.
  if (flags.noColor || flags.plain) setColor(false);
  const opts = { plan: String(flags.plan || loadCfg().monitor?.plan || "custom"), limit: Number(flags.limit) || 0, fold: flags.fold !== false };

  if (sub === "savings") {
    const v = savings({ days: Number(flags.days) || 0, limit: Number(flags.limit) || 4000, fold: flags.fold === true });
    if (flags.json) { emit(v); return v.avoided.known ? 0 : CODES.indeterminate; }
    out(savingsText(v));
    return v.avoided.known ? 0 : CODES.indeterminate;
  }

  if (sub === "sessions") {
    const rowsOut = sessions({ limit: Number(flags.limit) || 20 });
    if (flags.json) { emit({ sessions: rowsOut }); return 0; }
    out(sessionsText(rowsOut, { place: workspace().label }));
    return rowsOut.length ? 0 : CODES.indeterminate;
  }

  if (sub === "blocks") {
    const bs = blocks().slice(-(Number(flags.limit) || 12));
    if (flags.json) { emit({ blocks: bs }); return 0; }
    out(blocksText(bs, { place: workspace().label }));
    return bs.length ? 0 : CODES.indeterminate;
  }

  if (sub === "guard") {
    const g = guard({ ...opts, allowNear: !!flags.allowNear });
    if (flags.json) { emit(g); return g.ok ? 0 : CODES.near; }
    out(`  ${g.ok ? "ok" : "REFUSE"} — ${g.why}`);
    return g.ok ? 0 : CODES[g.state] ?? CODES.error;
  }

  const s = snapshot(opts);
  // The status view carries ONE savings line so the answer to "is this box
  // worth it" is in the default view rather than behind a subcommand. It is a
  // read of rows already on disk, so it costs the report nothing.
  const here = workspace();
  const saved = flags.compact || flags.json ? null : savings({ limit: 4000 });
  if (flags.writeState) writeJson(String(flags.writeState) === "true" ? STATE() : String(flags.writeState), s);
  if (flags.json) emit(s);
  else if (flags.compact) console.log(compact(s));
  else out(text(s, { place: here.label, saved, here }));

  if (flags.watch) {
    const every = Math.max(Number(flags.interval) || 10, 2) * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, every));
      const next = snapshot(opts);
      if (flags.writeState) writeJson(String(flags.writeState) === "true" ? STATE() : String(flags.writeState), next);
      if (flags.compact) console.log(compact(next));
      else { out(""); out(text(next, { place: here.label, saved, here })); }
    }
  }
  return CODES[s.state] ?? CODES.error;
}

export const commands = {
  monitor: {
    help: "what this workspace is spending in the current 5-hour block, and how many tokens the box saved it",
    usage: "bb monitor [status|savings|blocks|sessions|guard] [--days n] [--plan pro|max5|max20|custom] [--limit n] [--compact] [--json] [--no-color] [--watch --interval 10] [--write-state]",
    long: [
      "  bb monitor                     the current block, the spend rate, and which clock runs out first",
      "  bb monitor savings             how many tokens this codebase did NOT have to spend, and on what",
      "  bb monitor savings --days 7    the same, over the last week only",
      "  bb monitor --compact           one line, for a status bar",
      "  bb monitor guard               refuse-or-allow, asked before anything spends",
      "  bb monitor sessions            every session with its own title, what it used and what it displaced",
      "  bb monitor blocks              the 5-hour blocks this workspace has run",
      "",
      "Runs in ANY workspace: the root is the nearest .bundlebox (or git root) above cwd, and",
      "every report names the root it read. Spend is MEASURED from the transcripts the agents",
      "already wrote; savings are displaced turns COUNTED from work done and valued at this",
      "workspace's own median billed turn. The two are never netted against each other.",
      "",
      "Exit codes: 0 ok · 10 near · 11 limit reached · 20 indeterminate · 30 error.",
      "The limit defaults to this account's own P90 block over the last 8 days; --plan uses a published ceiling.",
    ].join("\n"),
    run: cmd,
  },
};
