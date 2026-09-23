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
import { git, run } from "../core/exec.js";
import { readJson } from "../core/config.js";
import { BB_DIR, PKG_ROOT } from "../core/paths.js";
import { now } from "../core/util.js";

/** What is true before the gear runs. Each field is null when its source could
 *  not be read (doctrine 2): a store that does not parse is not "0 findings". */
export function context(gearName) {
  const ctx = { gear: gearName, at: now(), open_findings: null, open_high: null, dirty: null, since_min: null, units_ready: null,
    corpora: null, corpus_base: null, base_up: null, scenarios: null, world: null, services: null };
  // Read off disk, not via arc/index.js, for the reason scenarioFacts gives. An
  // npm install ships arc/src and no binary; `arc build` exits 2 there.
  ctx.arc_built = fs.existsSync(path.join(PKG_ROOT, "arc", "target", "release", process.platform === "win32" ? "arc.exe" : "arc"));
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
  const out = { corpora: null, corpus_base: null, base_up: null, scenarios: null, world: null, services: null };
  const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; } };
  const countJson = (p) => { let n = 0; const walk = (d) => { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const q = path.join(d, x.name); if (x.isDirectory()) walk(q); else if (x.name.endsWith(".json")) n++; } }; walk(p); return n; };

  const cb = path.join(BB_DIR, "cookbook");
  const corpora = dirs(cb);
  if (corpora) {
    const withPersona = corpora.filter((d) => fs.existsSync(path.join(cb, d, "persona.json")));
    out.corpora = withPersona.length;
    out.scenarios = withPersona.reduce((a, d) => a + countJson(path.join(cb, d, "scenarios")), 0);
    const base = withPersona.map((d) => (readJson(path.join(cb, d, "persona.json"), {}) || {}).base).find(Boolean);
    out.corpus_base = base ? 1 : 0;
    // Probed only when something declares a base: a workspace with no corpus
    // pays nothing here, and one with a corpus pays one connect per gear run.
    if (base) out.base_up = reachable(String(base));
  }
  const gen = dirs(path.join(BB_DIR, "genesis"));
  if (gen) out.world = gen.filter((d) => fs.existsSync(path.join(BB_DIR, "genesis", d, "world.json"))).length;
  const svc = readJson(path.join(BB_DIR, "runbook", "services.json"), null);
  if (svc) out.services = (Array.isArray(svc) ? svc : svc.services || []).length;
  return out;
}

/** 1 when something accepts a TCP connection at the base's host and port, 0
 *  when nothing does, null when the base is not a URL.
 *
 *  A declared base is not a running one. The `scenarios` gear gated on
 *  `corpus_base == 1` alone, so with the corpus pointing at a port nobody was
 *  listening on it ran anyway and wrote a board of connection errors — which
 *  reads as twenty failing scenarios, not as one absent service — and `bb
 *  doctor` reported the stage as a gap, telling the reader the corpus was
 *  never run when what happened is that there was nothing to run it against.
 *
 *  Synchronous, because every fact is read before a gear runs and the gates
 *  are evaluated without awaiting. A child node does the connect so the probe
 *  needs nothing the CLI does not already have; the cost is one process spawn,
 *  under 100ms, and only when a base is declared. */
export function reachable(base, { timeout = 1500 } = {}) {
  let u;
  try { u = new URL(String(base)); } catch { return null; }
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const script = `const s=require("node:net").connect({host:process.argv[1],port:Number(process.argv[2])});`
    + `s.setTimeout(${Math.max(100, Number(timeout) || 1500)});`
    + `s.on("connect",()=>{s.destroy();process.exit(0)});s.on("timeout",()=>{s.destroy();process.exit(1)});s.on("error",()=>process.exit(1));`;
  const r = run([process.execPath, "-e", script, u.hostname, String(port)], { timeout: (Number(timeout) || 1500) + 2000 });
  return r.rc === 0 ? 1 : 0;
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
