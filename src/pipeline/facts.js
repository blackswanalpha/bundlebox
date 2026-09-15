// pipeline/facts.js — what is true before a gear runs.
//
// Every gate in a gear reads this and none of them re-measures it, so the whole
// run sees one consistent picture of the workspace. The rule that makes it safe
// to gate on: a fact whose source could not be read is NULL, never 0. A store
// that does not parse is not "no findings", and a gate over null RUNS the
// stage rather than skipping it (spec.js).
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import { git } from "../core/exec.js";
import { readJson } from "../core/config.js";
import { BB_DIR } from "../core/paths.js";
import { now } from "../core/util.js";

/** What is true before the gear runs. Each field is null when its source could
 *  not be read (doctrine 2): a store that does not parse is not "0 findings". */
export function context(gearName) {
  const ctx = { gear: gearName, at: now(), open_findings: null, open_high: null, dirty: null, since_min: null, units_ready: null,
    corpora: null, corpus_base: null, scenarios: null, world: null, services: null };
  Object.assign(ctx, storeFacts());
  Object.assign(ctx, scenarioFacts());
  const st = git(["status", "--porcelain"]);
  if (st.rc === 0) ctx.dirty = st.out.split("\n").filter((l) => l.trim()).length;
  const last = store.rows("gear_runs").filter((r) => r.gear === gearName).pop();
  if (last) {
    const t = Date.parse(last.at || last.ts || "");
    if (Number.isFinite(t)) ctx.since_min = Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  return ctx;
}

/** What the scenario half of the pipeline can act on, read straight off disk.
 *  Deliberately not by importing those modules: the context is built before a
 *  gear runs, and a partial install where one feature module does not import
 *  must still be able to gate on the others. Each stays null when its source
 *  could not be read, so a gate over it evaluates to NULL and the runner RUNS
 *  the stage — a gate that cannot be evaluated is not a reason to skip.
 */
export function scenarioFacts() {
  const out = { corpora: null, corpus_base: null, scenarios: null, world: null, services: null };
  const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; } };
  const countJson = (p) => { let n = 0; const walk = (d) => { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const q = path.join(d, x.name); if (x.isDirectory()) walk(q); else if (x.name.endsWith(".json")) n++; } }; walk(p); return n; };

  const cb = path.join(BB_DIR, "cookbook");
  const corpora = dirs(cb);
  if (corpora) {
    const withPersona = corpora.filter((d) => fs.existsSync(path.join(cb, d, "persona.json")));
    out.corpora = withPersona.length;
    out.scenarios = withPersona.reduce((a, d) => a + countJson(path.join(cb, d, "scenarios")), 0);
    out.corpus_base = withPersona.some((d) => (readJson(path.join(cb, d, "persona.json"), {}) || {}).base) ? 1 : 0;
  }
  const gen = dirs(path.join(BB_DIR, "genesis"));
  if (gen) out.world = gen.filter((d) => fs.existsSync(path.join(BB_DIR, "genesis", d, "world.json"))).length;
  const svc = readJson(path.join(BB_DIR, "runbook", "services.json"), null);
  if (svc) out.services = (Array.isArray(svc) ? svc : svc.services || []).length;
  return out;
}

export function storeFacts() {
  const f = store.get("findings", null);
  const u = store.get("units", null);
  const open = Array.isArray(f) ? f.filter((x) => x && x.status === "open") : null;
  return {
    open_findings: open ? open.length : null,
    open_high: open ? open.filter((x) => x.severity === "high" || x.severity === "critical").length : null,
    units_ready: Array.isArray(u) ? u.filter((x) => x && x.status === "ready").length : null,
  };
}

/** Pre-run facts only. `inputs` is the declared input count, not what ran. */
export function features(st, ctx, inputCount) {
  return { inputs: inputCount, open_findings: ctx.open_findings, dirty: ctx.dirty, since_min: ctx.since_min, optional: st.optional ? 1 : 0 };
}
