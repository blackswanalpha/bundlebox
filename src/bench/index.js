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
import * as arms from "./arms.js";
import * as swebench from "./swebench.js";
import * as gate from "./gate.js";

export { swebench, gate };

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
      // The file lists, not only their counts. `bb bench gate` decides whether a
      // unit is the same task as a benched one, and files are what that is
      // measured on: two counts cannot tell you a run was about the same code.
      bare_files: a.files.map((f) => f.file), packed_files_list: b.scope,
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
    bare_read_cap: cap, bare_range: arms.BARE_RANGE, max_files: maxFiles,
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
  L.push("", `  bare   ${human(t.bare)} tokens — grep the tree, read the search output, open a ${r.bare_range || 80}-line range in each of the top ${r.bare_read_cap} files`);
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
  // The one-task form, used by `swebench` to measure inside a checkout of
  // another repository. A child process rooted there is the only honest way to
  // run the arms against a tree that is not this one: the workspace root is
  // resolved once per process, so measuring another tree means being another
  // process in it — which is also exactly what a person running `bb` there gets.
  if (sub === "arm") {
    const f = String(flags.file || "");
    const task = readJson(f, null);
    if (!task || !task.problem) { warn("bb bench arm --file <task.json>  (needs {\"problem\": \"...\"})"); return 2; }
    const t0 = Date.now();
    const a = bare(task.problem, { files: task.files || [], cap: Number(task.cap) || cap });
    const b = await packed(task.problem, { files: task.files || [], maxFiles: Number(task.maxFiles) || maxFiles });
    const payload = { id: task.id || "", bare: a.tokens, packed: b.tokens,
      bare_files: a.files.map((x) => x.file), packed_files: b.scope,
      // Two file sets, because they cost differently and a benchmark that
      // merged them would be measuring the cheaper one and reporting the
      // dearer one. `packed_files` is the scope a session may edit; `named`
      // also counts the ranked pointers the brief hands it for free.
      packed_named: [...new Set([...(b.scope || []), ...((b.candidates || []).map((c) => c.file))])],
      bare_considered: a.considered, verdict: b.verdict, terms: a.terms,
      seconds: Math.round((Date.now() - t0) / 100) / 10 };
    emit(payload);
    return 0;
  }

  if (sub === "swebench") {
    const what = _[1] && !_[1].startsWith("-") ? _[1] : "run";
    if (what === "show") {
      const r = swebench.latest();
      if (!r) { warn("no SWE-bench run stored. bb bench swebench run"); return 2; }
      if (flags.json) { emit(r); return 0; }
      out(swebench.report(r));
      return 0;
    }
    if (what === "instances") {
      const d = await swebench.fetchInstances({ limit: Number(flags.limit) || 100, refresh: !!flags.refresh });
      if (d.rc) { warn(d.why); return d.rc; }
      if (flags.json) { emit({ dataset: d.dataset, at: d.at, rows: d.rows.length }); return 0; }
      out(`  ${d.rows.length} instance(s) cached from ${d.dataset}`);
      const byRepo = {};
      for (const r of d.rows) byRepo[r.repo] = (byRepo[r.repo] || 0) + 1;
      out(table(Object.entries(byRepo).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]), { header: ["repo", "instances"] }));
      return 0;
    }
    if (what === "run") {
      const r = await swebench.run({ n: Number(flags.n) || 12, offset: Number(flags.offset) || 0,
        repos: String(flags.repos || ""), cap, maxFiles, write: flags.write !== false, log: flags.json ? () => {} : out });
      if (r.rc) { warn(r.why); return r.rc; }
      if (flags.json) { emit(r); return 0; }
      out("");
      out(swebench.report(r));
      return 0;
    }
    warn(`unknown swebench sub-verb: ${what}. run | show | instances`);
    return 2;
  }

  if (sub === "gate") {
    // With a task, it answers for that task; with nothing, it reports every
    // task the last run says is not worth packing, which is the list `bb route`
    // now consults instead of packing them again.
    const title = _.slice(1).filter((x) => !x.startsWith("-")).join(" ");
    const L = gate.losers({});
    if (title) {
      const v = gate.verdictFor({ title, scope: String(flags.files || "").split(",").filter(Boolean) }, { l: L });
      if (flags.json) { emit(v); return v.pack ? 0 : 1; }
      out(`  ${v.pack ? "pack" : "BARE"}  ${v.why}`);
      return v.pack ? 0 : 1;
    }
    if (!L.ok) { if (flags.json) { emit(L); return 2; } warn(L.why); return 2; }
    if (flags.json) { emit(L); return L.lost.length || L.thin.length ? 1 : 0; }
    out(`  ${L.suite} — measured ${L.at.slice(0, 16)}, ${L.age_hours}h ago; margin ${L.margin}%\n`);
    if (!L.lost.length && !L.thin.length) { out("  every measured task costs less packed than bare. Nothing is opted out."); return 0; }
    out(table([...L.lost, ...L.thin].map((t) => [t.id.slice(0, 14), (t.title || "").slice(0, 44),
      human(t.bare), human(t.packed), `${t.saved_pct}%`, t.saved_pct <= 0 ? "loses" : "thin"]),
      { header: ["id", "task", "bare", "packed", "saved", "verdict"] }).split("\n").map((l) => "  " + l).join("\n"));
    out(`\n  ${L.lost.length} task(s) cost more packed, ${L.thin.length} win by less than ${L.margin}%.`);
    out("  `bb route` routes work matching these BARE; `bb monitor guard` refuses a spend whose brief has no delta.");
    return 1;
  }

  if (sub === "run") {
    const id = (_[1] && !_[1].startsWith("-") ? _[1] : String(flags.suite || "")) || "default";
    const r = await run(id, { cap, maxFiles, write: flags.write !== false });
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    out(report(r));
    return 0;
  }
  warn(`unknown bench sub-verb: ${sub}. run | init | suites | show | gate | arm | swebench`);
  return 2;
}

export const commands = {
  bench: {
    help: "the ablation benchmark: what a task costs with the factory and without it (no tokens)",
    usage: "bb bench [run [suite]] | init [--limit N] | suites | show | gate [<task>] | swebench run [--n 12] [--repos a,b] [--json] [--cap 10]",
    long: [
      "  bb bench run                     measure every task in the default suite, both arms",
      "  bb bench init                    derive a suite from the open findings that name a file",
      "  bb bench show --json             the last run as data",
      "  bb bench gate                    the tasks not worth packing; rc 1 when there are any",
      "  bb bench gate \"<task>\"           should THIS task be packed? rc 1 = route it bare",
      "  bb bench swebench run --n 12     the same two arms on public SWE-bench Verified instances",
      "  bb bench swebench show           the last SWE-bench run",
      "  bb bench swebench instances      which repositories the cached instances come from",
      "",
      "BARE   grep the tree for the task's terms, read the search output, open one range per hit in the top --cap files.",
      "PACKED one `bb pinpoint` prompt for the same task.",
      "",
      "Both arms are measured with the same estimator over text on disk; neither calls a model.",
      "Tasks where packed costs more are printed, not dropped.",
      "",
      "SWE-bench here measures LOCALISATION (are the maintainer's own changed files in the packed",
      "window?) and context cost. It is NOT a resolve rate: that needs the official harness and a model.",
    ].join("\n"),
    run: cmd,
  },
};
