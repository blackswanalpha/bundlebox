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

export { registry, DIR, symbolIndex } from "./tables.js";

export const tablePath = (name) => registry().path(name);
export const indexPath = () => path.join(DIR, "INDEX.md");

export async function build({ only = null, force = false } = {}) { return runner.build(registry(), { only, force }); }
export async function stale({ only = null } = {}) { return runner.stale(registry(), { only }); }

const onDisk = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

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
    usage: "bb snapgen build [--only a,b] [--force] | stale | list | show <table> | index  [--json]",
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
      warn(`unknown sub-verb: ${sub}. ${commands.snapgen.usage}`);
      return 2;
    },
  },
};
