// bench.test.js — the ablation benchmark against a fixture tree.
//
// The properties worth pinning are not the percentage (that is a property of
// the tree) but the three that make the percentage mean anything: both arms are
// measured over real text, the run is deterministic, and a task where packing
// costs more is reported rather than dropped.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-bench-")));
process.env.BB_ROOT = root;

const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const mod = (i) => `// mod${i}.js — the reconciler for ledger ${i}.\n` +
  Array.from({ length: 30 }, (_, k) => `export function reconcileLedger${i}_${k}(entry) {\n  if (!entry.id) throw new Error("reconcileLedger: no id");\n  return { ...entry, pass: ${k} };\n}\n`).join("\n");

before(() => {
  w("package.json", JSON.stringify({ name: "bench-fixture", type: "module", scripts: { test: "node --test" } }, null, 2));
  for (let i = 0; i < 14; i++) w(`src/mod${i}.js`, mod(i));
  fs.mkdirSync(path.join(root, ".bundlebox"), { recursive: true });
});

test("a suite on disk is what runs, and every task reports both arms", async () => {
  const suite = await import("../src/bench/suite.js");
  const bench = await import("../src/bench/index.js");
  suite.write("t", { title: "fixture", tasks: [
    { id: "a", title: "reconcile throws with no id", problem: "reconcileLedger throws no id instead of refusing the entry" },
    { id: "b", title: "the ledger pass counter", problem: "reconcileLedger pass counter is wrong on the second entry" },
  ] });
  const r = await bench.run("t", { write: false });
  assert.equal(r.rc, 0);
  assert.equal(r.tasks.length, 2);
  for (const t of r.tasks) {
    assert.ok(t.bare > 0, `${t.id}: bare arm measured nothing`);
    assert.ok(t.packed > 0, `${t.id}: packed arm measured nothing`);
    assert.equal(t.saved, t.bare - t.packed);
  }
  assert.equal(r.totals.bare, r.tasks.reduce((a, t) => a + t.bare, 0));
  assert.equal(r.kind, "MEASURED");
});

test("the same tree twice gives the same number — a bench that drifts is not a measurement", async () => {
  const bench = await import("../src/bench/index.js");
  const a = await bench.run("t", { write: false });
  const b = await bench.run("t", { write: false });
  assert.equal(a.totals.bare, b.totals.bare);
  assert.equal(a.totals.packed, b.totals.packed);
});

test("a smaller read budget makes the bare arm smaller and leaves the packed arm alone", async () => {
  const bench = await import("../src/bench/index.js");
  const wide = await bench.run("t", { write: false, cap: 12 });
  const tight = await bench.run("t", { write: false, cap: 2 });
  assert.ok(tight.totals.bare < wide.totals.bare, "a tighter cap should read less");
  assert.equal(tight.totals.packed, wide.totals.packed, "the packed arm must not depend on the bare arm's budget");
});

test("losses are counted, not dropped", async () => {
  const suite = await import("../src/bench/suite.js");
  const bench = await import("../src/bench/index.js");
  // A problem whose words appear nowhere: the search returns nothing, the bare
  // arm is the statement alone, and the prompt costs more than it saves.
  suite.write("loss", { title: "a task the search cannot place", tasks: [
    { id: "nowhere", title: "zzqqx", problem: "zzqqx wrrbbl" },
  ] });
  const r = await bench.run("loss", { write: false });
  assert.equal(r.tasks.length, 1);
  assert.equal(r.totals.losses, 1, "a task that cost more packed than bare must be counted");
  assert.ok(r.tasks[0].saved <= 0);
});

test("a suite with no tasks refuses instead of reporting a green zero", async () => {
  const suite = await import("../src/bench/suite.js");
  const bench = await import("../src/bench/index.js");
  suite.write("empty", { title: "nothing", tasks: [] });
  const r = await bench.run("empty", { write: false });
  assert.equal(r.rc, 2);
  assert.match(r.why, /no task/);
});
