// swebench.test.js — src/bench/swebench.js without the network: the ground
// truth read from a patch, the localisation score, the cached instance list and
// the report. The run itself needs git clones and is not exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-swebench-")));
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;

const swe = await import("../src/bench/swebench.js");

test("goldFiles: the b-side of every diff header, once each", () => {
  const patch = [
    "diff --git a/src/a.py b/src/a.py", "--- a/src/a.py", "+++ b/src/a.py", "@@ -1 +1 @@",
    "diff --git a/old.py b/new.py", "rename from old.py",
    "diff --git a/src/a.py b/src/a.py", " text mentioning diff --git a/x b/y is not a header",
  ].join("\n");
  assert.deepEqual(swe.goldFiles(patch), ["src/a.py", "new.py"]);
  assert.deepEqual(swe.goldFiles(""), []);
  assert.deepEqual(swe.goldFiles(null), []);
});

test("score: recall over gold, precision over found, and the files it missed", () => {
  assert.deepEqual(swe.score(["a", "b", "c", "d"], ["a", "z"]), { gold: 2, found: 4, hit: 1, recall: 50, precision: 25, missed: ["z"] });
  assert.deepEqual(swe.score([], ["a"]), { gold: 1, found: 0, hit: 0, recall: 0, precision: 0, missed: ["a"] });
  assert.equal(swe.score(["a"], []).recall, 0, "no gold is 0, not NaN");
  assert.equal(swe.score(["a", "b", "c"], ["a", "b", "c"]).precision, 100);
});

test("fetchInstances: a cache that holds the range is served without the network", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ instance_id: `org__repo-${i}`, repo: i % 2 ? "psf/requests" : "django/django",
    base_commit: "abc", problem_statement: "p", difficulty: "", gold_files: ["x.py"], test_files: [] }));
  fs.mkdirSync(swe.DIR(), { recursive: true });
  fs.writeFileSync(swe.INSTANCES(), JSON.stringify({ dataset: swe.DATASET, rows }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network touched"); };
  try {
    const got = await swe.fetchInstances({ limit: 100 });
    assert.equal(got.rows.length, 100);
    const r = await swe.run({ n: 2, repos: "nobody/none", write: false, log: () => {} });
    assert.equal(r.rc, 2);
    assert.match(r.why, /no instance matched \(offset 0, repos "nobody\/none"\)/);
  } finally { globalThis.fetch = realFetch; }
});

test("report: totals, the space line and the reproduce command", () => {
  const ok = { id: "psf__requests-1", difficulty: "<15 min fix", bare: 20000, packed: 5000, saved_pct: 75,
    localisation: { hit: 1, gold: 1 }, named_localisation: { hit: 1, gold: 1 }, bare_localisation: { hit: 0, gold: 1 } };
  const bad = { id: "django__django-2", difficulty: "", error: "clone django/django: fatal" };
  const r = { benchmark: "SWE-bench Verified", seconds: 1.5, measures: "M", not_measured: "N", bare_read_cap: 10,
    reproduce: "bb bench swebench run --n 2", instance_ids: [ok.id, bad.id], instances: [ok, bad],
    totals: { measured: 1, errors: 1, hit: 1, gold: 1, recall: 100, named_hit: 1, named_recall: 100, bare_hit: 0, bare_recall: 0,
      all: 1, named_all: 1, packed: 5000, bare: 20000, saved_pct: 75, ratio: 4, space_built: 0 } };
  const s = swe.report(r);
  assert.match(s, /SWE-bench Verified — 1 instance\(s\) in 1\.5s/);
  assert.match(s, /in scope \(budgeted to be read\): {2}1 of 1 gold file\(s\) — 100%/);
  assert.match(s, /75% less, 4x/);
  assert.match(s, /symbol space built in 0 of 1 target\(s\) before ranking — this run is the baseline arm/);
  assert.match(s, /1 instance\(s\) could not be measured/);
  assert.match(s, /clone django\/django: fat/);
  assert.match(s, /Reproduce: {4}bb bench swebench run --n 2/);
  assert.match(s, /Instances: {4}psf__requests-1 django__django-2/);
  r.totals.space_built = 1; r.totals.measured = 2;
  assert.match(swe.report(r), /a mixed run, not comparable to either arm/);
});
