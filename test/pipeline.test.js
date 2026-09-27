import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ROOT is resolved at import time, so the fixture root goes into the env first.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-pipeline-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;
const { holds, evaluate, gear, load } = await import("../src/pipeline/spec.js");
const { runGear, SKIP_BELOW } = await import("../src/pipeline/runner.js");
const store = await import("../src/core/store.js");
const { readMeta } = await import("../src/kit/cache.js");

test("holds: precedence not > and > or, parentheses override", () => {
  const ctx = { a: true, b: false, c: true, n: 3 };
  assert.equal(holds("a or b and c", ctx), true);         // a or (b and c)
  assert.equal(holds("b or b and c", ctx), false);
  assert.equal(holds("not b and c", ctx), true);          // (not b) and c
  assert.equal(holds("not (b or c)", ctx), false);
  assert.equal(holds("not b or c and b", ctx), true);     // (not b) or (c and b)
  assert.equal(holds("(a or b) and not c", ctx), false);
  assert.equal(holds("n > 2 and n <= 3", ctx), true);
  assert.equal(holds("n == 3 and !b", ctx), true);
  assert.equal(holds("", ctx), true);
});

test("holds: a comparison against an unknown value is null, and null gates run", async () => {
  assert.equal(holds("open_findings > 0", {}), null);
  assert.equal(holds("open_findings > 0", { open_findings: null }), null);
  assert.equal(holds("open_findings > 0 and dirty", { open_findings: 3 }), null);
  assert.equal(holds("a or missing > 1", { a: true }), true);       // true or null
  assert.equal(holds("a and missing > 1", { a: false }), false);    // false and null
  assert.equal(holds("not missing", {}), null);
  assert.equal(holds("a >", { a: 1 }), null);                       // unparseable is unknown, not false
  const e = evaluate("x > 0", {});
  assert.deepEqual(e.unknown, ["x"]);

  // A store the runner cannot read (findings.json is not an array) makes
  // open_findings null; the gated stage must still run.
  fs.writeFileSync(path.join(root, ".bundlebox", "var", "findings.json"), JSON.stringify({ not: "an array" }));
  let calls = 0;
  const table = { fake: { run: async () => { calls += 1; return 0; } } };
  const gears = { t: gear({ name: "t", stages: [{ verb: "fake", when: "open_findings > 0" }] }) };
  const r = await runGear("t", { apply: true, table, gears });
  assert.equal(r.stages[0].state, "ran");
  assert.match(r.stages[0].gate_note, /unknown/);
  assert.equal(r.context.open_findings, null);
  assert.equal(calls, 1);
  store.put("findings", []);
});

test("a missing verb is an error row, not a throw", async () => {
  const gears = { t: gear({ name: "t", stages: [{ verb: "no-such-verb" }, { verb: "fake" }] }) };
  const r = await runGear("t", { apply: true, table: { fake: { run: async () => 0 } }, gears });
  assert.equal(r.stages[0].state, "error");
  assert.match(r.stages[0].why, /no verb/);
  assert.equal(r.stages[1].state, "ran");
  assert.equal(r.failed, 1);
  assert.equal(r.verdict, "partial");
});

test("dry run marks stages would-run and runs nothing", async () => {
  let calls = 0;
  const gears = { t: gear({ name: "t", stages: [{ verb: "fake" }] }) };
  const r = await runGear("t", { apply: false, table: { fake: { run: async () => { calls += 1; return 0; } } }, gears });
  assert.equal(r.stages[0].state, "would-run");
  assert.equal(calls, 0);
  assert.equal(r.would_run, 1);
});

test("fresh: second run over unchanged inputs is skipped with stored metadata; a changed input runs", async () => {
  const input = path.join(root, "in.txt");
  fs.writeFileSync(input, "one");
  let calls = 0;
  const table = { fake: { run: async () => { calls += 1; return 0; } } };
  const gears = { t: gear({ name: "t", stages: [{ name: "fresh-stage", verb: "fake", skip_if_fresh: true, inputs: () => [input] }] }) };
  const a = await runGear("t", { apply: true, table, gears });
  assert.equal(a.stages[0].state, "ran");
  const meta = readMeta("pipeline-t-fresh-stage");
  assert.match(meta.fingerprint, /^1:[0-9a-f]{40}$/);
  assert.equal(meta.stage, "fresh-stage");
  const b = await runGear("t", { apply: true, table, gears });
  assert.equal(b.stages[0].state, "fresh");
  assert.match(b.stages[0].why, /unchanged/);
  assert.equal(b.skipped, 1);
  assert.equal(calls, 1);
  fs.writeFileSync(input, "one two");
  const c = await runGear("t", { apply: true, table, gears });
  assert.equal(c.stages[0].state, "ran");
  assert.equal(calls, 2);
});

test("skipped count is gated + fresh + predicted-idle, never would-run or ran", async () => {
  const input = path.join(root, "in2.txt");
  fs.writeFileSync(input, "x");
  const table = { fake: { run: async () => 0 } };
  const gears = { t: gear({ name: "t", stages: [
    { name: "gated", verb: "fake", when: "open_findings > 100" },
    { name: "fresh", verb: "fake", skip_if_fresh: true, inputs: () => [input] },
    { name: "runs", verb: "fake" },
  ] }) };
  await runGear("t", { apply: true, table, gears });       // primes the fingerprint
  const r = await runGear("t", { apply: true, table, gears });
  assert.deepEqual(r.stages.map((s) => s.state), ["gated", "fresh", "ran"]);
  assert.equal(r.skipped, 2);
  assert.equal(r.ran, 1);
  const runs = store.rows("gear_runs").filter((x) => x.gear === "t");
  const last = runs[runs.length - 1];
  assert.equal(last.skipped, 2);
  assert.equal(last.tokens, 0);
  assert.equal(r.context.since_min, 0);
});

test("chained gears run once each under one run id", async () => {
  const seen = [];
  const table = { fake: { run: async ({ _ }) => { seen.push(_[0]); return 0; } } };
  const gears = {
    a: gear({ name: "a", stages: [{ verb: "fake", args: ["a1"] }], chain: ["b", "a"] }),
    b: gear({ name: "b", stages: [{ verb: "fake", args: ["b1"] }], chain: [{ gear: "a", when: "" }] }),
  };
  const r = await runGear("a", { apply: true, table, gears });
  assert.deepEqual(seen, ["a1", "b1"]);
  assert.equal(r.chained[0].gear, "b");
  assert.equal(r.chained[0].run_id, r.run_id);
  assert.ok(r.chained[1].skipped_gear);
});

test("each stage writes an episode with pre-run features only", async () => {
  const before = store.rows("episodes").length;
  const gears = { ep: gear({ name: "ep", stages: [{ verb: "fake", optional: true }] }) };
  await runGear("ep", { apply: true, table: { fake: { run: async () => 0 } }, gears });
  const eps = store.rows("episodes").slice(before);
  assert.equal(eps.length, 1);
  assert.deepEqual(Object.keys(eps[0].features).sort(), ["dirty", "inputs", "open_findings", "optional", "since_min"]);
  assert.equal(eps[0].features.optional, 1);
  assert.equal(eps[0].kind, "stage");
  assert.equal(eps[0].gear, "ep");
});

test("a stage that spends is refused until all three keys are set, and the missing one is named", async () => {
  const cfg = path.join(root, ".bundlebox", "config.json");
  let calls = 0;
  const table = { fake: { run: async () => { calls += 1; return 0; } } };
  const gears = { s: gear({ name: "s", stages: [{ name: "spender", verb: "fake", spends: true }, { name: "free", verb: "fake" }] }) };
  // The gear inherits `spends` from the stage that declares it: what
  // `bb pipeline list` has to show is whether running this can cost money.
  assert.equal(gears.s.spends, true);

  const full = { bridge: { enabled: true, daily_budget_usd: 5 }, lanes: { daily_budget_usd: 5 } };
  // Each key absent in turn, including all three.
  const cases = [
    [{}, /bridge\.enabled.*bridge\.daily_budget_usd.*lanes\.daily_budget_usd/],
    [{ ...full, bridge: { ...full.bridge, enabled: false } }, /^spends: bridge\.enabled — not set/],
    [{ ...full, bridge: { ...full.bridge, daily_budget_usd: 0 } }, /^spends: bridge\.daily_budget_usd > 0 — not set/],
    [{ ...full, lanes: { daily_budget_usd: 0 } }, /^spends: lanes\.daily_budget_usd > 0 — not set/],
  ];
  for (const [c, why] of cases) {
    fs.writeFileSync(cfg, JSON.stringify(c));
    const r = await runGear("s", { apply: true, table, gears });
    assert.equal(r.stages[0].state, "refused", JSON.stringify(c));
    assert.match(r.stages[0].why, why);
    assert.equal(r.stages[1].state, "ran", "a free stage beside a refused one still runs");
    assert.equal(r.skipped, 1, "refused counts as skipped, never as ran or failed");
    assert.equal(r.failed, 0);
  }
  assert.equal(calls, cases.length, "the spending stage never ran");

  // A dry run says refused too: a person reading it has to see which key is
  // missing, not `would-run`.
  fs.writeFileSync(cfg, JSON.stringify({}));
  assert.equal((await runGear("s", { apply: false, table, gears })).stages[0].state, "refused");

  // All three present: it runs.
  fs.writeFileSync(cfg, JSON.stringify(full));
  const ok = await runGear("s", { apply: true, table, gears });
  assert.deepEqual(ok.stages.map((x) => x.state), ["ran", "ran"]);
  assert.equal(calls, cases.length + 2);
  fs.unlinkSync(cfg);
});

test("built-in gears load, user gears.json replaces by name, skip_if_fresh stages declare inputs()", async () => {
  fs.writeFileSync(path.join(root, ".bundlebox", "gears.json"), JSON.stringify({ gears: { mine: { description: "x", stages: [{ verb: "scan", when: "dirty > 0" }] }, intake: { stages: [{ verb: "scan" }] } } }));
  const { gears, warnings } = await load();
  assert.deepEqual(warnings, []);
  for (const n of ["intake", "orient", "measure", "ops", "buckmaster", "factory", "pr", "mine"]) assert.ok(gears[n], n);
  assert.equal(gears.intake.stages.length, 1);
  // `watch` is last, and it used to be absent: the cron tick folded the ledger
  // and rebuilt nothing, so the one page this workspace has showed the state of
  // whenever somebody last ran `bb console build` by hand.
  assert.deepEqual(gears.factory.chain.map((c) => c.gear), ["intake", "orient", "measure", "buckmaster", "watch"]);
  for (const g of Object.values(gears)) for (const s of g.stages) if (s.skip_if_fresh) assert.equal(typeof s.inputs, "function", `${g.name}/${s.name}`);
  // `practice` and `sentinel` are the built-ins that can cost money, and they
  // are the ones that declare it. Every other gear is free, which is what lets
  // a cron line run them unattended.
  assert.equal(gears.practice.spends, true);
  assert.deepEqual(Object.values(gears).filter((g) => g.spends).map((g) => g.name).sort(), ["practice", "sentinel"]);
  for (const g of ["practice", "sentinel"]) assert.deepEqual(gears[g].on, ["hand"], "nothing bb ships installs a line that spends");
  fs.unlinkSync(path.join(root, ".bundlebox", "gears.json"));
  assert.ok(SKIP_BELOW < 0.5);
});
