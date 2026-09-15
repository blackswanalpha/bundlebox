import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-runner-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;
const runner = await import("../src/run/runner.js");
const store = await import("../src/core/store.js");
const { loadPlan } = await import("../src/run/index.js");
const { save, load } = await import("../src/core/config.js");

const units = [
  { id: "U1", title: "fix links", brief: "Fix the dead link in README.", acceptance: process.platform === "win32" ? "cd ." : "true", scope: ["README.md"] },
  { id: "U2", title: "no gate", brief: "Rename a thing.", acceptance: "", scope: ["a.js"] },
];
const lanes = [
  { id: "L01", run_id: "R1", unit_ids: ["U1"], wave: 1, cwd: root, worktree: root, status: "ready" },
  { id: "L02", run_id: "R1", unit_ids: ["U2"], wave: 1, cwd: root, worktree: root, status: "ready" },
];
store.put("units", units);
store.put("lanes", lanes);

test("laneSessionId is a stable UUID", () => {
  const a = runner.laneSessionId("R1", "L01");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, runner.laneSessionId("R1", "L01"));
  assert.notEqual(a, runner.laneSessionId("R1", "L02"));
});

test("laneEnv passes only the allowlist plus extras", () => {
  process.env.BB_TEST_SECRET_TOKEN = "nope";
  process.env.ANTHROPIC_API_KEY = "yes";
  const env = runner.laneEnv({ BB_LANE: "L01", EMPTY: "" });
  assert.equal(env.BB_TEST_SECRET_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "yes");
  assert.equal(env.BB_LANE, "L01");
  assert.ok(!("EMPTY" in env), "an empty value is never set: a blank ANTHROPIC_BASE_URL is worse than none");
  assert.ok(env.PATH);
});

test("laneEnv: a Windows environment is spelled Windows' way, and still yields a PATH", () => {
  // Object.entries(process.env) on Windows hands back these exact spellings. A
  // case-sensitive allowlist matched none of them, so the lane got no PATH at
  // all and the agent binary could not be found.
  const win = {
    Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
    USERPROFILE: "C:\\Users\\me",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    ANTHROPIC_API_KEY: "yes",
    OneDrive: "C:\\Users\\me\\OneDrive",
    BB_TEST_SECRET_TOKEN: "nope",
  };
  const env = runner.laneEnv({}, { source: win });
  assert.ok(env.PATH, "a lane with no PATH cannot find the agent it was asked to run");
  assert.equal(env.PATH, win.Path);
  assert.equal(env.Path, win.Path, "and the OS spelling is kept, because that is what the child expects");
  for (const k of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "USERPROFILE", "APPDATA"]) {
    assert.ok(env[k], `${k} is carried: a Windows process needs it to start`);
  }
  assert.equal(env.ANTHROPIC_API_KEY, "yes");
  assert.equal(env.OneDrive, undefined, "still an allowlist");
  assert.equal(env.BB_TEST_SECRET_TOKEN, undefined);
});

test("laneEnv: a POSIX environment is unchanged by the Windows names", () => {
  const env = runner.laneEnv({}, { source: { PATH: "/usr/bin", HOME: "/home/me", AWS_SECRET_ACCESS_KEY: "nope" } });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/me" });
});

test("dry run writes the prompt and the quoted command first and spawns nothing", async () => {
  const plan = loadPlan("latest");
  assert.equal(plan.run_id, "R1");
  assert.deepEqual(plan.waves, [["L01", "L02"]]);
  const r = await runner.execute(plan, { apply: false, adapter: "claude" });
  assert.equal(r.rc, 0);
  assert.equal(r.dry_run, true);
  for (const l of r.results) {
    assert.equal(l.dry_run, true);
    assert.equal(l.spawned, undefined);
    const p = path.join(root, l.prompt_file), c = path.join(root, l.cmd_file);
    assert.ok(fs.existsSync(p) && fs.existsSync(c));
    const cmd = fs.readFileSync(c, "utf8");
    assert.match(cmd, /^claude -p --output-format stream-json --verbose/);
    assert.match(cmd, /--tools Bash Read Edit Write Grep Glob TodoWrite < /);
    assert.match(cmd, /# env: .*BB_LANE BB_RUN/);
  }
  assert.match(fs.readFileSync(path.join(root, r.results[0].prompt_file), "utf8"), /Task 1 of 1: fix links/);
  assert.ok(store.get("lanes").every((l) => l.status === "ready"), "a dry run does not touch lane state");
  assert.equal(store.rows("episodes").length, 0);
});

test("file adapter run: no process, acceptance verdict, empty-acceptance units are unproven", async () => {
  const plan = loadPlan("R1");
  const r = await runner.execute(plan, { apply: true, adapter: "file", maxParallel: 2 });
  const l1 = r.results.find((x) => x.lane === "L01"), l2 = r.results.find((x) => x.lane === "L02");
  assert.equal(l1.spawned, false);
  assert.equal(l1.rc, 0);
  assert.equal(l1.acceptance[0].rc, 0);
  assert.equal(l1.pr_eligible, true);
  assert.equal(l1.unproven, undefined);
  assert.equal(l2.rc, 0);
  assert.deepEqual(l2.unproven, ["U2"]);
  assert.equal(l2.pr_eligible, false, "unproven is not eligible for --pr");
  assert.deepEqual(r.unproven, ["U2"]);
  assert.match(fs.readFileSync(path.join(root, l2.cmd_file), "utf8"), /^# file: spawns nothing/);
  const eps = store.rows("episodes").filter((e) => e.kind === "lane");
  assert.equal(eps.length, 2);
  assert.ok(store.get("lanes").every((l) => l.status === "done"));
});

test("a failing acceptance fails the lane; a missing binary is rc 127, not a crash", async () => {
  store.put("units", [{ id: "U3", brief: "b", acceptance: "exit 3" }]);
  store.put("lanes", [{ id: "L03", run_id: "R2", unit_ids: ["U3"], cwd: root, worktree: root }]);
  const r = await runner.execute(loadPlan("R2"), { apply: true, adapter: "file" });
  assert.equal(r.results[0].rc, 1);
  assert.equal(r.results[0].why, "acceptance failed");
  save({ lanes: { custom_command: "bb-no-such-binary-xyz {prompt_file}" } });
  load({ fresh: true });
  const m = await runner.execute(loadPlan("R2"), { apply: true, adapter: "custom" });
  assert.equal(m.results[0].rc, 127);
  assert.match(m.results[0].why, /binary not found/);
  save({});
  load({ fresh: true });
});

test("daily budget fails closed", () => {
  save({ lanes: { daily_budget_usd: 0.000001 } });
  load({ fresh: true });
  const today = new Date().toISOString();
  store.append("usage", { session_id: "sb", msg_id: "m", agent: "claude", model: "claude-sonnet-5", input: 100000, output: 1000, cache_write: 0, cache_read: 0, ts: today });
  const b = runner.dailyBudget(load());
  assert.equal(b.ok, false);
  assert.match(b.why, /daily budget/);
  save({});
  load({ fresh: true });
  assert.equal(runner.dailyBudget(load()).ok, true);
});

test("the acceptance gate uses the platform's own shell", () => {
  // `bash` and `tail` are not on a Windows box. The gate used to hard-code both,
  // so every acceptance there failed with a shell error instead of a verdict.
  const posix = ["bash", "-lc", "set -o pipefail; { true ; } 2>&1"];
  const win = ["cmd.exe", "/d", "/s", "/c", "true"];
  const pick = (platform) => (platform === "win32" ? win : posix);
  assert.equal(pick("linux")[0], "bash");
  assert.equal(pick("win32")[0], "cmd.exe");
  assert.ok(!pick("win32").some((a) => /\btail\b/.test(a)), "nothing POSIX-only survives into the Windows form");
});
