// env.js — what a complete .bundlebox environment holds, and whether this one
// does.
//
// The environment is the whole point of the box: everything a session would
// otherwise spend its first turns deriving, derived once, locally, and kept
// fresh by a cron line rather than by an agent. Every row below is one such
// artefact, and every one is produced by a verb that cannot spend money.
//
// This exists because "is the environment set up" had no answer. `bb init`
// wrote a config file and stopped; a fresh workspace then had no tables, no
// index, no findings and no page, and nothing said so — the first session
// simply searched the tree, which is the exact cost this box was built to
// remove. A checklist that names each artefact, the verb that makes it and
// whether it is on disk turns that from a discovery into a line of output.
import fs from "node:fs";
import path from "node:path";
import { OUT, VAR, BB_DIR, rel } from "./core/paths.js";
import { out, emit, warn } from "./core/log.js";
import { human } from "./core/util.js";

/** The artefacts, in the order a session meets them.
 *
 *  `gear` is the declared pipeline that produces the row, so a missing artefact
 *  names its own fix. Nothing here is optional in the sense of being
 *  decorative: a row that is absent is a turn some session will pay for. */
export const ROWS = [
  { id: "config", what: "the workspace's own settings, gates and detected agents", path: () => path.join(BB_DIR, "config.json"), verb: "bb init --apply", gear: "" },
  { id: "tables", what: "the reference tables a session reads instead of searching", path: () => path.join(OUT, "snapgen", "INDEX.md"), verb: "bb snapgen build", gear: "orient" },
  { id: "index", what: "the tables compiled to one binary index the guards read per tool call", path: () => path.join(OUT, "arc", "index.arc"), verb: "bb arc build", gear: "orient" },
  { id: "findings", what: "what the local detectors found, with no model involved", path: () => path.join(VAR, "findings.json"), verb: "bb scan", gear: "intake" },
  { id: "oversight", what: "the tree measured against its own medians", path: () => path.join(OUT, "oversight"), verb: "bb oversight scan --write", gear: "intake" },
  { id: "worklist", what: "every measured gap, located and budgeted before a model sees it", path: () => path.join(OUT, "pinpoint", "WORKLIST.md"), verb: "bb pinpoint gaps", gear: "orient" },
  // No gear, and deliberately. The janitor writes the memory files a PERSON
  // wrote — CLAUDE.md and the memory directory — so it is the one artefact here
  // whose producer must never run on an unattended tick. It is compiled by the
  // SessionEnd hook, where a session that just changed the tree is the thing
  // being reconciled against it, or by hand.
  { id: "memory", what: "the agent's memory, compiled and swept of claims that no longer resolve", path: () => path.join(OUT, "janitor"), verb: "bb janitor --apply", gear: "", by: "the SessionEnd hook, or `bb janitor --apply`" },
  { id: "automation", what: "the habits this workspace has, as scripts, snippets, boilerplate and completions", path: () => path.join(OUT, "lathe", "INDEX.md"), verb: "bb lathe learn && bb lathe build --apply", gear: "buckmaster" },
  { id: "commandcenter", what: "one page for this workspace: the pipeline, the window, every session and what it saved", path: () => path.join(OUT, "commandcenter", "index.html"), verb: "bb commandcenter build", gear: "watch" },
];

const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };

export function report() {
  const rows = ROWS.map((r) => {
    const p = r.path();
    const st = stat(p);
    const size = st ? (st.isDirectory() ? dirBytes(p) : st.size) : 0;
    return { ...r, file: rel(p), present: Boolean(st), bytes: size, age_hours: st ? Math.round((Date.now() - st.mtimeMs) / 36000) / 100 : null };
  });
  const missing = rows.filter((r) => !r.present);
  return {
    rows, present: rows.length - missing.length, total: rows.length,
    missing: missing.map((r) => r.id),
    // What a gear can build, and what only a hook or a hand can. Reporting them
    // together made `bb env up --apply` promise to build the janitor's heap,
    // which is the one row it must not touch.
    buildable: missing.filter((r) => r.gear).map((r) => r.id),
    by_hand: missing.filter((r) => !r.gear).map((r) => ({ id: r.id, by: r.by || `\`${r.verb}\`` })),
    complete: missing.length === 0,
  };
}

function dirBytes(dir) {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(path.join(dir, e.name)) : (stat(path.join(dir, e.name))?.size || 0); } catch { /* unreadable */ }
  return n;
}

/** The one gear that brings a fresh workspace up. Named here rather than in the
 *  caller so `bb env` and `bb init` cannot disagree about it. */
export const BOOTSTRAP = "bootstrap";

export const commands = {
  env: {
    help: "what a complete .bundlebox holds, and whether this one does (no tokens)",
    usage: "bb env [--json] | bb env up [--apply]",
    long: [
      "  Every row is an artefact some session would otherwise derive by searching the tree, and",
      "  every one is produced by a verb that cannot spend money. A missing row is a turn somebody",
      "  will pay for.",
      "",
      "  `bb env up --apply` runs the bootstrap gear, which is intake, orient and watch: find what is",
      "  wrong, build what a session reads, and rebuild the page. `bb cron --apply` then keeps it",
      "  fresh every thirty minutes with no agent involved.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      if (sub === "up") {
        const { runGear } = await import("./pipeline/runner.js");
        const r = await runGear(BOOTSTRAP, { apply: !!flags.apply, quiet: !!flags.quiet, trigger: "hand" });
        if (!flags.apply) out("\n  dry run: --apply builds the environment.");
        const after = report();
        out(`\n  ENVIRONMENT — ${after.present} of ${after.total} artefacts${after.complete ? ", complete" : `; still missing ${after.missing.join(", ")}`}`);
        for (const h of after.by_hand) out(`  ${h.id} is not a gear's to build: ${h.by}.`);
        return r && r.rc ? r.rc : 0;
      }
      if (sub !== "status") { warn(`unknown sub-verb: ${sub}. ${commands.env.usage}`); return 2; }
      const rep = report();
      if (flags.json) { emit(rep); return 0; }
      out(`  ENVIRONMENT — ${rep.present} of ${rep.total} artefacts present${rep.complete ? "" : `, ${rep.total - rep.present} missing`}`);
      out("");
      for (const r of rep.rows) {
        const mark = r.present ? "ok  " : "MISS";
        const age = r.present ? `${r.age_hours < 1 ? "<1h" : `${Math.round(r.age_hours)}h`} old, ${human(r.bytes)}b` : (r.gear ? `\`bb pipeline run ${r.gear} --apply\`` : `\`${r.verb}\``);
        out(`  ${mark} ${r.id.padEnd(14)} ${r.file.padEnd(40)} ${age}`);
        if (!r.present) out(`       ${r.what}`);
      }
      out("");
      if (rep.complete) out("  `bb cron --apply` keeps every row above fresh on a thirty-minute tick, with no agent involved.");
      else {
        if (rep.buildable.length) out(`  \`bb env up --apply\` builds ${rep.buildable.join(", ")} — locally, no tokens.`);
        for (const h of rep.by_hand) out(`  ${h.id} comes from ${h.by}: it writes files a person wrote, so no tick gets to.`);
      }
      return 0;
    },
  },
};
