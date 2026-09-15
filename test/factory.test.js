// The measurement and judgement half: billing blocks, the window guard, frames
// and their evals, the pipeline's exit criteria, and the two ledgers that
// refuse a finding a reader cannot check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-factory-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;

const store = await import("../src/core/store.js");
const monitor = await import("../src/monitor/index.js");
const { Frame, AGGS } = await import("../src/frames/frame.js");
const frames = await import("../src/frames/index.js");
const stages = await import("../src/pipeline/stages.js");
const mainboard = await import("../src/mainboard/index.js");
const simulate = await import("../src/simulate/index.js");
const failsafe = await import("../src/failsafe/index.js");
const auditor = await import("../src/auditor/index.js");
const runbook = await import("../src/runbook/index.js");

const HOUR = 3600000;
const usage = (offsetMs, n = 1000) => ({ session_id: "s1", msg_id: `m${offsetMs}`, agent: "claude", model: "claude-opus-5",
  input: n, output: 0, cache_write: 0, cache_read: 0, ts: new Date(Date.now() - offsetMs).toISOString() });

test("blocks are five-hour windows that a gap ends", () => {
  for (const r of [usage(30 * HOUR), usage(29.5 * HOUR), usage(2 * HOUR), usage(1 * HOUR), usage(0.5 * HOUR)]) store.append("usage", r);
  const bs = monitor.blocks();
  assert.equal(bs.length, 2, "two clusters six hours apart are two blocks");
  assert.equal(bs[0].turns, 2);
  assert.equal(bs[1].turns, 3);
  assert.equal(bs[1].tokens, 3000);
  assert.equal(bs[0].end - bs[0].start, 5 * HOUR);
});

test("the P90 limit refuses to guess from too little history", () => {
  const two = monitor.blocks().filter((b) => b.end <= Date.now());
  const r = monitor.limitOf(two, { plan: "custom" });
  assert.equal(r.limit, null);
  assert.equal(r.source, "unknown");
  assert.match(r.why, /at least 3/);
});

test("a named plan is a published ceiling and says so", () => {
  const r = monitor.limitOf([], { plan: "max5" });
  assert.equal(r.limit, monitor.PLANS.max5);
  assert.equal(r.source, "plan");
  assert.equal(r.confidence, "published");
});

test("P90 is this account's own history once there is enough of it", () => {
  const blocks = [100, 200, 300, 400, 500, 900].map((tokens, i) => ({ tokens, start: Date.now() - (i + 2) * 24 * HOUR, end: Date.now() - (i + 2) * 24 * HOUR + 5 * HOUR }));
  const r = monitor.limitOf(blocks, { plan: "custom" });
  assert.equal(r.source, "p90");
  assert.equal(r.confidence, "measured");
  assert.equal(r.limit, 900);
  assert.match(r.why, /90th percentile of 6/);
});

test("the guard refuses when the block is spent and allows when it is not", () => {
  const near = monitor.guard({ plan: "max20", limit: 1 });      // 3000 used against a limit of 1
  assert.equal(near.ok, false);
  assert.equal(near.state, "hit");
  assert.match(near.why, /block/);
  const fine = monitor.guard({ limit: 10_000_000 });
  assert.equal(fine.ok, true);
});

test("an indeterminate window does not block: nothing is refused on an unknown", () => {
  const g = monitor.guard({ plan: "custom" });
  assert.equal(g.ok, true);
  assert.equal(g.state, "indeterminate");
});

// ── frames ──────────────────────────────────────────────────────────────────

test("a frame groups, aggregates and sorts, and a missing column is null not zero", () => {
  const f = new Frame([{ v: "a", n: 1 }, { v: "a", n: 3 }, { v: "b" }]);
  const g = f.group("v", [["rows", "count", "n"], ["total", "sum", "n"], ["mid", "median", "n"]]).sort("total", "desc");
  assert.deepEqual(g.rows, [{ v: "a", rows: 2, total: 4, mid: 2 }, { v: "b", rows: 1, total: 0, mid: null }]);
  assert.equal(AGGS.p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  assert.equal(AGGS.median([]), null);
});

test("where honours in, matches and exists without coercing a missing value into a match", () => {
  const f = new Frame([{ s: "high" }, { s: "low" }, { }]);
  assert.equal(f.where([["s", "in", ["high", "critical"]]]).length, 1);
  assert.equal(f.where([["s", "matches", "^l"]]).length, 1);
  assert.equal(f.where([["s", "exists", true]]).length, 2);
  assert.equal(f.where([["s", "!=", "high"]]).length, 2);
});

test("every shipped eval validates without reading any data", () => {
  const bad = frames.evals().flatMap(frames.checkOne);
  assert.deepEqual(bad, []);
  assert.ok(frames.evals().length >= 8, "the shipped evals went missing");
});

test("an empty frame is skipped, unless the spec says no rows means zero violations", () => {
  const population = frames.runOne({ id: "p", source: "lanes", where: [["id", "==", "nothing"]], metric: { fn: "median", col: "ratio" }, threshold: { op: "<=", value: 1 }, why: "x" });
  assert.equal(population.state, "skipped");
  assert.match(population.why, /Green has to mean measured/);
  const violations = frames.runOne({ id: "v", source: "findings", where: [["detector", "==", "nothing"]], metric: { fn: "count" }, threshold: { op: "==", value: 0 }, empty: "zero", why: "x" });
  assert.equal(violations.state, "held");
  assert.equal(violations.value, 0);
});

test("a counting eval with no policy says what to set rather than answering", () => {
  const r = frames.runOne({ id: "c", source: "findings", where: [["detector", "==", "nothing"]], metric: { fn: "count" }, threshold: { op: "==", value: 0 }, why: "x" });
  assert.equal(r.state, "skipped");
  assert.match(r.why, /"empty": "zero"/);
});

// ── the pipeline's own exit criteria ────────────────────────────────────────

test("every stage reports ok, gap or unknown, and a gap names the command that closes it", () => {
  const g = stages.gaps();
  assert.equal(g.stages.length, stages.STAGES.length);
  for (const s of g.stages) {
    assert.ok(["ok", "gap", "unknown"].includes(s.state), `${s.id} returned ${s.state}`);
    assert.ok(s.why, `${s.id} gave no reason`);
    assert.ok(s.fix, `${s.id} has no fix command`);
    assert.ok(s.question.endsWith("?"), `${s.id} does not ask a question`);
  }
  assert.equal(g.ok + g.gaps.length + g.unknown.length, g.of);
  if (g.next) assert.equal(g.next.state, "gap");
});

test("an empty workspace is a pipeline of gaps, not a green one", () => {
  const g = stages.gaps();
  assert.ok(g.gaps.length >= 3, "a workspace with no world, no corpus and no scan cannot be green");
  assert.ok(g.gaps.some((s) => s.id === "genesis"));
});

// ── the two ledgers ─────────────────────────────────────────────────────────

test("the board refuses a finding with no evidence, an unknown category or no stable id", () => {
  assert.deepEqual(mainboard.normalise({ id: "X-1", title: "t", category: "GAP", severity: "high", evidence: { request: "GET /x" } }, "cookbook").bad, undefined);
  assert.match(mainboard.normalise({ id: "X-2", title: "t", category: "GAP", severity: "high", evidence: {} }, "cookbook").bad[0], /no evidence/);
  assert.match(mainboard.normalise({ id: "X-3", title: "t", category: "NOPE", severity: "high", evidence: { a: 1 } }, "cookbook").bad[0], /taxonomy/);
  assert.match(mainboard.normalise({ title: "t", category: "GAP", severity: "high", evidence: { a: 1 } }, "cookbook").bad[0], /no id/);
  assert.match(mainboard.normalise({ id: "X-4", title: "t", category: "GAP", severity: "huge", evidence: { a: 1 } }, "cookbook").bad[0], /severity/);
});

test("every view declares a question and writes only categories in the taxonomy", () => {
  const r = mainboard.check();
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.ok(r.views >= 5);
});

test("a review is ingested only where it carries checkable evidence", () => {
  fs.mkdirSync(path.join(root, "src", "area"), { recursive: true });
  for (const n of ["a.js", "b.js", "c.js"]) fs.writeFileSync(path.join(root, "src", "area", n), "export const x = 1;\n");
  const report = path.join(tmp, "report.md");
  fs.writeFileSync(report, ["# audit", "", "```json",
    JSON.stringify({ findings: [
      { title: "a real one", severity: "high", detail: "d", evidence: { file: "src/area/a.js", line: 1 } },
      { title: "an opinion", severity: "high", detail: "d" },
    ] }), "```"].join("\n"));
  const r = auditor.review.record(auditor.areas(), "area", "security", report);
  assert.equal(r.rc, 0, r.why);
  assert.equal(r.recorded, 1);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0], /no evidence\.file/);
  assert.ok(fs.existsSync(path.join(root, r.review)), "the dated record is kept beside the findings");
});

test("a review knows which tree it described, so drift is answerable", () => {
  const before = auditor.review.drift(auditor.areas());
  assert.ok(before.length);
  assert.equal(before[0].state, "current");
  fs.writeFileSync(path.join(root, "src", "area", "d.js"), "export const y = 2;\n");
  const after = auditor.review.drift(auditor.areas());
  assert.equal(after[0].state, "drifted");
  assert.match(after[0].why, /write a new one beside it/);
});

test("a charter is derived from the area's own signals, and says what it is measured at", () => {
  const a = auditor.areas().find((x) => x.id === "area");
  assert.ok(a, "the fixture tree has an `area`");
  const ch = auditor.charter.derive(a);
  assert.ok(ch.standards.length, "some standard is always in force");
  assert.ok(["A", "B", "C"].includes(ch.adal.level));
  // Every selected standard names the signal that pulled it in: a selection
  // nobody can argue with is a checklist wearing a framework's clothes.
  for (const s of ch.standards) assert.ok(s.because, `${s.id} has no reason`);
  assert.ok(ch.assurance.rule.includes("evidence"));
});

test("a standard nobody checked is reported unproven, never met", () => {
  const a = auditor.areas().find((x) => x.id === "area");
  auditor.charter.write("area", auditor.charter.derive(a));
  const g = auditor.gate("area");
  assert.equal(g.rc, 0, g.why);
  const states = new Set(g.standards.map((s) => s.state));
  assert.ok(states.has("unproven"), "a fresh tree has standards nobody has evidence for");
  assert.ok(["CLEAR", "HOLD", "BLOCK", "UNPROVEN"].includes(g.verdict));
  if (g.counts.unproven) assert.notEqual(g.verdict, "CLEAR", "unproven never reads as clear");
});

// ── simulation, playbook, logs ──────────────────────────────────────────────

test("a latency budget is a multiple of the floor, clamped, never an absolute", () => {
  const th = simulate.DEFAULTS;
  assert.equal(simulate.budget(10, th), 40);                       // 4x the floor
  assert.equal(simulate.budget(1, th), 1 + th.min_slack_ms);        // never below floor + slack
  assert.equal(simulate.budget(0, th), null);                       // no floor, no budget
  const v = simulate.verdicts({ floor_ms: 10, levels: [{ concurrency: 8, p95: 200, p50: 10, max: 300, rps: 5, error_pct: 0, errors: 0, non_2xx: 0, requests: 10, seconds: 1 }] }, th);
  assert.equal(v.budget_ms, 40);
  assert.equal(v.findings[0].rule, "p95_over_budget");
  assert.equal(v.findings[0].severity, "high");                     // 5x the budget is a blocker
});

test("every playbook failure names a defined op and a source status() produces", () => {
  const r = failsafe.check();
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.ok(r.failures >= 8 && r.ops >= 8);
});

test("failsafe says what it could not see rather than reporting a clean board", () => {
  const r = failsafe.why();
  assert.ok(Array.isArray(r.blind));
  assert.ok(r.blind.length, "an empty workspace is blind to almost everything and must say so");
});

test("a log line becomes a signature with every digit, uuid, hash and path erased", () => {
  const a = runbook.signature('2026-09-14T10:00:00Z ERROR user 550e8400-e29b-41d4-a716-446655440000 failed after 1234ms at /srv/app/x.js');
  const b = runbook.signature('2026-09-14T11:22:33Z ERROR user 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed after 99ms at /srv/app/y.js');
  assert.equal(a, b, "two instances of one failure must collapse to one row");
  assert.ok(!/550e8400|7c9e6679/.test(a), "the uuid is identity, never the fact");
  assert.ok(!/1234|99/.test(a), "the duration varies between two instances of one event");
  assert.ok(!/srv/.test(a), "a path of three or more segments is erased");
  assert.match(a, /^ERROR user/, "the timestamp is erased and the message survives");
});
