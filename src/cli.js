// cli.js — one entrypoint for every verb. Each feature module exports
// `commands`; this file only merges them and dispatches. A module that fails to
// import becomes a row in `bb --help` and a clear error on use, never a crash of
// every other verb: a factory with one broken detector still scans.
import path from "node:path";
import { parse } from "./core/args.js";
import { setMode, out, warn, emit } from "./core/log.js";
import { ROOT, PKG_ROOT } from "./core/paths.js";
import { readJson } from "./core/config.js";

// Order matters only for --help grouping.
export const MODULES = [
  ["init", "./init.js"],
  ["doctor", "./doctor.js"],
  ["scan", "./scan.js"],
  ["compile", "./compile/index.js"],
  ["route", "./route/index.js"],
  ["run", "./run/index.js"],
  ["git", "./git/index.js"],
  ["tokens", "./tokens/index.js"],
  ["snapgen", "./snapgen/index.js"],
  ["pinpoint", "./pinpoint/index.js"],
  ["genesis", "./genesis/index.js"],
  ["cookbook", "./cookbook/index.js"],
  ["simulate", "./simulate/index.js"],
  ["mainboard", "./mainboard/index.js"],
  ["runbook", "./runbook/index.js"],
  ["frames", "./frames/index.js"],
  ["failsafe", "./failsafe/index.js"],
  ["blackice", "./blackice/index.js"],
  ["monitor", "./monitor/index.js"],
  ["commandcenter", "./commandcenter/index.js"],
  ["oversight", "./oversight/index.js"],
  ["pipeline", "./pipeline/index.js"],
  ["buckmaster", "./buckmaster/index.js"],
  ["bridge", "./bridge/index.js"],
  ["scripts", "./scripts/index.js"],
  ["wire", "./wire/index.js"],
  ["cron", "./cron.js"],
  ["selftest", "./selftest.js"],
  ["kernel", "./kernel-cmd.js"],
];

export const ALIASES = { scenarios: "cookbook", corpus: "cookbook", board: "mainboard", mb: "mainboard", frames: "frames", dataframes: "frames", cc: "commandcenter", usage: "monitor", sg: "pipeline", switchgear: "pipeline", learn: "buckmaster", bm: "buckmaster", bridgeswap: "bridge", scripttag: "scripts", st: "scripts", ctx: "context" };

const version = () => readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0";

export async function loadCommands() {
  const table = {};
  const broken = [];
  for (const [group, file] of MODULES) {
    try {
      const m = await import(file);
      for (const [name, cmd] of Object.entries(m.commands || {})) table[name] = { ...cmd, group, file };
    } catch (e) {
      broken.push({ group, file, error: String(e && e.message || e).split("\n")[0] });
    }
  }
  // Built-ins that live here so they exist even when everything else is broken.
  table.update = { help: "is there a newer bundlebox, and install it", usage: "bb update [--apply]", group: "meta",
    run: async ({ flags }) => (await import("./update/index.js")).update({ apply: !!flags.apply, log: out }) };
  table.mcp = table.mcp || { help: "serve the zero-token verbs as an MCP server over stdio", usage: "bb mcp", group: "wire",
    run: async () => { const { serve } = await import("./mcp/server.js"); await serve({ name: "bundlebox", version: version() }); return 0; } };
  table.version = { help: "print the version", usage: "bb version", group: "meta", run: async () => { out(version()); return 0; } };
  table.help = { help: "this list", usage: "bb help [verb]", group: "meta", run: async ({ _ }) => { help(table, broken, _[0]); return 0; } };
  return { table, broken };
}

function help(table, broken, verb) {
  if (verb && table[verb]) {
    const c = table[verb];
    out(`bb ${verb} — ${c.help}`);
    if (c.usage) out(`\n  ${c.usage}`);
    if (c.long) out(`\n${c.long}`);
    return;
  }
  out(`bb — bundlebox ${version()}: the zero-token software factory for AI coding agents`);
  out(`   workspace: ${ROOT}\n`);
  const groups = {};
  for (const [name, c] of Object.entries(table)) (groups[c.group] ||= []).push([name, c.help]);
  const order = [...new Set([...MODULES.map(([g]) => g), "wire", "meta"])];
  for (const g of order) {
    if (!groups[g]) continue;
    for (const [name, h] of groups[g]) out(`  ${name.padEnd(12)} ${h || ""}`);
  }
  if (broken.length) {
    out("\n  not loadable on this install:");
    for (const b of broken) out(`  ${b.group.padEnd(12)} ${b.error}`);
  }
  out("\n  Every verb is a dry run until --apply. Only `run` and `bridge send` can spend tokens.");
  out("  bb help <verb> for usage. Docs: https://github.com/blackswanalpha/bundlebox");
}

export async function main(argv) {
  const args = parse(argv);
  setMode({ quiet: !!args.flags.quiet || !!args.flags.q, json: !!args.flags.json });
  let verb = args._.shift() || "help";
  verb = ALIASES[verb] || verb;
  if (args.flags.version || args.flags.v && verb === "help") verb = "version";
  if (args.flags.help || args.flags.h) { args._.unshift(verb); verb = "help"; }
  const { table, broken } = await loadCommands();
  const cmd = table[verb];
  if (!cmd) {
    const b = broken.find((x) => x.group === verb);
    if (b) { warn(`bb ${verb} could not load: ${b.error}`); return 2; }
    warn(`unknown verb: ${verb}. Try: bb help`);
    return 2;
  }
  try {
    const code = await cmd.run(args);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    if (args.flags.json) emit({ error: String(e && e.message || e) });
    else console.error(`bb ${verb}: ${args.flags.debug ? e.stack : (e && e.message) || e}`);
    return 1;
  }
}
