// compile/index.js — the verbs: compile, context, gates.
import fs from "node:fs";
import { ROOT } from "../core/paths.js";
import { out, emit, warn } from "../core/log.js";
import { table } from "../core/util.js";
import * as store from "../core/store.js";
import { compileUnits, detectGates, userGates, summary } from "./compiler.js";
import * as context from "./context.js";

export { compileUnits, detectGates, userGates, summary } from "./compiler.js";
export * as anchors from "./anchors.js";
export * as brief from "./brief.js";
export * as context from "./context.js";

export const commands = {
  compile: {
    help: "turn open findings into packed work units (no tokens)",
    usage: "bb compile [--write] [--max-units N] [--json]",
    run: async ({ flags }) => {
      const findings = store.openFindings();
      const units = await compileUnits(findings, { maxUnits: Number(flags.maxUnits) || 0 });
      if (flags.write) store.put("units", units);
      if (flags.json) { emit({ units, written: !!flags.write }); return 0; }
      out(summary(units));
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
    help: "what proves a change here (detected, merged with kernel.gates)",
    usage: "bb gates [--list] [--json]",
    run: async ({ flags }) => {
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
