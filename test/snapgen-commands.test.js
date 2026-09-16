// snapgen-commands.test.js — the `commands` table's inputs.
//
// The bug this pins: the table's `bb verbs` section renders each module's own
// `help` and `usage`, and only `src/cli.js` was declared as an input. Editing a
// verb's description therefore changed what the table SHOULD say while `bb
// snapgen stale` reported it fresh — a derived artefact quietly disagreeing with
// the tree, which is the one failure the fingerprint exists to prevent.
//
// The assertion is on the FINGERPRINT rather than on the input list alone: the
// list is the mechanism and the fingerprint is the claim, and a list that grew
// without moving the fingerprint would pass a weaker test and fix nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-cmds-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

// Shaped like this repo, because the verb section only renders here.
w("package.json", JSON.stringify({ name: "bundlebox", type: "module", scripts: { test: "node --test" } }));
w("src/cli.js", 'export const MODULES = [["alpha", "./alpha/index.js"], ["beta", "./beta/index.js"]];\n');
w("src/alpha/index.js", 'export const commands = { alpha: { help: "the first verb", usage: "bb alpha", run: async () => 0 } };\n');
w("src/beta/index.js", 'export const commands = { beta: { help: "the second verb", usage: "bb beta", run: async () => 0 } };\n');

const { commands } = await import("../src/snapgen/views.js");
const cache = await import("../src/kit/cache.js");

test("every module the verb table renders is an input", async () => {
  const inputs = await commands.inputs();
  assert.ok(inputs.some((p) => p.endsWith(path.join("src", "cli.js"))), "cli.js is still an input");
  assert.ok(inputs.some((p) => p.endsWith(path.join("src", "alpha", "index.js"))), "a verb module is an input");
  assert.ok(inputs.some((p) => p.endsWith(path.join("src", "beta", "index.js"))));
  assert.ok(inputs.some((p) => p.endsWith("package.json")), "the manifests are still inputs");
});

test("changing a verb's own help moves the fingerprint", async () => {
  const before = cache.fingerprint(await commands.inputs());
  w("src/alpha/index.js", 'export const commands = { alpha: { help: "the first verb, described differently", usage: "bb alpha", run: async () => 0 } };\n');
  const after = cache.fingerprint(await commands.inputs());
  assert.notEqual(after, before, "the table is stale when the text it renders changed");
});

test("a module added to MODULES moves the fingerprint", async () => {
  const before = cache.fingerprint(await commands.inputs());
  w("src/gamma/index.js", 'export const commands = { gamma: { help: "a third verb", usage: "bb gamma", run: async () => 0 } };\n');
  assert.equal(cache.fingerprint(await commands.inputs()), before,
    "a file nothing registers is not an input, however verb-shaped it looks");
  // cli.js is re-read per call, so registering it is enough to be tracked. The
  // path assertion is the real one: rewriting cli.js moves the fingerprint by
  // itself, so a fingerprint-only test would pass without gamma being seen.
  w("src/cli.js", 'export const MODULES = [["alpha", "./alpha/index.js"], ["beta", "./beta/index.js"], ["gamma", "./gamma/index.js"]];\n');
  const after = await commands.inputs();
  assert.ok(after.some((p) => p.endsWith(path.join("src", "gamma", "index.js"))), "a verb registered after the first call is seen");
  assert.notEqual(cache.fingerprint(after), before);
});

test("a module named in MODULES that is not on disk is skipped, not counted", async () => {
  w("src/cli.js", 'export const MODULES = [["alpha", "./alpha/index.js"], ["ghost", "./ghost/index.js"]];\n');
  const inputs = await commands.inputs();
  assert.ok(inputs.some((p) => p.endsWith(path.join("src", "ghost", "index.js"))), "it is asked for");
  const fp = cache.fingerprint(inputs);
  // The count prefix is over inputs that EXIST, so a missing module cannot
  // inflate it into looking like the table covered more than it did.
  assert.equal(cache.inputsOf(fp), inputs.filter((p) => fs.existsSync(p)).length);
});
