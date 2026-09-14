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
