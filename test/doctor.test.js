// doctor.test.js — src/doctor.js over a tmp workspace. PATH holds only node,
// git, python3 and which, so `gh` is absent (no network) and no agent is found;
// every row the fixture controls is asserted, the rest only for shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-doctor-")));
const root = path.join(tmp, "ws");
const bin = path.join(tmp, "bin");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
fs.mkdirSync(bin);
for (const b of ["git", "python3", "which"]) {
  const p = spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" }).stdout.trim();
  if (p) fs.symlinkSync(p, path.join(bin, b));
}
fs.symlinkSync(process.execPath, path.join(bin, "node"));
process.env.PATH = bin;
process.env.HOME = tmp;
process.env.BB_ROOT = root;
const w = (rel, s) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof s === "string" ? s : JSON.stringify(s)); };

const doctor = await import("../src/doctor.js");
const { load } = await import("../src/core/config.js");
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

test("rows: every row is {name, state, value, fix}; a bare tmp dir warns about git, gh, config and calibration", async () => {
  const rows = await doctor.rows();
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), ["name", "state", "value", "fix"], r.name);
    assert.ok(["ok", "warn", "missing"].includes(r.state), `${r.name}: ${r.state}`);
  }
  const r = byName(rows);
  assert.equal(r.node.state, "ok");
  assert.equal(r.repository.state, "warn");
  assert.match(r.repository.value, /is not a git repository/);
  assert.deepEqual([r.gh.state, r.gh.value], ["warn", "not installed"]);
  assert.deepEqual([r.agents.state, r.agents.value], ["warn", "none on PATH"]);
  assert.deepEqual([r.config.state, r.config.value, r.config.fix], ["warn", "defaults only", "bb init"]);
  assert.equal(r.calibration.state, "warn");
  assert.match(r.calibration.value, /shipped coefficients; triage rule never calibrated/);
  assert.match(r["prompt head"].value, /never fitted/);
  assert.match(r["confidence head"].value, /never fitted/);
  assert.equal(r.state.state, "ok");
  assert.match(r.state.value, /B under \.bundlebox$/);
});

test("rows: config, gates, calibration and the fitted heads are read off disk", async () => {
  w(".bundlebox/config.json", { workspace: { subrepos: ["api"] }, kernel: { gates: { quick: "node --test", full: "nosuchbin run" } } });
  fs.mkdirSync(path.join(root, "api"));
  spawnSync("git", ["init", "-q"], { cwd: path.join(root, "api") });
  w(".bundlebox/var/calibration.json", { calibrated_at: "2026-09-01", fit: { code: { samples: 40 } }, triage: { n: 14, labelled: 30, fitted: true } });
  w(".bundlebox/var/task-head.json", { useful: false, n: 9, fires: 4, edited: 1, why: "below the floor" });
  w(".bundlebox/var/confidence-head.json", { useful: true, acted_on: 20, n: 50, fitted: { score: 0.8 }, shipped: { score: 0.7 } });
  load({ fresh: true });  // config is cached per process
  const r = byName(await doctor.rows());
  assert.equal(r.repository.state, "ok");
  assert.match(r.repository.value, /is a workspace; git lives in api/);
  assert.deepEqual([r.config.state, r.config.value], ["ok", path.join(".bundlebox", "config.json")]);
  assert.deepEqual([r["gate . quick"].state, r["gate . quick"].fix], ["ok", ""]);
  assert.deepEqual([r["gate . full"].state, r["gate . full"].fix], ["warn", "nosuchbin is not on PATH"]);
  assert.equal(r.gates, undefined, "gates were configured, so no 'none detected' row");
  assert.equal(r.calibration.state, "ok");
  assert.match(r.calibration.value, /fitted 2026-09-01 \(40 samples\); triage rule fitted \(n=14 acted_on of 30 labelled\)/);
  assert.match(r["prompt head"].value, /base rate \(n=9, 1 of 4 fires led to an edit\) — the regex decides: below the floor/);
  assert.match(r["confidence head"].value, /beats PRECISION on the holdout \(n=20 acted_on of 50, score 0\.8 vs 0\.7\)/);

  w(".bundlebox/var/calibration.json", { fitted_at: "2026-08-01", triage: { n: "x" } });
  const c = byName(await doctor.rows()).calibration;
  assert.equal(c.state, "warn");
  assert.match(c.value, /triage rule with no sample size/);
  assert.equal(c.fix, "bb triage calibrate --apply");
});

test("commands.doctor: prints one line per row and never fails the process", async () => {
  const written = [];
  const log0 = console.log;
  console.log = (...s) => { written.push(s.join(" ")); };
  let rc;
  try { rc = await doctor.commands.doctor.run({ flags: {} }); } finally { console.log = log0; }
  assert.equal(rc, 0);
  assert.match(written.join("\n"), /warn {2}gh {17}not installed\n {8}fix: install gh/);
  assert.match(written.at(-1), /^\n {2}\d+ rows, \d+ need attention$/);
});
