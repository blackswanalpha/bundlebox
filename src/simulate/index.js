// simulate/index.js — the situation stage: what the system does as the level
// climbs, and where its real limits are.
//
// A corpus asks whether the system obeys its own rules once. A simulation asks
// whether it still does under a hundred callers, and what it costs to find out.
// Both are free; neither opens a session. The kernel runs the levels on threads
// with one connection per worker, so the number on the board is the service's
// throughput and not this process's scheduler.
//
// Budgets here are never absolute milliseconds. A profile names a MULTIPLE of
// the floor measured in that run, clamped, with a slack floor under it — a
// constant written on one box is wrong on every other one, and a performance
// board that cries wolf on a slower laptop is a board nobody reads.
import fs from "node:fs";
import path from "node:path";
import * as kernel from "../core/kernel.js";
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import { BB_DIR, VAR, rel } from "../core/paths.js";
import { readJson, writeJson, load as loadCfg } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { now, stamp, pad, table, clamp } from "../core/util.js";

export const DIR = () => path.join(BB_DIR, "simulate");
export const RUNS = () => path.join(VAR, "simulations");

export const DEFAULTS = {
  p95_multiple_floor: 4.0,    // the budget never tightens below this many x the floor
  p95_multiple_ceiling: 40.0, // nor loosens above it, however noisy the floor was
  min_slack_ms: 25,           // and never below floor + this, so jitter is not a regression
  error_pct: 1.0,             // 5xx, non-2xx or refused, as a share of a level's requests
  blocker_budget_x: 3.0,      // p95 over this many x the budget is a blocker, not a major
};

export const SMOKE = {
  id: "smoke", title: "one caller, then eight, then thirty-two",
  request: { method: "GET", path: "/", headers: {} },
  levels: [{ concurrency: 1, seconds: 3 }, { concurrency: 8, seconds: 3 }, { concurrency: 32, seconds: 3 }],
};

export function profiles() {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(DIR()).filter((f) => f.endsWith(".json")).sort(); } catch { names = []; }
  for (const f of names) { const p = readJson(path.join(DIR(), f), null); if (p) rows.push({ ...p, id: p.id || f.replace(/\.json$/, "") }); }
  if (!rows.length) rows.push(SMOKE);
  return rows;
}
export const profile = (id) => profiles().find((p) => p.id === id) || null;

export function init(id, { path: routePath = "/", method = "GET" } = {}) {
  fs.mkdirSync(DIR(), { recursive: true });
  const file = path.join(DIR(), `${id}.json`);
  if (fs.existsSync(file)) return { rc: 2, why: `${rel(file)} exists` };
  writeJson(file, { ...SMOKE, id, title: `what ${method} ${routePath} does as the level climbs`, request: { method, path: routePath, headers: {} } });
  return { rc: 0, file: rel(file) };
}

/** The budget for this run, derived from the floor it just measured. */
export function budget(floorMs, th) {
  if (!Number.isFinite(floorMs) || floorMs <= 0) return null;
  const lo = floorMs * th.p95_multiple_floor;
  const hi = floorMs * th.p95_multiple_ceiling;
  return Math.max(clamp(lo, 0, hi), floorMs + th.min_slack_ms);
}

export function verdicts(run, th) {
  const rows = [];
  const b = budget(run.floor_ms, th);
  for (const lv of run.levels || []) {
    if (lv.error_pct > th.error_pct) {
      rows.push({ rule: "error_pct", severity: lv.error_pct > 10 ? "high" : "medium", level: lv.concurrency,
        title: `${lv.concurrency} concurrent: ${lv.error_pct}% of requests failed or answered non-2xx`,
        detail: `${lv.errors} refused, ${lv.non_2xx} non-2xx of ${lv.requests} in ${lv.seconds}s.`,
        facts: { error_pct: lv.error_pct, threshold: th.error_pct } });
    }
    if (b && lv.p95 > b) {
      const over = lv.p95 / b;
      rows.push({ rule: "p95_over_budget", severity: over > th.blocker_budget_x ? "high" : "medium", level: lv.concurrency,
        title: `${lv.concurrency} concurrent: p95 ${lv.p95}ms against a ${Math.round(b)}ms budget`,
        detail: `The budget is ${th.p95_multiple_floor}x the ${run.floor_ms}ms floor measured in this same run, so it travels between boxes. p50 ${lv.p50}ms, max ${lv.max}ms, ${lv.rps} rps.`,
        facts: { p95: lv.p95, budget: Math.round(b), floor_ms: run.floor_ms, over: Math.round(over * 100) / 100 } });
    }
  }
  return { budget_ms: b == null ? null : Math.round(b), findings: rows };
}

export function runFile(run) {
  fs.mkdirSync(RUNS(), { recursive: true });
  const f = path.join(RUNS(), `${run.profile}-${stamp()}.json`);
  writeJson(f, run);
  return rel(f);
}
export function latest(id = "") {
  try {
    const fs2 = fs.readdirSync(RUNS()).filter((f) => f.endsWith(".json") && (!id || f.startsWith(`${id}-`))).sort();
    return fs2.length ? readJson(path.join(RUNS(), fs2[fs2.length - 1]), null) : null;
  } catch { return null; }  // no runs yet
}

export function simulate(id, { base = "", seconds = 0, levels = "", write = true } = {}) {
  const p = profile(id);
  if (!p) return { rc: 2, why: `no profile \`${id}\`. bb simulate profiles` };
  if (!base) return { rc: 2, why: "no base: pass --base. Nothing is guessed, and a simulation against the wrong service is worse than none" };
  if (!kernel.available()) return { rc: 2, why: "the simulator is a kernel op and there is no `bbk` on this box. `bb kernel build`" };
  let lv = p.levels;
  if (levels) lv = String(levels).split(",").map((n) => ({ concurrency: Number(n) || 1, seconds: Number(seconds) || 3 }));
  else if (seconds) lv = lv.map((x) => ({ ...x, seconds: Number(seconds) }));
  const t0 = Date.now();
  const r = kernel.call("simulate", { base, request: p.request, levels: lv, timeout_ms: p.timeout_ms || 20000, max_requests: p.max_requests || 20000 },
    { timeout: (lv.reduce((a, x) => a + (x.seconds || 3), 0) + 60) * 1000 });
  if (!r || !r.ok) return { rc: 2, why: r?.why || kernel.lastError || "the kernel returned nothing" };
  const th = { ...DEFAULTS, ...(loadCfg().simulate?.thresholds || {}) };
  const v = verdicts(r, th);
  const run = { profile: id, title: p.title || "", at: now(), ...r, thresholds: th, ...v };
  const file = write ? runFile(run) : "";
  // Merged on EVERY stored run, including a clean one. Gating the merge on
  // `v.findings.length` meant a run that crossed nothing wrote nothing, so the
  // three findings from the last run against a service that was down stayed
  // open forever with no verb able to close them. A clean run is the evidence
  // that closes them, and it has to be allowed to say so.
  if (write) {
    const det = `simulate:${id}`;
    store.mergeFindings(v.findings.map((f) => ({
      detector: det, severity: f.severity, precision: "probe", title: f.title, path: `${p.request.method} ${p.request.path}`,
      files: [], key: `${id}/${f.rule}/${f.level}`, detail: f.detail,
      evidence: { ...f.facts, base, level: f.level, profile: id, run: file },
      fix_hint: "A latency finding names the level it appeared at. Reproduce with `bb simulate run " + id + " --base " + base + "` before changing anything.",
      auto_fix: null, kind: "investigate", est_tokens: 400,
    })), { detectors: new Set([det]) });
  }
  episodes.write({ kind: "stage", verb: "simulate", stage: `simulate:${id}`,
    features: { levels: lv.length, top_concurrency: Math.max(...lv.map((x) => x.concurrency)), floor_ms: r.floor_ms ?? -1 },
    rc: v.findings.length ? 1 : 0, seconds: (Date.now() - t0) / 1000, produced: v.findings.length, produces: ["findings", "simulation"],
    turns_saved: episodes.turns({ commands: lv.length, rows: (r.levels || []).reduce((a, x) => a + x.requests, 0) }),
    detail: { run: file } });
  return { rc: 0, run, file };
}

export function runText(run) {
  const L = [`  ${run.profile} — ${run.request} against ${run.base}`, ""];
  L.push(table((run.levels || []).map((l) => [l.concurrency, l.requests, `${l.rps}/s`, `${l.p50}ms`, `${l.p95}ms`, `${l.p99}ms`, `${l.max}ms`, l.error_pct ? `${l.error_pct}%` : ""]),
    { header: ["conc", "requests", "rate", "p50", "p95", "p99", "max", "errors"] }).split("\n").map((l) => "  " + l).join("\n"));
  L.push("", `  floor ${run.floor_ms ?? "—"}ms measured in this run · budget ${run.budget_ms ?? "—"}ms (${run.thresholds?.p95_multiple_floor}x the floor, never below floor + ${run.thresholds?.min_slack_ms}ms)`);
  for (const f of run.findings || []) L.push(`  ${pad(f.severity, 8)} ${f.title}`);
  if (!(run.findings || []).length) L.push("  nothing crossed a threshold at these levels");
  return L.join("\n");
}

async function cmd({ _, flags }) {
  const sub = _[0] || "run";
  if (sub === "profiles" || sub === "list") {
    const rows = profiles();
    if (flags.json) { emit({ profiles: rows, dir: rel(DIR()) }); return 0; }
    out(table(rows.map((p) => [p.id, `${p.request.method} ${p.request.path}`, p.levels.map((l) => l.concurrency).join("→"), `${p.levels.reduce((a, l) => a + l.seconds, 0)}s`, p.title || ""]),
      { header: ["profile", "request", "levels", "wall", "title"] }).split("\n").map((l) => "  " + l).join("\n"));
    if (!fs.existsSync(DIR())) out(`\n  no profiles on disk; \`smoke\` is the built-in. bb simulate init <id> --path /health`);
    return 0;
  }
  if (sub === "init") {
    const id = _[1];
    if (!id) { warn("bb simulate init <id> [--path /health] [--method GET]"); return 2; }
    const r = init(id, { path: String(flags.path || "/"), method: String(flags.method || "GET").toUpperCase() });
    out(r.rc ? `  ${r.why}` : `  ${r.file}`);
    return r.rc;
  }
  if (sub === "show") {
    const r = latest(_[1] || String(flags.profile || ""));
    if (!r) { warn("no stored simulation. bb simulate run <profile> --base <url>"); return 2; }
    if (flags.json) { emit(r); return 0; }
    out(runText(r));
    return 0;
  }
  if (sub === "run") {
    const id = _[1] || String(flags.profile || "") || "smoke";
    const r = simulate(id, { base: String(flags.base || ""), seconds: Number(flags.seconds) || 0, levels: String(flags.levels || ""), write: flags.write !== false });
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    out(runText(r.run));
    if (r.file) out(`\n  ${r.file}`);
    return r.run.findings.length ? 1 : 0;
  }
  warn(`unknown simulate sub-verb: ${sub}. run | profiles | show | init`);
  return 2;
}

export const commands = {
  simulate: {
    help: "run a situation profile at rising concurrency and report what the system does (0 model tokens)",
    usage: "bb simulate run [profile] --base <url> [--levels 1,8,32] [--seconds 3] | profiles | show | init <id>",
    long: [
      "  bb simulate run smoke --base http://127.0.0.1:4400",
      "  bb simulate run checkout --base http://127.0.0.1:8080 --levels 1,4,16,64 --seconds 5",
      "",
      "Latency budgets are a multiple of the floor measured in the same run, so a slower box",
      "does not turn into a performance regression. Profiles live in .bundlebox/simulate/.",
    ].join("\n"),
    run: cmd,
  },
};
