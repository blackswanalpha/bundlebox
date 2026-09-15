// pinpoint.test.js — ranking, anchoring and the cut loop against a fixture
// repo whose budget is small enough that three files do not fit. BB_ROOT is set
// before any src module loads. Regions are located once on the JS path and once
// through the kernel when it is built, and must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-pinpoint-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

// A window in which one 3000-token file fits and two do not: overhead floor 25k
// + reserve 12k + payload*2.4 must stay under 60k*0.78.
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000, min_tokens: 1000 } }));
w("package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test", lint: "eslint ." } }));
const filler = (n, tag) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i}, "${tag}") + other(${i});`).join("\n");
w("src/auth.js", "export function checkPassword(p) {\n  return p.length > 8;\n}\n");
w("src/session.js", `${filler(220, "s")}\nexport function refreshSession(id) {\n  const t = loginToken(id);\n  return t;\n}\n${filler(220, "z")}\n`);
w("src/token.js", `${filler(220, "t")}\nexport function loginToken(id) {\n  return "tok-" + id;\n}\n${filler(220, "u")}\n`);
w("src/unrelated.js", "export function nothing() { return 0; }\n");
w("docs/edge-cases.md", "| id | when | then |\n|---|---|---|\n| E1 | refreshSession is called twice | the second token wins |\n| E2 | printing | irrelevant |\n");
w(".bundlebox/out/buckmaster/recommendations.md", "# recs\n\n```\n- batch independent calls\n- read the region\n```\n");

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BBK = path.join(PKG, "kernel", "target", "release", "bbk");
const kernelBuilt = fs.existsSync(BBK);

const tables = await import("../src/snapgen/tables.js");
const pinpoint = await import("../src/pinpoint/index.js");
const store = await import("../src/core/store.js");

test("terms: stoplist and camel/snake parts", () => {
  const ts = pinpoint.terms("fix the loginToken bug in refresh_session when it fails");
  assert.deepEqual(ts, ["loginToken", "login", "Token", "refresh_session", "refresh", "session"]);
});

test("build: explicit file first, symbol hits next, cut until FITS", async () => {
  process.env.BB_KERNEL = "/nonexistent";
  tables.resetRegistry();
  const b = await pinpoint.build("loginToken expires early in refreshSession", { files: ["src/auth.js"] });
  assert.equal(b.scope[0], "src/auth.js", "the explicit file ranks first");
  assert.equal(b.verdict, "FITS");
  assert.ok(b.cut.length >= 1, "at least one big file was cut");
  assert.ok(b.scope.length + b.cut.length === 3, `scope ${b.scope} cut ${b.cut}`);
  assert.ok(!b.scope.includes("src/unrelated.js"));
  assert.ok(b.projected <= b.ceiling * 0.78);
  assert.equal(b.via.symbols, "js");
  assert.ok(b.anchors.every((a) => a.via === "js"));
  const a = b.anchors.find((x) => x.symbol === "refreshSession" || x.symbol === "loginToken");
  assert.ok(a, "a region was located from a symbol hit");
  assert.ok(a.line_start > 200 && a.line_end === a.line_start + 3, `${a.line_start}-${a.line_end}`);
  assert.ok(fs.existsSync(path.join(root, b.path)));
  assert.match(b.path, /^\.bundlebox\/out\/pinpoint\/\d{8}T\d{6}Z-logintoken-expires/);
});

test("prompt: the exact section order, gates, traps, process rules", async () => {
  process.env.BB_KERNEL = "/nonexistent";
  const b = await pinpoint.build("loginToken expires early in refreshSession", { files: ["src/auth.js"] });
  const heads = b.prompt.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(heads, [
    "## Where — located already, do not search",
    "## The regions this touches — quoted, current, do not re-read the files",
    "## Scope — the only files you may edit",
    "## Evidence already on file — do not re-derive",
    "## Done when",
    "## What this brief does not settle",
    "## Traps",
    "## What is already known about these files (bb oversight, no scan on file)",
    "## Process rules this workspace measured itself needing",
    "## Do not",
  ]);
  assert.match(b.prompt, /ask before opening these: `src\/\w+\.js`/);
  assert.match(b.prompt, /    npm run lint\n    npm test   # before the PR/);
  assert.match(b.prompt, /- E1: refreshSession is called twice — the second token wins/);
  assert.doesNotMatch(b.prompt, /E2/);
  assert.match(b.prompt, /- batch independent calls\n- read the region/);
  assert.match(b.prompt, /^Reference tables, read instead of searching: `\.bundlebox\/out\/snapgen\/layout\.md` ~\d+/m);
  assert.match(b.prompt, /do not re-read the files\n\n`src\/\w+\.js` lines \d+-\d+ \(~\d+ tokens\)\n```\n/);
  // The ambiguity ledger states what the brief leaves open rather than filling
  // it in. A brief with nothing open still prints the section, because a
  // missing section reads as "not checked".
  assert.ok(b.ambiguity.score >= 0 && b.ambiguity.score <= 1);
  assert.match(b.prompt, /## What this brief does not settle\n(- nothing unresolved|Ambiguity 0\.\d+)/);
});

test("ambiguity: a brief that locates nothing and proves nothing scores higher than one that does", async () => {
  const { ambiguity } = await import("../src/pinpoint/ambiguity.js");
  const thin = ambiguity({ gates: {}, symbols: [], grep: [], anchors: [], evidence: [], scope: [], cut: [], terms: [], verdict: "HEAVY", projected: 9e5, ceiling: 1e5 });
  const full = ambiguity({ gates: { quick: "npm test" }, symbols: [{}], grep: [], anchors: [{}], evidence: [{}], scope: ["a.js"], cut: [], terms: ["a", "b"], verdict: "FITS" });
  assert.equal(full.score, 0);
  assert.equal(full.band, "low");
  assert.ok(thin.score > 0.5, `an unlocatable, ungated, evidence-free brief should score high, got ${thin.score}`);
  assert.ok(thin.reasons.some((r) => r.id === "no-gate"));
  assert.ok(thin.reasons.some((r) => r.id === "no-location"));
});

test("evidence and oversight sections read the store and the stored scan", async () => {
  store.mergeFindings([{ detector: "todo-census", severity: "low", title: "src/auth.js: 1 TODO", path: "src/auth.js", files: ["src/auth.js"], key: "src/auth.js", evidence: { n: 1 }, fix_hint: "do it" }], { detectors: new Set(["todo-census"]) });
  const ov = await import("../src/oversight/index.js");
  ov.scan({ trees: ["."] });
  const b = await pinpoint.build("checkPassword rejects valid passwords", { files: ["src/auth.js"] });
  assert.match(b.prompt, /- \[todo-census\/low\] src\/auth\.js: 1 TODO → do it/);
  assert.match(b.prompt, /## What is already known about these files \(bb oversight, \d{4}-\d{2}-\d{2}\)/);
  assert.equal(b.evidence.length, 1);
});

test("regions: the kernel locates the same range", { skip: !kernelBuilt && "kernel not built" }, () => {
  process.env.BB_KERNEL = "/nonexistent";
  const js = pinpoint.locate("src/token.js", "loginToken");
  process.env.BB_KERNEL = BBK;
  const k = pinpoint.locate("src/token.js", "loginToken");
  delete process.env.BB_KERNEL;
  assert.equal(js.via, "js");
  assert.equal(k.via, "kernel");
  assert.equal(k.line_start, js.line_start);
  assert.equal(k.line_end, js.line_end);
  assert.equal(k.text, js.text);
});
