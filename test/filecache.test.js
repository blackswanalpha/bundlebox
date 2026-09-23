// filecache.test.js — a value derived from a file's bytes is served back only
// while those bytes are unchanged, survives a process, and a full walk prunes
// the entries of files that are gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-filecache-")));
process.env.BB_ROOT = root;

test("filecache: same sha serves the stored value, a new sha recomputes", async () => {
  const fc = await import("../src/core/filecache.js");
  fc.reset();
  let calls = 0;
  const compute = (v) => () => { calls++; return v; };
  assert.equal(fc.derived("a.js", "s1", "k", compute(1)), 1);
  assert.equal(fc.derived("a.js", "s1", "k", compute(2)), 1);
  assert.equal(calls, 1);
  assert.equal(fc.derived("a.js", "s2", "k", compute(3)), 3);
  assert.equal(fc.derived("a.js", "s2", "other", compute(4)), 4);
  assert.equal(calls, 3);
});

test("filecache: flush persists across a reset, and a full walk prunes gone files", async () => {
  const fc = await import("../src/core/filecache.js");
  fc.reset();
  fc.derived("keep.js", "s", "k", () => "kept");
  fc.derived("gone.js", "s", "k", () => "stale");
  fc.flush();
  fc.reset();
  let calls = 0;
  assert.equal(fc.derived("keep.js", "s", "k", () => { calls++; return "recomputed"; }), "kept");
  assert.equal(calls, 0);
  fc.flush(new Set(["keep.js"]));
  fc.reset();
  // gone.js was touched in neither the walk nor the run, so it was pruned.
  assert.equal(fc.derived("gone.js", "s", "k", () => "fresh"), "fresh");
});

test("filecache: an entry written under another version is ignored", async () => {
  const fc = await import("../src/core/filecache.js");
  const { VAR } = await import("../src/core/paths.js");
  fs.mkdirSync(VAR, { recursive: true });
  fs.writeFileSync(path.join(VAR, "filecache.json"), JSON.stringify({ version: "0:old", files: { "a.js": { sha: "s", v: { k: "old" } } } }));
  fc.reset();
  assert.equal(fc.derived("a.js", "s", "k", () => "new"), "new");
});
