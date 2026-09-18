// The inlet: a document becomes a world model, a corpus is seeded from it, and
// coverage is the set difference between the two. Everything here is free, and
// the packs it writes are the only thing in the pipeline a model is asked for —
// so what a pack contains is a contract worth pinning.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-genesis-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;

const expert = await import("../src/core/expert.js");
const genesis = await import("../src/genesis/index.js");
const corpus = await import("../src/cookbook/corpus.js");

const DOC = `
# Orders

An order must have at least one line before it can be submitted.
The API exposes GET /orders and POST /orders, and GET /orders/{id} for one.

    SUBMIT_WINDOW_HOURS = 24

As a warehouse picker, I want to see what is ready.

## Tenancy

A member must not read another tenant's orders. GET /tenant/{id}/members lists them.

## Running it

\`\`\`bash
npm test
npm run lint    # the gate
\`\`\`
`;

const py = expert.available();
const skipIfNoPython = (t) => { if (!py) { t.skip("python3 >= 3.9 is not on this box"); return true; } return false; };

test("a document becomes surfaces, rules, capabilities and actors, each citing a line", (t) => {
  if (skipIfNoPython(t)) return;
  const w = expert.call("world-derive", { text: DOC, name: "orders" });
  assert.ok(w, "world-derive returned nothing");
  assert.ok(w.counts.surfaces >= 2, `expected at least 2 surfaces, got ${w.counts.surfaces}`);
  assert.ok(w.rules.some((r) => /at least one line/.test(r.text)), "the must-rule was not extracted");
  assert.ok(w.rules.every((r) => r.line > 0 && r.why), "every rule cites a line");
  const ids = w.capabilities.map((c) => c.id);
  assert.ok(ids.includes("http:GET /orders"));
  assert.ok(ids.includes("http:POST /orders"));
  assert.ok(ids.includes("cmd:npm test"), `commands were not cleaned: ${ids.filter((i) => i.startsWith("cmd")).join(", ")}`);
  assert.ok(!ids.some((i) => i.includes("the gate")), "an inline comment survived into a command");
  assert.ok(w.actors.some((a) => /picker/i.test(a.title + a.role)), "the actor was not found");
  assert.ok(w.constants.some((c) => c.name === "SUBMIT_WINDOW_HOURS"));
});

test("what could not be settled is listed, not filled in", (t) => {
  if (skipIfNoPython(t)) return;
  const w = expert.call("world-derive", { text: DOC, name: "orders" });
  assert.ok(w.unknown.length, "a document with no base URL must say so");
  assert.ok(w.unknown.some((u) => /base URL/.test(u)));
  assert.equal(w.base, "", "nothing invents a base");
});

test("the tier comes from the capability's own shape", (t) => {
  if (skipIfNoPython(t)) return;
  const w = expert.call("world-derive", { text: DOC, name: "orders" });
  const tier = (id) => w.capabilities.find((c) => c.id === id)?.tier;
  assert.equal(tier("http:GET /orders"), "simple");
  assert.equal(tier("http:POST /orders"), "complex");
  assert.equal(tier("http:GET /orders/{id}"), "complex");
  assert.equal(tier("http:GET /tenant/{id}/members"), "complicated");
});

test("the route matcher matches by position, not by prefix", (t) => {
  if (skipIfNoPython(t)) return;
  const world = { capabilities: [
    { id: "http:GET /tasks", kind: "http", method: "GET", path: "/tasks", surface: "t", tier: "simple", why: "l1" },
    { id: "http:GET /files/{p:path}", kind: "http", method: "GET", path: "/files/{p:path}", surface: "t", tier: "simple", why: "l2" },
  ], rules: [] };
  // /tasks/{id} must NOT cover /tasks, a query string must not make a call unmatchable,
  // and a catch-all must consume at least one segment.
  const corpusIn = { scenarios: [{ id: "a", surface: "t", steps: [
    { do: "GET /tasks/1", expect: { status: 200 } },
    { do: "GET /files/a/b", expect: { status: 200, json: { x: 1 } } },
  ] }] };
  const p = expert.call("coverage-plan", { world, corpus: corpusIn });
  assert.equal(p.covered, 1, "only the catch-all is covered");
  assert.deepEqual(p.phantom_calls, ["GET /tasks/1"], "a call against nothing declared is reported");
  assert.deepEqual(p.specs.map((s) => s.capability), ["http:GET /tasks"]);
});

test("a status-only step covers a route but is reported shallow", (t) => {
  if (skipIfNoPython(t)) return;
  const world = { capabilities: [{ id: "http:GET /a", kind: "http", method: "GET", path: "/a", surface: "s", tier: "simple", why: "l1" }], rules: [] };
  const p = expert.call("coverage-plan", { world, corpus: { scenarios: [{ id: "x", steps: [{ do: "GET /a", expect: { status: 200 } }] }] } });
  assert.equal(p.covered, 1);
  assert.equal(p.shallow, 1);
  assert.equal(p.deep_pct, 0);
});

test("genesis derives, seeds a corpus, and writes no scenarios", (t) => {
  if (skipIfNoPython(t)) return;
  const doc = path.join(root, "PRD.md");
  fs.writeFileSync(doc, DOC);
  const r = genesis.derive({ doc, name: "orders" });
  assert.equal(r.rc, 0, r.why);
  const s = genesis.seed("orders", { base: "http://127.0.0.1:4400" });
  assert.equal(s.rc, 0);
  const c = corpus.load("orders");
  assert.ok(c, "the corpus was not written");
  assert.equal(c.persona.base, "http://127.0.0.1:4400");
  assert.ok(c.surfaces.length >= 2);
  assert.equal(c.scenarios.length, 0, "seeding must not invent scenarios — that is the judgement half");
});

test("a pack carries the derived half, the acceptance, and what it will not accept", async (t) => {
  if (skipIfNoPython(t)) return;
  const r = genesis.pack("orders", { batch: 4 });
  assert.equal(r.rc, 0, r.why);
  assert.ok(r.packs.length, "no packs written");
  const text = fs.readFileSync(path.join(root, r.packs[0].file.replace(/^\.\//, "")), "utf8");
  assert.match(text, /bb cookbook check --persona orders/, "the acceptance command must be in the brief");
  assert.match(text, /What this brief does not accept/, "the anti-rationalisation table must be in the brief");
  assert.match(text, /json_len_at_least/, "the expectation vocabulary must be in the brief");
  assert.match(text, /\{\{localdate\}\}/, "the substitution tokens must be in the brief");
  assert.ok(r.packs.every((p) => p.est_tokens > 0 && p.est_tokens < 6000), "a pack must stay small enough to be worth sending");
  // The order is the cache: the half that is the same in every pack leads, and
  // the surface name is the first thing that varies. Measured before the
  // reorder, six packs were 90% identical and none of it could be a prefix.
  const { PREAMBLE } = await import("../src/wire/brief.js");
  assert.ok(text.startsWith(PREAMBLE + "\n"), "a pack opens with the preamble every bundlebox brief shares");
  assert.ok(text.indexOf("What this brief does not accept") < text.indexOf("\n# Write "), "the fixed half precedes the surface title");
  assert.ok(text.indexOf("## Rules for this work") < text.indexOf("\n# Write "));
  assert.doesNotMatch(text.slice(0, text.indexOf("\n# Write ")), /orders/, "nothing corpus-specific may sit in the fixed prefix");
});

test("selection ranks by expected information and prints every term", (t) => {
  if (skipIfNoPython(t)) return;
  const scenarios = [
    { id: "flaky", surface: "s", severity: "high", steps: [1, 2, 3] },
    { id: "steady", surface: "s", severity: "low", steps: [1] },
    { id: "never", surface: "s", severity: "medium", steps: [1, 2] },
  ];
  const boards = [
    { at: "2026-09-10T00:00:00", scenarios: [{ id: "flaky", state: "failed" }, { id: "steady", state: "passed" }] },
    { at: "2026-09-12T00:00:00", scenarios: [{ id: "flaky", state: "passed" }, { id: "steady", state: "passed" }] },
    { at: "2026-09-13T00:00:00", scenarios: [{ id: "flaky", state: "failed" }, { id: "steady", state: "passed" }] },
  ];
  const r = expert.call("scenario-select", { scenarios, boards, budget_steps: 4, now: "2026-09-14T00:00:00" });
  assert.equal(r.ranked[0].id, "flaky", "the one that keeps changing its mind is worth the most");
  assert.ok(r.ranked.every((x) => x.why.includes("p_red")), "every row explains its score");
  assert.ok(r.steps_selected <= 5, "the budget is respected");
  const steady = r.ranked.find((x) => x.id === "steady");
  assert.ok(steady.p_red < 0.3, "a scenario that has never been red scores low, but not zero");
});

test("board verdicts separate the product, the environment and the corpus", (t) => {
  if (skipIfNoPython(t)) return;
  const board = { scenarios: [
    { id: "a", surface: "x", state: "failed", steps: [{ state: "failed", name: "s", why: ["status 500"], request: "GET /x" }, { state: "passed" }] },
    { id: "b", surface: "y", state: "blocked", steps: [{ state: "blocked" }, { state: "blocked" }] },
    { id: "c", surface: "z", state: "empty", steps: [{ state: "empty" }] },
  ] };
  const prev = { scenarios: [{ id: "a", state: "passed" }] };
  const v = expert.call("board-verdicts", { board, previous: prev });
  const rules = v.findings.map((f) => f.rule);
  assert.ok(rules.includes("red_share_gap"), "the product disagreement");
  assert.ok(rules.includes("blocked_share_env"), "the environment, filed as such");
  assert.ok(rules.includes("empty_steps"), "the corpus defect, filed as such");
  assert.ok(rules.includes("regression"), "green-then-red is called out on its own");
  assert.ok(v.findings.every((f) => f.detail), "every verdict says what it means");
});
