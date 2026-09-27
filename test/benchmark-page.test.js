// benchmark-page.test.js — scripts/benchmark-page.mjs builds the page from the
// runs on disk and measures nothing itself. The script resolves its root from
// its own location, so it runs from a copy in a tmp tree whose `src` links back
// here: the repository's own docs and bench files are never read or written.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts/benchmark-page.mjs");

function tree() {
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-benchpage-")));
  fs.mkdirSync(path.join(t, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(t, "scripts", "benchmark-page.mjs"));
  fs.symlinkSync(path.join(REPO, "src"), path.join(t, "src"), "dir");
  fs.mkdirSync(path.join(t, ".bundlebox", "var"), { recursive: true });
  fs.mkdirSync(path.join(t, "docs", "benchmark"), { recursive: true });
  return t;
}
const put = (t, rel, obj) => { const p = path.join(t, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); };
const run = (t, env = {}) => spawnSync(process.execPath, [path.join(t, "scripts", "benchmark-page.mjs")],
  { cwd: t, encoding: "utf8", env: { ...process.env, BB_ROOT: t, BB_SWEBENCH_RUN: "", ...env } });

const loc = (hit, gold) => ({ gold, found: 5, hit, recall: gold ? (hit / gold) * 100 : 0, precision: 20, missed: [] });
const inst = (i, over = {}) => ({ id: `psf__requests-${i}`, repo: "psf/requests", difficulty: "<15 min fix", gold_files: ["requests/models.py"],
  base_commit: "abc", bare: 40000 + i * 1000, packed: 8000 + i * 100, saved: 32000, saved_pct: 80,
  localisation: loc(1, 1), named_localisation: loc(1, 1), bare_localisation: loc(i % 2, 1), seconds: 1,
  bare_ms: 900, packed_ms: 300, space: { built: true, rows: 50, ms: 120 }, ...over });
function swe() {
  const instances = [inst(1), inst(2), inst(3), { id: "django__django-9", repo: "django/django", difficulty: "", error: "clone django/django: <fatal>" }];
  const ok = instances.filter((x) => !x.error);
  const sum = (k) => ok.reduce((s, x) => s + x[k], 0);
  return { benchmark: "SWE-bench Verified", dataset: "princeton-nlp/SWE-bench_Verified", at: "2026-09-20T00:00:00Z", seconds: 12,
    measures: "file-level localisation.", localisation_note: "note", method: "clone with `git clone` & <b>blobless</b>",
    not_measured: "resolve rate", bare_read_cap: 10, max_files: 12, offset: 0, repos: "(any)", reproduce: "bb bench swebench run --n 4",
    instance_ids: instances.map((x) => x.id), instances,
    totals: { instances: 4, measured: 3, errors: 1, bare: sum("bare"), packed: sum("packed"), gold: 3, hit: 3, bare_hit: 1, named_hit: 3,
      named_all: 3, any: 3, all: 3, space_built: 3, bare_ms: 2700, packed_ms: 900, saved: sum("bare") - sum("packed"),
      saved_pct: 80, recall: 100, bare_recall: 33.3, named_recall: 100, ratio: 5 } };
}
function local() {
  const tasks = [1, 2].map((i) => ({ id: `t${i}`, title: `task ${i}`, bare: 20000, packed: 5000, saved: 15000, saved_pct: 75, bare_ms: 400, packed_ms: 100 }));
  return { suite: "default", at: "2026-09-20T00:00:00Z", tasks, totals: { tasks: 2, measured: 2, bare: 40000, packed: 10000, saved: 30000, saved_pct: 75, losses: 0 } };
}

test("benchmark-page: refuses with exit 2 when either run is missing, and writes nothing", () => {
  const t = tree();
  const r = run(t);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no bench run on disk/);
  assert.equal(fs.existsSync(path.join(t, "docs", "benchmark", "index.html")), false);
  put(t, ".bundlebox/bench/swebench/latest.json", swe());
  assert.equal(run(t).status, 2, "one run of two is still a refusal");
});

test("benchmark-page: draws the page from the two runs and escapes the prose it quotes", () => {
  const t = tree();
  put(t, ".bundlebox/bench/swebench/latest.json", swe());
  put(t, ".bundlebox/out/bench/latest.json", local());
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(t, "docs", "benchmark", "index.html"), "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<svg class="chart"/);
  assert.match(html, /psf__requests-1/);
  assert.match(html, /clone with <code>git clone<\/code> &amp; &lt;b&gt;blobless&lt;\/b&gt;/, "the run's prose is escaped, its backticks become code");
});

test("benchmark-page: BB_SWEBENCH_RUN pins the SWE-bench run the page is built from", () => {
  const t = tree();
  put(t, ".bundlebox/out/bench/latest.json", local());
  put(t, "pinned.json", swe());
  assert.equal(run(t).status, 2, "no latest.json and no pin");
  assert.equal(run(t, { BB_SWEBENCH_RUN: "pinned.json" }).status, 0);
});
