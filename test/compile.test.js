// compile.test.js — anchors, context, brief, compiler against a temp fixture repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ROOT is fixed at import time, so the fixture must exist and BB_ROOT must
// point at it BEFORE any src module is loaded.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-compile-"));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

w("package.json", JSON.stringify({ name: "fixture", scripts: { test: "node --test", lint: "eslint ." } }));
w("src/util.js", `// util
export function first(a) {
  return a[0];
}

export function second(a) {
  const o = { x: "}" }; // brace in a string
  if (a.length > 1) {
    return a[1];
  }
  return null;
}
export const T = 1;
`);
w("src/model.py", `import os

class Model:
    """A class with a } in its docstring."""
    def __init__(self, n):
        self.n = n

    def double(self):
        return self.n * 2


def helper():
    return 1
`);
w("README.md", "# Title\n\n## Install\n\nrun it\n\n```\n## not a heading\n```\n\n## Usage\n\nuse it\n");
const big = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i} + ${i};`).join("\n") + "\n";
w("big/a/one.js", big(3500));
w("big/a/two.js", big(3500));
w("big/b/three.js", big(3500));

const anc = await import("../src/compile/anchors.js");
const context = await import("../src/compile/context.js");
const brief = await import("../src/compile/brief.js");
const compiler = await import("../src/compile/compiler.js");

test("locate: a JS function with a brace inside a string", () => {
  const a = anc.locate(path.join(root, "src/util.js"), "second");
  assert.ok(a);
  assert.equal(a.path, "src/util.js");
  assert.equal(a.line_start, 6);
  assert.equal(a.line_end, 12);
  assert.ok(a.tokens > 0);
  assert.ok(a.text.startsWith("export function second"));
});

test("locate: a Python class ends before the next top-level def", () => {
  const a = anc.locate("src/model.py", "Model");
  assert.ok(a);
  assert.equal(a.line_start, 3);
  assert.equal(a.line_end, 9);
  const m = anc.locate("src/model.py", "double");
  assert.equal(m.line_start, 8);
  assert.equal(m.line_end, 9);
});

test("locate: markdown heading section skips fenced fake headings", () => {
  const a = anc.locate("README.md", "Install");
  assert.equal(a.line_start, 3);
  assert.equal(a.line_end, 9);
});

test("locate: null for a missing symbol and a missing file, never a guess", () => {
  assert.equal(anc.locate("src/util.js", "nope"), null);
  assert.equal(anc.locate("src/missing.js", "first"), null);
  assert.equal(anc.rangeAnchor("src/util.js", "abc", 3), null);
  assert.equal(anc.rangeAnchor("src/util.js", 50, 60), null);
});

test("excerpt: the tail never reports a negative remainder", () => {
  const dense = { path: "x.js", symbol: "s", line_start: 1, line_end: 3, text: "a\nb\nc", tokens: 5000 };
  const e = anc.excerpt(dense);
  assert.ok(!/-\d+ more lines/.test(e));
  assert.ok(e.endsWith("a\nb\nc"));
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const long = { path: "x.js", symbol: "s", line_start: 10, line_end: 109, text: lines, tokens: 3200 };
  const t = anc.excerpt(long);
  const m = /\.\.\. (\d+) more lines — read x\.js offset (\d+) limit (\d+)$/.exec(t);
  assert.ok(m);
  assert.equal(m[1], "50"); assert.equal(m[2], "60"); assert.equal(m[3], "50");
});

test("payload: an anchored file costs region + widen * rest, never more than whole", () => {
  const a = anc.locate("src/util.js", "second");
  const p = anc.payload(["src/util.js", "src/model.py"], [a]);
  const whole = p.whole_total - p.files["src/model.py"];
  assert.ok(p.files["src/util.js"] <= whole);
  assert.equal(p.saved, whole - p.files["src/util.js"]);
  assert.deepEqual(p.anchored, ["src/util.js"]);
});

test("evaluate: FITS for a small scope and the parts add up", () => {
  const ev = context.evaluate(["src/util.js"], { brief: "do it", kind: "fix" });
  assert.equal(ev.verdict, "FITS");
  const p = ev.parts;
  assert.equal(ev.projected, Math.floor(p.overhead + p.brief + p.payload * 2.4 + p.reserve_output));
  assert.equal(p.overhead, 25000);
  assert.equal(p.reserve_output, 12000);
  assert.equal(ev.headroom, ev.ceiling - ev.projected);
});

test("evaluate: SPLIT when three large files overflow, and every file lands in a part", () => {
  const scope = ["big/a/one.js", "big/a/two.js", "big/b/three.js"];
  const ev = context.evaluate(scope, { kind: "fix" });
  assert.equal(ev.verdict, "SPLIT");
  assert.ok(ev.projected > ev.ceiling);
  assert.ok(ev.split.length >= 2);
  assert.deepEqual(ev.split.flat().sort(), scope);
});

test("split: directory groups stay whole when they fit", () => {
  const parts = context.split({ "a/x": 12, "a/y": 8, "b/x": 12, "b/y": 8 }, 25);
  assert.deepEqual(parts, [["a/x", "a/y"], ["b/x", "b/y"]]);
  // A group alone over the cap breaks, and only then by size.
  const broken = context.split({ "a/x": 20, "a/y": 20, "b/x": 5 }, 25);
  assert.equal(broken.length, 2);
  assert.ok(broken.every((p) => p.reduce((s, f) => s + ({ "a/x": 20, "a/y": 20, "b/x": 5 })[f], 0) <= 25));
});

test("cap: wraps unless the command already ends with a tail/head bound", () => {
  assert.equal(brief.cap("npm test | tail -n 20"), "npm test | tail -n 20");
  assert.equal(brief.cap("npm test | head -c 100 | sort"), "set -o pipefail; { npm test | head -c 100 | sort ; } 2>&1 | tail -c 4000");
  assert.equal(brief.cap(""), "");
});

test("brief: collapse and cacheStablePrefix", () => {
  assert.deepEqual(brief.collapse(["add 'x' to answers-screen table", "add 'x' to people-screen table"]),
    ["add 'x' to <per item above>-screen table"]);
  assert.equal(brief.collapse(["totally different", "not alike at all"]).length, 2);
  const b = brief.build({ title: "t", findings: [{ title: "f", evidence: { k: 1 } }], scope: ["src/util.js"], acceptance: "true" });
  assert.ok(b.endsWith(brief.GUARDRAILS));
  const s = brief.cacheStablePrefix(b);
  assert.ok(s.startsWith(brief.GUARDRAILS));
  assert.equal(s.split("Constraints:").length, 2);
  assert.ok(s.includes("# t"));
});

test("detectGates: package.json scripts become gates, lint is quick", () => {
  const g = compiler.detectGates(root);
  assert.equal(g.quick, "npm run lint");
  assert.equal(g.test, "npm test");
  assert.equal(g.source, "package.json");
});

test("compileUnits: two findings of one detector in one dir become one unit with hoisted evidence", async () => {
  const findings = [
    { id: "f1", detector: "dead-exports", severity: "critical", title: "second is unused", path: "src/util.js", files: ["src/util.js"],
      key: "src/util.js#second", detail: "no importer references it", evidence: { table: "exports", symbols: ["second"], count: 1 },
      fix_hint: "remove the export of second", kind: "fix", status: "open" },
    { id: "f2", detector: "dead-exports", severity: "critical", title: "first is unused", path: "src/util.js", files: ["src/util.js"],
      key: "src/util.js#first", detail: "no importer references it", evidence: { table: "exports", symbols: ["first"], count: 1 },
      fix_hint: "remove the export of first", kind: "fix", status: "open" },
    { id: "f3", detector: "dead-exports", severity: "info", title: "ignored", path: "src/util.js", files: ["src/util.js"], key: "k", evidence: {}, status: "open" },
  ];
  const units = await compiler.compileUnits(findings);
  assert.equal(units.length, 1);
  const u = units[0];
  assert.deepEqual(u.finding_ids.sort(), ["f1", "f2"]);
  assert.deepEqual(u.scope, ["src/util.js"]);
  assert.equal(u.verdict, "FITS");
  assert.equal(u.est_tokens, u.projected);
  assert.ok(u.brief.includes("Common to every item below:\n  count: 1\n  table: exports"));
  assert.ok(u.brief.includes("Procedure: remove the export of <per item above>"));
  assert.ok(u.brief.includes("## The regions this touches"));
  assert.equal(u.anchors.length, 2);
  assert.ok(u.anchors.every((a) => !("text" in a)));
  assert.ok(u.acceptance.startsWith("npm run lint && bb scan --only dead-exports --json"));
  assert.ok(u.brief.includes("set -o pipefail; { npm run lint && bb scan"));
  assert.equal(u.unproven, false);
  assert.equal(u.prior, null);
  assert.equal(u.status, "ready");
});

test("compileUnits: an oversized group is split into parts that name their index", async () => {
  const mk = (i, p) => ({ id: `g${i}`, detector: "god-file", severity: "high", title: `${p} is huge`, path: p, files: [p], key: p,
    evidence: { lines: 3500 }, kind: "fix", status: "open" });
  const units = await compiler.compileUnits([mk(1, "big/a/one.js"), mk(2, "big/a/two.js"), mk(3, "big/b/three.js")]);
  assert.ok(units.length >= 2);
  assert.ok(units.every((u) => /\[\d+\/\d+\]$/.test(u.title)));
  assert.ok(units.every((u) => u.brief.includes(`This is part ${u.part[0]} of ${u.part[1]}`)));
  assert.deepEqual(units.flatMap((u) => u.scope).sort(), ["big/a/one.js", "big/a/two.js", "big/b/three.js"]);
});
