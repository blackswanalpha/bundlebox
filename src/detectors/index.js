// detectors/index.js — the registry, the runner and triage.
//
// runAll walks the tree ONCE and hands every detector the same ctx; a detector
// that throws becomes a row in `ran`, never a crash, because a scan that dies
// on the fourteenth detector loses the thirteen that ran. triage decides what
// a finding becomes: it is the layer that spends tokens, so its rules are data
// (WEIGHT, PRECISION, JUDGEMENT) and its derivation is returned, not hidden.
import fs from "node:fs";
import { load } from "../core/config.js";
import { git } from "../core/exec.js";
import { readText, walk } from "../core/fs.js";
import { out, warn, emit } from "../core/log.js";
import { ROOT, abs } from "../core/paths.js";
import { human, sha1 } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { PLAN_ONLY } from "../actuators/_plan.js";

import docLinks from "./doc-links.js";
import todoCensus from "./todo-census.js";
import secretScan from "./secret-scan.js";
import bigFile from "./big-file.js";
import mergeMarkers from "./merge-markers.js";
import worktreeHygiene from "./worktree-hygiene.js";
import deadExports from "./dead-exports.js";
import duplicateBlocks from "./duplicate-blocks.js";
import godFile from "./god-file.js";
import orphanFiles from "./orphan-files.js";
import deadDeps from "./dead-deps.js";
import docDrift from "./doc-drift.js";
import lockfileDrift from "./lockfile-drift.js";
import staleEvidence from "./stale-evidence.js";
import missingTests from "./missing-tests.js";
import debugLeftovers from "./debug-leftovers.js";
import uiGeneric from "./ui-generic.js";
import antiSlop from "./anti-slop.js";
import swallowedErrors from "./swallowed-errors.js";
import deadConfig from "./dead-config.js";
import silentFallback from "./silent-fallback.js";
import quietDegrade from "./quiet-degrade.js";
import faultMask from "./fault-mask.js";

export const REGISTRY = Object.fromEntries([docLinks, todoCensus, secretScan, bigFile, mergeMarkers,
  worktreeHygiene, deadExports, duplicateBlocks, godFile, orphanFiles, deadDeps, docDrift, lockfileDrift,
  staleEvidence, missingTests, debugLeftovers, uiGeneric, antiSlop, swallowedErrors, deadConfig,
  silentFallback, quietDegrade, faultMask].map((d) => [d.name, d]));

export const SEVERITY = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
// Exponential, not linear: a critical was never traded against four lows.
export const WEIGHT = { info: 0.5, low: 1, medium: 2, high: 5, critical: 16 };
// What a detector's METHOD can support. A set difference is not a threshold.
export const PRECISION = { exact: 0.95, probe: 0.8, heuristic: 0.6 };
// Surveys. Their fix is a decision about the product, not an edit; a factory
// that files work against them generates arguments. Never promoted, whatever
// the severity: the original let `critical-always` outrank this set and a
// worktree with 21 dirty files became an opus lane opened inside that tree.
export const JUDGEMENT = new Set(["todo-census", "big-file", "worktree-hygiene", "stale-evidence", "lockfile-drift"]);
// A named list plus a named table is an edit, not a judgement: cheap tier.
const MECHANICAL = new Set(["doc-links", "doc-drift", "dead-deps", "merge-markers", "debug-leftovers", "dead-config"]);

/** The ctx every detector reads. Exported so an actuator can re-count with the
 *  same walker and the same caches the scan used. */
export function makeCtx({ files, cfg } = {}) {
  return { root: ROOT, cfg: cfg || load(), files: files || walk(ROOT), readText, git: (args) => git(args, ROOT) };
}

export function runAll({ only, files } = {}) {
  const cfg = load();
  const ctx = makeCtx({ files, cfg });
  const registered = Object.keys(REGISTRY);
  let names;
  if (only && only.length) names = only;
  else {
    const enabled = cfg.detectors?.enabled;
    names = Array.isArray(enabled) && enabled.length ? enabled : registered;
    for (const r of registered) if (!names.includes(r)) warn(`detector ${r} is registered but disabled in config`);
  }
  const findings = [], ran = [];
  for (const name of names) {
    const det = REGISTRY[name];
    if (!det) { ran.push({ name, ms: 0, count: 0, error: "no such detector" }); continue; }
    const t0 = Date.now();
    let got;
    try { got = det.run(ctx) || []; } catch (e) {
      ran.push({ name, ms: Date.now() - t0, count: 0, error: String(e?.message || e) });
      continue;
    }
    for (const raw of got) findings.push(normalise(raw, det));
    ran.push({ name, ms: Date.now() - t0, count: got.length, error: null });
  }
  return { findings, ran };
}

function normalise(f, det) {
  const files = Array.isArray(f.files) ? f.files : [];
  const path = f.path ?? files[0] ?? ".";
  const evidence = { ...(f.evidence || {}) };
  // The primary file's content hash at scan time is what lets stale-evidence
  // say "this finding was computed against bytes that no longer exist".
  const a = abs(path);
  let isFile = false;
  try { isFile = fs.statSync(a).isFile(); } catch { /* not a file: a dir or "." */ }
  if (isFile) evidence.sha = sha1(readText(a));
  return {
    ...f, detector: det.name, files, path,
    severity: f.severity || det.severity || "low",
    precision: f.precision || det.precision || "heuristic",
    kind: f.kind || "fix",
    key: f.key ?? path,
    evidence,
    fix_hint: f.fix_hint || "",
    auto_fix: f.auto_fix ?? null,
    detail: String(f.detail || "").slice(0, 1500),
    est_tokens: estimate.files(files).total,
    status: "open",
  };
}

// ── triage ──────────────────────────────────────────────────────────────────

/** Below this expected value a promotion is not worth a lane. Derived from the
 *  configured severity floor at a typical 200k unit cost, so the two knobs
 *  cannot disagree. */
export function evFloor(cfg) {
  const sev = cfg?.detectors?.promote_at || "medium";
  return Math.round(WEIGHT[sev] * 0.6 * 100000 / 200000 * 100) / 100;
}

/** Expected severity-points per 100k tokens: a promotion is a bet of
 *  est_tokens for a `conf` chance of removing `n` findings worth WEIGHT each. */
export function expectedValue(f) {
  const conf = PRECISION[f.precision] ?? PRECISION[REGISTRY[f.detector]?.precision] ?? PRECISION.heuristic;
  const n = Number.isFinite(f.evidence?.count) && f.evidence.count > 0 ? f.evidence.count : 1;
  const cost = Math.max(Number(f.est_tokens) || 0, 1000);
  return { conf, n, cost, ev: Math.round(conf * (WEIGHT[f.severity] ?? 1) * n * 100000 / cost * 100) / 100 };
}

export function triage(f, cfg = load()) {
  const steps = [];
  const sev = f.severity || "low";
  const { conf, n, cost, ev } = expectedValue(f);
  const floorName = cfg?.detectors?.promote_at || "medium";
  const floor = evFloor(cfg);
  const out = { promote: false, reason: "", model: null, kind: f.kind || "fix", priority: null, ev, confidence: conf, ev_floor: floor, steps };
  steps.push(`confidence ${conf} (${f.precision || "heuristic"} method); ev = ${conf} × ${WEIGHT[sev] ?? 1} × ${n} × 100k / ${human(cost)} = ${ev}`);
  if (sev === "info") { out.reason = "info severity never becomes work on its own"; steps.push("noise-floor: declined"); return out; }
  if (JUDGEMENT.has(f.detector)) { out.reason = `${f.detector} is a report, not a task`; steps.push("judgement-call: declined (critical does not override this)"); return out; }
  if (sev === "critical") {
    Object.assign(out, { promote: true, reason: "critical outranks the budget", model: "opus", kind: "fix", priority: 0 });
    steps.push("critical-always: promoted, opus, priority 0");
    return finish(out, f, steps);
  }
  if ((SEVERITY[sev] ?? 0) < (SEVERITY[floorName] ?? 2)) {
    out.reason = `${sev} is below promote_at=${floorName}`; steps.push(`severity floor: declined`); return out;
  }
  steps.push(`severity floor: ${sev} >= ${floorName}`);
  if (ev < floor) {
    out.reason = `expected value ${ev} below floor ${floor} (${f.precision} rule, ${sev}, ${human(cost)} tokens)`;
    steps.push("expected-value: declined"); return out;
  }
  steps.push(`expected-value: ${ev} >= ${floor}`);
  out.promote = true; out.reason = "at or above promote_at and worth the tokens";
  if (MECHANICAL.has(f.detector) && (f.files || []).length <= 4) { Object.assign(out, { model: "sonnet", kind: "fix", priority: 2 }); steps.push("mechanical: sonnet, priority 2"); }
  else { Object.assign(out, { model: "sonnet", priority: 3 }); steps.push("default-model: sonnet, priority 3"); }
  return finish(out, f, steps);
}
function finish(out, f, steps) {
  if (!f.auto_fix) return out;
  // A plan derives what the decision needs and decides nothing, so it changes
  // what the session READS and not whether the session happens. Pricing it at
  // zero would file a god file as free because its split seam is computable.
  if (PLAN_ONLY.has(f.auto_fix)) {
    out.plan = f.auto_fix;
    steps.push(`plan ${f.auto_fix}: derived at 0 tokens, the decision on top of it still costs a lane`);
    return out;
  }
  out.priority = 0;
  out.actuator = f.auto_fix;
  steps.push(`actuator ${f.auto_fix}: priority 0, zero model tokens`);
  return out;
}

/** The derivation as text, for `bb explain`. */
export function explain(f, cfg = load()) {
  const t = triage(f, cfg);
  const lines = [`triage: ${t.promote ? "PROMOTE" : "hold"} — ${t.reason}`];
  for (const s of t.steps) lines.push(`  ${s}`);
  if (t.promote) lines.push(`  model ${t.model}, kind ${t.kind}, priority ${t.priority}`);
  return lines.join("\n");
}

// ── bb triage ───────────────────────────────────────────────────────────────
//
// Two verbs over one idea: a closed finding says whether promoting it would
// have been right, so the promotion rule is a policy with a recorded outcome.
//
//   backfill    label the closures git can still prove
//   calibrate   hill-climb the policy over the labelled ones
//
// Both cost a read and some arithmetic. `backfill` shells out to git, once per
// finding, and that is the only reason it is a verb somebody runs rather than
// something a scan does on its own.
export const commands = {
  triage: {
    help: "label what closed findings cost, and fit the promotion rule to them (0 model tokens)",
    usage: "bb triage [backfill|calibrate] [--apply] [--json]",
    examples: [
      "  bb triage backfill               label the closures git can still prove",
      "  bb triage calibrate              what promote_at and the EV floor should be",
    ],
    async run({ _, flags }) {
      const store = await import("../core/store.js");
      const expert = await import("../core/expert.js");
      const sub = _[0] || "calibrate";

      if (sub === "backfill") {
        const c = store.backfillClosures();
        if (flags.json) { emit(c); return 0; }
        out(`  ${c.acted_on} acted on, ${c.vanished} vanished, ${c.unchanged} unchanged — ${c.already} already labelled`);
        out(`  ${c.left_unknown} left unknown: git sees commits and this workspace edits for hours before it makes one.`);
        return 0;
      }
      if (sub !== "calibrate") { warn(`unknown triage sub-verb: ${sub}. backfill | calibrate`); return 2; }

      const cfg = load();
      const r = expert.call("triage-calibrate", {
        findings: store.get("findings", []), cfg,
        ...(flags.cost ? { cost_penalty: Number(flags.cost) } : {}),
      });
      if (!r) { warn(`python3 is required to fit the promotion rule (${expert.lastError}). bb doctor`); return 2; }
      if (flags.json) { emit(r); return r.ok ? 0 : 1; }
      const shape = (p) => `promote_at ${p.promote_at} / ev_mult ${p.ev_mult}`;
      if (!r.ok) {
        out(`  not calibrated: ${r.why}`);
        out(`  running on the shipped rule: ${shape(r.policy)}`);
        out(`  \`bb triage backfill\` labels what git can still prove.`);
        return 1;
      }
      out(`  ${r.basis}`, "");
      for (const [name, k] of [["shipped", "before"], ["fitted", "after"]]) {
        const x = r[k];
        out(`  ${name.padEnd(8)} ${shape(name === "shipped" ? r.shipped : r.policy).padEnd(34)} promoted ${x.promoted}, caught ${x.caught} of ${x.acted_on}, recall ${x.recall}, waste ${x.waste_share}  score ${k === "before" ? r.score_before : r.score_after}`);
      }
      if (!r.changed) { out(`\n  the shipped rule already wins over ${r.explored} policy(s) explored; nothing to apply`); return 0; }
      if (flags.apply) {
        const p = store.applyTriagePolicy(r.policy, { acted_on: r.acted_on, score_before: r.score_before, score_after: r.score_after });
        out(`\n  written to ${p}`);
        return 0;
      }
      out(`\n  ${r.explored} policy(s) explored in ${r.steps} step(s). \`bb triage calibrate --apply\` keeps it.`);
      return 0;
    },
  },
};
