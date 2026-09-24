// snapgen/index.js — the verbs over the reference tables, and the read side
// pinpoint uses (`symbolHits`): a where-is-it question answered from a table
// that already exists, never from a grep over the tree.
import fs from "node:fs";
import path from "node:path";
import { rel } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { out, emit, warn } from "../core/log.js";
import { human, pad } from "../core/util.js";
import * as runner from "../kit/runner.js";
import { registry, DIR, symbolIndex } from "./tables.js";
import * as graph from "./graph.js";

export { registry, DIR, symbolIndex } from "./tables.js";
export * as graph from "./graph.js";

export const tablePath = (name) => registry().path(name);
export const indexPath = () => path.join(DIR, "INDEX.md");

/** Build the tables, then recompile the index over them.
 *
 *  Here and not in a hook: the index is derived from the tables, so the moment
 *  the tables move is the only moment it can go stale. Failure is not fatal —
 *  every reader of the index falls back to scanning the tables, which is what
 *  it did before arc existed. */
export async function build({ only = null, force = false, index = true } = {}) {
  const r = await runner.build(registry(), { only, force });
  if (index && (r.built?.length || force)) {
    try { const arc = await import("../arc/index.js"); arc.build(); } catch { /* the tables still answer */ }
  }
  return r;
}
export async function stale({ only = null } = {}) { return runner.stale(registry(), { only }); }

const onDisk = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };  // absence is the answer

/** [{file, symbol, line, term}] from the built symbols tables. Terms under four
 *  characters are ignored: `get` matches half of any tree. */
export async function symbolHits(terms, { maxFiles = 0 } = {}) {
  const reg = registry();
  const names = reg.names("symbols");
  const missing = names.filter((n) => !onDisk(reg.path(n)));
  if (missing.length) await runner.build(reg, { only: missing });
  const tl = terms.map((t) => String(t).toLowerCase()).filter((t) => t.length >= 4);
  const hits = [];
  const rx = /^(\S+)\s+(\S+):(\d+)$/;
  for (const n of names) {
    for (const line of readText(reg.path(n)).split("\n")) {
      const m = rx.exec(line.trim());
      if (!m) continue;
      const sl = m[1].toLowerCase();
      const term = tl.find((t) => sl.includes(t) || (sl.length >= 5 && t.includes(sl)));
      if (term) hits.push({ file: m[2], symbol: m[1], line: Number(m[3]), term });
    }
  }
  if (maxFiles > 0) {
    const files = new Set();
    return hits.filter((h) => files.has(h.file) || (files.size < maxFiles && files.add(h.file)));
  }
  return hits;
}

const list = (flags) => (typeof flags.only === "string" ? flags.only.split(",").map((s) => s.trim()).filter(Boolean) : null);

export const commands = {
  snapgen: {
    help: "reference tables a session reads instead of searching (no tokens)",
    usage: "bb snapgen build [--only a,b] [--force] | stale | list | show <table> | index | skeleton <file> | blast [--since ref] | callers <symbol>  [--json]",
    long: [
      "  bb snapgen build                 build every stale reference table",
      "  bb snapgen show <table>          one table, as a session would read it",
      "  bb snapgen skeleton <file>       the declarations of a file, not the bodies",
      "  bb snapgen blast [--since ref]   what the current diff can reach, and what reading it costs",
      "  bb snapgen callers <symbol>      the files that import the declaring file, and the files that name it",
      "",
      "skeleton, blast and callers read the tree and a symbol index. Nothing here calls a model.",
      "An IMPORT edge is exact. A MENTION is a name match and is reported separately, never folded in.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "list";
      const reg = registry();
      if (sub === "build") {
        const rows = await build({ only: list(flags), force: !!flags.force });
        if (flags.json) { emit({ rows, index: rel(indexPath()), via: symbolIndex().via }); return 0; }
        out(runner.report(reg, rows));
        out(`  symbols via: ${symbolIndex().via}`);
        return rows.some((r) => r.state === "error") ? 1 : 0;
      }
      if (sub === "stale") {
        const rows = await stale({ only: list(flags) });
        if (flags.json) { emit({ rows }); return 0; }
        out(runner.report(reg, rows));
        return 0;
      }
      if (sub === "list") {
        const rows = await stale();
        if (flags.json) { emit({ tables: rows.map((r) => ({ ...r, description: reg.get(r.name)?.description || "" })) }); return 0; }
        for (const r of rows) out(`  ${pad(r.state, 8)} ${pad(r.name, 24)} ${pad(r.tokens == null ? "-" : human(r.tokens), 7, true)} tok   ${reg.get(r.name)?.description || ""}`);
        out(`\n  index: ${rel(indexPath())}`);
        return 0;
      }
      if (sub === "show") {
        const name = _[1];
        if (!name || !reg.has(name)) { warn(`bb snapgen show <table>; have ${reg.names().join(", ")}`); return 2; }
        if (!onDisk(reg.path(name))) await build({ only: [name] });
        const text = readText(reg.path(name));
        if (flags.json) { emit({ name, path: rel(reg.path(name)), text }); return 0; }
        out(text.trimEnd());
        return 0;
      }
      if (sub === "index") {
        const p = runner.index(reg);
        if (flags.json) { emit({ index: rel(p) }); return 0; }
        out(readText(p).trimEnd());
        return 0;
      }
      if (sub === "skeleton") {
        const files = _.slice(1).filter((x) => !String(x).startsWith("-"));
        if (!files.length) { warn("bb snapgen skeleton <file> [file...]"); return 2; }
        const rows = files.map((f) => graph.skeleton(f, { cap: Number(flags.cap) || 120 }));
        if (flags.json) { emit({ skeletons: rows }); return 0; }
        for (const r of rows) {
          out(`  ${r.file} — ${r.declarations} declaration(s), ${human(r.tokens_skeleton)} of ${human(r.tokens_whole)} tokens${r.ratio ? ` (${r.ratio}x less to read)` : ""}`);
          out(r.lines.map((l) => "  " + l).join("\n") || "    (no declarations parsed)");
          if (r.imported_by.length) out(`\n  imported by: ${r.imported_by.join(", ")}`);
          out("");
        }
        out("  MEASURED: both counts come from bb's own estimator over text on disk.");
        return 0;
      }
      if (sub === "blast") {
        const named = _.slice(1).filter((x) => !String(x).startsWith("-"));
        let files = named, how = "named on the command line";
        if (!files.length) {
          const c = graph.changedFiles(flags.since ? String(flags.since) : "");
          if (c.rc) { warn(c.why); return c.rc; }
          files = c.files; how = c.how;
        }
        if (!files.length) { out(`  nothing changed (${how}) — no radius to compute`); return 0; }
        const b = graph.blast(files, { depth: Number(flags.depth) || 2 });
        if (flags.json) { emit({ how, ...b }); return 0; }
        out(`  ${b.changed.length} file(s) changed (${how}) reach ${b.reached.length} more within ${b.levels.length} hop(s)`);
        out(`  ${human(b.tokens_changed)} tokens changed · ${human(b.tokens_reached)} tokens downstream — that second number is what a reviewer would open to be sure`);
        for (const l of b.levels) out(`\n  hop ${l.depth} (${l.files.length})\n${l.files.map((f) => "    " + f).join("\n")}`);
        if (b.also_mentions.length) out(`\n  also MENTIONS a changed symbol by name (heuristic, not an import edge):\n${b.also_mentions.map((f) => "    " + f).join("\n")}`);
        if (b.unresolved.length) out(`\n  not in the symbol index (not a source file, or newly added): ${b.unresolved.join(", ")}`);
        return 0;
      }
      if (sub === "callers") {
        const name = _[1];
        if (!name) { warn("bb snapgen callers <symbol>"); return 2; }
        const g = graph.graph();
        const declaring = [...g.declares].filter(([, names]) => names.includes(name)).map(([f]) => f);
        const importers = [...new Set(declaring.flatMap((f) => [...(g.inn.get(f) || [])]))].map(rel).sort();
        const mentions = graph.references(name, { limit: Number(flags.limit) || 40 });
        if (flags.json) { emit({ symbol: name, declared_in: declaring.map(rel), imports: importers, mentions }); return 0; }
        if (!declaring.length) { out(`  no file declares \`${name}\` at top level. bb snapgen show symbols`); return 2; }
        out(`  ${name} declared in: ${declaring.map(rel).join(", ")}`);
        out(`\n  IMPORT the declaring file (exact, ${importers.length}):\n${importers.map((f) => "    " + f).join("\n") || "    none"}`);
        out(`\n  MENTION the name (heuristic, ${mentions.length}):\n${mentions.map((f) => "    " + f).join("\n") || "    none"}`);
        return 0;
      }
      warn(`unknown sub-verb: ${sub}. ${commands.snapgen.usage}`);
      return 2;
    },
  },
};
