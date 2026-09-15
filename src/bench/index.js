// bench/index.js — the ablation benchmark: the same task, twice, measured.
//
// `bb session` reports what a session used and what the cache and the wire
// saved it. What it could not report was the factory's own effect, because
// "the turns the local verbs displaced" is an estimate and the report says so.
// This verb closes that gap for the part that can be measured: the CONTEXT a
// task costs, with the factory in front of it and without.
//
// The ablation is borrowed from skill evaluation: run the subject, then run it
// again with the thing under test removed, and report the difference. Here the
// removed thing is bundlebox itself — the bare arm is a search and a read,
// which is what the same session does on a box where nothing is installed.
//
// Two rules keep the number honest:
//   1. Both arms are measured with the same estimator over text that exists.
//   2. A task where the factory costs MORE is printed, not dropped. A bench
//      that only publishes its wins is marketing with a table in it.
import fs from "node:fs";
import path from "node:path";
import { OUT, VAR, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { human, now, stamp, table } from "../core/util.js";
import * as store from "../core/store.js";
import * as suite from "./suite.js";
import { bare, packed, BARE_READ_CAP } from "./arms.js";

export const DIR = () => path.join(OUT, "bench");
export const LATEST = () => path.join(DIR(), "latest.json");

const pct = (saved, from) => (from > 0 ? Math.round((saved / from) * 1000) / 10 : 0);

/** One task, both arms. Never throws: a task that cannot be measured is a row
 *  saying so, because a bench that dies on task four loses tasks one to three. */
export async function runTask(t, { cap = BARE_READ_CAP, maxFiles = 6 } = {}) {
  const row = { id: t.id, title: t.title || t.problem, from: t.from || "" };
  try {
    const a = bare(t.problem, { files: t.files || [], cap });
    const b = await packed(t.problem, { files: t.files || [], maxFiles });
    const saved = a.tokens - b.tokens;
    return { ...row, bare: a.tokens, packed: b.tokens, saved, saved_pct: pct(saved, a.tokens),
      bare_files_read: a.read, bare_files_found: a.considered, packed_files: b.scope.length,
      anchors: b.anchors, verdict: b.verdict, terms: a.terms, prompt: b.path };
  } catch (e) {
    return { ...row, error: String((e && e.message) || e).split("\n")[0], bare: 0, packed: 0, saved: 0, saved_pct: 0 };
  }
}

export async function run(id = "default", { cap = BARE_READ_CAP, maxFiles = 6, write = true } = {}) {
  let spec = suite.load(id);
  if (!spec && id === "default") {
    const tasks = suite.derive();
    if (!tasks.length) return { rc: 2, why: "no suite on disk and no open finding names a file. `bb scan` first, or write .bundlebox/bench/default.json" };
    suite.write("default", { title: "derived from the open findings", note: "regenerate with `bb bench init`", tasks });
    spec = suite.load("default");
  }
  if (!spec) return { rc: 2, why: `no bench suite \`${id}\`. bb bench suites` };
  if (!spec.tasks.length) return { rc: 2, why: `suite \`${id}\` has no task with a \`problem\`` };

  const t0 = Date.now();
  const tasks = [];
  for (const t of spec.tasks) tasks.push(await runTask(t, { cap, maxFiles }));
  const ok = tasks.filter((r) => !r.error);
  const totalBare = ok.reduce((a, r) => a + r.bare, 0);
  const totalPacked = ok.reduce((a, r) => a + r.packed, 0);
  const saved = totalBare - totalPacked;
  const losses = ok.filter((r) => r.saved <= 0);

  const result = {
    suite: id, title: spec.title, at: now(), seconds: Math.round((Date.now() - t0) / 100) / 10,
    bare_read_cap: cap, max_files: maxFiles,
    totals: { bare: totalBare, packed: totalPacked, saved, saved_pct: pct(saved, totalBare),
      tasks: tasks.length, measured: ok.length, errors: tasks.length - ok.length, losses: losses.length,
      ratio: totalPacked > 0 ? Math.round((totalBare / totalPacked) * 10) / 10 : null },
    kind: "MEASURED",
    method: "both arms counted by bb's own estimator over text on disk; neither arm called a model",
    tasks,
  };
  if (write) {
    fs.mkdirSync(DIR(), { recursive: true });
    writeJson(path.join(DIR(), `${stamp()}-${id}.json`), result);
    writeJson(LATEST(), result);
    store.append("bench", { suite: id, bare: totalBare, packed: totalPacked, saved,
      saved_pct: result.totals.saved_pct, tasks: tasks.length, losses: losses.length });
  }
  return { rc: 0, ...result };
}

export function latest() { return readJson(LATEST(), null); }

/** Every run ever, oldest first: the dashboard's trend line. */
export function history({ limit = 40 } = {}) { return store.rows("bench", { limit }); }

export function report(r) {
  const L = [`  ${r.suite} — ${r.totals.measured} task(s) measured in ${r.seconds}s`, ""];
  L.push(table(r.tasks.map((t) => [
    t.id.slice(0, 10), (t.title || "").slice(0, 46),
    t.error ? "—" : human(t.bare), t.error ? "—" : human(t.packed),
    t.error ? t.error.slice(0, 22) : `${t.saved_pct}%`,
    t.error ? "" : `${t.bare_files_read}/${t.bare_files_found}`,
    t.error ? "" : String(t.packed_files),
  ]), { header: ["id", "task", "bare", "packed", "saved", "read", "scope"] }));
  const t = r.totals;
  L.push("", `  bare   ${human(t.bare)} tokens — search the tree, open the top ${r.bare_read_cap} files whole`);
  L.push(`  packed ${human(t.packed)} tokens — one pinpoint prompt per task`);
  L.push(`  saved  ${human(t.saved)} tokens, ${t.saved_pct}% of the bare arm${t.ratio ? ` (${t.ratio}x less context)` : ""}`);
  if (t.losses) L.push(`  ${t.losses} task(s) cost MORE packed than bare; they are in the table above and are not dropped.`);
  if (t.errors) L.push(`  ${t.errors} task(s) could not be measured.`);
  L.push("", "  MEASURED: both arms are token counts over text on disk. Neither arm called a model,");
  L.push("  and this number is never added to what a session USED.");
  return L.join("\n");
}

async function cmd({ _, flags }) {
  const sub = _[0] && !_[0].startsWith("-") ? _[0] : "run";
  const cap = Number(flags.cap) || BARE_READ_CAP;
  const maxFiles = Number(flags.maxFiles) || 6;

  if (sub === "suites") {
    const all = suite.ids();
    if (flags.json) { emit({ suites: all }); return 0; }
    if (!all.length) { out("  no suite on disk. `bb bench init` derives one from the open findings."); return 0; }
    for (const id of all) { const s = suite.load(id); out(`  ${id.padEnd(16)} ${s.tasks.length} task(s)  ${s.title}`); }
    return 0;
  }
  if (sub === "init") {
    const tasks = suite.derive({ limit: Number(flags.limit) || 12 });
    if (!tasks.length) { warn("no open finding names a file. Run `bb scan` first."); return 2; }
    const id = String(flags.id || "default");
    const file = suite.write(id, { title: flags.title ? String(flags.title) : "derived from the open findings", note: "each task is a finding a session would be handed", tasks });
    out(`  ${file}  (${tasks.length} task(s))`);
    return 0;
  }
  if (sub === "show") {
    const r = latest();
    if (!r) { warn("no bench run stored. bb bench run"); return 2; }
    if (flags.json) { emit(r); return 0; }
    out(report(r));
    return 0;
  }
  if (sub === "run") {
    const id = (_[1] && !_[1].startsWith("-") ? _[1] : String(flags.suite || "")) || "default";
    const r = await run(id, { cap, maxFiles, write: flags.write !== false });
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    out(report(r));
    return 0;
  }
  warn(`unknown bench sub-verb: ${sub}. run | init | suites | show`);
  return 2;
}

export const commands = {
  bench: {
    help: "the ablation benchmark: what a task costs with the factory and without it (no tokens)",
    usage: "bb bench [run [suite]] | init [--limit N] | suites | show [--json] [--cap 10]",
    long: [
      "  bb bench run                     measure every task in the default suite, both arms",
      "  bb bench init                    derive a suite from the open findings that name a file",
      "  bb bench show --json             the last run as data",
      "",
      "BARE   search the tree for the task's terms and read the top --cap files whole.",
      "PACKED one `bb pinpoint` prompt for the same task.",
      "",
      "Both arms are measured with the same estimator over text on disk; neither calls a model.",
      "Tasks where packed costs more are printed, not dropped.",
    ].join("\n"),
    run: cmd,
  },
};
