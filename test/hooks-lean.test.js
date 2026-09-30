// hooks-lean.test.js — what the two context hooks may cost. SessionStart is
// written into the cache once and re-read on every call, and a prompt band is
// re-read on every call after it, so each one has to carry something the
// session could not get for less.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-lean-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const cfg = (wire) => w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 }, wire: { auto_init: false, inject_context: true, auto_pinpoint: true, ...wire } }));
w("package.json", JSON.stringify({ name: "fixture", type: "module" }));
w("src/login.js", "export function refreshToken(session) {\n  return session.token;\n}\n");
w(".bundlebox/out/snapgen/INDEX.md", "# snapgen — the reference tables\n\n| artefact | what |\n|---|---|\n| [`layout.md`](layout.md) | the workspace map |\n");
w(".bundlebox/out/snapgen/layout.md", "# layout\n");
w(".bundlebox/out/snapgen/symbols-src.md", "# symbols\n");
cfg({});

const hooks = await import("../src/wire/hooks.js");
const { load } = await import("../src/core/config.js");
const capture = async (fn) => {
  const written = [];
  const w0 = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  try { await fn(); } finally { process.stdout.write = w0; }
  return written.map((x) => JSON.parse(x));
};

test("a harness notification is not a task, however task-shaped its body", () => {
  const note = "<task-notification>\n<task-id>b1</task-id>\n<summary>fix the build in src/login.js and update the tests</summary>\n</task-notification>";
  assert.equal(hooks.isTask(note), false);
  assert.equal(hooks.isTask("<system-reminder>update the refreshToken tests in src/login.js</system-reminder>"), false);
  assert.equal(hooks.isTask("fix the refreshToken expiry in src/login.js so a stale session is refused"), true, "a person's task still is one");
});

test("a harness notification gets no band", async () => {
  const out = await capture(() => hooks.handleEvent("prompt", { session_id: "n1", prompt: "<task-notification>\n<summary>fix the refreshToken build in src/login.js</summary>\n</task-notification>" }));
  assert.equal(out.length, 0);
});

test("a locate that matched nothing emits nothing, and one that matched emits the map", async () => {
  const none = await capture(() => hooks.handleEvent("prompt", { session_id: "p1", prompt: "migrate the quarterly spreadsheet macros to a warehouse schema nobody wrote yet" }));
  assert.equal(none.length, 0, "no 'located below — do not search' over an empty list");
  const hit = await capture(() => hooks.handleEvent("prompt", { session_id: "p2", prompt: "fix refreshToken in src/login.js so an expired session is refused" }));
  assert.equal(hit.length, 1);
  assert.match(hit[0].hookSpecificOutput.additionalContext, /src\/login\.js/);
});

test("session-start points at the tables instead of pasting the index", async () => {
  const [ss] = await capture(() => hooks.handleEvent("session-start", { session_id: "s1", source: "startup" }));
  const ctx = ss.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\.bundlebox\/out\/snapgen\/INDEX\.md — .*\blayout\b.*\bsymbols-src\b/);
  assert.ok(!ctx.includes("| artefact |"), "the index body stays on disk");
  assert.ok(!ctx.includes("For a task:"), "auto_pinpoint runs the locate itself");
  cfg({ auto_pinpoint: false }); load({ fresh: true });
  const [off] = await capture(() => hooks.handleEvent("session-start", { session_id: "s2", source: "startup" }));
  assert.match(off.hookSpecificOutput.additionalContext, /For a task: `bb pinpoint/);
  cfg({}); load({ fresh: true });
});
