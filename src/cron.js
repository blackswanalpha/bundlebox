// cron.js — the unattended worker. One crontab line, under flock, logging to
// ~/.bundlebox/logs. It runs the free path only: `pipeline run factory` never
// spends, and `bb run --apply` is not something a cron line gets to say.
import fs from "node:fs";
import path from "node:path";
import { ROOT, HOME, PKG_ROOT } from "./core/paths.js";
import { run, which } from "./core/exec.js";
import { out, warn, emit } from "./core/log.js";

const MARK = "# bundlebox";
export function line({ every = 30, root = ROOT } = {}) {
  const bb = which("bb") || path.join(PKG_ROOT, "bin", "bb.js");
  const lock = path.join(HOME, "cron.lock"), log = path.join(HOME, "logs", "factory.log");
  const flock = which("flock") ? `flock -n ${lock} ` : "";
  return `*/${Math.max(1, Math.min(59, Number(every) || 30))} * * * * cd ${JSON.stringify(root)} && ${flock}${JSON.stringify(bb)} pipeline run factory --quiet >> ${JSON.stringify(log)} 2>&1  ${MARK} ${root}`;
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
