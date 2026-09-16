// wire.test.js — what `bb wire --apply` writes into an agent's settings file.
//
// The regression here shipped silently. `addClaudeHooks` stripped every
// bundlebox hook once PER ROW instead of once per event, which is invisible
// while each event has one handler and wrong the moment one has two: the
// PreToolUse(Read) row was installed by the first row and stripped again by the
// second, so the read guard was missing from the settings file and no diff said
// so.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-wire-")));
process.env.BB_ROOT = root;
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));

const wire = await import("../src/wire/index.js");
const { CLAUDE_HOOKS, isOurHook, skills } = await import("../src/wire/agents.js");

const rows = (json) => {
  const o = JSON.parse(json);
  const out = [];
  for (const [event, groups] of Object.entries(o.hooks || {})) for (const g of groups) for (const h of g.hooks || []) out.push(`${event}(${g.matcher || ""}) ${h.command}`);
  return out.sort();
};

test("every declared hook row reaches the settings file", () => {
  const got = rows(wire.addClaudeHooks(null));
  assert.equal(got.length, CLAUDE_HOOKS.length, `wrote ${got.length} of ${CLAUDE_HOOKS.length}: ${got.join(" | ")}`);
  for (const h of CLAUDE_HOOKS) assert.ok(got.some((r) => r.startsWith(`${h.event}(${h.matcher || ""}) bb hook ${h.cmd}`)), `${h.event}${h.matcher ? `(${h.matcher})` : ""} -> ${h.cmd} is missing`);
});

test("two rows on one event both survive", () => {
  const pre = CLAUDE_HOOKS.filter((h) => h.event === "PreToolUse");
  assert.ok(pre.length >= 2, "this test is only meaningful while one event carries two handlers");
  const got = rows(wire.addClaudeHooks(null)).filter((r) => r.startsWith("PreToolUse"));
  assert.equal(got.length, pre.length);
  assert.equal(new Set(got.map((r) => r.split(") ")[0])).size, pre.length, "each keeps its own matcher group");
});

test("applying twice is the same file, not two copies", () => {
  const once = wire.addClaudeHooks(null);
  const twice = wire.addClaudeHooks(once);
  assert.deepEqual(rows(twice), rows(once));
});

test("a changed timeout replaces the row instead of doubling it", () => {
  const stale = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "bb hook pre-read", timeout: 3 }] }] } });
  const got = JSON.parse(wire.addClaudeHooks(stale));
  const read = got.hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => h.command === "bb hook pre-read");
  assert.equal(read.length, 1);
  assert.equal(read[0].timeout, CLAUDE_HOOKS.find((h) => h.cmd === "pre-read").timeout);
});

test("somebody else's hooks on the same event are left alone", () => {
  const theirs = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "./my-own-guard.sh" }] }] } });
  const got = JSON.parse(wire.addClaudeHooks(theirs));
  const mine = got.hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => !isOurHook(h));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].command, "./my-own-guard.sh");
});

test("unwire removes only ours", () => {
  const theirs = { hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "./my-own-guard.sh" }] }] } };
  const after = JSON.parse(wire.removeClaudeHooks(wire.addClaudeHooks(JSON.stringify(theirs))));
  assert.deepEqual(after, theirs);
});

// ── skills ──────────────────────────────────────────────────────────────────
//
// A skill is the one surface bb installs that costs nothing until it triggers,
// unlike the instructions block, which arrives in every system prompt and is
// billed whether or not the session was about that.

test("every skill in the package is wired, and unwire takes it back out", () => {
  const all = skills();
  assert.ok(all.length >= 2, `expected the packaged skills, got ${all.map((s) => s.name).join(", ") || "none"}`);
  for (const s of all) assert.ok(s.files.includes("SKILL.md"), `${s.name} has no SKILL.md`);
  const rows = wire.plan(["claude"], { root, scope: "project", mode: "add" }).filter((r) => r.kind === "copy");
  assert.equal(rows.length, all.reduce((n, s) => n + s.files.length, 0));
  for (const s of all) assert.ok(rows.some((r) => r.path.includes(path.join(".claude", "skills", s.name, "SKILL.md"))), `${s.name} is not wired`);
  assert.ok(rows.every((r) => r.action === "create"), "nothing is installed in the fixture yet");
  wire.applyPlan(rows);
  const again = wire.plan(["claude"], { root, scope: "project", mode: "add" }).filter((r) => r.kind === "copy");
  assert.ok(again.every((r) => r.action === "unchanged"), "applying twice changes nothing");
  const removal = wire.plan(["claude"], { root, scope: "project", mode: "remove" }).filter((r) => r.kind === "copy");
  assert.ok(removal.every((r) => r.action === "delete"));
  wire.applyPlan(removal);
  assert.equal(fs.existsSync(path.join(root, ".claude", "skills", all[0].name, "SKILL.md")), false);
});

test("a skill document declares the name its directory carries", () => {
  for (const s of skills()) {
    const fm = fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8").split("---")[1] || "";
    const name = /^name:\s*(\S+)/m.exec(fm);
    assert.ok(name, `${s.name}/SKILL.md has no name in its frontmatter`);
    assert.equal(name[1], s.name, "the frontmatter name and the directory must agree, or the agent loads neither");
    assert.match(fm, /^description:\s*\S/m, `${s.name} has no description, which is the only thing that decides whether it triggers`);
  }
});
