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
    "## Where — located",
    "## The regions this touches — quoted, current",
    "## Scope — the only files you may edit",
    // Ranked candidates the budget could not afford are NAMED rather than
    // dropped: naming one costs about fifteen tokens, budgeting one costs its
    // whole size times churn. Measured on SWE-bench Verified, the file the fix
    // belonged in was usually just outside the scope.
    "## If the scope does not hold it — ranked, not budgeted",
    "## Evidence already on file",
    "## Done when",
    "## Traps",
    "## What is already known about these files (bb oversight, no scan on file)",
    "## What this brief does not settle",
  ]);
  assert.match(b.prompt, /ask before opening these: `src\/\w+\.js`/);
  assert.match(b.prompt, /    npm run lint\n    npm test   # before the PR/);
  assert.match(b.prompt, /- E1: refreshSession is called twice — the second token wins/);
  assert.doesNotMatch(b.prompt, /E2/);
  assert.match(b.prompt, /- batch independent calls\n- read the region/);
  assert.match(b.prompt, /^Reference tables, read instead of searching: `\.bundlebox\/out\/snapgen\/layout\.md` ~\d+/m);
  assert.match(b.prompt, /quoted, current\n\n`src\/\w+\.js` lines \d+-\d+ \(~\d+ tokens\)\n```\n/);
  // The ambiguity ledger states what the brief leaves open rather than filling
  // it in. A brief with nothing open still prints the section, because a
  // missing section reads as "not checked".
  assert.ok(b.ambiguity.score >= 0 && b.ambiguity.score <= 1);
  assert.match(b.prompt, /## What this brief does not settle\n(- nothing unresolved|Ambiguity 0\.\d+)/);
});

// ── the order is the cache ──────────────────────────────────────────────────
//
// Measured 2026-09-18: two briefs for different tasks shared 1,594 of 3,350
// characters, all of them AFTER the task-specific sections, so no run could
// cache them. The shared part now leads, and the problem statement is the
// first byte that differs.
test("two briefs for different tasks share a byte-identical prefix that ends at the problem statement", async () => {
  process.env.BB_KERNEL = "/nonexistent";
  const { PREAMBLE } = await import("../src/wire/brief.js");
  const a = await pinpoint.build("loginToken expires early in refreshSession", { files: ["src/auth.js"] });
  const b = await pinpoint.build("checkPassword rejects valid passwords", { files: ["src/auth.js"] });
  assert.ok(a.prompt.startsWith(PREAMBLE + "\n"), "the brief opens with the shared preamble");
  let i = 0;
  while (i < a.prompt.length && a.prompt[i] === b.prompt[i]) i++;
  const shared = a.prompt.slice(0, i);
  assert.ok(shared.length > PREAMBLE.length + 40, `shared prefix is ${shared.length} chars; the tables and process rules belong in it too`);
  assert.ok(shared.includes("Reference tables, read instead of searching"));
  assert.ok(shared.includes("- batch independent calls"));
  assert.match(a.prompt.slice(i - 3), /^\n# /, "the first differing byte is the problem statement's title");
  assert.doesNotMatch(a.prompt, /## Do not/, "the policy list lives in the preamble now, once, ahead of the varying part");
});

// ── the change, not only the coordinates ─────────────────────────────────────
test("proposals: a statement that spells the edit out yields one diff when the old text sits in exactly one located region", async () => {
  process.env.BB_KERNEL = "/nonexistent";
  const b = await pinpoint.build("refreshSession returns a stale token: change `loginToken(id)` to `loginToken(id, { fresh: true })`", { files: ["src/session.js"] });
  assert.equal(b.proposals.length, 1, JSON.stringify(b.proposals));
  const p = b.proposals[0];
  assert.equal(p.file, "src/session.js");
  assert.equal(p.from, "loginToken(id)");
  assert.match(p.diff, /^--- a\/src\/session\.js\n\+\+\+ b\/src\/session\.js\n@@ -\d+,\d+ \+\d+,\d+ @@\n/);
  assert.match(p.diff, /\n-  const t = loginToken\(id\);\n\+  const t = loginToken\(id, \{ fresh: true \}\);\n/);
  assert.match(b.prompt, /## Proposed change — apply it, then run the gate\n\n`src\/session\.js:\d+` in `refreshSession`: `loginToken\(id\)` → `loginToken\(id, \{ fresh: true \}\)`/);
  assert.match(b.prompt, /```diff\n--- a\/src\/session\.js/);
  // The band names it, so the session knows the brief carries the change
  // before it opens anything.
  const brief = await import("../src/wire/brief.js");
  const band = brief.band(brief.record(b));
  assert.match(band, /proposed change, as a diff in the brief: src\/session\.js:\d+ — `loginToken\(id\)` → `loginToken\(id, \{ fresh: true \}\)`/);
});

test("proposals: an old text that matches nowhere, or in two places, yields no diff and no section", () => {
  const anchors = [
    { path: "a.js", symbol: "f", line_start: 10, line_end: 12, text: "function f() {\n  return x + 1;\n}", tokens: 10 },
    { path: "b.js", symbol: "g", line_start: 20, line_end: 22, text: "function g() {\n  return x + 1;\n}", tokens: 10 },
  ];
  assert.deepEqual(pinpoint.proposals({ problem: "change `x + 1` to `x + 2`", anchors }), [], "two regions match: a choice, not a diff");
  assert.deepEqual(pinpoint.proposals({ problem: "change `y` to `z`", anchors }), [], "nothing matches");
  assert.deepEqual(pinpoint.statedEdits("make it faster"), [], "no spans, no edits");
  assert.deepEqual(pinpoint.statedEdits("`a` -> `b`; rename `c` to `d`; replace `e` with `f`; `g` should be `h`"),
    [{ from: "a", to: "b" }, { from: "e", to: "f" }, { from: "c", to: "d" }, { from: "g", to: "h" }]);
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

// ── specificity: what a term's rarity is worth ───────────────────────────────
//
// The miss these lock down was measured on bundlebox itself. "wire the pre-read
// guard so it denies a read the pinpoint brief already quotes" ranked three
// unrelated files first — each declaring a symbol exactly called `read`, `guard`
// or `brief` — and never put `src/wire/hooks.js` in scope at all.

const rankmod = await import("../src/pinpoint/rank.js");

test("termWeights: a term in one file outweighs a term in many", () => {
  const sym = [
    { file: "a.js", symbol: "read", term: "read" },
    { file: "b.js", symbol: "readOrNull", term: "read" },
    { file: "c.js", symbol: "read", term: "read" },
    { file: "d.js", symbol: "refreshSession", term: "refreshSession" },
  ];
  const w = rankmod.termWeights(sym);
  assert.ok(w.get("refreshsession") > w.get("read"), "the rare term is worth more");
  assert.ok(w.get("read") >= rankmod.MIN_TERM, "and the common one is never worth nothing");
  assert.equal(w.get("refreshsession"), 1, "a term in exactly one file keeps its full weight");
});

test("a loose match on a rare word outranks an exact match on a common one", () => {
  const sym = [
    { file: "src/slop/index.js", symbol: "read", term: "read", line: 1 },
    { file: "src/tokens/ledger.js", symbol: "read", term: "read", line: 1 },
    { file: "src/auditor/charter.js", symbol: "read", term: "read", line: 1 },
    { file: "src/wire/hooks.js", symbol: "preRead", term: "read", line: 1 },
    { file: "src/wire/hooks.js", symbol: "sessionStart", term: "session", line: 1 },
  ];
  const order = rankmod.rank("the read guard in the session hooks", { sym });
  assert.equal(order[0], "src/wire/hooks.js", "two terms, one of them rare, beats three exact matches on a common name");
});

test("informative: a noisy index does not count as an answer", () => {
  const noisy = Array.from({ length: 20 }, (_, i) => ({ file: `f${i}.js`, symbol: "read", term: "read" }));
  assert.equal(rankmod.informative(noisy), 0, "twenty files matching one common term is vocabulary, not localisation");
  assert.ok(rankmod.informative([...noisy, { file: "x.js", symbol: "refreshSession", term: "refreshSession" }]) > 0);
});

test("components names every directory and the basename stem", () => {
  assert.deepEqual(rankmod.components("src/wire/hooks.js"), ["src", "wire", "hooks"]);
  assert.deepEqual(rankmod.components("a.py"), ["a"]);
});

test("pathWeights: a directory naming four files beats one naming every file", () => {
  const universe = ["src/wire/hooks.js", "src/wire/index.js", "src/wire/brief.js", "src/janitor/sweep.js", "src/tokens/ledger.js"];
  const { hits, w } = rankmod.pathWeights(["wire", "src", "sweep"], universe);
  assert.equal(hits.get("wire").length, 3);
  assert.ok(w.get("sweep") > w.get("wire"), "one file beats three");
  assert.ok(w.get("wire") > w.get("src"), "three files beat all five");
});

test("the path puts a file in the ranking with no symbol hit at all", () => {
  const universe = ["src/wire/hooks.js", "src/monitor/window.js"];
  const order = rankmod.rank("the wire hooks", { sym: [{ file: "src/monitor/window.js", symbol: "guard", term: "guard" }], terms: ["wire", "hooks"], universe });
  assert.equal(order[0], "src/wire/hooks.js", "two path components name it; nothing else does");
});

test("an explicit file stays first even when the path evidence names another", () => {
  const universe = ["src/auth.js", "src/session.js"];
  const order = rankmod.rank("loginToken expires early in refreshSession", {
    explicit: ["src/auth.js"],
    sym: [{ file: "src/session.js", symbol: "refreshSession", term: "refreshSession" }],
    terms: ["session", "refreshSession"], universe,
  });
  assert.deepEqual(order, ["src/auth.js", "src/session.js"]);
});
