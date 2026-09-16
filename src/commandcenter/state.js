// state.js — everything the command centre shows, assembled once.
//
// One function, because the page, the JSON endpoint and the static build must
// never disagree about what is true. Every number here is already measured
// somewhere else in the factory; this module joins them and labels each one
// MEASURED or ESTIMATE. It computes nothing new and it never adds the two.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as stages from "../pipeline/stages.js";
import * as monitor from "../monitor/index.js";
import * as bridge from "../bridge/index.js";
import * as cookbook from "../cookbook/index.js";
import * as corpus from "../cookbook/corpus.js";
import * as simulate from "../simulate/index.js";
import * as genesis from "../genesis/index.js";
import * as bench from "../bench/index.js";
import { ROOT, VAR, PKG_ROOT, rel } from "../core/paths.js";
import { readJson } from "../core/config.js";
import { now } from "../core/util.js";

const SEV = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** The measured half of "what did the factory save": the ablation bench.
 *
 *  `saved.turns` above is an ESTIMATE and is labelled one. This is not: both
 *  arms are token counts over text on disk, so the page can put a percentage on
 *  a card without the card being a claim. When no bench has been run the block
 *  says so rather than showing a zero, because a zero here reads as "it saved
 *  nothing" and the truth is "nobody measured".
 */
export function benchState() {
  const last = bench.latest();
  const runs = bench.history({ limit: 40 });
  if (!last) return { state: "never run", how: "bb bench run", runs: [], tasks: [] };
  const t = last.totals || {};
  return {
    state: "measured", suite: last.suite, at: last.at, kind: last.kind || "MEASURED", method: last.method || "",
    bare: num(t.bare), packed: num(t.packed), saved: num(t.saved), saved_pct: num(t.saved_pct),
    ratio: t.ratio ?? null, tasks_measured: num(t.measured), tasks_total: num(t.tasks),
    losses: num(t.losses), errors: num(t.errors), bare_read_cap: last.bare_read_cap,
    tasks: (last.tasks || []).map((x) => ({ id: x.id, title: x.title, bare: num(x.bare), packed: num(x.packed),
      saved: num(x.saved), saved_pct: num(x.saved_pct), error: x.error || "" })),
    runs: runs.map((r) => ({ at: r.at, bare: num(r.bare), packed: num(r.packed), saved: num(r.saved), saved_pct: num(r.saved_pct) })),
  };
}

/** Everything the page shows.
 *
 *  `write` is not a detail: the command centre serves this over HTTP and is
 *  declared read-only, so the one derived cache underneath it (session titles)
 *  must be readable without being written back. A read route that writes is
 *  still a write route. */
export function state({ sessions = 25, fold = false, write = true } = {}) {
  const findings = store.get("findings", []);
  const open = findings.filter((f) => f.status === "open");
  const units = store.get("units", []);
  const lanes = store.get("lanes", []);
  const eps = store.rows("episodes");

  const byDetector = {};
  for (const f of open) byDetector[f.detector] = (byDetector[f.detector] || 0) + 1;
  const bySeverity = {};
  for (const f of open) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const byVerb = {};
  for (const e of eps) {
    const v = e.verb || e.kind || "?";
    const b = (byVerb[v] ||= { verb: v, runs: 0, turns_saved: 0, seconds: 0, produced: 0 });
    b.runs += 1; b.turns_saved += num(e.turns_saved); b.seconds += num(e.seconds); b.produced += num(e.produced);
  }

  const boards = corpus.ids().map((id) => {
    const b = cookbook.latest(id);
    if (!b) return { corpus: id, state: "never run" };
    const t = b.totals || {};
    return { corpus: id, at: b.at, base: b.base, engine: b.engine, seconds: b.seconds, requests: b.requests,
      passed: t.passed || 0, red: (t.failed || 0) + (t.error || 0), blocked: t.blocked || 0, empty: t.empty || 0,
      scenarios: (b.scenarios || []).length,
      surfaces: [...new Set((b.scenarios || []).map((s) => s.surface))].filter(Boolean),
      worst: (b.scenarios || []).filter((s) => s.state === "failed" || s.state === "error")
        .slice(0, 5).map((s) => ({ id: s.id, surface: s.surface, severity: s.severity,
          why: (s.steps || []).find((x) => x.state === "failed" || x.state === "error")?.why?.[0] || "" })) };
  });

  const sims = (() => {
    let names = [];
    try { names = fs.readdirSync(simulate.RUNS()).filter((f) => f.endsWith(".json")).sort().slice(-6); } catch { names = []; }
    return names.map((f) => readJson(path.join(simulate.RUNS(), f), null)).filter(Boolean).map((r) => ({
      profile: r.profile, at: r.at, base: r.base, request: r.request, floor_ms: r.floor_ms, budget_ms: r.budget_ms,
      levels: (r.levels || []).map((l) => ({ concurrency: l.concurrency, rps: l.rps, p95: l.p95, error_pct: l.error_pct })),
      findings: (r.findings || []).length })).reverse();
  })();

  const calls = bridge.calls().slice(-12).reverse().map((c) => ({ id: c.id, state: c.state, reason: c.reason,
    agent: c.agent || "", problem: c.problem, est_tokens: c.est_tokens, accepted: c.accepted ?? null, at: c.drafted_at || c.at }));

  const worlds = genesis.ids().map((id) => { const w = genesis.world(id) || {}; return { id, from: w.from, counts: w.counts, unknown: (w.unknown || []).length }; });

  // One source for "what did this save", shared with `bb monitor savings`, so
  // the page and the terminal can never quote different figures. `saved` is
  // derived from it rather than recomputed for the same reason.
  const sv = monitor.savings({ limit: 4000 });
  const localSeconds = eps.reduce((a, e) => a + num(e.seconds), 0);

  return {
    at: now(), root: rel(ROOT), workspace: path.basename(ROOT),
    version: readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0",
    pipeline: stages.gaps(),
    window: monitor.snapshot({ fold }),
    sessions: monitor.sessions({ limit: sessions, write }),
    saved: {
      turns: sv.avoided.turns, tokens: sv.avoided.tokens, local_seconds: Math.round(localSeconds),
      note: "Counted from work the local verbs actually did. An ESTIMATE of cost avoided, never added to what was used.",
    },
    savings: sv,
    findings: { open: open.length, total: findings.length, by_severity: bySeverity, by_detector: byDetector,
      top: open.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0)).slice(0, 12)
        .map((f) => ({ id: f.id, severity: f.severity, detector: f.detector, title: f.title, path: f.path, kind: f.kind })) },
    units: { total: units.length, ready: units.filter((u) => u.status === "ready").length,
      by_verdict: units.reduce((a, u) => ({ ...a, [u.verdict || "?"]: (a[u.verdict || "?"] || 0) + 1 }), {}) },
    lanes: { total: lanes.length, by_status: lanes.reduce((a, l) => ({ ...a, [l.status || "?"]: (a[l.status || "?"] || 0) + 1 }), {}) },
    episodes: { total: eps.length, by_verb: Object.values(byVerb).sort((a, b) => b.turns_saved - a.turns_saved).slice(0, 14) },
    bench: benchState(),
    boards, simulations: sims, agents: calls, worlds,
  };
}
