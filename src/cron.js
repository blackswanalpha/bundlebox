// cron.js — the unattended worker. Two crontab lines, under flock, logging to
// ~/.bundlebox/logs. They run the free path only: `pipeline run factory` never
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

/** The lines `install` writes, one per gear. Two, because a gear declaring
 *  `on: cron` was an eligibility and not a schedule: `factory` was the only
 *  entry, and `situation`, `ops` and `scenarios` carried `cron` for months
 *  while nothing reached them. `full` is on the slower line because it is not
 *  free in the way `factory` is — `scenarios` needs a service up and writes a
 *  board — and it runs ungated: the recom gate answers from the tree, the
 *  config and the head commit, and a service coming up changes none of them.
 *  `every` is minutes; 360 is a starting number, not a measured one. */
export const CRON_ENTRIES = [
  { gear: "factory", every: 30, gate: true, log: "factory.log" },
  { gear: "full", every: 360, gate: false, log: "full.log" },
];

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

/** The recom record the worker gates on. Without it the line fires every 30
 *  minutes whatever the tree did, which on a quiet box is 48 full pipeline runs
 *  a day over code nobody touched — the most expensive kind of working cron
 *  line there is, in the second sense. `bb recom gate` prints the recorded
 *  answer and runs NOTHING while every declared fact still reads the same. */
export const GATE_ID = "cron/factory";

// A cron schedule for a cadence in minutes: every N minutes under an hour,
// on the hour every H hours past it. Anything else rounds to the nearest.

export function schedule(every) {
  const m = Math.max(1, Math.round(Number(every) || 30));
  if (m < 60) return `*/${Math.min(59, m)} * * * *`;
  const h = Math.max(1, Math.min(23, Math.round(m / 60)));
  return `0 */${h} * * *`;
}

export function line({ every = 30, root = ROOT, gate = true, gear = CRON_GEAR, log: logName = "" } = {}) {
  const bb = which("bb") || path.join(PKG_ROOT, "bin", "bb");
  const lock = path.join(HOME, "cron.lock"), log = path.join(HOME, "logs", logName || `${gear}.log`);
  const flock = which("flock") ? `flock -n ${lock} ` : "";
  const work = `${JSON.stringify(bb)} pipeline run ${gear} --apply --quiet`;
  const cmd = gate ? `${JSON.stringify(bb)} recom gate ${GATE_ID} -- ${work}` : work;
  return `${schedule(every)} cd ${JSON.stringify(root)} && ${flock}${cmd} >> ${JSON.stringify(log)} 2>&1  ${MARK} ${root}`;
}

/** Every line `install` writes. `--every` moves the factory line only; the
 *  slower one keeps its own cadence. */
export function lines({ every, gate = true, root = ROOT } = {}) {
  return CRON_ENTRIES.map((e) => line({ ...e, root, every: e.gear === CRON_GEAR && every ? every : e.every, gate: e.gate && gate }));
}

/** The gear a line of ours runs, or "" for a line that is not ours. */
export const gearOf = (l) => (ours(l) ? (String(l).match(/pipeline run (\S+)/) || [])[1] || "" : "");

/** Which gears declaring `on: cron` an installed line actually reaches, by
 *  walking each installed entry's chain. `installed` is null when crontab
 *  cannot be read, and then nothing is claimed either way. */
export async function cronGears() {
  const cur = current();
  const installed = cur === null ? null : cur.split("\n").map(gearOf).filter(Boolean);
  let declared = [], reached = new Set();
  try {
    const { load } = await import("./pipeline/spec.js");
    const { gears } = await load();
    declared = Object.values(gears).filter((g) => (g.on || []).includes("cron")).map((g) => g.name);
    const stack = [...(installed || [])];
    while (stack.length) {
      const g = gears[stack.pop()];
      if (!g || reached.has(g.name)) continue;
      reached.add(g.name);
      for (const c of g.chain) stack.push(c.gear);
    }
  } catch { /* no gears: nothing declared, nothing missing */ }
  return { installed, declared, reached: [...reached], missing: installed === null ? [] : declared.filter((g) => !reached.has(g)) };
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
    help: "the unattended worker: the crontab lines that run the free pipeline",
    usage: "bb cron install [--every 30] [--no-gate] [--apply] | status | remove [--apply]",
    long: [
      `  Two lines. \`${CRON_ENTRIES[0].gear}\` every ${CRON_ENTRIES[0].every} minutes under \`bb recom gate ${GATE_ID}\`: it re-probes the head`,
      "  commit, the tree and the config, prints the recorded answer and runs NOTHING while all three",
      "  read the same. Anything that is not provably fresh runs, so the failure direction costs one",
      "  extra pipeline pass and never a stale answer. `--no-gate` installs the old unconditional line.",
      `  \`${CRON_ENTRIES[1].gear}\` every ${CRON_ENTRIES[1].every / 60} hours, ungated: it reaches every other gear that declares \`on: cron\`, and`,
      "  a stage that needs a service up reports unknown and moves on when nothing answers.",
      "  `bb doctor` has a row for a cron gear no installed line reaches.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      const cur = current();
      if (cur === null) { warn("crontab is not available on this box"); return 2; }
      const mine = cur.split("\n").filter(ours);
      if (sub === "status") {
        const g = await cronGears();
        if (flags.json) { emit({ installed: mine.length > 0, lines: mine, gears: g }); return 0; }
        out(mine.length ? `  installed:\n  ${mine.join("\n  ")}` : "  not installed. bb cron install --apply");
        if (g.missing.length) out(`  declared \`on: cron\` and reached by no installed line: ${g.missing.join(", ")}. bb cron install --apply`);
        return 0;
      }
      if (sub === "install") {
        const ls = lines({ every: flags.every, gate: flags.gate !== false });
        fs.mkdirSync(path.join(HOME, "logs"), { recursive: true });
        for (const e of CRON_ENTRIES) {
          const bad = await unsafeVerbs(e.gear);
          if (bad.length) { warn(`refusing to install: \`${e.gear}\` reaches a verb that can spend (${bad.join(", ")}). A cron line does not get to say that.`); return 2; }
        }
        if (!flags.apply) { out(`  would add:\n  ${ls.join("\n  ")}\n  re-run with --apply`); return 0; }
        const rest = cur.split("\n").filter((x) => !ours(x) && x.trim());
        if (!install([...rest, ...ls].join("\n"))) { warn("crontab write failed"); return 1; }
        out(`  installed ${ls.length} line(s); logs under ${path.join(HOME, "logs")}`);
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
