// gate.test.js — the gate's safety property, which is an asymmetry.
//
// A gate that is wrong in the `fresh` direction hands back an answer about a
// world that moved, and nothing downstream can tell. A gate that is wrong the
// other way costs one extra run. So the rule under test is: **anything that is
// not provably fresh runs**, and only `fresh` skips.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-gate-")));
process.env.BB_ROOT = root;

const dep = path.join(root, "watched.txt");
const marker = path.join(root, "it-ran");
// `node -e` rather than `touch`: the test has to run where the runner does, and
// Windows has no touch.
const ARGV = ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`];
const ran = () => fs.existsSync(marker);
const clear = () => { try { fs.unlinkSync(marker); } catch { /* first run */ } };

before(() => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(dep, "one");
});

const record = async (over = {}) => {
  const { record: write } = await import("../src/recom/index.js");
  return write({
    id: "mobile/signin", title: "Sign-in stops at the SMS step", outcome: "blocked",
    summary: "the code field never accepts the test number's code",
    depends: [`file_sha:${dep}`],
    saved_wall_s: 600, saved_tokens: 24000, ...over,
  }, { apply: true });
};

test("a fresh record runs nothing and hands back the answer", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary: recom probes need one");
  const { gate } = await import("../src/recom/gate.js");
  assert.equal((await record()).rc, 0);
  clear();

  const r = gate("mobile/signin", ARGV);
  assert.equal(r.verdict, "fresh");
  assert.equal(r.ran, false);
  assert.equal(ran(), false, "the drive must not happen");
  assert.match(r.answer.summary, /code field/);
  assert.equal(r.saved_tokens, 24000, "what was not spent comes from the record");
});

test("a fact that moved runs the command and names it", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary");
  const { gate } = await import("../src/recom/gate.js");
  clear();
  fs.writeFileSync(dep, "two");

  const r = gate("mobile/signin", ARGV);
  assert.equal(r.verdict, "stale");
  assert.equal(r.ran, true);
  assert.equal(r.rc, 0);
  assert.equal(ran(), true);
  assert.equal(r.moved.length, 1);
  assert.equal(r.moved[0].probe, `file_sha:${dep}`);
  assert.ok(r.moved[0].was && r.moved[0].now && r.moved[0].was !== r.moved[0].now, "both values, so a reader can see what changed");
  assert.equal(r.saved_tokens, 0, "a stale record saves nothing: the run happens anyway");
});

test("no record at all runs the command — the safe direction", async () => {
  const { gate } = await import("../src/recom/gate.js");
  clear();
  const r = gate("mobile/never-recorded", ARGV);
  assert.equal(r.verdict, "missing");
  assert.equal(r.ran, true);
  assert.equal(ran(), true);
});

test("an unreadable fact is not a matching fact, so it runs", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary");
  const { gate } = await import("../src/recom/gate.js");
  // A record whose dependency is then deleted. `unknown` must behave like
  // `stale`, never like `fresh`: a store that let those collapse would
  // eventually say a device was signed in when there was no device.
  const gone = path.join(root, "gone.txt");
  fs.writeFileSync(gone, "here");
  assert.equal((await record({ id: "mobile/vanishes", depends: [`file_sha:${gone}`] })).rc, 0);
  fs.unlinkSync(gone);
  clear();

  const r = gate("mobile/vanishes", ARGV);
  assert.equal(r.verdict, "unknown");
  assert.equal(r.ran, true, "unreadable never skips");
  assert.equal(ran(), true);
});

test("--force runs a fresh record, and a dry run runs nothing at all", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary");
  const { gate } = await import("../src/recom/gate.js");
  fs.writeFileSync(dep, "three");
  assert.equal((await record()).rc, 0);

  clear();
  const dry = gate("mobile/signin", ARGV, { apply: false, force: true });
  assert.equal(dry.state, "would run");
  assert.equal(ran(), false);

  clear();
  const forced = gate("mobile/signin", ARGV, { force: true });
  assert.equal(forced.forced, true);
  assert.equal(forced.ran, true);
  assert.equal(ran(), true);
});

test("the command's exit code is the gate's, so it chains", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary");
  const { gate } = await import("../src/recom/gate.js");
  const r = gate("mobile/never-recorded", ["node", "-e", "process.exit(3)"]);
  assert.equal(r.rc, 3);
});

test("the mobile line is in the instruction block only where there is a driver", async () => {
  const { instructions, BASE } = await import("../src/wire/agents.js");
  assert.equal(instructions({ mobile: false }), BASE, "a sentence about phones is paid for on every prompt");
  assert.ok(instructions({ mobile: true }).includes("bb recom gate"));
  assert.ok(instructions({ mobile: true }).trimEnd().endsWith("<!-- bundlebox:end -->"));
});
