// cron.js — the unattended worker. Two crontab lines by default, under flock,
// logging to ~/.bundlebox/logs. They run the free path only: `pipeline run
// factory` never spends, and `bb run --apply` is not something those lines get
// to say.
//
// The line carries `--apply`, and that is not the same `--apply` the rest of
// the box means by it. Every verb inside `factory` is one that only writes
// under .bundlebox/ — scan, snapgen, compile, route, the ledger, the bench —
// and `run` is not among them, which is checked below rather than assumed.
// Without the flag every stage reported `would-run` and the worker ran every
// half hour for a year producing nothing, which is the most expensive kind of
// working cron line there is.
//
// `bb cron install --spend` writes a third line, and it is the only way one
// gets written. A gear reaches it by declaring `spends: true`, which is a
// statement in the gear and not a property of the line; the line merely agrees
// to carry it. Three things then stand between that line and a bill, and all
// three are somewhere a person had to type:
//
//   the flag        `--spend`, once, at install
//   the gear        `spends: true` on the stage, so an undeclared `run` that
//                   somebody adds to `factory` is still refused
//   the three keys  `bridge.enabled`, `bridge.daily_budget_usd` and
//                   `lanes.daily_budget_usd`, read by the runner AT THE TICK,
//                   so removing any one of them stops the loop without
//                   touching the crontab
//
// That is what makes the loop autonomous rather than merely unattended: it can
// be scheduled, it stops itself at a ceiling it re-reads every tick, and the
// thing that switches it off is a config key rather than a line edit.
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

/** The lines `--spend` adds on top, and the only lines that can cost anything.
 *  Kept apart from CRON_ENTRIES rather than flagged inside it, so that the
 *  default install has no branch to get wrong: `lines({})` cannot return one of
 *  these however the flags are read.
 *
 *  Daily, and ungated. The recom gate answers from the tree, the config and the
 *  head commit, and what this loop is for is the corpus not covering something
 *  — which none of those three move. `every` is minutes; 1440 is a starting
 *  number, not a measured one, and it is the slowest cadence here on purpose. */
export const SPEND_ENTRIES = [
  { gear: "practice", every: 1440, gate: false, log: "practice.log", spends: true },
];

export const entriesFor = ({ spend = false } = {}) => (spend ? [...CRON_ENTRIES, ...SPEND_ENTRIES] : CRON_ENTRIES);

/** [] when the gear is safe to run unattended, or the verbs that are not.
 *
 *  Two different refusals, and conflating them is what kept a spending gear off
 *  every schedule:
 *
 *  - a spending verb under a stage that did NOT declare `spends` is an
 *    undeclared spend. Somebody added `run` to `factory`; no line carries it,
 *    `--spend` or not, because nothing in the gear says it should cost money.
 *  - a stage that DID declare `spends` is a gear the caller asks for by name.
 *    `{ spend: true }` is that asking, and it is `bb cron install --spend`. */
export async function unsafeVerbs(gearName = CRON_GEAR, { spend = false } = {}) {
  try {
    const { load } = await import("./pipeline/spec.js");
    const { gears } = await load();
    const seen = new Set(), stack = [gearName], bad = [];
    while (stack.length) {
      const g = gears[stack.pop()];
      if (!g || seen.has(g.name)) continue;
      seen.add(g.name);
      for (const st of g.stages) {
        if (SPENDING_VERBS.has(st.verb) && !st.spends) bad.push(`${g.name}/${st.verb}`);
        else if (st.spends && !spend) bad.push(`${g.name}/${st.verb} declares \`spends\`; --spend installs it`);
      }
      for (const c of g.chain) stack.push(c.gear);
    }
    return bad;
  } catch (e) { return [`${gearName}: the pipeline spec did not load (${e.message}), so nothing proves it safe`]; }
}

/** Whether the three config keys a `spends` stage needs are set, asked without
 *  importing the pipeline into every caller. `{ ok, missing }`. */
export async function spendPermission() {
  try {
    const [{ spendKeys }, { load }] = await Promise.all([import("./pipeline/spec.js"), import("./core/config.js")]);
    return spendKeys(load({ fresh: true }));
  } catch (e) { return { ok: false, missing: [`config unreadable (${e.message})`] }; }
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
  // A day or more is midnight. `*/24` is not a thing cron does with it: the
  // hour field caps at 23, so it would fire at 00:00 AND 23:00 — twice, on the
  // one cadence where somebody asked for once.
  if (m >= 1440) return "0 0 * * *";
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
 *  slower ones keep their own cadence. `spend` adds SPEND_ENTRIES and is the
 *  only thing that ever does. */
export function lines({ every, gate = true, root = ROOT, spend = false } = {}) {
  return entriesFor({ spend }).map((e) => line({ ...e, root, every: e.gear === CRON_GEAR && every ? every : e.every, gate: e.gate && gate }));
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
    usage: "bb cron install [--every 30] [--no-gate] [--spend] [--apply] | status | remove [--apply]",
    long: [
      `  Two lines by default. \`${CRON_ENTRIES[0].gear}\` every ${CRON_ENTRIES[0].every} minutes under \`bb recom gate ${GATE_ID}\`: it re-probes the head`,
      "  commit, the tree and the config, prints the recorded answer and runs NOTHING while all three",
      "  read the same. Anything that is not provably fresh runs, so the failure direction costs one",
      "  extra pipeline pass and never a stale answer. `--no-gate` installs the old unconditional line.",
      `  \`${CRON_ENTRIES[1].gear}\` every ${CRON_ENTRIES[1].every / 60} hours, ungated: it reaches every other gear that declares \`on: cron\`, and`,
      "  a stage that needs a service up reports unknown and moves on when nothing answers.",
      "  `bb doctor` has a row for a cron gear no installed line reaches.",
      "",
      `  \`--spend\` adds a third: \`${SPEND_ENTRIES[0].gear}\` daily, the one line that can open a paid session. It is`,
      "  refused unless the gear declares `spends: true` on the stage that costs money, and every tick is",
      "  refused again unless `bridge.enabled`, `bridge.daily_budget_usd` and `lanes.daily_budget_usd` are",
      "  all set. Unsetting any one of them stops the loop without touching the crontab, which is the",
      "  switch to reach for: `bb cron status` says which of the three is missing.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      const cur = current();
      if (cur === null) { warn("crontab is not available on this box"); return 2; }
      const mine = cur.split("\n").filter(ours);
      if (sub === "status") {
        const g = await cronGears();
        // Whether an installed spending line can actually do anything is a
        // different question from whether it is installed, and it is the one
        // that changes without the crontab changing.
        const spending = mine.filter((l) => SPEND_ENTRIES.some((e) => gearOf(l) === e.gear));
        const perm = spending.length ? await spendPermission() : null;
        if (flags.json) { emit({ installed: mine.length > 0, lines: mine, gears: g, spending, permission: perm }); return 0; }
        out(mine.length ? `  installed:\n  ${mine.join("\n  ")}` : "  not installed. bb cron install --apply");
        if (g.missing.length) out(`  declared \`on: cron\` and reached by no installed line: ${g.missing.join(", ")}. bb cron install --apply`);
        if (perm) {
          out(perm.ok
            ? `  ${spending.length} line(s) may spend, and the three keys are set: each tick runs inside the daily ceilings.`
            : `  ${spending.length} line(s) may spend, but ${perm.missing.join(", ")} — not set. Every spending stage is refused at the tick, so the line costs seconds and nothing else.`);
        } else if (mine.length) out("  no installed line can spend. `bb cron install --spend --apply` adds the one that can.");
        return 0;
      }
      if (sub === "install") {
        const spend = !!flags.spend;
        const ls = lines({ every: flags.every, gate: flags.gate !== false, spend });
        fs.mkdirSync(path.join(HOME, "logs"), { recursive: true });
        for (const e of entriesFor({ spend })) {
          const bad = await unsafeVerbs(e.gear, { spend: !!e.spends });
          if (bad.length) { warn(`refusing to install: \`${e.gear}\` reaches a verb that can spend (${bad.join(", ")}). A cron line does not get to say that.`); return 2; }
        }
        if (!flags.apply) { out(`  would add:\n  ${ls.join("\n  ")}\n  re-run with --apply`); return 0; }
        const rest = cur.split("\n").filter((x) => !ours(x) && x.trim());
        if (!install([...rest, ...ls].join("\n"))) { warn("crontab write failed"); return 1; }
        out(`  installed ${ls.length} line(s); logs under ${path.join(HOME, "logs")}`);
        if (spend) {
          const perm = await spendPermission();
          out(perm.ok
            ? `  ${SPEND_ENTRIES.map((e) => e.gear).join(", ")} may spend, inside bridge.daily_budget_usd and lanes.daily_budget_usd. Unset either to stop it without touching the crontab.`
            : `  ${SPEND_ENTRIES.map((e) => e.gear).join(", ")} is installed but ${perm.missing.join(", ")} — not set, so every spending stage is refused at the tick. \`bb config\` sets them.`);
        }
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
