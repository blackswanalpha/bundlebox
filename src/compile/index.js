// compile/index.js — the verbs: compile, context, gates.
import fs from "node:fs";
import { ROOT } from "../core/paths.js";
import { out, emit, warn } from "../core/log.js";
import { table } from "../core/util.js";
import * as store from "../core/store.js";
import { compileUnits, detectGates, userGates, summary, suppressed, runGate } from "./compiler.js";
import * as context from "./context.js";

export { compileUnits, detectGates, userGates, summary, suppressed, runGate } from "./compiler.js";
export * as anchors from "./anchors.js";
export * as brief from "./brief.js";
export * as context from "./context.js";

/** Run the declared gates in order, stopping at the first failure.
 *
 *  Order is quick before full, and that is the whole saving: a quick gate that
 *  fails has already answered the question, and the full one would cost minutes
 *  to answer it again. `lint`, `typecheck` and `test` are run only when they are
 *  not already the command a quick or full gate names, so a workspace whose
 *  `quick` IS `npm run lint` does not run lint twice. */
export async function runGates({ flags = {} } = {}) {
  const scope = flags.scope ? String(flags.scope) : ".";
  const g = detectGates(ROOT, scope);
  const only = flags.only ? String(flags.only).split(",").map((x) => x.trim()).filter(Boolean) : [];
  const order = ["quick", "full", "lint", "typecheck", "test"].filter((k) => (!only.length || only.includes(k)) && g[k]);
  const seen = new Set();
  const planned = order.filter((k) => !seen.has(g[k]) && seen.add(g[k]));
  if (!planned.length) {
    warn(`no gate to run for scope ${scope} — \`bb gates --list\` shows what was detected`);
    return 2;
  }
  const rows = [];
  let stoppedAfter = "";
  for (const k of planned) {
    const r = runGate(g[k], { cwd: ROOT });
    rows.push({ gate: k, ...r });
    // Named, never silent: the gates that did not run must not read as passing.
    if (r.rc !== 0) { stoppedAfter = k; break; }
  }
  const skipped = planned.slice(rows.length);
  const failed = rows.filter((r) => r.rc !== 0);
  if (flags.json) { emit({ scope, source: g.source || "", gates: rows, skipped, ok: !failed.length }); return failed.length ? 1 : 0; }
  out(table(rows.map((r) => [r.rc === 0 ? "ok" : "FAIL", r.gate, `${r.seconds ?? "-"}s`, r.cmd]), { header: ["", "gate", "took", "command"] }));
  for (const r of failed) out(`\n  ${r.gate} failed (rc ${r.rc}${r.timed_out ? ", timed out" : ""}) — ${r.cmd}\n${r.tail.split("\n").map((l) => "    " + l).join("\n")}`);
  if (skipped.length) out(`\n  not run after ${stoppedAfter} failed: ${skipped.join(", ")}. They were not checked, which is not the same as passing.`);
  if (!failed.length) out(`\n  ${rows.length} gate(s) passed (${rows[0].via}). This is what proves a change here.`);
  return failed.length ? 1 : 0;
}

export const commands = {
  compile: {
    help: "turn open findings into packed work units (no tokens)",
    usage: "bb compile [--write] [--max-units N] [--json]",
    run: async ({ flags }) => {
      const findings = store.openFindings();
      const units = await compileUnits(findings, { maxUnits: Number(flags.maxUnits) || 0 });
      if (flags.write) store.put("units", units);
      const sup = suppressed();
      if (flags.json) { emit({ units, suppressed: sup, written: !!flags.write }); return 0; }
      out(summary(units));
      // A detector held back at the board limit is still on the board. Printing
      // the count is the difference between a rule that reports as a count and
      // a rule that was quietly forgotten.
      for (const det of Object.keys(sup).sort()) {
        out(`  ${det}: ${sup[det].open} open, none compiled — at per_detector_open=${sup[det].limit}. \`bb findings --detector ${det}\` still lists them.`);
      }
      if (flags.write) out(`  wrote ${units.length} units to .bundlebox/var/units.json`);
      else if (units.length) out("  dry-run: add --write to store them");
      return 0;
    },
  },
  context: {
    help: "will these files fit one session? parts table and split",
    usage: "bb context <paths...> [--kind fix|verify|investigate|build|write] [--brief file] [--json]",
    run: async ({ _, flags }) => {
      if (!_.length) { warn("bb context needs at least one path"); return 2; }
      let briefText = "";
      if (flags.brief) {
        try { briefText = fs.readFileSync(String(flags.brief), "utf8"); } catch { warn(`cannot read brief ${flags.brief}`); return 2; }
      }
      const ev = context.evaluate(_, { brief: briefText, kind: flags.kind ? String(flags.kind) : "" });
      if (flags.json) { emit(ev); return 0; }
      out(context.report(ev));
      return 0;
    },
  },
  gates: {
    help: "what proves a change here (detected, merged with kernel.gates); `run` runs them",
    usage: "bb gates [--list] [--json] | bb gates run [--only quick,full] [--scope dir] [--json]",
    long: [
      "  `bb gates` says what proves a change here. `bb gates run` proves it.",
      "",
      "  Measured over the 26 sessions this workspace has recorded: `npm run` and `npm test` are the",
      "  first and third most-run commands, and `npm run -> npm test -> npm run` is the most common",
      "  three-command run of any kind. That is one question — does this change hold — asked over three",
      "  turns, and every turn re-sends the window before the next answer arrives.",
      "",
      "  One call runs every declared gate in order and stops at the first failure, because a full gate",
      "  after a failing quick one is a minute spent proving something already disproved. rc 1 when any",
      "  gate failed, so a script can branch on it.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      if (_[0] === "run") return runGates({ flags });
      // One row per declared scope, because a workspace of projects has one
      // gate per project and printing only the root's says "none detected"
      // over a config that set four.
      const scopes = [...new Set([".", ...Object.keys(userGates())])].sort();
      const resolved = Object.fromEntries(scopes.map((s) => [s, detectGates(ROOT, s)]));
      if (flags.json) { emit(resolved); return 0; }
      const rows = [];
      for (const s of scopes) {
        const g = resolved[s];
        for (const k of ["quick", "full", "lint", "typecheck", "test"]) if (flags.list || g[k]) rows.push([s, k, g[k] || "-"]);
      }
      out(rows.length ? table(rows, { header: ["scope", "gate", "command"] }) : "  no gates detected");
      const root = resolved["."];
      out(`  source: ${root.source || "declared in kernel.gates"}${root.quick || rows.length ? "" : "  (no quick gate: fix units compile with only the re-scan; other kinds are unproven)"}`);
      return 0;
    },
  },
};
