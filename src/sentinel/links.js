// links.js — Sentinel's two conversations with the rest of the free path.
//
//   lathe   Sentinel feeds it and draws from it. Every command a run executes
//           is recorded as a shape, so LATHE-1 learns Sentinel's own sequences
//           the way it learns a session's. And before a finding is paid for, a
//           script tagged `@fixes <detector>` and `@safe true` runs first, in
//           the auto-fix worktree, never the main checkout.
//   arc     located briefs. The identifiers a reviewer or a finding names are
//           looked up in the binary index, so a lane is handed `file:line`
//           instead of spending turns searching for them; and when an auto-fix
//           PR merges, the tables and the index are rebuilt so the next lookup
//           answers from the tree that now exists.
import fs from "node:fs";
import { load } from "../core/config.js";
import { abs, rel } from "../core/paths.js";
import { run as exec } from "../core/exec.js";

/** Record what a run executed, as LATHE-1's input. A no-op unless
 *  `lathe.record_shapes` is on, the same switch the PostToolUse hook reads. */
export async function recordShapes(commands, { cfg = load(), session = "sentinel" } = {}) {
  if (!cfg.lathe?.record_shapes || !commands.length) return 0;
  const [{ record }, { commandShapes }] = await Promise.all([import("../lathe/record.js"), import("../lathe/index.js")]);
  let n = 0;
  for (const command of commands) n += record({ tool_name: "Bash", tool_input: { command }, session_id: session }, { shapesOf: commandShapes });
  return n;
}

/** The scripts a person has marked safe that say they close one of these
 *  detectors. Indexed fresh: a stale index points at a file that moved. */
export async function scriptsFor(detectors) {
  const want = new Set(detectors || []);
  if (!want.size) return [];
  const scripts = await import("../scripts/index.js");
  const { rows } = scripts.scan({ write: true });
  return rows.filter((r) => r.safe && (r.fixes || []).some((d) => want.has(d)));
}

/** Run one script from the main checkout's copy, with the worktree as its cwd,
 *  and write the episode `bb scripts run` would. */
export async function runScript(row, cwd, { timeout = 1800000 } = {}) {
  const p = abs(row.path);
  if (!fs.existsSync(p)) return { tag: row.tag, rc: 2, why: `${row.path} is gone` };
  const t0 = Date.now();
  const r = exec([p], { cwd, timeout });
  const seconds = Math.round((Date.now() - t0) / 10) / 100;
  const episodes = await import("../buckmaster/episodes.js");
  episodes.write({ kind: "script", verb: `script:${row.tag}`, stage: row.tag, gear: "sentinel", features: { safe: 1, fixes: (row.fixes || []).join(",") },
    rc: r.rc, seconds, produced: r.rc === 0 ? 1 : 0, produces: row.produces || [], reads: row.needs || [], turns_saved: 0, detail: { tail: (r.out || r.err).slice(-600) } });
  return { tag: row.tag, path: rel(p), rc: r.rc, seconds, why: r.rc ? (r.err || r.out).trim().slice(-200) : "" };
}

// Identifier shapes worth a lookup: `backticked`, camelCase / PascalCase with
// an inner capital, snake_case, and a.b member paths. Plain English words are
// not, or every comment would look up "the".
const TICKED = /`([A-Za-z_$][\w$.]{2,60})`/g;
const SHAPED = /\b([a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\b/g;

export function identifiers(text, { max = 12 } = {}) {
  const seen = new Set();
  for (const re of [TICKED, SHAPED]) for (const m of String(text || "").matchAll(re)) {
    const t = m[1].split(".").pop();
    if (t.length >= 3) seen.add(t);
    if (seen.size >= max) break;
  }
  return [...seen].slice(0, max);
}

/** `file:line  symbol` rows for what a text names, or [] with no index. */
export async function locate(text, { cap = 10 } = {}) {
  const terms = identifiers(text);
  if (!terms.length) return [];
  const { lookup } = await import("../arc/read.js");
  const hits = lookup(terms, { cap, shapes: ["exact"] });
  return (hits || []).map((h) => ({ symbol: h.symbol, file: h.file, line: h.line }));
}

/** The brief section a lane reads first. Empty when nothing was located. */
export function locatedBlock(hits) {
  if (!hits.length) return "";
  return ["", "Located (arc index, exact matches; read these ranges instead of searching):", ...hits.map((h) => `- ${h.file}:${h.line}  ${h.symbol}`)].join("\n");
}

/** After an auto-fix merge: the tables, then the index over them. Only when
 *  an index was built here before; a box that never used arc is not given one. */
export async function refreshArc() {
  const { FILE } = await import("../arc/read.js");
  if (!fs.existsSync(FILE())) return { state: "skipped", why: "no arc index on this box" };
  const { loadCommands } = await import("../cli.js");
  const { table } = await loadCommands();
  const s = table.snapgen ? await table.snapgen.run({ _: ["build"], flags: { quiet: true }, rest: [] }) : 2;
  const { build } = await import("../arc/index.js");
  const b = build();
  return b && !b.error ? { state: "rebuilt", snapgen_rc: s } : { state: "failed", why: b?.error || "arc binary not built" };
}
