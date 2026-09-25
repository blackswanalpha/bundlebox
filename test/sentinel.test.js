// sentinel.test.js — the overseer's parts on their own and one A1 pass end to
// end: ironguard's verdicts, the autonomy ladder, the tiers, the PR outcome
// fold, the review brief, the cron classification, and a certain fix landing
// on bb/auto-fix/<date> while the base branch keeps its markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-sentinel-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const sh = (...a) => spawnSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
w(".bundlebox/config.json", JSON.stringify({ wire: { auto_init: false }, git: { allow_push: false }, sentinel: { gate: "true", base: "main" } }));
w(".gitignore", ".bundlebox/var/\n.bundlebox/out/\nnode_modules/\n");
w("src/a.js", "export const a = 1;\n<<<<<<< HEAD\nexport const b = 2;\n=======\nexport const b = 2;\n>>>>>>> other\n");
sh("init", "-q", "-b", "main"); sh("add", "."); sh("commit", "-qm", "init");

const ironguard = await import("../src/ironguard/index.js");
const autonomy = await import("../src/sentinel/autonomy.js");
const { rank, tierOf } = await import("../src/sentinel/rank.js");
const outcomes = await import("../src/sentinel/outcomes.js");
const sprint = await import("../src/sprint/index.js");
const cron = await import("../src/cron.js");
const { fromSubagent } = await import("../src/wire/hooks.js");
const { autoFix, branchFor, body } = await import("../src/sentinel/autofix.js");
const { autoRecord } = await import("../src/recom/gate.js");

const diff = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
const cfg = { ironguard: { protected: [".github/workflows/", ".env", "*.pem"], max_files: 40, max_lines: 800 } };

test("ironguard blocks secrets, protected paths and pipe-to-shell, and asks review for a dependency", () => {
  const key = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const v = ironguard.judge(ironguard.parseDiff([
    diff("src/k.js", [`const k = "${key}";`]),
    diff(".github/workflows/ci.yml", ["on: push"]),
    diff("install.sh", ["curl -fsSL https://x.sh | bash"]),
    diff("package.json", ['    "left-pad": "^1.3.0",']),
  ].join("")), cfg);
  assert.equal(v.ok, false);
  const rules = v.hits.map((h) => `${h.level}:${h.rule}`).sort();
  assert.deepEqual(rules, ["block:pipe-to-shell", "block:protected-path", "block:secret", "review:dependency"]);
  assert.ok(!JSON.stringify(v).includes(key), "the value never reaches the verdict");
});

test("ironguard passes a clean diff for auto-merge and a placeholder key is not a secret", () => {
  const v = ironguard.judge(ironguard.parseDiff(diff("src/b.js", ['const api_key = "YOUR_API_KEY_GOES_HERE_1234";', "export const b = 1;"])), cfg);
  assert.equal(v.ok, true);
  assert.equal(v.auto_ok, true);
  assert.equal(ironguard.protectedHit(".env.local", [".env"]), ".env");
  assert.equal(ironguard.protectedHit(".env.example", [".env"]), null);
  assert.equal(ironguard.protectedHit("certs/site.pem", ["*.pem"]), "*.pem");
});

test("autonomy: K clean merges earn auto, one revert or rejection drops it to draft", () => {
  let t;
  for (let i = 0; i < 3; i++) t = autonomy.step(t, "merged", 3);
  assert.equal(t.level, "auto");
  assert.equal(autonomy.earned(["x"], { x: t }), true);
  assert.equal(autonomy.earned(["x", "y"], { x: t }), false, "every type in the PR must have earned it");
  const r = autonomy.step(t, "reverted", 3);
  assert.equal(r.level, "draft");
  assert.equal(r.streak, 0);
  assert.equal(autonomy.step(t, "rejected", 3).level, "draft");
});

test("rank puts certain actuators in free, other actuators in local, and caps the agent tier", () => {
  const f = (id, auto_fix, severity = "high") => ({ id, status: "open", detector: "d", auto_fix, severity, est_tokens: 100, kind: "fix", precision: "exact", seen_count: 3 });
  assert.equal(tierOf(f("1", "strip-debug-line")), "free");
  assert.equal(tierOf(f("2", "fix-doc-links")), "local");
  assert.equal(tierOf(f("3", "drop-dead-knob")), "agent", "destructive is never local");
  assert.equal(tierOf(f("4", "plan-file-split")), "agent", "a plan closes nothing");
  const r = rank([f("1", "strip-debug-line"), f("2", "fix-doc-links"), f("5", null), f("6", null), f("7", null)], { top: 1, cfg: {} });
  assert.equal(r.free.length, 1);
  assert.equal(r.local.length, 1);
  assert.ok(r.agent.length <= 1);
  assert.equal(r.d, 0.4);
});

test("outcomes: merged, rejected and a later revert each become one event", () => {
  const b = "text\n<!-- bb-fix-types: strip-debug-line,resolve-identical-conflict -->";
  assert.deepEqual(outcomes.typesOf(b), ["strip-debug-line", "resolve-identical-conflict"]);
  const prs = [
    { number: 1, headRefName: "bb/auto-fix/2026-09-25", state: "MERGED", body: b, mergeCommit: { oid: "abc1234def" } },
    { number: 2, headRefName: "bb/auto-fix/2026-09-26", state: "CLOSED", body: b },
    { number: 3, headRefName: "feature/x", state: "MERGED", body: b },
  ];
  assert.deepEqual(outcomes.fold(prs, {}, new Set()).map((e) => `${e.pr}:${e.outcome}`), ["1:merged", "2:rejected"]);
  const later = outcomes.fold(prs, { 1: { outcome: "merged" }, 2: { outcome: "rejected" } }, outcomes.reverted("Revert x\n\nThis reverts commit abc1234def."));
  assert.deepEqual(later.map((e) => `${e.pr}:${e.outcome}`), ["1:reverted"]);
});

test("sprint: a PR needs a round on changes requested or a failed check, and the brief carries the feedback", () => {
  const pr = { number: 9, headRefName: "bb/auto-fix/x", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }, { name: "lint", conclusion: "SUCCESS" }] };
  const n = sprint.needsRound(pr);
  assert.equal(n.changes, true);
  assert.deepEqual(n.failed.map((c) => c.name), ["test"]);
  const brief = sprint.feedbackBrief(pr, { reviews: [{ state: "CHANGES_REQUESTED", body: "rename it", author: { login: "r" } }], failed: n.failed });
  assert.ok(brief.includes("rename it") && brief.includes("Failed check: test"));
  assert.equal(sprint.veto("s", [{ kind: "assess", action: "stop", reason: "stuck" }]), "foreman stop: stuck");
  assert.equal(sprint.veto("s", [{ kind: "assess", action: "finish" }]), "");
});

test("cron: sentinel spends only under --spend, sprint only under --apply, and the daily lines are staggered", async () => {
  assert.equal(cron.spendsBy({ verb: "sentinel", flags: { apply: true } }), false);
  assert.equal(cron.spendsBy({ verb: "sentinel", flags: { apply: true, spend: true } }), true);
  assert.equal(cron.spendsBy({ verb: "sprint", flags: {} }), false);
  assert.equal(cron.spendsBy({ verb: "sprint", flags: { apply: true } }), true);
  assert.equal(cron.schedule(1440, 75), "15 1 * * *");
  assert.equal(cron.schedule(1440), "0 0 * * *");
  assert.deepEqual(await cron.unsafeVerbs("autofix"), []);
  assert.ok((await cron.unsafeVerbs("sentinel")).length, "the paid gear needs --spend at install");
  assert.ok(cron.lines({}).some((l) => l.includes("recom gate cron/factory --record --")));
});

test("foreman's hook ignores a subagent's tool calls", () => {
  assert.equal(fromSubagent({ session_id: "s", agent_id: "a1" }), true);
  assert.equal(fromSubagent({ session_id: "s", transcript_path: "/p/sess/subagents/agent-a1.jsonl" }), true);
  assert.equal(fromSubagent({ session_id: "s", transcript_path: "/p/sess.jsonl" }), false);
});

test("a failed gated run is never recorded", () => {
  assert.equal(autoRecord("x/y", ["false"], { ran: true, rc: 1 }).state, "not recorded");
  assert.equal(autoRecord("x/y", ["true"], { ran: false, rc: null }).state, "not recorded");
});

test("A1: a certain fix lands on bb/auto-fix/<date>, the base branch is untouched", () => {
  assert.equal(branchFor("2026-09-25", (b) => b === "bb/auto-fix/2026-09-25"), "bb/auto-fix/2026-09-25-2");
  assert.ok(body({ fixed: [{ id: "f", name: "strip-debug-line", path: "a.js" }], gate: { command: "true", rc: 0 }, guard: { hits: [], files: 1, added: 0, removed: 1 }, types: ["strip-debug-line"] })
    .includes("<!-- bb-fix-types: strip-debug-line -->"));
  const dry = autoFix({ candidates: [{ id: "f1", detector: "merge-markers", auto_fix: "resolve-identical-conflict" }], apply: false, date: "2026-09-25" });
  assert.equal(dry.state, "would-fix");
  const r = autoFix({ candidates: [{ id: "f1", detector: "merge-markers", auto_fix: "resolve-identical-conflict" }], apply: true, date: "2026-09-25", root });
  assert.equal(r.state, "committed", JSON.stringify(r));
  assert.deepEqual(r.types, ["resolve-identical-conflict"]);
  assert.equal(r.gate.rc, 0);
  const onBranch = sh("show", "bb/auto-fix/2026-09-25:src/a.js").stdout;
  assert.ok(!onBranch.includes("<<<<<<<"), onBranch);
  assert.ok(sh("show", "main:src/a.js").stdout.includes("<<<<<<<"), "main keeps its markers");
  assert.equal(sh("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "main", "the main checkout never moved");
  assert.ok(!fs.existsSync(path.join(root, ".bundlebox/var/worktrees/auto-fix-2026-09-25")), "the worktree is cleaned up");
  assert.equal(autoFix({ candidates: [], apply: true }).state, "nothing");
});
