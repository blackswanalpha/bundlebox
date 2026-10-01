// run-edits.test.js — a lane is charged only for what it changed, not for the
// edits that were already in the tree when it was spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-run-edits-")));
process.env.BB_ROOT = root;
const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
git("init", "-q");
git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
w("keep.js", "a\nb\n"); w("dirty.js", "1\n"); w("gone.js", "x\n"); w("same.js", "s\n");
git("add", "-A"); git("commit", "-qm", "base");

const repo = await import("../src/git/repo.js");

test("editsSince: pre-existing edits are subtracted, the run's own are counted with lines", () => {
  w("dirty.js", "1\n2\n");            // dirty before the run
  w("scratch.txt", "old\n");          // untracked before the run
  const snap = repo.snapshot(root);
  assert.ok(snap && snap.head, "snapshot of a repo with a HEAD");
  w("keep.js", "a\nb\nc\nd\n");       // the run: modify a clean file
  w("dirty.js", "1\n2\n3\n");         // the run: edit an already-dirty file further
  w("new.js", "n1\nn2\n");            // the run: add a file
  fs.rmSync(path.join(root, "gone.js"));   // the run: delete a file
  const e = repo.editsSince(snap);
  const by = Object.fromEntries(e.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ["dirty.js", "gone.js", "keep.js", "new.js"], "scratch.txt and same.js were not touched by the run");
  assert.deepEqual([by["keep.js"].kind, by["keep.js"].add, by["keep.js"].del], ["modified", 2, 0]);
  assert.deepEqual([by["dirty.js"].kind, by["dirty.js"].add], ["modified", 1], "only the line the run added, not the one already there");
  assert.deepEqual([by["new.js"].kind, by["new.js"].add], ["added", 2]);
  assert.deepEqual([by["gone.js"].kind, by["gone.js"].del], ["deleted", 1]);
  assert.equal(e.lines_added, 5);
  assert.equal(e.committed, false);
});

test("editsSince: a commit the run made still counts, and an untouched dirty tree is zero", () => {
  const snap = repo.snapshot(root);
  assert.equal(repo.editsSince(snap).files.length, 0, "nothing done, nothing charged");
  w("same.js", "s\nt\n");
  git("add", "same.js"); git("commit", "-qm", "run commit");
  const e = repo.editsSince(snap);
  assert.deepEqual(e.files.map((f) => f.path), ["same.js"]);
  assert.equal(e.committed, true);
});

test("snapshot: outside a repository is null, and so is what it subtracts", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "bb-plain-"));
  assert.equal(repo.snapshot(plain), null);
  assert.equal(repo.editsSince(null), null);
});
