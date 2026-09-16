// lathe.test.js — the automation engine. LATHE-1 is four count-based models
// over artefacts this workspace already produced; nothing here calls a language
// model, and these tests are the reason the counts can be trusted.
//
// Most of what is locked down here was a DEFECT first, found by running the
// engine on this repository's own data:
//
//   - every shell command shaped as `cd`, because an agent prefixes almost all
//     of them with `cd <root> &&`;
//   - `for`, `do`, `done` and `break` mined as commands, because splitting a
//     shell loop on its separators makes its grammar look like work;
//   - six rows describing one 14-verb pipeline, because a length cap stopped
//     growth and made every 8-item window look closed;
//   - `out_of_scope -> out_of_scope` in the completion table, 400 times over.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-lathe-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 } }));

const lathe = await import("../src/lathe/index.js");
const record = await import("../src/lathe/record.js");
const emit = await import("../src/lathe/emit.js");
const expert = await import("../src/core/expert.js");
const havePython = expert.available();

// ── shaping: the difference between a model and noise ───────────────────────

test("a command is shaped by its work, not by how the shell was entered", () => {
  assert.deepEqual(lathe.commandShapes("cd /x && npm test"), ["npm test"]);
  assert.deepEqual(lathe.commandShapes("cd a && cd b && cd c"), [], "cd is how a shell is entered, not work");
  assert.deepEqual(lathe.commandShapes("set -euo pipefail"), []);
  assert.deepEqual(lathe.commandShapes("grep -rn foo src/ | head -20"), ["grep", "head"]);
  assert.deepEqual(lathe.commandShapes("git commit -m 'one; two'"), ["git commit"], "a quoted separator is not a separator");
  assert.deepEqual(lathe.commandShapes("/usr/local/bin/node --test"), ["node"], "the path is not the command");
});

test("shell grammar is not a command", () => {
  assert.deepEqual(lathe.commandShapes("for i in 1 2 3; do curl -s x; break; done"), []);
  // A segment LED by grammar is not mined at all. `if test -f a` does run
  // `test`, and recovering it means stripping keywords until a real binary
  // appears — which on `for i in 1 2 3` recovers `i`. Losing the guarded
  // command costs one occurrence; mining a loop variable as a command costs the
  // model its meaning.
  assert.deepEqual(lathe.commandShapes("if test -f a; then echo b; fi"), []);
  assert.deepEqual(lathe.commandShapes("(node -e 1) | head -5"), ["node", "head"], "a leading paren is grouping");
});

test("a sub-verb is part of the shape, an argument is not", () => {
  assert.equal(lathe.commandShape("git push origin main"), "git push");
  assert.equal(lathe.commandShape("git commit -m x"), "git commit");
  assert.equal(lathe.commandShape("sed -n 40,60p src/a.js"), "sed", "a flag is not a sub-verb");
  assert.equal(lathe.commandShape("node src/index.js"), "node", "a path is not a sub-verb");
});

// ── recording: the input, captured when it is free ──────────────────────────

test("the hook records the shape and never the command", () => {
  fs.rmSync(record.FILE(), { force: true });
  const n = record.record({ tool_name: "Bash", tool_input: { command: "cd /x && git commit -m 'the secret is hunter2'" }, session_id: "S1" }, { shapesOf: lathe.commandShapes });
  assert.equal(n, 1);
  const text = fs.readFileSync(record.FILE(), "utf8");
  assert.match(text, /git commit/);
  assert.ok(!text.includes("hunter2"), "the argument is the part that differs every time, so it is never the habit — and never recorded");
});

test("only Bash is recorded, and only when it did work", () => {
  fs.rmSync(record.FILE(), { force: true });
  assert.equal(record.record({ tool_name: "Read", tool_input: { file_path: "a.js" } }, { shapesOf: lathe.commandShapes }), 0);
  assert.equal(record.record({ tool_name: "Bash", tool_input: { command: "cd /x" } }, { shapesOf: lathe.commandShapes }), 0);
  assert.equal(record.stat().rows, 0);
});

test("runs group by session, in order", () => {
  fs.rmSync(record.FILE(), { force: true });
  for (const [cmd, s] of [["npm run lint", "A"], ["npm test", "A"], ["git commit -m x", "A"], ["npm test", "B"], ["git push", "B"]]) {
    record.record({ tool_name: "Bash", tool_input: { command: cmd }, session_id: s }, { shapesOf: lathe.commandShapes });
  }
  const runs = record.runs({});
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.find((r) => r.length === 3), ["npm run", "npm test", "git commit"]);
});

test("rotate drops the oldest half past the cap", () => {
  fs.rmSync(record.FILE(), { force: true });
  for (let i = 0; i < 10; i++) record.record({ tool_name: "Bash", tool_input: { command: `npm test${i}` }, session_id: "S" }, { shapesOf: lathe.commandShapes });
  assert.equal(record.rotate({ max: 4 }), 5);
  assert.equal(record.stat().rows, 5);
});

// ── mining: the properties that make a pattern worth a script ───────────────

test("one pipeline is one habit, not every window of it", { skip: havePython ? false : "python3 required" }, () => {
  const pipeline = ["scan", "oversight", "compile", "route", "snapgen", "guidelines", "recommend", "ledger", "episodes", "bench"];
  const r = expert.call("sequences", { sequences: [pipeline, pipeline, pipeline], min_support: 3 });
  assert.ok(r, expert.lastError);
  // Closedness has to collapse the windows: with a length cap of 8 this
  // returned six rows at the same support, all describing this one run.
  assert.equal(r.patterns.length, 1, `got ${r.patterns.length}: ${r.patterns.map((p) => p.items.join(">")).join(" | ")}`);
  assert.deepEqual(r.patterns[0].items, pipeline);
  assert.equal(r.patterns[0].support, 3);
  assert.equal(r.patterns[0].sessions, 3);
});

test("a shorter prefix survives only when it happens more often", { skip: havePython ? false : "python3 required" }, () => {
  const r = expert.call("sequences", { sequences: [["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c"], ["a", "b"], ["a", "b"]], min_support: 3 });
  const got = r.patterns.map((p) => p.items.join(">"));
  assert.ok(got.includes("a>b>c"), got.join(" | "));
  assert.ok(got.includes("a>b"), "a>b occurs 5 times and a>b>c only 3, so it is its own habit");
});

test("a repetition is reported as its base cycle", { skip: havePython ? false : "python3 required" }, () => {
  const six = ["grep", "head", "grep", "head", "grep", "head"];
  const r = expert.call("sequences", { sequences: [six, six, six], min_support: 3 });
  const lengths = r.patterns.map((p) => p.items.length);
  assert.ok(!lengths.includes(6), "a habit run three times is not a habit six steps long");
  assert.ok(r.patterns.some((p) => p.items.join(">") === "grep>head"), r.patterns.map((p) => p.items.join(">")).join(" | "));
});

test("a coincidence of two sessions is not a habit", { skip: havePython ? false : "python3 required" }, () => {
  const r = expert.call("sequences", { sequences: [["x", "y"], ["x", "y"]], min_support: 3 });
  assert.deepEqual(r.patterns, []);
});

test("completions never propose a prefix that is already the whole name", { skip: havePython ? false : "python3 required" }, () => {
  const r = expert.call("completions", { names: ["out_of_scope", "reinforcement", "reinforced"], min_count: 1 });
  for (const p of r.prefixes) {
    assert.ok(p.names.some((n) => n.length > p.prefix.length), `\`${p.prefix}\` completes to \`${p.names.join(",")}\` and saves nothing`);
  }
});

// ── emitting: what a habit becomes ──────────────────────────────────────────

test("a habit becomes a tagged script that nothing will run yet", () => {
  const s = emit.scriptFor({ items: ["npm run lint", "npm test"], support: 7, sessions: 4, confidence: 0.9, lift: 3.2 }, { kind: "shell" });
  assert.match(s.text, /^#!\/usr\/bin\/env bash$/m);
  assert.match(s.text, /^# @tag lathe$/m);
  assert.match(s.text, /^# @turns 2$/m);
  assert.match(s.text, /^# @safe false$/m, "the model knows what ran, not whether running it unattended is safe");
  assert.match(s.text, /7 occurrence\(s\) across 4 session\(s\)/);
  assert.match(s.text, /^npm run lint$/m);
  assert.match(s.text, /^npm test$/m);
  assert.equal(s.turns, 2);
});

test("boilerplate is the longest prologue a group of files already shares", () => {
  const head = ['import { test } from "node:test";', 'import assert from "node:assert/strict";'];
  const runs = [[...head, "const a = 1;"], [...head, "const b = 2;"], [...head, "const c = 3;"], ["something", "else"]];
  const p = emit.commonPrologue(runs, { minFiles: 3 });
  assert.deepEqual(p.lines, head);
  assert.equal(p.files, 3);
  assert.equal(emit.commonPrologue(runs.slice(0, 2), { minFiles: 3 }), null, "two files do not make a convention");
});

test("build is a dry run until --apply, and says what each artefact holds", async () => {
  const model = { name: "LATHE-1", learned_at: "now", inputs: { declarations: 2 }, sequence: { verbs: [{ items: ["scan", "compile"], support: 5, sessions: 3, confidence: 1, lift: 2 }], shell: [] }, completion: { prefixes: [{ prefix: "log", names: ["loginToken"], certain: true, entropy: 0, n: 1 }] } };
  const dry = await emit.all(model, { apply: false });
  assert.equal(dry.apply, false);
  assert.ok(dry.rows.every((r) => r.state !== "wrote"));
  assert.equal(fs.existsSync(path.join(emit.DIR(), "scripts.md")), false);
  const wet = await emit.all(model, { apply: true });
  assert.ok(wet.rows.every((r) => r.state === "wrote"));
  assert.match(fs.readFileSync(path.join(emit.DIR(), "scripts.md"), "utf8"), /scan → compile/);
  assert.match(fs.readFileSync(path.join(emit.DIR(), "autocomplete.md"), "utf8"), /`log` \| `loginToken`/);
  assert.match(fs.readFileSync(path.join(emit.DIR(), "INDEX.md"), "utf8"), /nothing here called a model/);
  const again = await emit.all(model, { apply: true });
  assert.ok(again.rows.every((r) => r.state === "unchanged"), "re-emitting the same model rewrites nothing");
});

test("a pattern of one repeated shape never reaches the scripts table", () => {
  const model = { name: "LATHE-1", sequence: { verbs: [], shell: [{ items: ["npm test", "npm test", "npm test"], support: 9, sessions: 2, confidence: 1, lift: 1 }] }, completion: {} };
  // `varied` drops it at learn time; this checks the emitter does not resurrect
  // one if it ever arrives.
  const r = emit.scripts({ ...model, sequence: { verbs: [], shell: model.sequence.shell.filter((p) => new Set(p.items).size > 1) } }, {});
  assert.equal(r.count, 0);
});
