// reach.test.js — the three ways a Terminal-Bench 2.0 run showed bundlebox
// failing to reach the agent: tools deferred until a search nobody ran, a
// scope drawn from the few files the index can see, and a shell `cd` that
// sent the read guard to the wrong file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-reach-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 }, wire: { auto_init: false } }));
w("tools/gdb.py", "def ocaml_heap_sweep_printer():\n    return 1\n");
for (let i = 0; i < 12; i++) w(`runtime/heap${i}.c`, `static void sweep_${i}(void) { /* heap sweep */ }\n`);

const brief = await import("../src/wire/brief.js");
const pinpoint = await import("../src/pinpoint/index.js");
const { serve } = await import("../src/mcp/server.js");

test("G8: a read after `cd` is checked as the file the shell will open", () => {
  assert.deepEqual(brief.parseBash("cd runtime && sed -n 1,3p heap0.c"), { kind: "read", file: "runtime/heap0.c", offset: 1, limit: 3 });
  assert.deepEqual(brief.parseBash(`cd ${root}/runtime && cat heap1.c`), { kind: "read", file: "runtime/heap1.c", offset: 0, limit: 0 });
  assert.equal(brief.parseBash("cd runtime && grep -rn sweep").pathArg, "runtime", "a pathless search after cd searches that directory");
  assert.equal(brief.parseBash("cd runtime && grep -rn sweep").stdin, false, "and it is not reading a pipe");
  assert.equal(brief.parseBash("cd - && cat heap0.c"), null, "a target the hook cannot know ends the parse");
  assert.equal(brief.parseBash("cd $HOME && cat .bashrc"), null);
  assert.equal(brief.parseBash("cd /tmp && cat build.log"), null, "outside the root is not guarded");
  assert.deepEqual(brief.parseBash("grep -n sweep runtime/"), { kind: "search", pattern: "sweep", pathArg: "runtime/", stdin: false }, "no cd, unchanged");
  assert.equal(brief.parseBash("npm test | grep fail").stdin, true, "a pipe is still a pipe");
});

test("G6: coverage counts the code the locate cannot see", () => {
  assert.equal(pinpoint.coverage(["a.py", ...Array.from({ length: 12 }, (_, i) => `r/${i}.c`)]).partial, true);
  assert.equal(pinpoint.coverage(["a.py", "b.js", "c.c"]).partial, false, "a stray C file does not switch a tree off");
  assert.equal(pinpoint.coverage(Array.from({ length: 30 }, (_, i) => `s/${i}.py`).concat(Array.from({ length: 12 }, (_, i) => `r/${i}.c`))).partial, false);
});

test("G6: a mostly-C tree gets no scope drawn from its one Python file, unless the task names a file", async () => {
  const b = await pinpoint.build("improve the ocaml heap sweep so free space is run-length compressed");
  assert.equal(b.abstain, true);
  assert.deepEqual(b.scope, []);
  assert.match(b.prompt, /located nothing for this task: 12 of this tree's 13 code files/);
  const named = await pinpoint.build("fix the sweep in runtime/heap3.c so it stops early");
  assert.equal(named.abstain, false);
  assert.ok(named.scope.includes("runtime/heap3.c"));
});

test("G1: bb_pinpoint and bb_context load at session start; the rest stay deferred", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines = [];
  output.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  serve({ input, output });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  for (let i = 0; i < 50 && !lines.length; i++) await new Promise((r) => setTimeout(r, 20));
  const tools = JSON.parse(lines[0]).result.tools;
  const always = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"]).map((t) => t.name).sort();
  assert.deepEqual(always, ["bb_context", "bb_pinpoint"]);
  assert.ok(tools.length > always.length, "the others are listed, deferred");
  input.end();
});

test("G1: with the prompt hook wired, bb_pinpoint is deferred: the hook already ran it", async () => {
  const { promptHookWired } = await import("../src/mcp/server.js");
  assert.equal(promptHookWired(), false);
  w(".claude/settings.json", JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "bb hook prompt", timeout: 15 }] }] } }));
  try {
    assert.equal(promptHookWired(), true);
    const input = new PassThrough(), output = new PassThrough();
    const lines = [];
    output.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
    serve({ input, output });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    for (let i = 0; i < 50 && !lines.length; i++) await new Promise((r) => setTimeout(r, 20));
    const always = JSON.parse(lines[0]).result.tools.filter((t) => t._meta?.["anthropic/alwaysLoad"]).map((t) => t.name);
    assert.deepEqual(always, ["bb_context"]);
    input.end();
  } finally { fs.rmSync(path.join(root, ".claude"), { recursive: true, force: true }); }
});
