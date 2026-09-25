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
sh("init", "-q", "-b", "main");
// Repo-local, so the worktree autoFix cuts inherits them: a CI runner has no
// global identity, and Windows' autocrlf would rewrite the conflict block.
sh("config", "user.email", "t@t"); sh("config", "user.name", "t"); sh("config", "core.autocrlf", "false");
sh("add", "."); sh("commit", "-qm", "init");

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

test("A1: a certain fix lands on bb/auto-fix/<date>, the base branch is untouched", async () => {
  assert.equal(branchFor("2026-09-25", (b) => b === "bb/auto-fix/2026-09-25"), "bb/auto-fix/2026-09-25-2");
  assert.ok(body({ fixed: [{ id: "f", name: "strip-debug-line", path: "a.js" }], gate: { command: "true", rc: 0 }, guard: { hits: [], files: 1, added: 0, removed: 1 }, types: ["strip-debug-line"] })
    .includes("<!-- bb-fix-types: strip-debug-line -->"));
  const dry = await autoFix({ candidates: [{ id: "f1", detector: "merge-markers", auto_fix: "resolve-identical-conflict" }], apply: false, date: "2026-09-25" });
  assert.equal(dry.state, "would-fix");
  const r = await autoFix({ candidates: [{ id: "f1", detector: "merge-markers", auto_fix: "resolve-identical-conflict" }], apply: true, date: "2026-09-25", root });
  assert.equal(r.state, "committed", JSON.stringify(r));
  assert.deepEqual(r.types, ["resolve-identical-conflict"]);
  assert.equal(r.gate.rc, 0);
  const onBranch = sh("show", "bb/auto-fix/2026-09-25:src/a.js").stdout;
  assert.ok(!onBranch.includes("<<<<<<<"), onBranch);
  assert.ok(sh("show", "main:src/a.js").stdout.includes("<<<<<<<"), "main keeps its markers");
  assert.equal(sh("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "main", "the main checkout never moved");
  assert.ok(!fs.existsSync(path.join(root, ".bundlebox/var/worktrees/auto-fix-2026-09-25")), "the worktree is cleaned up");
  assert.equal((await autoFix({ candidates: [], apply: true })).state, "nothing");
});

// ── the three languages and the two links ──────────────────────────────────

const policy = await import("../src/sentinel/policy.js");
const expert = await import("../src/core/expert.js");
const kernel = await import("../src/core/kernel.js");
const links = await import("../src/sentinel/links.js");
const emit = await import("../src/lathe/emit.js");
const scriptsIx = await import("../src/scripts/index.js");

const both = (fn) => { const py = fn(); process.env.BB_SENTINEL_JS = "1"; try { return [py, fn()]; } finally { delete process.env.BB_SENTINEL_JS; } };

test("the Python expert and the JS mirror decide the same tiers, steps, phases and rounds", { skip: !expert.available() && "python3 not found" }, () => {
  const f = (id, auto_fix, severity, est) => ({ id, status: "open", detector: `d${id}`, auto_fix, severity, est_tokens: est, kind: "fix", precision: "exact", seen_count: 3 });
  const rows = [f("1", "strip-debug-line", "low", 10), f("2", "fix-doc-links", "high", 10), f("3", null, "critical", 900), f("4", null, "critical", 100), f("5", "plan-file-split", "medium", 5)];
  const [py, js] = both(() => policy.tier(rows, { top: 2, cfg: {} }));
  assert.equal(py.via, "python");
  assert.equal(js.via, "js");
  const ids = (r) => ({ free: r.free.map((x) => x.id), local: r.local.map((x) => x.id), agent: r.agent.map((x) => x.id), held: r.held, d: r.d, detectors: r.detectors });
  assert.deepEqual(ids(py), ids(js));
  for (const o of ["merged", "rejected", "reverted"]) {
    const [a, b] = both(() => policy.step({ streak: 2, merged: 2, rejected: 0, reverted: 0, level: "draft", last: "merged" }, o, 3, autonomy.step));
    assert.deepEqual(a, b, o);
  }
  for (const st of [{ free: 1, scripts: 0, agent: 2, spend: true, spend_ok: true }, { free: 0, scripts: 0, agent: 0, spend: false }, { free: 0, scripts: 1, agent: 3, spend: true, spend_ok: false, missing: ["bridge.enabled"] }]) {
    const [a, b] = both(() => policy.phases(st));
    assert.deepEqual({ run: a.run, skip: a.skip }, { run: b.run, skip: b.skip }, JSON.stringify(st));
  }
  for (const st of [{ changes: false, failed: 0 }, { changes: true, rounds: 3, max: 3 }, { changes: true, rounds: 1, max: 3, sig: "x", last_sig: "x", writable: true }, { failed: 1, rounds: 0, max: 3, sig: "y", last_sig: "", writable: true }, { changes: true, rounds: 0, max: 3, sig: "y", writable: false }]) {
    const [a, b] = both(() => policy.round(st));
    delete a.via; delete b.via;
    assert.deepEqual(a, b, JSON.stringify(st));
  }
});

test("the kernel's diffscan and the JS collector return the same change", { skip: !kernel.available() && "no kernel" }, () => {
  w("src/new.js", "export const n = 1;\n");
  w("src/a.js", "export const a = 2;\n");
  const k = ironguard.collect({ cwd: root, base: "main" });
  const j = ironguard.collect({ cwd: root, base: "main", kernel: false });
  if (k.via !== "kernel") return;   // an installed bbk older than diffscan: the fallback is the contract
  const norm = (c) => JSON.stringify(c.files.map((f) => [f.path, f.added, f.removed, f.binary]).sort());
  assert.equal(norm(k), norm(j));
  sh("checkout", "--", "src/a.js"); fs.rmSync(path.join(root, "src/new.js"));
});

test("lathe writes a habit as a Python script that stops at the first failing step", { skip: !expert.available() && "python3 not found" }, () => {
  const s = emit.scriptFor({ items: ["true", "exit 3", "echo never"], support: 5, sessions: 2, confidence: 0.9 }, { kind: "shell", lang: "py" });
  assert.equal(s.name.endsWith(".py"), true);
  assert.match(s.text, /^#!\/usr\/bin\/env python3$/m);
  assert.match(s.text, /^# @safe false$/m);
  const p = path.join(root, "habit.py");
  fs.writeFileSync(p, s.text);
  const r = spawnSync(expert.python()[0], [...expert.python().slice(1), p], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes("$ echo never"));
  fs.rmSync(p);
  assert.match(emit.scriptFor({ items: ["a", "b"], support: 1, sessions: 1 }, {}).text, /^#!\/usr\/bin\/env bash$/m, "sh stays the default for a proposal");
});

test("a script tagged @fixes and @safe true is found for its detector, and arc names are located", async () => {
  w("scripts/fix-docs.sh", "#!/usr/bin/env bash\n# @tag fix-docs\n# @title rewrite the doc links\n# @fixes doc-links\n# @safe true\necho hi > fixed.txt\n");
  fs.chmodSync(path.join(root, "scripts/fix-docs.sh"), 0o755);
  w("scripts/unsafe.sh", "#!/usr/bin/env bash\n# @tag unsafe\n# @title nope\n# @fixes doc-links\n# @safe false\n");
  const rows = await links.scriptsFor(["doc-links"]);
  assert.deepEqual(rows.map((r) => r.tag), ["fix-docs"], "@safe false is never run");
  assert.deepEqual(scriptsIx.parse(path.join(root, "scripts/fix-docs.sh")).fixes, ["doc-links"]);
  assert.deepEqual(links.identifiers("rename `loadPlan` and fix readJson; also the_thing and runner.execute, not the word"), ["loadPlan", "readJson", "the_thing", "execute"]);
  assert.equal(links.locatedBlock([]), "");
  assert.match(links.locatedBlock([{ file: "src/a.js", line: 3, symbol: "a" }]), /src\/a\.js:3  a/);
  fs.rmSync(path.join(root, "scripts"), { recursive: true });
});

test("A1 runs a safe tagged script in the worktree and lands its change on the branch", async () => {
  w("scripts/touch.sh", "#!/usr/bin/env bash\n# @tag touch-it\n# @title add a file\n# @fixes doc-drift\n# @safe true\necho made > made.txt\n");
  fs.chmodSync(path.join(root, "scripts/touch.sh"), 0o755);
  sh("add", "scripts"); sh("commit", "-qm", "script");
  const rows = await links.scriptsFor(["doc-drift"]);
  const r = await autoFix({ candidates: [], scripts: rows, apply: true, date: "2026-09-26", root });
  assert.equal(r.state, "committed", JSON.stringify(r));
  assert.deepEqual(r.types, ["script:touch-it"]);
  // With a kernel on the box, it owns the worktree and the gate.
  if (kernel.available()) { assert.equal(r.worktree_via, "kernel"); assert.equal(r.gate.via, "kernel"); }
  assert.equal(sh("show", "bb/auto-fix/2026-09-26:made.txt").stdout.trim(), "made");
  assert.ok(!fs.existsSync(path.join(root, "made.txt")), "the script ran in the worktree, not the checkout");
});
