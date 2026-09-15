// anti-slop.test.js — each rule fires on the shape it names and stays quiet on
// the shape next to it. A pattern detector that also matches the correct code
// is a detector nobody leaves enabled.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-slop-")));
process.env.BB_ROOT = root;

const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

before(() => {
  w("package.json", JSON.stringify({ name: "slop-fixture", type: "module" }, null, 2));
  w("src/cost.js", [
    "export const names = (xs) => xs.filter((x) => x.live).map((x) => x.name);",
    "export const byId = (xs) => xs.reduce((a, x) => ({ ...a, [x.id]: x }), {});",
  ].join("\n") + "\n");
  w("src/evidence.ts", [
    "export function widen(v: string) { return v as unknown as number; }",
    "export type Bag = Record<string, unknown>;",
    "export function take(x: any) { return x; }",
    "export const pick = (c: boolean) => ({ ...(c ? { a: 1 } : {}) });",
  ].join("\n") + "\n");
  w("src/seam.js", [
    'import { vi } from "vitest";',
    'vi.mock("./cost.js");',
    "export const read = (o, k) => Reflect.get(o, k);",
  ].join("\n") + "\n");
  // The shapes that must NOT fire: one pass, a named accumulator, `as const`,
  // a real optional field, a finite-key record, and the patterns in a comment.
  w("src/clean.js", [
    "export const names = (xs) => xs.flatMap((x) => (x.live ? [x.name] : []));",
    "export const byId = (xs) => xs.reduce((a, x) => { a[x.id] = x; return a; }, {});",
    "// .filter(x => x).map(x => x) and Reflect.get(o, k) in a comment are prose.",
  ].join("\n") + "\n");
  w("src/clean.ts", [
    "export const MODES = ['a', 'b'] as const;",
    "export type Counts = Record<'a' | 'b', number>;",
    "export function size(v: string): number { return v.length; }",
  ].join("\n") + "\n");
});

const hitsFor = (out, file) => {
  const f = out.find((x) => (x.files || [])[0] === file);
  return f ? f.evidence.rules : {};
};

test("each rule fires on the shape it names", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const r = await runAll({ only: ["anti-slop"] });
  const out = r.findings;
  const cost = hitsFor(out, "src/cost.js");
  assert.equal(cost["filter-then-map"], 1);
  assert.equal(cost["reduce-accumulator-copy"], 1);

  const ev = hitsFor(out, "src/evidence.ts");
  assert.equal(ev["chained-assertion"], 1);
  assert.equal(ev["open-dictionary"], 1);
  assert.equal(ev["any-contract"], 1);
  assert.equal(ev["conditional-empty-spread"], 1);

  const seam = hitsFor(out, "src/seam.js");
  assert.equal(seam["module-mock"], 1);
  assert.equal(seam["reflect-escape"], 1);
});

test("the correct shape next to each one stays quiet, and a comment is prose", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const out = (await runAll({ only: ["anti-slop"] })).findings;
  assert.deepEqual(hitsFor(out, "src/clean.js"), {});
  assert.deepEqual(hitsFor(out, "src/clean.ts"), {});
});

test("one hit of one rule is info, so it can never be promoted into work", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const out = (await runAll({ only: ["anti-slop"] })).findings;
  const seam = out.find((x) => (x.files || [])[0] === "src/seam.js");
  const evidence = out.find((x) => (x.files || [])[0] === "src/evidence.ts");
  assert.equal(evidence.severity, "medium", "four rules in one file is a habit");
  assert.ok(["low", "info"].includes(seam.severity));
});

test("TypeScript-only rules do not fire on JavaScript", async () => {
  const { runAll } = await import("../src/detectors/index.js");
  const out = (await runAll({ only: ["anti-slop"] })).findings;
  for (const f of out.filter((x) => (x.files || [])[0].endsWith(".js"))) {
    for (const k of ["chained-assertion", "open-dictionary", "any-contract"]) {
      assert.equal(f.evidence.rules[k], undefined, `${k} fired on ${f.files[0]}`);
    }
  }
});
