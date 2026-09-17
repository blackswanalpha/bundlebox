// cli.js — one entrypoint for every verb. Each feature module exports
// `commands`; this file only merges them and dispatches. A module that fails to
// import becomes a row in `bb --help` and a clear error on use, never a crash of
// every other verb: a factory with one broken detector still scans.
import path from "node:path";
import { parse } from "./core/args.js";
import { setMode, out, warn, emit } from "./core/log.js";
import { ROOT, PKG_ROOT } from "./core/paths.js";
import { readJson } from "./core/config.js";
import { clamp, table } from "./core/util.js";

// Order matters only for --help grouping.
export const MODULES = [
  ["init", "./init.js"],
  ["doctor", "./doctor.js"],
  ["env", "./env.js"],
  ["scan", "./scan.js"],
  ["triage", "./detectors/index.js"],
  ["compile", "./compile/index.js"],
  ["route", "./route/index.js"],
  ["run", "./run/index.js"],
  ["git", "./git/index.js"],
  ["tokens", "./tokens/index.js"],
  ["snapgen", "./snapgen/index.js"],
  ["arc", "./arc/index.js"],
  ["pinpoint", "./pinpoint/index.js"],
  ["bench", "./bench/index.js"],
  ["genesis", "./genesis/index.js"],
  ["cookbook", "./cookbook/index.js"],
  ["simulate", "./simulate/index.js"],
  ["mainboard", "./mainboard/index.js"],
  ["runbook", "./runbook/index.js"],
  ["viewport", "./viewport/index.js"],
  ["recom", "./recom/index.js"],
  ["dotty", "./dotty/index.js"],
  ["slop", "./slop/index.js"],
  ["finish", "./finish/index.js"],
  ["sieve", "./sieve/index.js"],
  ["janitor", "./janitor/index.js"],
  ["frames", "./frames/index.js"],
  ["failsafe", "./failsafe/index.js"],
  ["auditor", "./auditor/index.js"],
  ["monitor", "./monitor/index.js"],
  ["console", "./console/index.js"],
  ["oversight", "./oversight/index.js"],
  ["designlabs", "./designlabs/index.js"],
  ["pipeline", "./pipeline/index.js"],
  ["buckmaster", "./buckmaster/index.js"],
  ["lathe", "./lathe/index.js"],
  ["echos", "./echos/index.js"],
  ["bridge", "./bridge/index.js"],
  ["scripts", "./scripts/index.js"],
  ["wire", "./wire/index.js"],
  ["uptake", "./uptake/index.js"],
  ["cron", "./cron.js"],
  ["selftest", "./selftest.js"],
  ["kernel", "./kernel-cmd.js"],
];

export const ALIASES = { gc: "janitor", memory: "janitor", blackice: "auditor", audit: "auditor", scenarios: "cookbook", corpus: "cookbook", board: "mainboard", mb: "mainboard", frames: "frames", dataframes: "frames", cc: "console", usage: "monitor", sg: "pipeline", switchgear: "pipeline", learn: "buckmaster", bm: "buckmaster", bridgeswap: "bridge", scripttag: "scripts", st: "scripts", ctx: "context" };

const version = () => readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0";

export async function loadCommands() {
  const cmds = {};
  const broken = [];
  for (const [group, file] of MODULES) {
    try {
      const m = await import(file);
      for (const [name, cmd] of Object.entries(m.commands || {})) cmds[name] = { ...cmd, group, file };
    } catch (e) {
      broken.push({ group, file, error: String(e && e.message || e).split("\n")[0] });
    }
  }
  // Built-ins that live here so they exist even when everything else is broken.
  cmds.update = { help: "is there a newer bundlebox, and install it", usage: "bb update [--apply]", group: "meta",
    run: async ({ flags }) => (await import("./update/index.js")).update({ apply: !!flags.apply, log: out }) };
  cmds.mcp = cmds.mcp || { help: "serve the zero-token verbs as an MCP server over stdio", usage: "bb mcp", group: "wire",
    run: async () => { const { serve } = await import("./mcp/server.js"); await serve({ name: "bundlebox", version: version() }); return 0; } };
  cmds.version = { help: "print the version", usage: "bb version", group: "meta", run: async () => { out(version()); return 0; } };
  cmds.help = { help: "this list", usage: "bb help [verb]", group: "meta", run: async ({ _ }) => { help(cmds, broken, _[0]); return 0; } };
  return { table: cmds, broken };
}

// What a verb does to the world, printed in its own column. A list of forty
// verbs in which two of them can spend money and the reader has to remember
// which is a list that has to be memorised; a column is read.
//
//   spends    can call a paid model, and only with the flag named here
//   writes    changes files in the workspace itself, and only with --apply
//   records   writes artefacts under .bundlebox/ and touches no source file
//   reads     reads and reports; nothing on disk changes
const SPENDS = { run: "--apply", bridge: "--run --spend" };
// Verbs that can change a file a human wrote. Everything here is a dry run
// until --apply; that is the whole contract and the column states it once.
const WRITES = new Set(["init", "fix", "wire", "unwire", "git", "kernel", "update", "cron", "designlabs", "janitor", "finish"]);
// Verbs that only ever write under .bundlebox/. They need no flag because
// nothing they touch was written by hand.
const RECORDS = new Set(["scan", "compile", "route", "snapgen", "arc", "pinpoint", "bench", "genesis", "cookbook",
  "simulate", "runbook", "viewport", "recom", "dotty", "mainboard", "oversight", "auditor", "buckmaster", "lathe", "console", "pipeline", "scripts", "sieve"]);
// The groups, in the order a factory uses them, with the question each answers.
const CHAPTERS = [
  ["govern", "What is the bar, before anything is written?", ["auditor"]],
  ["look", "What is in this tree?", ["init", "doctor", "env", "scan", "findings", "explain", "triage", "oversight", "designlabs"]],
  ["pack", "What goes in the window?", ["compile", "context", "gates", "route", "snapgen", "arc", "pinpoint", "tokens", "sieve", "janitor", "slop", "bench"]],
  ["prove", "What does the running system do?", ["genesis", "cookbook", "simulate", "runbook", "viewport", "recom", "dotty", "mainboard", "frames", "failsafe"]],
  ["spend", "What costs money, and how much is left?", ["run", "bridge", "monitor", "session", "headroom", "agents"]],
  ["ship", "What closes the loop?", ["finish", "git", "fix", "pipeline", "scripts", "cron", "buckmaster", "lathe", "console"]],
  ["wire", "How do agents reach it?", ["wire", "unwire", "uptake", "hook", "mcp", "kernel", "selftest", "update", "version", "help"]],
];

function effect(name) {
  if (SPENDS[name]) return `spends ${SPENDS[name]}`;
  if (WRITES.has(name)) return "writes --apply";
  return RECORDS.has(name) ? "records" : "reads";
}

// The page is laid out against the terminal, clamped so a very wide or very
// narrow window still reads as columns.
const helpWidth = () => clamp(process.stdout.columns || 100, 72, 120);

// Greedy word wrap. A description that does not fit the column becomes two
// lines under the same verb, never a line that runs past the screen.
const wrap = (text, width) => {
  const lines = [];
  let line = "";
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
};

function help(cmds, broken, verb) {
  if (verb && cmds[verb]) {
    const c = cmds[verb];
    out(`bb ${verb} — ${c.help}`);
    out(table([["effect", effect(verb)], ["group", c.group]]).split("\n").map((l) => `  ${l}`).join("\n"));
    if (c.usage) out(`\n  ${c.usage}`);
    if (c.long) out(`\n${c.long}`);
    return;
  }
  out(`bb — bundlebox ${version()}: the zero-token software factory for AI coding agents`);
  out(`   workspace: ${ROOT}`);

  const placed = new Set();
  const chapters = [];
  for (const [title, question, names] of CHAPTERS) {
    const rows = names.filter((n) => cmds[n]).map((n) => { placed.add(n); return [n, effect(n), cmds[n].help || ""]; });
    if (rows.length) chapters.push([`${title.toUpperCase()}  ${question}`, rows]);
  }
  const rest = Object.entries(cmds).filter(([n]) => !placed.has(n)).map(([n, c]) => [n, effect(n), c.help || ""]);
  if (rest.length) chapters.push(["ALSO", rest]);

  // One grid for every chapter, not one table per chapter: the two column
  // edges run straight down the whole page and the header is printed once, at
  // the top. Descriptions wrap into the third column instead of running off
  // the terminal, so no row is read by scrolling sideways.
  const all = chapters.flatMap(([, rows]) => rows);
  const verbW = Math.max(4, ...all.map((r) => r[0].length));
  const effW = Math.max(6, ...all.map((r) => r[1].length));
  const descW = Math.max(28, helpWidth() - verbW - effW - 6);
  const cont = " ".repeat(2 + verbW + 2 + effW + 2);
  out(`\n  ${"verb".padEnd(verbW)}  ${"effect".padEnd(effW)}  what it does`);
  out(`  ${"-".repeat(verbW)}  ${"-".repeat(effW)}  ${"-".repeat(descW)}`);
  for (const [title, rows] of chapters) {
    out(`\n  ${title}`);
    for (const [name, eff, desc] of rows) {
      const lines = wrap(desc, descW);
      out(`  ${name.padEnd(verbW)}  ${eff.padEnd(effW)}  ${lines[0]}`.trimEnd());
      for (const l of lines.slice(1)) out(`${cont}${l}`);
    }
  }
  if (broken.length) {
    out("\n  NOT LOADABLE ON THIS INSTALL");
    out(table(broken.map((b) => [b.group, b.error]), { header: ["group", "why"] }).split("\n").map((l) => `  ${l}`).join("\n"));
  }
  out("\n  Every verb is a dry run until --apply. Only the two `spends` rows above can cost money.");
  out("  bb help <verb> for usage. Docs: https://github.com/blackswanalpha/bundlebox");
}

// Verbs that write their own episode, with features this hook cannot see. A
// second, thinner row for the same work would be double counting in the one
// place that must not double count.
const SELF_RECORDED = new Set(["run", "pipeline", "bridge", "scripts", "cookbook",
  "genesis", "simulate", "mainboard", "frames", "auditor"]);

/** One row per verb that did work a session would otherwise have done. The free
 *  verbs run BEFORE a session opens, so without this hook `bb session` reports
 *  the factory as having saved nothing on exactly the runs it prepared.
 *
 *  It never throws and never changes the exit code: a bill that cannot be
 *  written must not lose the verb that earned it. */
async function recordEpisode(verb, args, rc, t0) {
  if (SELF_RECORDED.has(verb)) return;
  try {
    const ep = await import("./buckmaster/episodes.js");
    const sub = typeof args._[0] === "string" && /^[a-z][\w-]*$/.test(args._[0]) ? `${verb} ${args._[0]}` : "";
    const key = sub && ep.YIELD[sub] ? sub : ep.YIELD[verb] ? verb : "";
    if (!key) return;
    ep.record({ verb: key, rc: typeof rc === "number" ? rc : 0, seconds: Math.round((Date.now() - t0)) / 1000,
      features: { apply: args.flags.apply ? 1 : 0, write: args.flags.write ? 1 : 0 },
      detail: ep.takeDetail() });
  } catch { /* the verb already did its job */ }
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
  const t0 = Date.now();
  try {
    const code = await cmd.run(args);
    await recordEpisode(verb, args, code, t0);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    if (args.flags.json) emit({ error: String(e && e.message || e) });
    else console.error(`bb ${verb}: ${args.flags.debug ? e.stack : (e && e.message) || e}`);
    return 1;
  }
}
