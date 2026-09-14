// route.test.js — lanes, checkouts, waves, ids against a temp fixture repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-route-"));
process.env.BB_ROOT = root;
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 1;\n");
fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 2;\n");
// A clean git repo when git is on the box, so the shared-checkout rule is exercised.
const g = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const hasGit = g("init", "-q").status === 0 && g("add", "-A").status === 0 && g("commit", "-q", "-m", "init").status === 0;

const router = await import("../src/route/router.js");
const { load } = await import("../src/core/config.js");
const { budget } = load();

const unit = (id, scope, est, extra = {}) => ({ id, title: id, kind: "fix", scope, est_tokens: est, model: "", status: "ready", repo: ".", priority: 5, ev: 1, ...extra });

test("uuid5 is deterministic and well-formed", () => {
  const a = router.uuid5(router.NAMESPACE, "run-1/L01");
  assert.equal(a, router.uuid5(router.NAMESPACE, "run-1/L01"));
  assert.notEqual(a, router.uuid5(router.NAMESPACE, "run-1/L02"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const p1 = router.plan([unit("u1", ["src/a.js"], 50000)], { runId: "run-x" });
  const p2 = router.plan([unit("u1", ["src/a.js"], 50000)], { runId: "run-x" });
  assert.equal(p1.lanes[0].session_id, p2.lanes[0].session_id);
});

test("two units sharing a file land in one lane, and the merge subtracts one overhead", () => {
  const p = router.plan([unit("u1", ["src/a.js"], 60000), unit("u2", ["src/a.js", "src/b.js"], 60000)], { runId: "run-share" });
  assert.equal(p.lanes.length, 1);
  assert.deepEqual(p.lanes[0].unit_ids.sort(), ["u1", "u2"]);
  assert.equal(p.lanes[0].est_tokens, 120000 - p.budget.overhead);
  assert.deepEqual(p.lanes[0].files, ["src/a.js", "src/b.js"]);
  assert.equal(p.lanes[0].id, "L01");
  assert.equal(p.lanes[0].wave, 1);
});

test("waves never share a file, and shared checkout is at most one lane per repo", () => {
  // Two lanes that cannot merge (over the ceiling together) but touch one file.
  const big = budget.max_tokens - 10000;
  const units = [unit("u1", ["src/a.js"], big), unit("u2", ["src/a.js", "src/b.js"], big), unit("u3", ["src/b.js"], big)];
  const p = router.plan(units, { runId: "run-waves", maxParallel: 4 });
  assert.equal(p.lanes.length, 3);
  for (const wave of p.waves) {
    const seen = new Set();
    for (const id of wave) for (const f of p.lanes.find((l) => l.id === id).files) { assert.ok(!seen.has(f), `${f} twice in a wave`); seen.add(f); }
  }
  assert.deepEqual(p.waves.flat().sort(), ["L01", "L02", "L03"]);
  assert.ok(p.lanes.every((l) => l.wave >= 1));
  assert.ok(p.lanes.every((l) => l.slots === 2), "a unit over 60% of the ceiling takes two slots");
  const shared = p.lanes.filter((l) => !l.worktree);
  if (hasGit) {
    assert.equal(shared.length, 1);
    assert.equal(shared[0].branch, null);
    assert.ok(shared[0].warning);
    const wt = p.lanes.filter((l) => l.worktree);
    assert.equal(wt.length, 2);
    for (const l of wt) {
      assert.ok(l.worktree.startsWith(`${root}.worktrees${path.sep}`));
      assert.ok(!fs.existsSync(l.worktree), "the router plans a worktree, never creates it");
      assert.match(l.branch, /^bb\/run-waves-l0\d$/);
    }
  } else {
    assert.equal(shared.length, 3);
    assert.ok(p.lanes.every((l) => l.warning));
  }
});

test("actuator units go to plan.local as objects and never become lanes", () => {
  const p = router.plan([unit("u1", ["src/a.js"], 40000, { actuator: "strip-markers", status: "local" }), unit("u2", ["src/b.js"], 40000)], { runId: "run-local" });
  assert.equal(p.local.length, 1);
  assert.equal(p.local[0].id, "u1");
  assert.equal(p.lanes.length, 1);
  assert.ok(router.report(p).includes("close LOCALLY"));
});
