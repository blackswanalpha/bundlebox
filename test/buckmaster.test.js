import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-buckmaster-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
// A low re-read threshold so one synthetic transcript fires a rule; written
// before import because config is cached per process.
fs.writeFileSync(path.join(root, ".bundlebox", "config.json"), JSON.stringify({ buckmaster: { thresholds: { reread_ratio: 0.01 } } }));
process.env.BB_ROOT = root;
process.env.HOME = tmp;
const episodes = await import("../src/buckmaster/episodes.js");
const outcomes = await import("../src/buckmaster/outcomes.js");
const buckmaster = await import("../src/buckmaster/index.js");
const expert = await import("../src/core/expert.js");
const store = await import("../src/core/store.js");
const { slug } = await import("../src/adapters/claude.js");

test("turns() counts files, commands, searches and a page per 40 rows", () => {
  assert.equal(episodes.turns({ files_read: 2, commands: 1, searches: 1, rows: 85 }), 6);
  assert.equal(episodes.turns({ rows: 39 }), 0);
  assert.equal(episodes.turns({}), 0);
  assert.equal(episodes.turns({ files_read: -3, commands: "2" }), 2);
});

test("write() normalises to the CONVENTIONS shape; features keep scalars only", () => {
  const r = episodes.write({ kind: "stage", verb: "scan", run_id: "R1", features: { inputs: 3, nested: { a: 1 }, dirty: null }, produced: "4", seconds: "1.23456", useful: 7 });
  for (const k of ["id", "kind", "verb", "prev", "features", "rc", "seconds", "produced", "reads", "turns_saved", "run_id", "useful"]) assert.ok(k in r, k);
  assert.deepEqual(r.features, { inputs: 3, dirty: null });
  assert.equal(r.produced, 4);
  assert.equal(r.seconds, 1.235);
  assert.equal(r.useful, -1);
  assert.equal(episodes.normalise({ verb: "x" }).produced, null);
});

test("autolabel is order-aware and a stage never self-certifies", () => {
  const w = (o) => episodes.write({ kind: "stage", run_id: "R2", ...o });
  const a = w({ verb: "a", produces: ["x"], reads: ["x"] });              // self-read: not evidence
  const b = w({ verb: "b", produces: ["y"], reads: ["x"] });              // later, reads x -> a is 1
  const c = w({ verb: "c", produces: ["z"], reads: ["w"] });              // reads w BEFORE d produces it
  const d = w({ verb: "d", produces: ["w"], reads: [] });                 // nothing later reads w -> 0
  const g = w({ verb: "g", produces: ["q"], reads: ["z"], state: "gated" }); // did not run: its read counts for nothing
  const labels = episodes.autolabel([a, b, c, d, g], { completed: true });
  assert.equal(labels[a.id], 1);
  assert.equal(labels[b.id], 0);
  assert.equal(labels[c.id], 0);
  assert.equal(labels[d.id], 0);
  assert.equal(g.id in labels, false);
  const stored = Object.fromEntries(store.rows("episodes").map((e) => [e.id, e.useful]));
  assert.equal(stored[a.id], 1);
  assert.equal(stored[d.id], 0);
  assert.equal(stored[g.id], -1);
  const open = episodes.autolabel([a, d], { completed: false, apply: false });
  assert.equal(open[d.id], -1);
});

test("report() labels tokens per turn ESTIMATE without usage rows and MEASURED with them", () => {
  const before = episodes.report();
  assert.equal(before.tokens_per_turn.kind, "ESTIMATE");
  assert.equal(before.tokens_per_turn.value, 2600);
  store.append("usage", { session_id: "s", msg_id: "1", model: "claude-sonnet-5", input: 10, output: 300, cache_write: 700, cache_read: 0, ts: "2026-09-13T00:00:00Z" });
  const after = episodes.report();
  assert.equal(after.tokens_per_turn.kind, "MEASURED");
  assert.equal(after.tokens_per_turn.value, 1000);
  assert.ok(after.by_verb.length >= 4);
  assert.match(episodes.reportText(after), /MEASURED/);
});

test("outcomes: verdict is worst-first and accepted is tri-state", () => {
  const base = { lane_rc: 0, accepted: null, sha: "", reverted: 0, recurred: 0, human_edits: 0, human_lines: 0, lines_changed: 0 };
  assert.equal(outcomes.verdictFor({ ...base }), "pending");
  assert.equal(outcomes.verdictFor({ ...base, accepted: 0 }), "broken");
  assert.equal(outcomes.verdictFor({ ...base, accepted: 1, sha: "abc", reverted: 1 }), "broken");
  assert.equal(outcomes.verdictFor({ ...base, accepted: 1, sha: "abc", recurred: 1 }), "weak");
  assert.equal(outcomes.verdictFor({ ...base, accepted: 1, sha: "abc", human_edits: 2 }), "weak");
  assert.equal(outcomes.verdictFor({ ...base, accepted: 1, sha: "abc" }), "held");
  assert.equal(outcomes.verdictFor({ ...base, accepted: null, sha: "abc" }), "held");
  assert.equal(outcomes.verdictFor({ ...base, lane_rc: null, accepted: 1, sha: "abc" }), "held");
  assert.equal(outcomes.verdictFor({ ...base, lane_rc: 1, accepted: 1 }), "broken");
});

test("outcomes: record splits spend by finding share; history and backlog read it", () => {
  store.put("findings", [
    { id: "f1", detector: "doc-links", status: "open", auto_fix: "fix-doc-links", last_seen: "2026-09-10T00:00:00Z" },
    { id: "f2", detector: "dead-exports", status: "open", auto_fix: null, last_seen: "2026-09-10T00:00:00Z" },
    { id: "f3", detector: "dead-exports", status: "open", auto_fix: null, last_seen: "2026-09-10T00:00:00Z" },
  ]);
  store.put("units", [{ id: "U1", finding_ids: ["f1", "f2", "f3"], scope: ["a.js"] }]);
  store.append("usage", { session_id: "l", msg_id: "1", model: "claude-sonnet-5", input: 100, output: 100, cache_write: 100, cache_read: 0, run_id: "R9", lane_id: "L01", ts: "2026-09-13T00:00:00Z" });
  const row = outcomes.record({ id: "L01", run_id: "R9", unit_ids: ["U1"], rc: 0, accepted: true, ended: "2026-09-12T00:00:00Z" });
  assert.equal(row.spend_tokens, 300);
  assert.deepEqual(row.by_detector, { "doc-links": 1, "dead-exports": 2 });
  assert.equal(row.accepted, 1);
  assert.equal(row.verdict, "pending");
  const scored = outcomes.score();
  assert.equal(scored.length, 1);
  assert.equal(scored[0].verdict, "held");         // the gate was green and nothing has contradicted it
  const unchecked = outcomes.record({ id: "L02", run_id: "R9", unit_ids: ["U1"], rc: 0, ended: "2026-09-12T00:00:00Z" });
  assert.equal(unchecked.accepted, null);
  assert.equal(outcomes.score().find((r) => r.lane_id === "L02").verdict, "pending");   // nothing checked it, nothing shipped
  const by = outcomes.byDetector();
  assert.equal(by.find((a) => a.detector === "dead-exports").spend, 200);
  assert.equal(by.find((a) => a.detector === "doc-links").spend, 100);
  const hist = outcomes.history();
  assert.deepEqual(hist["dead-exports"], { held: 1, weak: 0, broken: 0 });
  const backlog = outcomes.backlog();
  assert.deepEqual(backlog.map((a) => a.detector), ["dead-exports"]);   // doc-links has an actuator
  assert.equal(outcomes.outcomes().length, 2);                          // last row per id wins
  store.put("findings", [{ ...store.get("findings")[1], last_seen: "2026-09-13T00:00:00Z" }]);
  assert.equal(outcomes.recurred({ finding_ids: ["f2"], ended: "2026-09-12T00:00:00Z" }), 1);
});

const py = expert.available();
test("buckmaster signals + rules end-to-end on a synthetic transcript", { skip: py ? false : "python3 >= 3.9 not found; expert verbs untested on this box" }, async () => {
  const dir = path.join(tmp, ".claude", "projects", slug(root));
  fs.mkdirSync(dir, { recursive: true });
  const usage = (i, o) => ({ input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: o });
  const line = (id, content) => JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5", content, usage: usage(1000, 50) }, timestamp: "2026-09-13T10:00:00.000Z", sessionId: "syn", cwd: root });
  const result = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(100) }] }, sessionId: "syn", cwd: root });
  const lines = [];
  for (let i = 0; i < 6; i++) { lines.push(line(`m${i}`, [{ type: "tool_use", name: "Read", input: { file_path: "src/a.js" } }])); lines.push(result); }
  lines.push(line("m9", [{ type: "tool_use", name: "Grep", input: { pattern: "x" } }]), result);
  fs.writeFileSync(path.join(dir, "syn.jsonl"), lines.join("\n") + "\n");

  const rc = await buckmaster.commands.buckmaster.run({ _: ["signals"], flags: { quiet: true } });
  assert.equal(rc, 0);
  const sig = store.get("signals");
  assert.equal(sig.sessions.length, 1);
  assert.ok(sig.aggregate.reread_ratio > 0.5, `reread_ratio ${sig.aggregate.reread_ratio}`);
  assert.equal(sig.aggregate.retry_ratio, null);          // no errors: null, not 0

  const rc2 = await buckmaster.commands.buckmaster.run({ _: ["recommend"], flags: { quiet: true } });
  assert.equal(rc2, 0);
  const rules = store.get("rules");
  assert.ok(rules.recommendations.some((r) => r.id === "snapgen-hot"), JSON.stringify(rules.recommendations));
  assert.equal(rules.thresholds.reread_ratio, 0.01);
  const md = fs.readFileSync(buckmaster.recommendationsPath(), "utf8");
  assert.match(md, /## snapgen-hot/);
  assert.match(md, /rereads-want-a-table/);

  const rc3 = await buckmaster.commands.buckmaster.run({ _: ["graph"], flags: { quiet: true } });
  assert.equal(rc3, 0);
  assert.ok(Array.isArray(store.get("graph").edges));
  const rc4 = await buckmaster.commands.buckmaster.run({ _: ["model"], flags: { quiet: true, train: true } });
  assert.equal(rc4, 0);
  const m = JSON.parse(fs.readFileSync(buckmaster.modelPath(), "utf8"));
  assert.equal(m.useful, false);                           // too few labelled rows to steer
});
