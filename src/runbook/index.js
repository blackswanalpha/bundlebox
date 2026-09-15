// runbook/index.js — run the local system, watch it, and pay almost nothing to
// do either.
//
// `bb scan` answers questions about the SOURCE for nothing. This answers the
// same class of question about the RUNNING system: is it up, is it answering,
// what broke, what is it costing. Every one of those has a cheap local answer
// that a session should never be spent deriving, and a scenario run against a
// service that is not up is the most expensive kind of red board there is —
// every step fails, every failure is filed, and a session pays to read a board
// about nothing.
//
// Six mechanisms, and they are the whole design:
//
// 1. **A service is a declared row, not a remembered command.** `services.json`
//    holds the command, the health URL, the cage and the group. `up` reads it.
// 2. **A group is the unit of work.** Nobody starts one service; they start the
//    set a test needs. Groups are declared, so the set is reviewable.
// 3. **`up` refuses what will not fit.** Ceilings are summed against available
//    memory before anything starts. A box that swaps reports a product that is
//    fine as a product that is slow.
// 4. **`up --wait` returns when the service ANSWERS**, not when the process
//    exists. Waiting costs wall clock and no tokens; not waiting costs a board.
// 5. **Logs go to files and the digest reads them by OFFSET.** A cursor per log
//    means the second `logs` call reads only what arrived since the first.
// 6. **Nothing prints log lines by default.** Lines become SIGNATURES and known
//    failures arrive NAMED. Forty thousand lines become about twenty rows in
//    60 ms, and the raw file stays on disk with its path printed.
import path from "node:path";
import { rel } from "../core/paths.js";
import { out, warn, emit } from "../core/log.js";
import { pad } from "../core/util.js";
import { digest as digestFrom, signature, levelOf } from "./digest.js";
import { FILE, services, groups, groupOf, init } from "./services.js";
import { LOGS, state, up, down, wait, status } from "./lifecycle.js";
import * as mem from "./memory.js";
import * as report from "./report.js";

export { FILE, services, byId, groups, groupOf, init } from "./services.js";
export { LOGS, STATE, state, up, down, wait, status } from "./lifecycle.js";

/** The digest of every service log. Kept as a no-argument-first call because
 *  `failsafe` asks this of the runbook rather than of a directory: the runbook
 *  owns where logs live, and one caller knowing that path is one caller that
 *  breaks when it moves. */
export const digest = (opts = {}) => digestFrom(LOGS(), opts);
export { signature, levelOf };

// ── the verb ────────────────────────────────────────────────────────────────
//
// One handler per sub-verb, in a table. It was a single 151-line `cmd` with ten
// `if (sub === …)` blocks, which is the shape where a change to `logs` means
// reading past `up`. Each handler takes `{_, flags}` and returns an exit code;
// printing is `report.js`.

const SUBS = "status | up <group> | down <group> | wait <group> | logs [id] | perf | services | groups | init";

const say = (lines) => { for (const l of lines) out(l); };

const HANDLERS = {
  init({ flags }) {
    const r = init();
    if (flags.json) { emit(r); return r.rc; }
    out(`  ${r.why || r.file}`);
    if (r.file) out(`  ${r.file}`);
    if (r.buckets) out(`  ${r.buckets}`);
    return r.rc;
  },

  services({ flags }) {
    const rows = services();
    if (flags.json) { emit({ services: rows, file: rel(FILE()) }); return 0; }
    say(report.services(rows, rel(FILE())));
    return 0;
  },

  groups({ flags }) {
    const g = groups();
    if (flags.json) { emit({ groups: g }); return 0; }
    say(report.groups(g));
    return 0;
  },

  status({ flags }) {
    const rows = status();
    if (flags.json) { emit({ services: rows }); return 0; }
    say(report.status(rows));
    return rows.some((r) => r.state !== "up") ? 1 : 0;
  },

  perf({ flags }) {
    const rows = status().filter((r) => r.state === "up");
    if (flags.json) { emit({ perf: rows }); return 0; }
    const { lines, hot } = report.perf(rows);
    say(lines);
    if (hot.length) warn(`${hot.map((r) => r.id).join(", ")} is at or past MemoryHigh — the kernel is reclaiming, so any timing from it is about the cage`);
    return 0;
  },

  wait({ _, flags }) {
    const list = groupOf(_[1] || "all");
    if (!list.length) { warn(`no service or group \`${_[1] || "all"}\``); return 2; }
    const r = wait(list, { seconds: Number(flags.seconds) || Number(flags.wait) || 0 });
    if (flags.json) { emit(r); return r.ok ? 0 : 1; }
    if (!r.targets.length) { out(`  ${r.why}`); return r.ok ? 0 : 1; }
    for (const t of r.targets) out(report.probeLine(t));
    return r.ok ? 0 : 1;
  },

  logs({ _, flags }) {
    const r = digestFrom(LOGS(), {
      id: _[1] || "", since: flags.all !== true, level: String(flags.level || ""),
      grep: String(flags.grep || ""), sample: !!flags.sample, top: Number(flags.top) || 40,
      engine: flags.js ? "js" : "auto",
    });
    if (flags.json) { emit(r); return r.high ? 1 : 0; }
    say(report.logs(r, { all: !!flags.all, sample: !!flags.sample, top: Number(flags.top) || 40 }));
    for (const b of r.refused || []) warn(`bucket ${b.id} is not being matched: ${b.why}`);
    // A high bucket is a named failure this workspace already paid to learn.
    // Everything printed below it describes a system that was already broken,
    // so the exit code says so and `logs` works as a gate.
    if (r.high) { out(""); warn("a high bucket fired. Nothing below it is evidence about the product."); return 1; }
    return 0;
  },
};

/** `up` refuses a set whose ceilings exceed available memory. A box that swaps
 *  reports a product that is fine as a product that is slow, and every number
 *  measured on it afterwards is about the swap. */
function admit(list, flags) {
  const already = new Set(Object.keys(state()));
  const starting = list.filter((s) => !already.has(s.id));
  const check = mem.admit(starting, services().filter((s) => already.has(s.id)),
    { reserve: mem.bytes(flags.reserve) || 1024 ** 3 });
  return { check, starting };
}

function lifecycle(sub, { _, flags }) {
  const target = _[1] || "all";
  const list = groupOf(target);
  if (!list.length) { warn(`no service or group \`${target}\`. bb runbook groups`); return 2; }

  if (sub === "up") {
    const { check, starting } = admit(list, flags);
    if (!check.ok && !flags.force) {
      if (flags.json) { emit({ up: [], admit: check }); return 1; }
      warn(check.why);
      out(`  asked for ${starting.map((s) => s.id).join(", ") || "nothing"}`);
      return 1;
    }
    if (check.undeclared.length && !flags.json) {
      out(`  no ceiling declared for ${check.undeclared.join(", ")} — counted as zero, so the check below is a floor`);
    }
  }

  const rows = list.map((s) => (sub === "up" ? up(s.id, { apply: !!flags.apply }) : down(s.id, { apply: !!flags.apply })));
  // Waiting costs wall clock and no tokens; not waiting costs a board in which
  // every step failed against a service that had not finished booting.
  let waited = null;
  if (sub === "up" && flags.apply && flags.wait !== false && (flags.wait || flags.wait === undefined)
      && (flags.wait !== undefined || list.some((s) => s.health))) {
    waited = wait(list, { seconds: Number(flags.wait) || 0 });
  }

  if (flags.json) { emit({ [sub]: rows, ...(waited ? { wait: waited } : {}) }); return rows.some((r) => r.rc) || (waited && !waited.ok) ? 1 : 0; }
  for (const r of rows) out(`  ${pad(r.id, 14)} ${pad(r.state, 14)} ${r.via ? `via ${r.via}  ` : ""}${r.why || r.cmd || ""}${r.log ? `  ${r.log}` : ""}`);
  if (!flags.apply) { out(`\n  dry run. --apply ${sub === "up" ? "starts" : "stops"} them.`); return 0; }
  if (waited) {
    out("");
    if (waited.why && !waited.targets.length) out(`  ${waited.why}`);
    for (const t of waited.targets) out(report.probeLine(t));
    if (!waited.ok) { warn("not every service answered. Do not run a corpus against this — every step would fail for the same reason."); return 1; }
    out("  every service answers. A board run now is about the product.");
  }
  return rows.some((r) => r.rc) ? 1 : 0;
}

async function cmd(args) {
  const sub = args._[0] || "status";
  if (sub === "up" || sub === "down") return lifecycle(sub, args);
  const h = HANDLERS[sub];
  if (h) return h(args);
  warn(`unknown runbook sub-verb: ${sub}. ${SUBS}`);
  return 2;
}

export const commands = {
  runbook: {
    help: "the running system: is it up, is it answering, what broke since the last call, what is it costing (0 model tokens)",
    usage: `bb runbook [${SUBS}] [--apply] [--wait[=s]] [--force] [--level E] [--grep <rx>] [--sample] [--all] [--json]`,
    long: [
      "  bb runbook up chat --apply --wait   start the group, caged, and return when every service ANSWERS",
      "  bb runbook status                   process state, health probe, memory",
      "  bb runbook logs                     what arrived since the last call, as signatures and named failures",
      "  bb runbook logs --level E --sample  errors only, with one real line per signature",
      "  bb runbook perf                     memory against the cage, cpu, latency",
      "",
      "Services and groups are declared in .bundlebox/runbook/services.json; the named failures in",
      "digest.json beside it. `up` refuses a set whose ceilings exceed available memory (--force overrides),",
      "and `logs` exits 1 when a high bucket fired, so it works as a gate. Every verb is a dry run until --apply.",
    ].join("\n"),
    run: cmd,
  },
};
