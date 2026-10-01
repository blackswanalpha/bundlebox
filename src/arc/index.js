// arc/index.js — `bb arc`: compile the derived tables into one binary index.
//
// The measurement that decided this design. The PreToolUse search guard asks
// "is this name declared, and where" on every tool call. Answered from the six
// `symbols-*.md` tables that is a full read plus a regex over 20,000 lines:
// 1.80ms. Answered from the compiled index it is 0.14ms cold, 0.073ms warm.
//
// And answered by SPAWNING the Rust binary it is 2.28ms, because the process
// costs 2.20ms of that. So the split is: `arc` (Rust) is the compiler, and
// `src/arc/read.js` is the reader, in-process, where the 13x actually lands.
// The binary stays the reference implementation and the batch tool; nothing on
// the hot path spawns it.
import fs from "node:fs";
import path from "node:path";
import { OUT, PKG_ROOT, rel } from "../core/paths.js";
import { out, emit, warn } from "../core/log.js";
import { run } from "../core/exec.js";
import { human } from "../core/util.js";
import * as read from "./read.js";

export { read };
export const BIN = () => {
  const local = path.join(PKG_ROOT, "arc", "target", "release", process.platform === "win32" ? "arc.exe" : "arc");
  return fs.existsSync(local) ? local : "";
};
export const TABLES = () => {
  const dir = path.join(OUT, "snapgen");
  try { return fs.readdirSync(dir).filter((n) => /^symbols-.*\.md$/.test(n)).map((n) => path.join(dir, n)).sort(); }
  catch { return []; } // no tables compiled yet
};

/** Compile the index. Returns null when the binary is not built, so a caller
 *  can say so rather than silently leaving a stale index in place. */
export function build() {
  const bin = BIN();
  if (!bin) return null;
  const tables = TABLES();
  if (!tables.length) return { error: "no symbols-*.md tables; run `bb snapgen build`" };
  const file = read.FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = run([bin, "build"], { input: JSON.stringify({ out: file, tables }), timeout: 120000 });
  if (r.rc !== 0) return { error: `arc build: ${(r.err || "").trim().slice(-200) || `rc ${r.rc}`}` };
  try { read.reset(); return JSON.parse(r.out); } catch (e) { return { error: `arc build: bad json (${e.message})` }; }
}

/** The binary's own answer to a lookup. Kept so the two readers can be held to
 *  one contract in a test, which is the only thing that keeps them equal. */
export function lookupVia(bin, terms, opts = {}) {
  const r = run([bin, "lookup"], { input: JSON.stringify({ index: read.FILE(), terms, ...opts }), timeout: 30000 });
  if (r.rc !== 0) return null;
  try { return JSON.parse(r.out).hits; } catch { return null; } // null sends the caller to the table scan
}

export const commands = {
  arc: {
    help: "compile the derived symbol tables into one binary index the guards read in microseconds",
    usage: "bb arc [stat] | bb arc build | bb arc lookup <name...> [--under dir] [--shapes exact,prefix,suffix]",
    long: [
      "  The index answers one question — where is this name declared — and it is asked on every",
      "  tool call a session makes. Measured on this tree: 1.80ms from the markdown tables, 0.14ms",
      "  from the compiled index in a cold process, 0.073ms warm.",
      "",
      "  `arc` itself is Rust and dependency-free (arc/Cargo.toml), for the same reason the kernel",
      "  is: it must build on a box with rustc, cargo and no network. It compiles; it is never on",
      "  the hot path, because spawning it costs 2.20ms and that is more than the scan it replaces.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "stat";
      if (sub === "build") {
        const r = build();
        if (!r) { warn(`arc is not built: \`cargo build --release --manifest-path ${rel(path.join(PKG_ROOT, "arc", "Cargo.toml"))}\``); return 2; }
        if (r.error) { warn(r.error); return 2; }
        if (flags.json) { emit(r); return 0; }
        out(`  ARC — ${r.symbols} declarations, ${human(r.bytes)} bytes, ${r.ms.toFixed(1)}ms`);
        for (const t of r.tables || []) out(`    ${String(t.symbols).padStart(5)}  ${rel(t.table)}`);
        out(`  wrote ${rel(read.FILE())}`);
        return 0;
      }
      if (sub === "lookup") {
        const terms = _.slice(1);
        if (!terms.length) { warn(commands.arc.usage); return 2; }
        const shapes = typeof flags.shapes === "string" ? flags.shapes.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        const hits = read.lookup(terms, { under: flags.under ? String(flags.under) : "", ...(shapes ? { shapes } : {}) });
        if (hits === null) { warn(`no index at ${rel(read.FILE())}; \`bb arc build\``); return 2; }
        if (flags.json) { emit({ terms, hits }); return 0; }
        if (!hits.length) { out("  no declaration matches"); return 1; }
        for (const h of hits) out(`  ${h.file}:${h.line} — ${h.symbol}`);
        return 0;
      }
      if (sub === "stat") {
        const st = read.stat();
        if (flags.json) { emit({ binary: BIN() || null, index: st }); return 0; }
        out(`  binary  ${BIN() || "not built (cargo build --release --manifest-path arc/Cargo.toml)"}`);
        if (!st) { out(`  index   none at ${rel(read.FILE())} — \`bb arc build\``); return 0; }
        out(`  index   ${st.symbols} declarations, ${human(st.bytes)} bytes, built ${st.built} (${Math.round(st.age_seconds / 60)}m ago)`);
        return 0;
      }
      warn(`unknown sub-verb: ${sub}. ${commands.arc.usage}`);
      return 2;
    },
  },
};
