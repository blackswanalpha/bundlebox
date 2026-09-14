// gates.test.js — `kernel.gates` in both shapes, and the scope a gate runs in.
// A workspace of projects has one gate per project and none at the top; the
// per-directory shape is the documented one and used to merge into nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gates-"));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), typeof s === "string" ? s : JSON.stringify(s, null, 2)); };

w("demo/package.json", { name: "demo", scripts: { test: "node --test" } });
w("demo/src/a.js", "export const a = 1;\n");
w(".bundlebox/config.json", {
  kernel: { gates: { demo: { quick: "npm test", full: "npm run lint && npm test" },
                     ".": { quick: "node selftest.mjs" } } },
});

const { detectGates, userGates, compileUnits } = await import("../src/compile/compiler.js");
const { load } = await import("../src/core/config.js");
// load() is cached per process, so a test that rewrites the config has to say so.
const reload = () => load({ fresh: true });
reload();

test("a per-directory config resolves per directory", () => {
  assert.equal(detectGates(root, "demo").quick, "npm test");
  assert.equal(detectGates(root, "demo").scope, "demo");
  assert.equal(detectGates(root, "demo/src").quick, "npm test", "the most specific declared scope wins");
  assert.equal(detectGates(root, ".").quick, "node selftest.mjs");
  assert.equal(detectGates(root, "other").quick, "node selftest.mjs", "an undeclared scope falls back to the root");
});

test("a flat config still works and is read as the root's", () => {
  w(".bundlebox/config.json", { kernel: { gates: { quick: "make check" } } });
  reload();
  assert.deepEqual(Object.keys(userGates()), ["."]);
  assert.equal(detectGates(root, "demo").quick, "make check");
});

test("a unit takes its gate to the directory the gate was declared for", async () => {
  w(".bundlebox/config.json", { kernel: { gates: { demo: { quick: "npm test" } } }, detectors: { promote_at: "low" } });
  reload();
  const units = await compileUnits([{
    id: "f1", detector: "merge-markers", severity: "high", precision: "exact", kind: "fix",
    title: "demo/src/a.js: something", path: "demo/src/a.js", files: ["demo/src/a.js"], key: "demo/src/a.js",
    detail: "x", evidence: { n: 1 }, status: "open", est_tokens: 100,
  }]);
  assert.equal(units.length, 1);
  assert.match(units[0].acceptance, /^\(cd "demo" && npm test\)/,
    "acceptance runs at the lane's cwd, so a sub-directory gate has to be taken there");
});

// ── a workspace of projects ────────────────────────────────────────────────
// No manifest at the top, one per project, git per project. `bb init` used to
// report "no manifest" and "no gates detected" over exactly this shape.
test("detectRepo finds the projects and the subrepos, not just the root", async () => {
  const { detectRepo } = await import("../src/init.js");
  w("storybook/build.mjs", "console.log(1);\n");                 // a directory, no manifest
  w("api/pyproject.toml", "[project]\nname = 'api'\n");
  fs.mkdirSync(path.join(root, "demo", ".git"), { recursive: true });
  const r = detectRepo(root);
  assert.deepEqual(r.manifests, [], "nothing at the top");
  assert.deepEqual(r.projects.map((p) => p.dir), ["api", "demo"]);
  assert.deepEqual(r.projects.find((p) => p.dir === "api").ecosystems, ["python"]);
  assert.deepEqual(r.subrepos, ["demo"], "git lives in the project, not the workspace");
  assert.equal(r.git, false);
});

test("a project's gate is detected in the project, and runs there", () => {
  w(".bundlebox/config.json", {});
  reload();
  const g = detectGates(root, "demo");
  assert.equal(g.quick, "npm test");
  assert.equal(g.source, "package.json");
  assert.equal(g.scope, "demo", "so the command is taken to the directory that proves itself");
  const api = detectGates(root, "api");
  assert.equal(api.quick, "pytest -q");
  assert.equal(api.scope, "api");
});

test("a directory that is not a project is proven the way the workspace is", () => {
  const g = detectGates(root, "storybook");
  assert.equal(g.scope, ".", "the fallback gate belongs at the root, and runs there");
});

test("a unit in a subrepo names it, so the lane can get a worktree", async () => {
  const { repoOf } = await import("../src/compile/compiler.js");
  assert.equal(repoOf("demo/src/a.js"), "demo");
  assert.equal(repoOf("storybook/build.mjs"), ".", "no .git above it");
});
