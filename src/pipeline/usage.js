// usage.js — which gears run, read off the two logs the runner already writes.
//
//   gear_runs.jsonl   one row per gear run (runner.js)
//   episodes.jsonl    one row per verb; `kind: "stage"` rows are a gear's stages
//
// `summary` is what the console's panel shows; `follow` is what `bb pipeline
// tail` prints. Both read the same rows so the page and the terminal agree.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import { VAR } from "../core/paths.js";

const DAY = 24 * 3600 * 1000;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** A runner writes a gear row, then rewrites it as `chained_update` once its
 *  chain finishes. The update is the same run, so it is not counted twice. */
export const isRun = (r) => r && r.gear && !r.chained_update;

/** One row per run: a `chained_update` replaces the row it updates, because
 *  only the update carries the chain's seconds and verdict. */
export function runs(rows) {
  const by = new Map();
  for (const r of rows) if (r && r.gear) by.set(r.id || `${r.gear}:${r.run_id || r.at}`, r);
  return [...by.values()];
}

/** Per gear: runs in the last day and week, and what the last run was. */
export function summary(rows = store.rows("gear_runs"), { at = Date.now(), recent = 15 } = {}) {
  const all = runs(rows);
  const by = {};
  for (const r of all) {
    const age = at - Date.parse(r.at);
    const g = (by[r.gear] ||= { gear: r.gear, total: 0, day: 0, week: 0, seconds: 0, failed: 0, last: null });
    g.total += 1; g.seconds += num(r.seconds);
    if (age <= DAY) g.day += 1;
    if (age <= 7 * DAY) g.week += 1;
    if (num(r.failed) > 0) g.failed += 1;
    g.last = r;
  }
  const gears = Object.values(by).map((g) => ({
    gear: g.gear, total: g.total, day: g.day, week: g.week, failed: g.failed,
    avg_seconds: g.total ? Math.round((g.seconds / g.total) * 10) / 10 : 0,
    last_at: g.last.at, last_trigger: g.last.trigger || "", last_verdict: g.last.verdict || "",
  })).sort((a, b) => b.week - a.week || Date.parse(b.last_at) - Date.parse(a.last_at));
  return {
    total: all.length, gears,
    recent: all.slice(-recent).reverse().map((r) => ({ at: r.at, gear: r.gear, trigger: r.trigger || "",
      verdict: r.verdict || "", ran: num(r.ran), failed: num(r.failed), seconds: num(r.seconds), chained: r.chained || [] })),
  };
}

const clock = (at) => String(at || "").slice(11, 19);

/** One terminal line for a gear row or a stage row. */
export function line(r) {
  if (r.kind === "stage") return `${clock(r.at)}    ${r.gear} › ${r.stage}  ${r.state || "?"}${r.rc ? ` rc=${r.rc}` : ""}  ${num(r.seconds)}s`;
  const chain = r.chained && r.chained.length ? `  → ${r.chained.join(" → ")}` : "";
  return `${clock(r.at)}  ${r.gear}${r.chained_update ? " (chain done)" : ""}  ${r.trigger || "?"}  ${r.verdict || "?"}  ran ${num(r.ran)}/${num(r.stages)}` +
    `${num(r.failed) ? `  failed ${num(r.failed)}` : ""}  ${num(r.seconds)}s${chain}`;
}

/** Call `onRow` for every row appended to the named logs from now on.
 *
 *  Polls the file size rather than using fs.watch: recursive watching is not
 *  on every box (see console/index.js), and a missed event here is a missed
 *  run. A file that shrinks was rotated, so it is read again from the start. */
export function follow(names, onRow, { interval = 1000, dir = VAR } = {}) {
  const tails = names.map((name) => {
    const file = path.join(dir, `${name}.jsonl`);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* not written yet */ }
    return { name, file, offset: size, partial: "" };
  });
  const read = (t) => {
    let st;
    try { st = fs.statSync(t.file); } catch { return; }
    if (st.size < t.offset) { t.offset = 0; t.partial = ""; }
    if (st.size === t.offset) return;
    const fd = fs.openSync(t.file, "r");
    try {
      const buf = Buffer.alloc(st.size - t.offset);
      fs.readSync(fd, buf, 0, buf.length, t.offset);
      t.offset = st.size;
      const lines = (t.partial + buf.toString("utf8")).split("\n");
      t.partial = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let row;
        try { row = JSON.parse(l); } catch { continue; /* a torn row is skipped, as store.rows does */ }
        onRow(t.name, row);
      }
    } finally { fs.closeSync(fd); }
  };
  const timer = setInterval(() => { for (const t of tails) read(t); }, interval);
  return { poll: () => { for (const t of tails) read(t); }, close: () => clearInterval(timer) };
}
