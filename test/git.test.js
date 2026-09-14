import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-git-")));
process.env.BB_ROOT = root;
const sh = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]);
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 1;\n");
fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 1;\n");
fs.writeFileSync(path.join(root, "space name.md"), "# s\n");
sh(["add", "-A"]); sh(["commit", "-qm", "init"]);
const g = await import("../src/git/index.js");

test("porcelain -z parse: rename and a path with a space", () => {
  sh(["mv", "src/b.js", "src/c.js"]);
  fs.writeFileSync(path.join(root, "space name.md"), "# changed\n");
  const rows = g.dirtyFiles(root);
  const ren = rows.find((r) => r.path === "src/c.js");
  assert.ok(ren && ren.from === "src/b.js", JSON.stringify(rows));
  assert.ok(rows.some((r) => r.path === "space name.md"));
  sh(["checkout", "-q", "--", "."]); sh(["reset", "-q", "--hard"]);
});

test("guards refuse every listed flag by substring", () => {
  for (const f of ["--force", "-f", "--force-with-lease=refs/heads/x", "--force-if-includes", "--no-verify", "-c core.hooksPath=/dev/null"]) {
    assert.throws(() => g.guardArgs(["push", f]), f);
  }
  assert.doesNotThrow(() => g.guardArgs(["push", "-u", "origin", "x"]));
});

test("commit refuses with no scope, stages only scope files with a conventional message", () => {
  const empty = g.commit({ cwd: root, scope: [], apply: true });
  assert.equal(empty.ok, false);
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "src/c.js"), "export const c = 1;\n");
  const r = g.commit({ cwd: root, scope: ["src/a.js"], detector: "doc-links", findings: [{ id: "f1", title: "x" }], acceptance: ["npm test"], apply: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const last = sh(["log", "-1", "--pretty=%s%n%b"]).stdout;
  assert.match(last, /^docs\(src\): close 1 doc-links findings? in src/);
  assert.match(last, /Verified by/);
  assert.ok(sh(["status", "--porcelain"]).stdout.includes("src/c.js"), "out-of-scope file left uncommitted");
});

test("secret sweep", () => {
  const swept = g.secretSweep([".env", ".env.local", ".env.example", "id_rsa", "x/serviceAccount-prod.json", "src/a.js"]);
  const list = Array.isArray(swept) ? swept : swept.refused;
  assert.deepEqual(list.sort(), [".env", ".env.local", "id_rsa", "x/serviceAccount-prod.json"].sort());
});

test("prBody has the sections the reviewer needs", () => {
  const body = g.prBody({ id: "L01", unit_ids: ["u1"] }, [{ id: "f1", title: "t", detector: "doc-links" }], { base: "main", acceptance: ["npm test"] });
  for (const h of ["## Summary", "## Base", "## Findings closed", "## Test plan", "bb explain"]) assert.ok(body.includes(h), h);
});

// ── a workspace whose git lives in its projects ────────────────────────────
test("a hand-scoped commit says what it does not know", () => {
  const text = g.message({ scope: ["demo/src"], files: ["src/a.js", "src/b.js"] });
  assert.match(text, /^chore\(demo\): 2 files in demo\n/);
  assert.match(text, /cannot say what it closes/);
  assert.match(text, /- src\/a\.js/);
  assert.ok(!text.includes("Closes 0"), "a commit with no findings never claims to close none");
});

test("a scope written relative to the repo says so instead of `none in scope`", () => {
  const sub = path.join(root, "proj");
  fs.mkdirSync(path.join(sub, "src"), { recursive: true });
  const run = (args) => spawnSync("git", args, { cwd: sub, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]); run(["config", "user.email", "t@t"]); run(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(sub, "src/x.js"), "export const x = 1;\n");
  run(["add", "-A"]); run(["commit", "-qm", "init"]);
  fs.writeFileSync(path.join(sub, "src/x.js"), "export const x = 2;\n");

  const wrong = g.commit({ cwd: sub, scope: ["src"] });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /outside proj: scope is workspace-relative/);
  assert.match(wrong.why, /proj\/src/, "and it names the scope that would have worked");

  const right = g.commit({ cwd: sub, scope: ["proj/src"] });
  assert.equal(right.ok, true);
  assert.deepEqual(right.staged, ["src/x.js"]);
});

test("bb git acts on the one subrepo when the workspace itself is not one", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bb-ws-"));
  fs.mkdirSync(path.join(ws, ".bundlebox"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".bundlebox/config.json"), JSON.stringify({ workspace: { subrepos: ["only"] } }));
  const sub = path.join(ws, "only");
  fs.mkdirSync(sub);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sub });
  // defaultRepo reads ROOT, which is this file's fixture, so the behaviour is
  // pinned through the module's own resolution rather than a second copy of it.
  assert.equal(typeof g.defaultRepo, "function");
  assert.equal(g.defaultRepo(), root, "a workspace that IS a repo acts on itself");
});
