// turntables.test.js — the replay: a verdict that changed, and whether the
// scenario changed with it. The distinction between those two is the whole
// value of the view, so it is the thing under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, tracks, definition } from "../src/mainboard/turntables.js";

const sc = (id, state, { question = "q", steps = [["s1", 200]] } = {}) => ({
  id, surface: "auth", title: id, severity: "high", state, question,
  rule: ["r"], steps: steps.map(([name, status]) => ({ kind: "http", name, request: `GET /${name}`, status, state: state === "passed" ? "passed" : "failed", why: "because", evidence: { status } })),
});
const board = (at, scenarios) => ({ corpus: "c", at, base: "http://127.0.0.1:1", scenarios });

test("a verdict that flips twice with no edit is a flake, not a defect", () => {
  const r = replay([
    board("t1", [sc("a", "passed")]),
    board("t2", [sc("a", "failed")]),
    board("t3", [sc("a", "passed")]),
  ], { corpus: "c" });
  assert.equal(r.facts.flaky, 1);
  assert.equal(r.facts.regressions, 0);
  const f = r.findings.find((x) => x.id.endsWith("-flake"));
  assert.ok(f, "a flake is filed");
  assert.equal(f.category, "RACE");
  assert.equal(f.severity, "high");
  assert.equal(f.evidence.sequence, "green → red → green");
});

test("a verdict that flips because the scenario was edited is neither", () => {
  const r = replay([
    board("t1", [sc("a", "passed", { question: "before" })]),
    board("t2", [sc("a", "failed", { question: "after" })]),
    board("t3", [sc("a", "passed", { question: "after again" })]),
  ], { corpus: "c" });
  assert.equal(r.facts.flaky, 0, "an edited scenario is not accused of being unstable");
  assert.equal(r.facts.regressions, 0);
  assert.equal(r.facts.explained_by_edit, 2);
  assert.equal(r.findings.length, 0);
});

test("green then red with the same definition is a regression naming both runs", () => {
  const r = replay([
    board("t1", [sc("a", "passed")]),
    board("t2", [sc("a", "failed")]),
  ], { corpus: "c" });
  assert.equal(r.facts.regressions, 1);
  const f = r.findings[0];
  assert.equal(f.category, "CONTRACT");
  assert.equal(f.severity, "high", "the scenario's own severity carries through");
  assert.equal(f.evidence.passed_at, "t1");
  assert.equal(f.evidence.failed_at, "t2");
  assert.equal(f.evidence.request, "GET /s1");
});

test("a green scenario whose step answers two different codes is filed as unstable", () => {
  const r = replay([
    board("t1", [sc("a", "passed", { steps: [["signup", 201]] })]),
    board("t2", [sc("a", "passed", { steps: [["signup", 409]] })]),
  ], { corpus: "c" });
  const f = r.findings.find((x) => x.id.endsWith("-unstable"));
  assert.ok(f, "the weak assertion is filed");
  assert.equal(f.category, "RACE");
  assert.deepEqual(f.evidence.steps[0].statuses, ["201", "409"]);
  assert.equal(r.facts.regressions, 0);
});

test("a scenario missing from one board is not compared against nothing", () => {
  // A partial run stores a board with a subset. Treating the absent scenarios
  // as gone would file a regression per scenario nobody ran.
  const r = replay([
    board("t1", [sc("a", "passed"), sc("b", "passed")]),
    board("t2", [sc("a", "passed")]),
  ], { corpus: "c" });
  assert.equal(r.findings.length, 0);
  assert.equal(r.facts.scenarios_replayed, 1, "only the scenario present in both is replayed");
});

test("one board is not a replay", () => {
  const r = replay([board("t1", [sc("a", "failed")])], { corpus: "c" });
  assert.equal(r.findings.length, 0);
  assert.equal(r.facts.scenarios_replayed, 0);
});

test("the definition digest covers what the scenario asks and not what it answered", () => {
  const green = sc("a", "passed");
  const red = sc("a", "failed");
  assert.equal(definition(green), definition(red), "the same question hashes the same however it came out");
  assert.notEqual(definition(green), definition(sc("a", "passed", { question: "different" })));
  assert.notEqual(definition(green), definition(sc("a", "passed", { steps: [["other", 200]] })), "a renamed step is an edit");
});

test("tracks keeps one row per scenario across every board it appears in", () => {
  const t = tracks([board("t1", [sc("a", "passed")]), board("t2", [sc("a", "failed")]), board("t3", [sc("b", "passed")])]);
  assert.equal(t.length, 2);
  assert.equal(t.find((x) => x.id === "a").runs.length, 2);
  assert.equal(t.find((x) => x.id === "b").runs.length, 1);
});
