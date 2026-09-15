// uptake.test.js — the observation half, and the discipline around it.
//
// Two ways this verb could lie, and both are worse than not shipping it:
//
//   1. Counting a MENTION of `bb` as a use of it. Every document this box
//      writes about itself contains `bb scan`, and a session that wrote one
//      would report as a session that ran it. The whole number inverts.
//   2. Printing 0% for a surface no transcript can answer for. The instructions
//      block arrives in the system prompt, which is not a turn, so "it never
//      fired" would be a measurement of nothing dressed as a finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, segments, surfaces, READ_FLOOR } from "../src/uptake/index.js";

const bash = (command) => ({ name: "Bash", input: { command } });
const turnOf = (...toolUses) => ({ toolUses, toolResults: [] });
const seen = (...uses) => observe([turnOf(...uses)]);

test("a heredoc body is text being written, not commands being run", () => {
  const cmd = ["cat > doc.md <<'EOF'", "Run bb scan first, then bb compile.", "EOF", "git add doc.md"].join("\n");
  assert.deepEqual(segments(cmd).filter((s) => s.startsWith("bb ")), []);
  assert.equal(seen(bash(cmd)).bbVerbs.length, 0, "writing about bb is not running bb");
});

test("bb is counted only where a shell would actually run it", () => {
  assert.deepEqual(seen(bash("bb scan --json")).bbVerbs, ["scan"]);
  assert.deepEqual(seen(bash("cd /tmp && bb route")).bbVerbs, ["route"]);
  assert.deepEqual(seen(bash("node bin/bb.js compile")).bbVerbs, ["compile"], "this repo runs itself before it is installed");
  // Mentions, not invocations.
  assert.deepEqual(seen(bash("echo 'bb scan' > note.txt")).bbVerbs, []);
  assert.deepEqual(seen(bash("grep -rn 'bb pinpoint' src/")).bbVerbs, []);
  assert.deepEqual(seen(bash("# run bb doctor later")).bbVerbs, []);
});

test("a file opened with sed counts exactly as much as one opened with Read", () => {
  const viaTool = seen({ name: "Read", input: { file_path: "src/a.js" } }, { name: "Read", input: { file_path: "src/b.js" } });
  const viaShell = seen(bash("sed -n '1,80p' src/a.js"), bash("cat src/b.js"));
  assert.equal(viaTool.opens, 2);
  assert.equal(viaShell.opens, 2, "which tool a session uses is a harness setting, not a fact about the work");
  assert.equal(viaShell.files, 2);
});

test("searching is counted through either path, and reading is not searching", () => {
  const o = seen({ name: "Grep", input: { pattern: "x" } }, bash("rg -n 'handler' src/"), bash("find . -name '*.js'"), bash("cat src/a.js"));
  assert.equal(o.searches, 3);
  assert.equal(o.opens, 1);
});

test("a reference table read any way at all counts as the table firing", () => {
  assert.ok(seen({ name: "Read", input: { file_path: ".bundlebox/out/snapgen/INDEX.md" } }).snapgen > 0);
  assert.ok(seen(bash("cat .bundlebox/out/snapgen/symbols.md")).snapgen > 0);
  assert.ok(seen({ name: "Grep", input: { path: ".bundlebox/out/snapgen", pattern: "x" } }).snapgen > 0);
  assert.equal(seen({ name: "Read", input: { file_path: "src/snapgen/index.js" } }).snapgen, 0, "the code that builds the table is not the table");
});

test("the MCP tools are recognised under either name the harness gives them", () => {
  assert.deepEqual(seen({ name: "mcp__bundlebox__bb_pinpoint", input: {} }).mcp, ["bb_pinpoint"]);
  assert.deepEqual(seen({ name: "bb_context", input: {} }).mcp, ["bb_context"]);
  assert.deepEqual(seen({ name: "mcp__other__search", input: {} }).mcp, [], "another server's tool is not ours");
});

test("a surface that arrives in the system prompt is not observable, and says why", () => {
  const defs = surfaces({ wire: { inject_context: true, guard_reads: true } });
  const blind = defs.filter((s) => !s.observable);
  assert.ok(blind.length >= 3);
  for (const s of blind) {
    assert.ok(s.why && s.why.length > 10, `${s.id} must say why it cannot be answered`);
    assert.equal(typeof s.fired, "undefined", "a surface with no observation must not carry a firing rule");
    assert.equal(typeof s.chance, "undefined", "...nor a denominator it could be scored against");
  }
});

test("a chance is the moment the surface was for, not a session count", () => {
  const defs = surfaces({ wire: {} });
  const pinpoint = defs.find((s) => s.id === "pinpoint");
  const tables = defs.find((s) => s.id === "tables");
  const cli = defs.find((s) => s.id === "cli");

  // A session that opened one file is not a session that ignored pinpoint.
  assert.equal(pinpoint.chance(seen({ name: "Read", input: { file_path: "a.js" } })), false);
  const many = observe([turnOf(...Array.from({ length: READ_FLOOR }, (_, i) => ({ name: "Read", input: { file_path: `f${i}.js` } })))]);
  assert.equal(pinpoint.chance(many), true);
  assert.equal(pinpoint.fired(many), false);
  assert.equal(pinpoint.fired(seen(bash("bb pinpoint 'fix the total'"))), true);
  assert.equal(pinpoint.fired(seen({ name: "mcp__bundlebox__bb_pinpoint", input: {} })), true);

  // Tables answer searches; a session that never searched had no chance to.
  assert.equal(tables.chance(seen({ name: "Read", input: { file_path: "a.js" } })), false);
  assert.equal(tables.chance(seen({ name: "Grep", input: { pattern: "x" } })), true);

  // The CLI needs a shell before it can be ignored.
  assert.equal(cli.chance(seen({ name: "Read", input: { file_path: "a.js" } })), false);
  assert.equal(cli.chance(seen(bash("ls"))), true);
  assert.equal(cli.fired(seen(bash("ls"))), false);
});

test("a miss carries the evidence, not just the verdict", () => {
  const defs = surfaces({ wire: {} });
  const many = observe([turnOf(...Array.from({ length: 12 }, (_, i) => ({ name: "Read", input: { file_path: `f${i}.js` } })))]);
  assert.match(defs.find((s) => s.id === "pinpoint").detail(many), /12 file\(s\), 12 distinct/);
  assert.match(defs.find((s) => s.id === "cli").detail(seen(bash("ls"), bash("pwd"))), /2 shell call\(s\), none of them bb/);
});
