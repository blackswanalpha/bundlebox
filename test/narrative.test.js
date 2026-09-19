// narrative.test.js — what goes back into the window after a compaction is
// the RECORD of the session, read off disk, not a summary of it. These tests
// pin what the record holds, that it is frozen at the moment of compaction,
// and that it is injected once on the first event after and never twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-narrative-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", type: "module" }));
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 }, wire: { auto_init: false, inject_context: true }, janitor: { restate_rules: true, narrative: true, notify: false } }));
w("src/a.js", "export const a = 1;\n");
w("src/b.js", "export const b = 2;\n");

const narrative = await import("../src/wire/narrative.js");
const hooks = await import("../src/wire/hooks.js");
const brief = await import("../src/wire/brief.js");
const gs = await import("../src/grapple/store.js");
const { load } = await import("../src/core/config.js");
const { text: estimateText } = await import("../src/tokens/estimate.js");

const SID = "s-compact";
const capture = async (fn) => {
  const written = [];
  const w0 = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  try { await fn(); } finally { process.stdout.write = w0; }
  return written.map((x) => JSON.parse(x));
};

// the record a session leaves behind
brief.activate(brief.record({ problem: "fix the login token refresh", scope: ["src/a.js", "src/b.js"], cut: ["src/c.js"],
  anchors: [{ path: "src/a.js", symbol: "refresh", line_start: 4, line_end: 9 }], gates: { quick: "npm run lint", full: "npm test" } }, { sessionId: SID, briefPath: "" }));
gs.record("tool", { session_id: SID, tool: "Read", file: "src/a.js", read: true, edit: false, hash: "r1" });
gs.record("tool", { session_id: SID, tool: "Edit", file: "src/a.js", read: false, edit: true, hash: "e1" });
gs.record("tool", { session_id: SID, tool: "Edit", file: "src/a.js", read: false, edit: true, hash: "e2" });
gs.record("tool", { session_id: SID, tool: "Write", file: "src/b.js", read: false, edit: true, hash: "e3" });
gs.record("tool", { session_id: "someone-else", tool: "Write", file: "src/z.js", read: false, edit: true, hash: "e9" });
gs.record("write_verdict", { session_id: SID, file: "src/c.js", decision: "deny", phase: "observe", emitted: false });
w(".bundlebox/var/shapes.jsonl", [{ at: "2026-09-18T00:00:00Z", s: SID, v: ["npm test"] }, { at: "2026-09-18T00:01:00Z", s: SID, v: ["git status"] }, { at: "2026-09-18T00:02:00Z", s: SID, v: ["npm test"] }].map((r) => JSON.stringify(r)).join("\n") + "\n");
w("GATES.md", "# gates\n\n- [x] G1: lint is clean\n  CHECK: npm run lint\n  EXPECT: 0 with errors\n- [ ] G2: the suite is green\n  CHECK: npm test\n  EXPECT: fail 0\n- [ ] G3: reviewed by hand\n");
gs.putQuestion({ key: "q-open", shape: "pattern", text: "swallowed-errors: is this deliberate?", ev: 40 });
w(".bundlebox/out/janitor/RULES.md", "# rules\n- never commit without the gate\n- one problem, one diff\n");

test("the record holds the task, the scope, the progress, the commands, the ledger and the open handoffs", () => {
  const text = narrative.build(narrative.gather({ sessionId: SID }));
  assert.match(text, /^task: fix the login token refresh/m);
  assert.match(text, /^scope — the only files to edit: src\/a\.js, src\/b\.js$/m);
  assert.match(text, /^cut for budget, name before opening: src\/c\.js$/m);
  assert.match(text, /^located: src\/a\.js:4 \(refresh\)$/m);
  assert.match(text, /^done when: npm run lint {2}\/ {2}npm test$/m);
  assert.match(text, /^edited this session \(last touched first\): src\/b\.js, src\/a\.js x2$/m, "another session's edits are not this session's");
  assert.match(text, /^writes refused as outside the scope: src\/c\.js$/m);
  assert.match(text, /^last commands: git status; npm test$/m, "distinct shapes, newest last");
  assert.match(text, /^ledger \(GATES\.md\): 2 of 3 gate\(s\) unmet — G2, G3$/m);
  assert.match(text, /^open questions \(bb grapple ask\): q-open swallowed-errors/m);
  assert.equal(text, narrative.build(narrative.gather({ sessionId: SID })), "pure over the record: same inputs, same page");
});

test("pre-compact freezes the page; session-start(compact) puts it back first, with the rules, once", async () => {
  load({ fresh: true });
  const pre = await capture(() => hooks.handleEvent("pre-compact", { session_id: SID, trigger: "auto" }));
  assert.deepEqual(pre, [], "nothing is emitted at pre-compact: whether it would reach the window is not observable");
  const frozen = narrative.read({ sessionId: SID });
  assert.match(frozen, /^task: fix the login token refresh/m);
  assert.ok(fs.existsSync(narrative.LATEST()), "a person can read the page without bundlebox open");
  // the session's state moves on after the freeze; the frozen page does not
  gs.record("tool", { session_id: SID, tool: "Write", file: "src/after.js", read: false, edit: true, hash: "e4" });
  const ss = await capture(() => hooks.handleEvent("session-start", { session_id: SID, source: "compact" }));
  assert.equal(ss.length, 1);
  const ctx = ss[0].hookSpecificOutput.additionalContext;
  assert.equal(ss[0].hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(ctx.startsWith("bundlebox: the conversation was just compacted. This is the record"), "the work first");
  assert.ok(ctx.includes("scope — the only files to edit: src/a.js, src/b.js"));
  assert.ok(!ctx.includes("src/after.js"), "the frozen page describes the moment of compaction, not a later one");
  assert.ok(ctx.includes("- never commit without the gate"), "the rules, verbatim, after it");
  assert.ok(estimateText(ctx, "prose") <= hooks.CAPS.narrative + hooks.CAPS["restate-rules"] + 20);
  // the next prompt does not restate the same compaction again
  const p = await capture(() => hooks.handleEvent("prompt", { session_id: SID, prompt: "ok" }));
  assert.deepEqual(p, []);
  // and a fresh compaction is answered again
  await capture(() => hooks.handleEvent("pre-compact", { session_id: SID, trigger: "manual" }));
  const again = await capture(() => hooks.handleEvent("prompt", { session_id: SID, prompt: "ok" }));
  assert.equal(again.length, 1);
  assert.equal(again[0].hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(again[0].hookSpecificOutput.additionalContext.includes("src/after.js"), "re-frozen at the second compaction, so it now holds the later edit");
});

test("a session with no brief and no edits carries only the workspace's ledger and queue, and a plain session-start is unchanged", async () => {
  const text = narrative.build(narrative.gather({ sessionId: "nobody" }));
  assert.ok(!/^task:|^scope|^edited|^last commands/m.test(text), "nothing of another session leaks in");
  assert.match(text, /^ledger \(GATES\.md\)/m, "the ledger is the workspace's and still stands");
  // an empty workspace has no page at all
  fs.renameSync(path.join(root, "GATES.md"), path.join(root, "GATES.md.bak"));
  const qs = path.join(root, ".bundlebox/var/grapple-questions.json");
  fs.renameSync(qs, qs + ".bak");
  try {
    assert.equal(narrative.build(narrative.gather({ sessionId: "nobody" })), "");
    assert.equal(narrative.write({ sessionId: "nobody" }), "");
  } finally { fs.renameSync(path.join(root, "GATES.md.bak"), path.join(root, "GATES.md")); fs.renameSync(qs + ".bak", qs); }
  const ss = await capture(() => hooks.handleEvent("session-start", { session_id: "nobody", source: "startup" }));
  assert.equal(ss.length, 1);
  assert.ok(!ss[0].hookSpecificOutput.additionalContext.includes("just compacted"));
});

test("the ledger parser reads the checkbox and nothing else", () => {
  const l = narrative.ledger("- [ ] A: one\n  CHECK: x\n- [x] B: two\n- [X] C: three\nnot a gate\n");
  assert.deepEqual(l.gates.map((g) => [g.id, g.met]), [["A", false], ["B", true], ["C", true]]);
  assert.deepEqual(l.unmet.map((g) => g.id), ["A"]);
});
