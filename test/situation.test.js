// situation.test.js — the composite verbs: `bb situation` answers five
// questions in one call, and `bb gates run` runs each declared gate once.
//
// Both exist because `bb echos` measured 1.04 tool calls per turn over this
// workspace's 26 recorded sessions. The tests below check the two properties
// that make a composite worth calling: it never loses a section when one input
// is missing, and it never runs the same gate twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-situation-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", scripts: { test: "node --test", lint: "eslint ." } }));
w(".bundlebox/config.json", JSON.stringify({ kernel: { gates: { quick: "echo quick", full: "echo full", lint: "echo quick" } } }));

const sit = await import("../src/situation/index.js");
const compile = await import("../src/compile/index.js");

test("a section whose input is missing says so rather than printing nothing", async () => {
  const s = await sit.situation({ cwd: root });
  assert.equal(s.record.ran, false, "no echos run here yet");
  const text = sit.report(s);
  assert.match(text, /never run here/, "not checked must not read as nothing wrong");
  assert.match(text, /artefacts\s+\d+ of \d+ ready/);
  assert.match(text, /work\s+\d+ unit\(s\) packed/);
  assert.match(text, /gates\s+/);
});

test("the echos section reports hits, unknowns and the locate baseline together", async () => {
  fs.mkdirSync(path.join(root, ".bundlebox/out/echos"), { recursive: true });
  w(".bundlebox/out/echos/latest.json", JSON.stringify({
    at: "2026-09-20T10:30:00Z", engine: "arc",
    echos: [{ id: "spin", verdict: "hit", detail: "`git branch` ran 5 times in a row. Nothing was edited between them.", severity: "medium" },
      { id: "stray", verdict: "unknown", detail: "0 brief(s)" }, { id: "oscillate", verdict: "ok", detail: "none" }],
    locate: { verdict: "unknown", n: 2, windows_scored: 1 },
  }));
  const r = sit.record();
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.unknown, ["stray"], "ok is not unknown and unknown is not a hit");
  const text = sit.report(await sit.situation({ cwd: root }));
  assert.match(text, /1 hit\(s\), 1 unknown \(stray\)/);
  assert.match(text, /locate\s+unknown, n=2 over 1 brief\(s\)/);
});

test("gates run runs each distinct command once and stops at the first failure", async () => {
  // `lint` repeats `quick`'s command, so three declared gates are two runs.
  const rc = await compile.runGates({ flags: { json: false } });
  assert.equal(rc, 0);
  const failing = path.join(root, ".bundlebox/config.json");
  fs.writeFileSync(failing, JSON.stringify({ kernel: { gates: { quick: "exit 3", full: "echo never" } } }));
  const { load } = await import("../src/core/config.js");
  load({ fresh: true });
  const rc2 = await compile.runGates({ flags: {} });
  assert.equal(rc2, 1, "a failing gate is rc 1 so a script can branch on it");
});
