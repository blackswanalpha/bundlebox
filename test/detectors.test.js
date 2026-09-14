// detectors.test.js — every detector against a fixture repo built in tmpdir.
// BB_ROOT is set BEFORE the modules load because paths.js computes ROOT at
// import; everything under test is imported dynamically after the fixture
// exists.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-det-")));
process.env.BB_ROOT = root;

const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const fnFile = (name, n) => Array.from({ length: n }, (_, i) => `export function ${name}${i}(a, b) {\n  if (a > b) {\n    return a - b;\n  }\n  return b - a + ${i};\n}\n`).join("\n");
const block = Array.from({ length: 12 }, (_, i) => `  const v${i} = compute(${i}, "s${i}");`).join("\n");

before(() => {
  w("package.json", JSON.stringify({ name: "fixture", type: "module", main: "src/app.js",
    dependencies: { lodash: "^4.17.21", "used-pkg": "1.0.0" }, devDependencies: { eslint: "^8.0.0" },
    scripts: { test: "node --test", lint: "eslint ." } }, null, 2));
  w("README.md", [
    "# Fixture", "",
    "See [missing](docs/missing.md) and [site](https://example.com/docs/x.md) and [anchor](#top).",
    "Details in `lib/moved.js` and `src/app.js`.",
    "This project ships 3 detectors and 2 npm scripts.",
    "", "```", "[fenced](docs/also-missing.md)", "```", "",
  ].join("\n"));
  w("src/detectors/a.js", "export default { name: 'a' };\n");
  w("src/detectors/b.js", "export default { name: 'b' };\n");
  w("src/app.js", "import used from \"used-pkg\";\nimport { moved } from \"./util/moved.js\";\nexport function main() { console.log(moved(used)); }\n");
  w("src/util/moved.js", "export function moved(x) { return x; }\n");
  // Assembled at runtime so this test file does not itself trip secret-scan.
  w("src/secrets.js", `export const aws = "${"AKIA" + "QWERTYUIOPASDFGH"}";\nexport const gh = "${"ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"}";\nexport const fake = "${"AKIA" + "EXAMPLEEXAMPLE12"}";\n`);
  w("src/dupA.js", `export function alpha() {\n${block}\n  return v0;\n}\n`);
  w("src/dupB.js", `export function beta() {\n${block}\n  return v11;\n}\n`);
  w("src/conflict.js", "export const x = 1;\n<<<<<<< HEAD\nexport const y = 2;\n=======\nexport const y = 3;\n>>>>>>> feature\n");
  w("src/big.js", fnFile("big", 70));
  for (let i = 0; i < 6; i++) w(`src/s${i}.js`, fnFile(`s${i}`, 1));
  w("src/orphan/lonely.js", "export const lonely = 1;\n");
  w("src/debug.js", "export function d(x) {\n  console.log(x);\n  debugger;\n  return x;\n}\n");
  w("src/todo.js", "// TODO: later\n// FIXME: now\nexport const t = 1;\n");
  w("test/app.test.js", "import { main } from '../src/app.js';\nmain();\n");
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("add", "."); git("commit", "-qm", "init");
});

const by = (findings, name) => findings.filter((f) => f.detector === name);

test("runAll: every registered detector runs without error", async () => {
  const { runAll, REGISTRY } = await import("../src/detectors/index.js");
  const { findings, ran } = runAll({});
  assert.equal(ran.length, Object.keys(REGISTRY).length);
  assert.deepEqual(ran.filter((r) => r.error), []);
  for (const f of findings) {
    assert.ok(f.detector && f.severity && f.precision && f.key && f.title, `shape: ${JSON.stringify(f).slice(0, 80)}`);
    assert.equal(typeof f.est_tokens, "number");
    assert.equal(f.status, "open");
  }
});

test("secret-scan: two hits in one file, values masked, placeholder skipped", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const [f] = by(runAll({ only: ["secret-scan"] }).findings, "secret-scan");
  assert.ok(f, "finding");
  assert.equal(f.path, "src/secrets.js");
  assert.equal(f.evidence.count, 2);
  assert.deepEqual(f.evidence.hits.map((h) => h.line), [1, 2]);
  assert.ok(f.evidence.hits.every((h) => h.masked.endsWith("****") && h.masked.length === 8));
  assert.ok(!JSON.stringify(f).includes("AKIA" + "QWERTYUIOPASDFGH"), "the value never reaches the finding");
  assert.equal(f.evidence.tracked, true);
  assert.equal(typeof f.evidence.sha, "string");
});

test("doc-links: flags the missing path, not the URL, anchor, fenced or existing ones", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const [f] = by(runAll({ only: ["doc-links"] }).findings, "doc-links");
  assert.ok(f);
  const targets = f.evidence.broken.map((b) => b.target).sort();
  assert.deepEqual(targets, ["docs/missing.md", "lib/moved.js"]);
  assert.equal(f.auto_fix, "fix-doc-links");
  assert.equal(f.evidence.broken.find((b) => b.target === "lib/moved.js").candidates[0], "src/util/moved.js");
});

test("duplicate-blocks: a copied 12-line block between two files", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const dups = by(runAll({ only: ["duplicate-blocks"] }).findings, "duplicate-blocks");
  const f = dups.find((x) => x.files.includes("src/dupA.js") && x.files.includes("src/dupB.js"));
  assert.ok(f, JSON.stringify(dups.map((d) => d.title)));
  assert.ok(f.evidence.shared_lines >= 24);
  assert.match(f.evidence.first.a, /^src\/dupA\.js:\d+-\d+$/);
});

test("god-file: threshold is relative to the tree's median", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const gods = by(runAll({ only: ["god-file"] }).findings, "god-file");
  assert.deepEqual(gods.map((g) => g.path), ["src/big.js"]);
  const e = gods[0].evidence;
  assert.ok(e.lines >= 3 * e.median_lines && e.lines >= 400, JSON.stringify(e));
});

test("merge-markers", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const [f] = by(runAll({ only: ["merge-markers"] }).findings, "merge-markers");
  assert.equal(f.path, "src/conflict.js");
  assert.deepEqual(f.evidence.lines, [2]);
  assert.equal(f.severity, "high");
});

test("dead-deps: lodash unused, used-pkg imported, eslint named in scripts", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const [f] = by(runAll({ only: ["dead-deps"] }).findings, "dead-deps");
  assert.deepEqual(f.evidence.deps.map((d) => d.name), ["lodash"]);
  assert.equal(typeof f.evidence.deps[0].line, "number");
});

test("doc-drift: counts only what it counted; 3 detectors claimed, 2 on disk", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const drift = by(runAll({ only: ["doc-drift"] }).findings, "doc-drift");
  assert.equal(drift.length, 1, JSON.stringify(drift.map((d) => d.title)));
  assert.equal(drift[0].evidence.claimed, 3);
  assert.equal(drift[0].evidence.counted, 2);
  assert.equal(drift[0].auto_fix, "sync-doc-counts");
});

test("debug-leftovers, todo-census, orphan-files, lockfile-drift, dead-exports", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const { findings } = runAll({ only: ["debug-leftovers", "todo-census", "orphan-files", "lockfile-drift", "dead-exports"] });
  assert.deepEqual(by(findings, "debug-leftovers").find((f) => f.path === "src/debug.js").evidence.hits.map((h) => h.line), [2, 3]);
  const todo = by(findings, "todo-census")[0];
  assert.equal(todo.severity, "info");
  assert.deepEqual(todo.evidence.counts, { TODO: 1, FIXME: 1 });
  assert.ok(by(findings, "orphan-files").some((f) => f.evidence.files.includes("src/orphan/lonely.js")));
  assert.ok(!by(findings, "orphan-files").some((f) => f.evidence.files.includes("src/util/moved.js")), "imported file is not an orphan");
  assert.equal(by(findings, "lockfile-drift")[0].key, "npm:missing");
  assert.ok(by(findings, "dead-exports").some((f) => f.path === "src/orphan/lonely.js"));
  assert.ok(!by(findings, "dead-exports").some((f) => f.path === "src/app.js"), "package.json main is a public surface");
});

test("triage: ev math, floors, judgement never promoted, critical outranks", async () => {
  const { triage, evFloor } = await import("../src/detectors/index.js");
  const cfg = { detectors: { promote_at: "medium" } };
  assert.equal(evFloor(cfg), 0.6);
  const t1 = triage({ detector: "doc-links", severity: "medium", precision: "exact", est_tokens: 5000, files: ["README.md"], evidence: {} }, cfg);
  assert.equal(t1.ev, 38);                       // 0.95 × 2 × 1 × 100k / 5k
  assert.equal(t1.promote, true);
  assert.equal(t1.model, "sonnet"); assert.equal(t1.priority, 2);
  const t2 = triage({ detector: "orphan-files", severity: "medium", precision: "heuristic", est_tokens: 300000, files: [], evidence: {} }, cfg);
  assert.equal(t2.ev, 0.4); assert.equal(t2.promote, false); assert.match(t2.reason, /expected value 0.4 below floor 0.6/);
  const t3 = triage({ detector: "todo-census", severity: "critical", precision: "exact", est_tokens: 100, evidence: {} }, cfg);
  assert.equal(t3.promote, false); assert.match(t3.reason, /report, not a task/);
  const t4 = triage({ detector: "secret-scan", severity: "critical", precision: "probe", est_tokens: 100, evidence: {} }, cfg);
  assert.equal(t4.promote, true); assert.equal(t4.model, "opus"); assert.equal(t4.priority, 0);
  const t5 = triage({ detector: "dead-deps", severity: "low", precision: "exact", est_tokens: 100, evidence: {} }, cfg);
  assert.equal(t5.promote, false); assert.match(t5.reason, /below promote_at/);
  const t6 = triage({ detector: "dead-deps", severity: "info", precision: "exact", est_tokens: 100, evidence: {} }, cfg);
  assert.match(t6.reason, /info/);
});

test("actuator fix-doc-links: dry run writes a patch and leaves the doc alone; apply rewrites", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const { actuate } = await import("../src/actuators/index.js");
  const [f] = by(runAll({ only: ["doc-links"] }).findings, "doc-links");
  const before = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const dry = actuate(f, { apply: false });
  assert.equal(dry.changed, true); assert.equal(dry.applied, false);
  assert.ok(fs.existsSync(path.join(root, dry.patch)), "patch written");
  const patch = fs.readFileSync(path.join(root, dry.patch), "utf8");
  assert.match(patch, /^--- a\/README\.md\n\+\+\+ b\/README\.md\n@@ /);
  assert.match(patch, /-Details in `lib\/moved\.js`/); assert.match(patch, /\+Details in `src\/util\/moved\.js`/);
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), before, "dry run does not write");
  assert.deepEqual(dry.declined.map((d) => d.reason.split(";")[0]), ["nothing named missing.md is where the citation says"]);
  const wet = actuate(f, { apply: true });
  assert.equal(wet.applied, true);
  assert.ok(fs.readFileSync(path.join(root, "README.md"), "utf8").includes("`src/util/moved.js`"));
});

test("actuator sync-doc-counts: rewrites the matched span only, preserving digit form", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const { actuate } = await import("../src/actuators/index.js");
  const [f] = by(runAll({ only: ["doc-drift"] }).findings, "doc-drift");
  const r = actuate(f, { apply: true });
  assert.equal(r.changed, true);
  const now = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(now.includes("ships 2 detectors and 2 npm scripts"), now);
  assert.equal(by(runAll({ only: ["doc-drift"] }).findings, "doc-drift").length, 0);
});

test("stale-evidence: an open finding whose file changed", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const store = await import("../src/core/store.js");
  const { findings } = runAll({ only: ["merge-markers"] });
  store.mergeFindings(findings, { detectors: new Set(["merge-markers"]) });
  assert.equal(by(runAll({ only: ["stale-evidence"] }).findings, "stale-evidence").length, 0);
  fs.appendFileSync(path.join(root, "src/conflict.js"), "// touched\n");
  const [s] = by(runAll({ only: ["stale-evidence"] }).findings, "stale-evidence");
  assert.ok(s); assert.equal(s.evidence.count, 1); assert.equal(s.evidence.findings[0].path, "src/conflict.js");
});
