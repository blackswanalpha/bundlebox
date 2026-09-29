// repeats.test.js — a failed tool call reported only when it failed the same
// way before in the same session.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-repeats-")));
process.env.BB_ROOT = root;
fs.mkdirSync(path.join(root, ".bundlebox"), { recursive: true });
fs.writeFileSync(path.join(root, ".bundlebox/config.json"), JSON.stringify({ wire: { auto_init: false } }));

const repeats = await import("../src/wire/repeats.js");
const fail = (session, command, error) => ({ session_id: session, tool_name: "Bash", tool_input: { command, description: "x" }, error });

test("repeats: silent on the first failure, speaks on the second identical one", () => {
  assert.equal(repeats.notice(repeats.record(fail("s1", "npm test", "Exit code 1\nFAIL at 12:03:44 pid 4411"))), null);
  const r = repeats.record(fail("s1", "npm  test", "Exit code 1\nFAIL at 12:09:10 pid 5120"));
  assert.equal(r.n, 2, "whitespace in the command and digits in the error do not make a new failure");
  assert.match(repeats.notice(r), /failed 2 times this session/);
});

test("repeats: a different error is progress, another session is a fresh start, an interrupt is not a failure", () => {
  assert.equal(repeats.record(fail("s2", "make", "missing header foo.h")).n, 1);
  assert.equal(repeats.record(fail("s2", "make", "undefined symbol bar")).n, 1);
  assert.equal(repeats.record(fail("s3", "make", "missing header foo.h")).n, 1);
  assert.equal(repeats.record({ ...fail("s2", "make", "missing header foo.h"), is_interrupt: true }), null);
  assert.equal(repeats.record({ session_id: "s2", tool_name: "Bash", tool_input: { command: "ls" } }), null);
});

test("repeats: old sessions are dropped past KEEP_SESSIONS", () => {
  for (let i = 0; i < repeats.KEEP_SESSIONS + 5; i++) repeats.record(fail(`k${i}`, "false", "Exit code 1"));
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".bundlebox/var/repeat-failures.json"), "utf8"));
  assert.ok(Object.keys(doc).length <= repeats.KEEP_SESSIONS);
});

test("hooks: post-tool-failure is a wired event with a cap", async () => {
  const hooks = await import("../src/wire/hooks.js");
  const { CLAUDE_HOOKS } = await import("../src/wire/agents.js");
  assert.ok(hooks.EVENTS.includes("post-tool-failure"));
  assert.ok(hooks.CAPS["post-tool-failure"] > 0);
  assert.ok(CLAUDE_HOOKS.some((h) => h.event === "PostToolUseFailure" && h.cmd === "post-tool-failure"));
});
