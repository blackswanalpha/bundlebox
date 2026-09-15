// failsafe/index.js — what is failing now, why, and the operation that closes it.
//
// Three questions and they are deliberately separate:
//
//   bb failsafe status   what is failing, from every source this box can read
//   bb failsafe why      each failure matched against the playbook: the cause
//                        this workspace already paid to learn, and the op
//   bb failsafe ops      the operations, and which of them mutate anything
//
// The playbook is data. A cause somebody worked out once belongs in a file
// where the next person finds it, not in a paragraph in a chat log — and a
// failure that matches nothing is printed as its raw signature so it can be
// given an entry rather than silently dropped.
//
// Every source also says what it is BLIND to. A `status` that reports "nothing
// failing" while three of its five sources could not look is the most
// expensive kind of green.
import path from "node:path";
import * as store from "../core/store.js";
import * as runbook from "../runbook/index.js";
import * as monitor from "../monitor/index.js";
import * as cookbook from "../cookbook/index.js";
import * as corpus from "../cookbook/corpus.js";
import * as simulate from "../simulate/index.js";
import * as stages from "../pipeline/stages.js";
import * as episodes from "../buckmaster/episodes.js";
import { BB_DIR, PKG_ROOT, rel } from "../core/paths.js";
import { readJson } from "../core/config.js";
import { run as execRun } from "../core/exec.js";
import { out, warn, emit, hr } from "../core/log.js";
import { pad, table } from "../core/util.js";

export const SHIPPED = () => path.join(PKG_ROOT, "src", "failsafe", "playbook.json");
export const LOCAL = () => path.join(BB_DIR, "failsafe", "playbook.json");

export function playbook() {
  const base = readJson(SHIPPED(), { failures: [], ops: [] });
  const local = readJson(LOCAL(), null);
  if (!local) return base;
  const byId = new Map(base.failures.map((f) => [f.id, f]));
  for (const f of local.failures || []) byId.set(f.id, f);
  const ops = new Map(base.ops.map((o) => [o.id, o]));
  for (const o of local.ops || []) ops.set(o.id, o);
  return { ...base, ...local, failures: [...byId.values()], ops: [...ops.values()] };
}

/** Everything failing right now, one row per fact, each naming its source and
 *  what that source cannot see. */
export function status() {
  const rows = [];
  const blind = [];

  const svc = runbook.status();
  if (!svc.length) blind.push("runbook: no services declared, so nothing knows whether anything was listening");
  for (const s of svc) {
    if (s.state !== "up") rows.push({ source: "runbook", key: s.id, state: "down", title: `${s.id} is ${s.state}`, evidence: { service: s.id, process: s.state, log: s.log } });
    else if (s.answering && !["up", "unknown"].includes(s.answering)) rows.push({ source: "runbook", key: s.id, answering: "down", title: `${s.id} does not answer at ${s.health}`, evidence: { service: s.id, health: s.health, why: s.why } });
    if (s.answering === "unknown") blind.push(`runbook: cannot probe ${s.id} (${s.why || "no kernel"})`);
  }

  const ids = corpus.ids();
  if (!ids.length) blind.push("cookbook: no corpus, so nothing checks what the running system does");
  for (const id of ids) {
    const b = cookbook.latest(id);
    if (!b) { blind.push(`cookbook: ${id} has never been run`); continue; }
    const t = b.totals || {};
    const steps = (t.passed || 0) + (t.failed || 0) + (t.error || 0) + (t.blocked || 0) + (t.empty || 0);
    if (b.setup?.state === "failed") rows.push({ source: "board", key: id, setup: "failed", title: `${id}: setup failed against ${b.base}`, evidence: { corpus: id, base: b.base, why: b.setup.steps?.[0]?.why || [] } });
    else if (steps && ((t.failed || 0) + (t.error || 0)) / steps > 0.1) rows.push({ source: "board", key: id, red_share: Math.round((100 * ((t.failed || 0) + (t.error || 0))) / steps) / 100,
      title: `${id}: ${(t.failed || 0) + (t.error || 0)} of ${steps} steps red`, evidence: { corpus: id, base: b.base, totals: t, at: b.at } });
  }

  const sim = simulate.latest();
  if (!sim) blind.push("simulate: nothing stored, so every number here is about one caller at a time");
  else for (const lv of sim.levels || []) if (lv.error_pct > 1) rows.push({ source: "simulation", key: `${sim.profile}-${lv.concurrency}`, error_pct: lv.error_pct,
    title: `${sim.profile} at ${lv.concurrency} concurrent: ${lv.error_pct}% failed`, evidence: { profile: sim.profile, base: sim.base, level: lv.concurrency, p95: lv.p95, rps: lv.rps, at: sim.at } });

  const w = monitor.snapshot();
  if (w.state === "indeterminate") blind.push(`monitor: ${w.why || "no limit could be established"}`);
  else if (w.state !== "ok") rows.push({ source: "monitor", key: "window", state: w.state, title: `the five-hour block is at ${w.limit.pct}% of ${w.limit.source}`, evidence: { pct: w.limit.pct, left: w.limit.left, minutes_left: w.block?.minutes_left, burn: w.burn.per_minute } });

  for (const s of stages.status()) {
    if (s.state === "gap") rows.push({ source: "stages", key: s.id, state: "gap", title: `${s.title}: ${s.why}`, evidence: { stage: s.id, fix: s.fix } });
    if (s.state === "unknown") blind.push(`stages: ${s.id} — ${s.why}`);
  }

  const open = store.get("findings", []).filter((f) => f.status === "open");
  for (const f of open.filter((x) => x.detector === "eval")) rows.push({ source: "findings", key: f.id, detector: "eval", title: f.title, evidence: f.evidence || {} });
  const unproven = store.get("units", []).filter((u) => !u.acceptance);
  if (unproven.length) rows.push({ source: "units", key: "unproven", acceptance: "", title: `${unproven.length} unit(s) have no acceptance command`, evidence: { units: unproven.map((u) => u.id).slice(0, 8) } });

  const logs = runbook.digest({ since: true });
  for (const l of logs.files || []) for (const sig of (l.signatures || []).filter((s) => /error|exception|fatal|panic|refused|timeout|traceback/i.test(s.sig)).slice(0, 6))
    rows.push({ source: "log", key: sig.sig.slice(0, 60), signature: sig.sig, title: `${sig.n}x ${sig.sig.slice(0, 80)}`, evidence: { file: l.file, count: sig.n, sample: sig.sample } });
  // A named bucket outranks every signature guess: the workspace has already
  // paid to learn what it means, and the row carries that sentence.
  for (const b of logs.buckets || [])
    rows.push({ source: "log", key: `bucket:${b.id}`, bucket: b.id, severity: b.severity, signature: b.id,
      title: `${b.n}x ${b.id}: ${b.says}`, evidence: { count: b.n, sample: b.sample, severity: b.severity } });

  return { rows, blind };
}

const matches = (row, m) => Object.entries(m || {}).every(([k, v]) =>
  k === "source" ? row.source === v
  : typeof v === "number" ? Number(row[k]) >= v
  : v === "" ? row[k] === ""
  : String(row[k] ?? "") === String(v));

/** Each failure against the playbook. A row matching nothing is returned with
 *  `entry: null` and its raw signature, so it can be given one. */
export function why() {
  const pb = playbook();
  const { rows, blind } = status();
  const ops = new Map(pb.ops.map((o) => [o.id, o]));
  const out = rows.map((r) => {
    const entry = pb.failures.find((f) => matches(r, f.match)) || null;
    return { ...r, entry: entry ? { id: entry.id, why: entry.why, op: entry.op, doc: entry.doc, cmd: ops.get(entry.op)?.cmd || "" } : null };
  });
  return { rows: out, blind, unmatched: out.filter((r) => !r.entry) };
}

export function record(rows) {
  const store_rows = rows.filter((r) => r.entry).map((r) => ({
    detector: "failsafe", severity: r.source === "monitor" ? "medium" : r.source === "runbook" ? "high" : "medium",
    precision: "exact", title: r.title, path: r.source, files: [], key: `${r.source}/${r.key}`,
    detail: `${r.entry.why}\n\nThe operation that closes it: \`${r.entry.cmd || r.entry.op}\`\nMore: ${r.entry.doc}`,
    evidence: { ...r.evidence, source: r.source, playbook_entry: r.entry.id },
    fix_hint: r.entry.cmd || r.entry.op, auto_fix: null, kind: "verify", est_tokens: 300,
  }));
  store.mergeFindings(store_rows, { detectors: new Set(["failsafe"]) });
  return store_rows.length;
}

export function check() {
  const pb = playbook();
  const errors = [], warnings = [];
  const opIds = new Set(pb.ops.map((o) => o.id));
  const sources = new Set(["runbook", "board", "simulation", "monitor", "stages", "findings", "units", "log"]);
  for (const f of pb.failures) {
    if (!f.id) errors.push("a failure with no id");
    if (!f.why) errors.push(`${f.id}: no why; the whole point of the playbook is the cause`);
    if (!opIds.has(f.op)) errors.push(`${f.id}: op \`${f.op}\` is not defined`);
    if (!sources.has(f.match?.source)) errors.push(`${f.id}: match.source \`${f.match?.source}\` is not a source status() produces`);
  }
  const used = new Set(pb.failures.map((f) => f.op));
  for (const o of pb.ops) if (!used.has(o.id)) warnings.push(`op \`${o.id}\` is defined and no failure names it`);
  return { ok: !errors.length, errors, warnings, failures: pb.failures.length, ops: pb.ops.length };
}

/** Re-run only what was red on the last board, against the same base. */
export async function rerun({ corpusId = "", apply = true } = {}) {
  const id = corpusId || corpus.ids()[0];
  const b = cookbook.latest(id);
  if (!b) return { rc: 2, why: `no stored board for \`${id}\`` };
  const red = (b.scenarios || []).filter((s) => s.state === "failed" || s.state === "error").map((s) => s.id);
  if (!red.length) return { rc: 0, why: `nothing was red on the last ${id} board`, ids: [] };
  if (!apply) return { rc: 0, why: `would re-run ${red.length} scenario(s) against ${b.base}`, ids: red };
  const r = await cookbook.runCorpus(id, { base: b.base, ids: red });
  return r.rc ? r : { rc: 0, board: r.board, ids: red, why: `re-ran ${red.length} against ${b.base}` };
}

async function cmd({ _, flags }) {
  const sub = _[0] || "status";

  if (sub === "ops") {
    const pb = playbook();
    if (flags.json) { emit({ ops: pb.ops }); return 0; }
    out(table(pb.ops.map((o) => [o.id, o.destructive ? "MUTATES" : "safe", o.cmd, o.why]), { header: ["op", "", "command", "what it does"] })
      .split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "check") {
    const r = check();
    if (flags.json) { emit(r); return r.ok ? 0 : 1; }
    out(`  ${r.failures} failures, ${r.ops} ops — ${r.ok ? "ok" : "REFUSED"}`);
    for (const e of r.errors) out(`    !! ${e}`);
    for (const w of r.warnings) out(`    ·  ${w}`);
    return r.ok ? 0 : 1;
  }

  if (sub === "run") {
    const id = _[1];
    const op = playbook().ops.find((o) => o.id === id);
    if (!op) { warn(`no op \`${id}\`. bb failsafe ops`); return 2; }
    if (!flags.apply) { out(`  ${op.cmd}\n\n  ${op.why}. --apply runs it.`); return 0; }
    if (op.cmd.includes("<")) { warn(`\`${op.cmd}\` has a placeholder in it; run it yourself with the value filled in`); return 2; }
    const r = execRun(["bash", "-lc", op.cmd], { timeout: 900000 });
    out(r.out.trimEnd());
    if (r.err.trim()) warn(r.err.trim().slice(-500));
    return r.rc;
  }

  if (sub === "rerun") {
    const r = await rerun({ corpusId: String(flags.persona || ""), apply: flags.apply !== false });
    if (r.rc) { warn(r.why); return r.rc; }
    out(`  ${r.why}`);
    if (r.board) out(cookbook.boardText(r.board));
    return 0;
  }

  if (sub === "status" || sub === "why") {
    const r = why();
    if (sub === "why" && flags.write !== false) record(r.rows);
    if (flags.json) { emit(r); return r.rows.length ? 1 : 0; }
    if (!r.rows.length) out("  nothing failing from any source this box can read.");
    for (const row of r.rows) {
      out(`  ${pad(row.source, 11)} ${row.title}`);
      if (sub === "why") {
        if (row.entry) out(`              ${row.entry.why}\n              op: ${row.entry.cmd || row.entry.op}   ·   ${row.entry.doc}`);
        else out(`              no playbook entry. Add one for \`${row.source}\` matching ${JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !["source", "title", "evidence", "entry"].includes(k))))}`);
      }
    }
    if (r.blind.length) { hr(); out("  what none of this could see:"); for (const b of r.blind) out(`    ? ${b}`); }
    if (sub === "why") out(`\n  ${r.rows.filter((x) => x.entry).length} matched the playbook, ${r.unmatched.length} did not.`);
    return r.rows.length ? 1 : 0;
  }
  warn(`unknown failsafe sub-verb: ${sub}. status | why | ops | run <op> | rerun | check`);
  return 2;
}

export const commands = {
  failsafe: {
    help: "what is failing now, why, and the operation that closes it (0 model tokens)",
    usage: "bb failsafe [status|why|ops|run <op> [--apply]|rerun|check] [--json]",
    long: [
      "  bb failsafe status    every source this box can read, and what each is blind to",
      "  bb failsafe why       each failure matched against the playbook: cause, op, doc",
      "  bb failsafe rerun     re-run only what was red on the last board, same base",
      "",
      "The playbook ships in src/failsafe/playbook.json and is extended per workspace",
      "in .bundlebox/failsafe/playbook.json. A failure matching nothing prints its raw",
      "shape so it can be given an entry.",
    ].join("\n"),
    run: cmd,
  },
};
