// foreman.test.js — the agent supervisor end to end on the evidence path: a
// change asks for verification, a pass on the current tree finishes, a stale or
// failing run does not, and replay counts what a threshold change moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-foreman-")));
process.env.BB_ROOT = root;
delete process.env.TYPESAFE_API_KEY;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const sh = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
w(".bundlebox/config.json", JSON.stringify({ wire: { auto_init: false } }));
w(".gitignore", ".bundlebox/\n");
w("src/a.js", "export const a = 1;\n");
sh("init", "-q"); sh("add", "."); sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

const gs = await import("../src/grapple/store.js");
const foreman = await import("../src/foreman/index.js");
const expert = await import("../src/core/expert.js");
const has = expert.available();

const S = "sess-1";
for (let i = 0; i < 3; i++) gs.record("tool", { session_id: S, tool: "Edit", file: "src/a.js", edit: true, hash: `e${i}` });

test("history folds the timeline into the policy's state", () => {
  const rows = [{ kind: "assess", action: "steer", turns: 4 }, { kind: "assess", action: "stop" }, { kind: "assess", action: "resume" }, { kind: "verify" }];
  assert.deepEqual(foreman.history(rows, 10), { iteration: 3, steers: 1, retries: 1, previous: "resume", turns_since_steer: 6 });
});

test("override pairs: a check key is a bar, anything else a setting", () => {
  const c = foreman.overrides({ thresholds: { x__y: 0.1 } }, ["core.worker-health__worker_stuck=0.6", "max_steers=3", "junk", "bad=nope"]);
  assert.deepEqual(c, { thresholds: { x__y: 0.1, "core.worker-health__worker_stuck": 0.6 }, max_steers: 3 });
});

test("a change is verified before it finishes, and only a current pass counts", { skip: !has && "python3 not found" }, () => {
  w("src/a.js", "export const a = 2;\n");
  w("test/a.test.js", "// covers a\n");
  const first = foreman.assess({ session: S, job: "bump a" });
  assert.equal(first.action, "verify", first.reason);
  assert.equal(first.via, "evidence");

  const bad = foreman.verify({ command: "node -e \"process.exit(3)\"", session: S });
  assert.equal(bad.ok, false);
  assert.equal(foreman.assess({ session: S }).action, "resume", "a failing run is not finished");

  const good = foreman.verify({ command: "node -e \"process.exit(0)\"", session: S });
  assert.equal(good.ok, true);
  const done = foreman.assess({ session: S });
  assert.equal(done.action, "finish", done.reason);
  assert.equal(done.job, "bump a", "the job carries over from the run's first assessment");

  w("src/a.js", "export const a = 3;\n");
  assert.equal(foreman.assess({ session: S }).action, "verify", "the tree moved, the pass is stale");
});

test("replay re-decides the recorded timeline under a new bar", { skip: !has && "python3 not found" }, () => {
  const rows = foreman.replayRows(S);
  assert.ok(rows.length >= 4);
  const same = expert.call("foreman", { op: "replay", rows, cfg: {} });
  assert.equal(same.agree, rows.length, "the recorded bars reproduce every recorded action");
  const strict = expert.call("foreman", { op: "replay", rows, cfg: foreman.overrides({}, ["core.verification__tests_sufficient=0.95"]) });
  assert.ok(strict.changed.some((c) => c.was === "finish" && c.now === "resume"), JSON.stringify(strict.changed));
});

test("the post-tool watcher steers a looping session only in the steer phase, and only every N calls", { skip: !has && "python3 not found" }, async () => {
  const hooks = await import("../src/wire/hooks.js");
  const L = "sess-loop";
  for (let i = 0; i < 14; i++) gs.record("tool", { session_id: L, tool: "Read", file: "src/a.js", hash: "same" });
  const capture = async (fn) => {
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = (s) => { buf += s; return true; };
    try { return { r: await fn(), out: buf }; } finally { process.stdout.write = orig; }
  };
  const { load } = await import("../src/core/config.js");
  const cfg = async (f) => ({ ...load(), foreman: { ...foreman.settings(), ...f } });

  const obs = await capture(async () => hooks.foremanWatch({ session_id: L }, await cfg({ hook: "observe", hook_every: 1 })));
  assert.equal(obs.r.action, "steer");
  assert.equal(obs.out, "", "observe injects nothing");
  assert.equal(foreman.timeline({ run: L }).at(-1).hook, "observe");

  const skipped = await capture(async () => hooks.foremanWatch({ session_id: L }, await cfg({ hook: "steer", hook_every: 5 })));
  assert.equal(skipped.r, null, "not due: one call since the last assessment");

  const live = await capture(async () => hooks.foremanWatch({ session_id: "sess-loop-2" }, await cfg({ hook: "steer", hook_every: 1 })));
  assert.equal(live.r.action, "continue", "a session with no turns yet is not stuck");
  assert.equal(live.out, "");
  for (let i = 0; i < 14; i++) gs.record("tool", { session_id: "sess-loop-3", tool: "Read", file: "src/a.js", hash: "same" });
  const steer = await capture(async () => hooks.foremanWatch({ session_id: "sess-loop-3" }, await cfg({ hook: "steer", hook_every: 1 })));
  const emitted = JSON.parse(steer.out);
  assert.equal(emitted.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(emitted.hookSpecificOutput.additionalContext, /^bundlebox foreman STEER: the agent is stuck/);
  const stop = await capture(async () => hooks.foremanWatch({ session_id: "sess-loop-3" }, await cfg({ hook: "steer", hook_every: 1, steer_grace_turns: 0 })));
  assert.match(JSON.parse(stop.out).hookSpecificOutput.additionalContext, /^bundlebox foreman STOP/, "the second warning after a steer is a stop");
});

test("the run's commits are its work, and committing a verified tree keeps it verified", { skip: !has && "python3 not found" }, () => {
  const C = "sess-commit";
  const base = foreman.rev("HEAD");
  for (let i = 0; i < 3; i++) gs.record("tool", { session_id: C, tool: "Read", file: "src/b.js", hash: `r${i}` });
  w("src/b.js", "export const b = 1;\n");
  w("test/b.test.js", "// covers b\n");
  sh("add", "."); sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add b");
  const first = foreman.assess({ session: C, since: base, job: "add b" });
  assert.equal(first.commits, 1);
  assert.equal(first.base, base);
  assert.equal(first.action, "verify", "a clean tree with a commit in the run is work to verify, not nothing");

  w("src/b.js", "export const b = 2;\n");
  assert.equal(foreman.verify({ command: "node -e \"process.exit(0)\"", session: C }).ok, true);
  sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "b is 2");
  const done = foreman.assess({ session: C });
  assert.equal(done.base, base, "later assessments keep the run's first base");
  assert.equal(done.commits, 2);
  assert.equal(done.action, "finish", done.reason);
  assert.equal(foreman.assess({ session: C, since: "no-such-rev" }).error, "--since no-such-rev is not a commit");
});
