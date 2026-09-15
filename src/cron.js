// cron.js — the unattended worker. One crontab line, under flock, logging to
// ~/.bundlebox/logs. It runs the free path only: `pipeline run factory` never
// spends, and `bb run --apply` is not something a cron line gets to say.
//
// The line carries `--apply`, and that is not the same `--apply` the rest of
// the box means by it. Every verb inside `factory` is one that only writes
// under .bundlebox/ — scan, snapgen, compile, route, the ledger, the bench —
// and `run` is not among them, which is checked below rather than assumed.
// Without the flag every stage reported `would-run` and the worker ran every
// half hour for a year producing nothing, which is the most expensive kind of
// working cron line there is.
import fs from "node:fs";
import path from "node:path";
import { ROOT, HOME, PKG_ROOT } from "./core/paths.js";
import { run, which } from "./core/exec.js";
import { out, warn, emit } from "./core/log.js";

const MARK = "# bundlebox";
/** The gear the worker runs, and the verbs it is allowed to contain. A gear is
 *  data on disk, so this is checked when the line is built rather than trusted:
 *  adding `run` to `factory` must not turn a cron line into a spending loop. */
export const CRON_GEAR = "factory";
export const SPENDING_VERBS = new Set(["run", "bridge"]);

/** [] when the gear is safe to run unattended, or the verbs that are not. */
export async function unsafeVerbs(gearName = CRON_GEAR) {
  try {
    const { load } = await import("./pipeline/spec.js");
    const { gears } = await load();
    const seen = new Set(), stack = [gearName], bad = [];
    while (stack.length) {
      const g = gears[stack.pop()];
      if (!g || seen.has(g.name)) continue;
      seen.add(g.name);
      for (const st of g.stages) if (SPENDING_VERBS.has(st.verb)) bad.push(`${g.name}/${st.verb}`);
      for (const c of g.chain) stack.push(c.gear);
    }
    return bad;
  } catch { return []; }
}

export function line({ every = 30, root = ROOT } = {}) {
  const bb = which("bb") || path.join(PKG_ROOT, "bin", "bb.js");
  const lock = path.join(HOME, "cron.lock"), log = path.join(HOME, "logs", "factory.log");
  const flock = which("flock") ? `flock -n ${lock} ` : "";
  return `*/${Math.max(1, Math.min(59, Number(every) || 30))} * * * * cd ${JSON.stringify(root)} && ${flock}${JSON.stringify(bb)} pipeline run ${CRON_GEAR} --apply --quiet >> ${JSON.stringify(log)} 2>&1  ${MARK} ${root}`;
}
function current() {
  if (!which("crontab")) return null;
  const r = run(["crontab", "-l"], { timeout: 10000 });
  return r.rc === 0 ? r.out : r.err.includes("no crontab") ? "" : null;
}
function install(text) {
  const r = run(["crontab", "-"], { input: text.endsWith("\n") ? text : text + "\n", timeout: 10000 });
  return r.rc === 0;
}
const ours = (l) => l.includes(`${MARK} ${ROOT}`);

export const commands = {
  cron: {
    help: "the unattended worker: one crontab line running the free pipeline",
    usage: "bb cron install [--every 30] [--apply] | status | remove [--apply]",
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      const cur = current();
      if (cur === null) { warn("crontab is not available on this box"); return 2; }
      const mine = cur.split("\n").filter(ours);
      if (sub === "status") {
        if (flags.json) { emit({ installed: mine.length > 0, lines: mine }); return 0; }
        out(mine.length ? `  installed:\n  ${mine.join("\n  ")}` : "  not installed. bb cron install --apply");
        return 0;
      }
      if (sub === "install") {
        const l = line({ every: flags.every });
        fs.mkdirSync(path.join(HOME, "logs"), { recursive: true });
        const bad = await unsafeVerbs();
        if (bad.length) { warn(`refusing to install: \`${CRON_GEAR}\` reaches a verb that can spend (${bad.join(", ")}). A cron line does not get to say that.`); return 2; }
        if (!flags.apply) { out(`  would add:\n  ${l}\n  re-run with --apply`); return 0; }
        const rest = cur.split("\n").filter((x) => !ours(x) && x.trim());
        if (!install([...rest, l].join("\n"))) { warn("crontab write failed"); return 1; }
        out(`  installed; log at ${path.join(HOME, "logs", "factory.log")}`);
        return 0;
      }
      if (sub === "remove") {
        if (!mine.length) { out("  nothing to remove"); return 0; }
        if (!flags.apply) { out(`  would remove ${mine.length} line(s); re-run with --apply`); return 0; }
        const rest = cur.split("\n").filter((x) => !ours(x) && x.trim());
        if (!install(rest.join("\n"))) { warn("crontab write failed"); return 1; }
        out("  removed");
        return 0;
      }
      warn(`unknown: bb cron ${sub}`); return 2;
    },
  },
};
