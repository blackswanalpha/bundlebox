// oversight.test.js — metrics, rules, guidelines against a fixture tree.
// BB_ROOT is set before any src module loads. Duplication runs once on the JS
// path (BB_KERNEL pointed at nothing) and once through the kernel when it is
// built, so the two window passes are pinned to the same pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-oversight-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

// Twelve ordinary files set the medians; one copied block, one vibe-coded file.
const plain = (i) => `export function f${i}(a) {\n  if (a) {\n    return a + 1;\n  }\n  return 0;\n}\n\nexport function g${i}(b) {\n  return b * 2;\n}\n`;
for (let i = 0; i < 12; i++) w(`src/plain${i}.js`, plain(i));
const block = Array.from({ length: 16 }, (_, i) => `  const v${i} = compute(${i}, "s${i}") + other(v${Math.max(0, i - 1)});`).join("\n");
w("src/copy_a.js", `export function alpha() {\n${block}\n  return v15;\n}\n`);
w("src/copy_b.js", `export function beta() {\n${block}\n  return v15;\n}\n`);
const vibe = ["export function messy(x) {"];
// Sixty code lines (the vibe rule ignores shorter files) with a mark on most of them.
for (let i = 0; i < 30; i++) vibe.push(`  // const value${i} = x + ${i + 3}`, `  const value${i} = x + ${i + 3};`, `  let other${i} = value${i} * 7; // TODO handle ${i}`);
vibe.push("  return 0;", "}", "function messyV2() { return 1; }", "");
w("src/vibe.js", vibe.join("\n"));
w("src/model.py", "import os\n\nclass A:\n\tdef run(self):\n\t\tif self:\n\t\t\tfor x in []:\n\t\t\t\tpass\n\t\treturn 1\n\n\ndef helper():\n    return 2\n");
w("src/two.py", "def a():\n  if x:\n    if y:\n      return 1\n  return 2\n\n\ndef b():\n  return 3\n");
w("package.json", JSON.stringify({ name: "fixture", type: "module" }));

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BBK = path.join(PKG, "kernel", "target", "release", "bbk");
const kernelBuilt = fs.existsSync(BBK);

const metrics = await import("../src/oversight/metrics.js");
const rules = await import("../src/oversight/rules.js");
const guidelines = await import("../src/oversight/guidelines.js");
const ov = await import("../src/oversight/index.js");

test("metrics: functions, longest function and brace depth on JS", () => {
  const m = metrics.measure("src/plain0.js");
  assert.equal(m.functions, 2);
  assert.equal(m.fn_max, 6);
  assert.equal(m.max_depth, 2);
  assert.equal(m.decls, 2);
  const s = metrics.measure("x.js", `function a() {\n  const s = "}";\n  if (s) { /* { */\n    return 1;\n  }\n}\n`);
  assert.equal(s.max_depth, 2, "braces in strings and comments do not count");
  assert.equal(s.fn_max, 6);
});

test("metrics: python with tabs and with a 2-space unit", () => {
  const tabs = metrics.measure("src/model.py");
  assert.equal(tabs.functions, 2);
  assert.equal(tabs.max_depth, 4);
  assert.equal(tabs.fn_max, 5);
  const two = metrics.measure("src/two.py");
  assert.equal(two.functions, 2);
  assert.equal(two.max_depth, 3);
  assert.equal(two.fn_max, 5);
});

test("metrics: every mark kind counts toward mark_total", () => {
  const m = metrics.measure("m.js", [
    "// set the user id", "const userId = x;",
    "function a() { try { x(); } catch (e) {} }",
    "// const old = 3;",
    "const n = y * 42; // eslint-disable-line",
    "// TODO later",
    "function fooV2() {}", "function foo() {}", "",
  ].join("\n"));
  assert.equal(m.narration, 1);
  assert.equal(m.swallows, 1);
  assert.equal(m.commented_code, 1);
  assert.equal(m.suppressions, 1);
  assert.equal(m.deferred, 1);
  assert.equal(m.twins, 1);
  assert.equal(m.magic, 1);
  assert.equal(m.mark_total, 7);
  assert.equal(metrics.measure("t.test.js", "const n = 42;\n").magic, 0, "tests are not measured for magic numbers");
});

test("rules: vibe-coded fires with the ratio capped at 20x", () => {
  const doc = rules.scan({ trees: ["."] });
  const v = doc.findings.filter((f) => f.detector === "oversight:vibe-coded");
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "src/vibe.js");
  assert.match(v[0].title, />20x this tree's median of 0\.5/);
  assert.equal(v[0].evidence.ratio, 20);
  assert.equal(v[0].evidence.ratio_capped, true);
  assert.match(v[0].title, /narration/);
  assert.ok(fs.existsSync(path.join(root, ".bundlebox/out/oversight/latest.json")));
  assert.ok(fs.existsSync(metrics.cachePath()));
});

test("rules: duplication finds the copied block on the JS path", () => {
  process.env.BB_KERNEL = "/nonexistent";
  const doc = rules.scan({ trees: ["."] });
  assert.equal(doc.via.dupes, "js");
  const d = doc.findings.filter((f) => f.detector === "oversight:duplication");
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].files, ["src/copy_a.js", "src/copy_b.js"]);
  assert.ok(d[0].evidence.shared_lines >= 24, String(d[0].evidence.shared_lines));
  assert.match(d[0].title, /share \d+ normalised lines/);
});

test("rules: the kernel finds the same pair", { skip: !kernelBuilt && "kernel not built" }, () => {
  process.env.BB_KERNEL = "/nonexistent";
  const js = rules.scan({ trees: ["."] }).findings.find((f) => f.detector === "oversight:duplication");
  process.env.BB_KERNEL = BBK;
  const doc = rules.scan({ trees: ["."] });
  assert.equal(doc.via.dupes, "kernel");
  const k = doc.findings.find((f) => f.detector === "oversight:duplication");
  assert.ok(k);
  assert.deepEqual(k.files, js.files);
  assert.equal(k.evidence.shared_lines, js.evidence.shared_lines);
  delete process.env.BB_KERNEL;
});

test("rules: headline quotes the numbers that drove the verdict; thresholds are overridable", () => {
  const doc = rules.latest();
  const t = rules.thresholds({ oversight: { vibe_ratio_cap: 5, thresholds: { dupe_pair_lines: 30 } } });
  assert.equal(t.vibe_ratio_cap, 5);
  assert.equal(t.dupe_pair_lines, 30);
  assert.equal(t.god_lines_floor, rules.DEFAULT_THRESHOLDS.god_lines_floor);
  const again = rules.decide({ ...doc, thresholds: t, dupes: doc.dupes });
  assert.match(again.find((f) => f.detector === "oversight:vibe-coded").title, />5x/);
  for (const f of doc.findings) {
    assert.match(f.detector, /^oversight:/);
    assert.ok(f.evidence && Object.keys(f.evidence).length, "a finding carries evidence");
    assert.ok(/\d/.test(f.title), "the headline carries a number");
  }
});

test("scan --write merges into the store with the oversight detectors", async () => {
  const doc = ov.scan({ trees: ["."], write: true });
  const store = await import("../src/core/store.js");
  const open = store.openFindings().filter((f) => f.detector.startsWith("oversight:"));
  assert.equal(open.length, doc.findings.length);
  assert.ok(open.every((f) => f.seen_count >= 1 && f.id));
});

test("guidelines: text quotes the tree's own median and only rules with hits are written", async () => {
  const doc = rules.latest();
  const r = await guidelines.build(doc);
  const names = r.rows.map((x) => x.name).sort();
  assert.deepEqual(names, ["bloat", "duplication", "vibe-coded"]);
  const bloat = fs.readFileSync(path.join(guidelines.DIR, "bloat.md"), "utf8");
  assert.match(bloat, new RegExp(`median longest function is ${doc.base["."].median_fn_max} lines`));
  const vibe = fs.readFileSync(path.join(guidelines.DIR, "vibe-coded.md"), "utf8");
  const med = Math.max(doc.base["."].median_mark_density, 0.5);
  assert.match(vibe, new RegExp(`median mark density is ${med}`));
  assert.match(vibe, /^## Evidence in this tree$/m);
  assert.match(vibe, /^## Why$/m);
  assert.match(vibe, /^## While writing$/m);
  assert.match(vibe, /src\/vibe\.js/);
  assert.ok(!fs.existsSync(path.join(guidelines.DIR, "god-file.md")));
  assert.ok(fs.existsSync(path.join(guidelines.DIR, "INDEX.md")));
  const lines = fs.readFileSync(guidelines.agentLinesPath(), "utf8");
  assert.match(lines, /never inserted|Nothing here is inserted/);
  assert.match(lines, /<!-- 1 file\(s\) -->/);
});

test("brief: under 300 tokens and about the named files only", async () => {
  const estimate = await import("../src/tokens/estimate.js");
  const b = guidelines.brief(["src/vibe.js", "src/copy_a.js", "src/nope.js"]);
  assert.ok(estimate.text(b, "prose") <= 300);
  assert.match(b, /src\/vibe\.js: \d+ lines/);
  assert.match(b, /vibe-coded/);
  assert.match(b, /shares \d+ lines with src\/copy_b\.js/);
  assert.match(b, /src\/nope\.js: not in the last scan/);
});
