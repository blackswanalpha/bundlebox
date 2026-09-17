// The corpus half: substitution, expectations, the gate in front of a run, and
// — the one that matters most — that the Rust kernel and the JavaScript engine
// return the same board for the same corpus. Which runtime happens to be
// installed must not change what a board says.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-scenario-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;

const { subst, substString, token, at, lenOf, typeName, clockOf, offset } = await import("../src/cookbook/tokens.js");
const { check, checkCmd, asserts, KEYS } = await import("../src/cookbook/expect.js");
const engine = await import("../src/cookbook/engine.js");
const corpus = await import("../src/cookbook/corpus.js");
const kernel = await import("../src/core/kernel.js");

const CLOCK = clockOf({ timezone: "Africa/Nairobi", tz_offset_minutes: 180, run: "RUNSTAMP", now: Date.UTC(2026, 8, 14, 21, 30, 0) / 1000 });

test("a string that is exactly one token keeps that value's type", () => {
  const missing = [];
  assert.equal(substString("{{used}}", CLOCK, { used: 4096 }, missing), 4096);
  assert.equal(substString("bytes: {{used}}", CLOCK, { used: 4096 }, missing), "bytes: 4096");
  assert.deepEqual(subst({ a: "{{flag}}" }, CLOCK, { flag: true }, missing), { a: true });
  assert.equal(missing.length, 0);
});

test("an unresolved token is collected, not substituted away", () => {
  const missing = [];
  assert.equal(substString("GET /items/{{tem}}", CLOCK, {}, missing), "GET /items/{{tem}}");
  assert.deepEqual(missing, ["tem"]);
});

test("localdate is the persona's date, not UTC's", () => {
  // 21:30 UTC at +03:00 is already the next day locally.
  assert.equal(token("today", CLOCK, {}), "2026-09-14");
  assert.equal(token("localdate", CLOCK, {}), "2026-09-15");
});

test("localday clamps forward unconditionally, so it is monotonic in the hour", () => {
  const morning = clockOf({ tz_offset_minutes: 180, now: Date.UTC(2026, 8, 14, 3, 0, 0) / 1000 });
  const evening = clockOf({ tz_offset_minutes: 180, now: Date.UTC(2026, 8, 14, 21, 0, 0) / 1000 });
  for (const c of [morning, evening]) {
    const t = Date.parse(token("localday+7h", c, {}));
    assert.ok(t > c.now * 1000, "localday+7h must be in the future at every hour of the day");
  }
});

test("offset needs a unit; a bare number is unresolved rather than seconds", () => {
  assert.equal(offset("+90m"), 5400);
  assert.equal(offset("-3d"), -259200);
  assert.equal(offset("+90"), null);
});

test("paths index lists and a bare array arrives as _list", () => {
  assert.equal(at({ briefs: [{ date: "x" }] }, "briefs.0.date"), "x");
  assert.equal(at({ _list: [1, 2] }, "_list.1"), 2);
  assert.equal(at({ a: 1 }, "a.b"), undefined);
  assert.equal(lenOf([1, 2, 3]), 3);
  assert.equal(typeName(1.5), "float");
  assert.equal(typeName(2), "int");
});

test("check reports every expectation that did not hold, in the corpus's words", () => {
  const body = { id: "it-1", version: 2, items: [{ id: "a" }, { id: "b" }], name: "widget" };
  const r = check({ status: 200, json: { version: 1 }, json_present: ["id"], json_len_at_least: { items: 3 },
    json_matches: { id: "^it-\\d+$" }, contains: { items: { id: "c" } } }, body, 200, 10);
  assert.equal(r.why.length, 3);
  assert.ok(r.why.some((w) => w.includes("version = 2, expected 1")));
  assert.ok(r.why.some((w) => w.includes("has 2 items, expected at least 3")));
  assert.ok(r.why.some((w) => w.includes("no item of items")));
  assert.equal(r.got.version, 2);
});

test("not_both fails only when both sides hold", () => {
  const narrative = { says: "clear", meetings: 2 };
  assert.equal(check({ not_both: [{ says: "clear" }, { meetings: 2 }] }, narrative, 200, 1).why.length, 1);
  assert.equal(check({ not_both: [{ says: "clear" }, { meetings: 9 }] }, narrative, 200, 1).why.length, 0);
});

test("asserts separates 'nothing failed' from 'nothing was asserted'", () => {
  assert.deepEqual(asserts({}), { n: 0, unknown: [] });
  assert.deepEqual(asserts({ status: 200 }), { n: 1, unknown: [] });
  assert.deepEqual(asserts({ stat: 200 }), { n: 0, unknown: ["stat"] });
});

test("a bare run step expects rc 0; one with an expect block does not", () => {
  assert.equal(checkCmd(null, { rc: 0, stdout: "", stderr: "", ms: 1 }).why.length, 0);
  assert.equal(checkCmd(null, { rc: 1, stdout: "", stderr: "", ms: 1 }).why.length, 1);
  assert.equal(checkCmd({ rc: 1 }, { rc: 1, stdout: "", stderr: "", ms: 1 }).why.length, 0);
});

// ── the gate in front of a run ───────────────────────────────────────────────

function writeCorpus(id, scenarios, persona = {}) {
  const dir = path.join(root, ".bundlebox", "cookbook", id);
  fs.mkdirSync(path.join(dir, "scenarios", "01-items"), { recursive: true });
  fs.writeFileSync(path.join(dir, "persona.json"), JSON.stringify({ base: "", rpm: 0, ...persona }));
  fs.writeFileSync(path.join(dir, "surfaces.json"), JSON.stringify([{ id: "items", title: "Items" }]));
  scenarios.forEach((s, i) => fs.writeFileSync(path.join(dir, "scenarios", "01-items", `0${i + 1}.json`), JSON.stringify(s)));
  return dir;
}

test("check refuses a scenario that asserts nothing, an unknown surface, a duplicate id and a bad actor", () => {
  writeCorpus("bad", [
    { id: "dup", surface: "items", steps: [{ name: "x", do: "GET /a", expect: {} }] },
    { id: "dup", surface: "nope", steps: [{ name: "y", do: "GET /b", expect: { status: 200 } }] },
    { id: "who", surface: "items", steps: [{ name: "z", as: "nobody", do: "GET /c", expect: { status: 200 } }] },
    { id: "kind", surface: "items", steps: [{ name: "w", do: "GET /d", run: "ls", expect: { status: 200 } }] },
    { id: "key", surface: "items", steps: [{ name: "v", do: "GET /e", expect: { staus: 200 } }] },
  ]);
  const r = corpus.check(corpus.load("bad"));
  assert.equal(r.ok, false);
  const joined = r.errors.join("\n");
  assert.match(joined, /no step asserts anything/);
  assert.match(joined, /is not in surfaces\.json/);
  assert.match(joined, /duplicate id/);
  assert.match(joined, /names nobody/);
  assert.match(joined, /a step is one thing/);
  assert.match(joined, /is not implemented/);
});

test("check refuses a token nothing in scope defines, and keeps the three that do", () => {
  writeCorpus("tokens", [
    { id: "typo", surface: "items", steps: [{ name: "a", do: "GET /items/{{tenatn}}", expect: { status: 200 } }] },
    { id: "unit", surface: "items", steps: [{ name: "b", do: "GET /at/{{+90}}", expect: { status: 200 } }] },
    { id: "order", surface: "items", steps: [
      { name: "c", do: "GET /a/{{item}}", expect: { status: 200 } },
      { name: "d", do: "POST /b", expect: { status: 201 }, save: { item: "id" } },
    ] },
    { id: "legal", surface: "items", steps: [
      { name: "e", do: "POST /b", body: { when: "{{+2d}}", who: "{{tenant}}" }, expect: { status: 201 }, save: { item: "id" } },
      { name: "f", do: "GET /b/{{item}}", headers: { "X-Run": "{{run}}" }, expect: { status: 200, json: { seat: "{{seat}}" } } },
    ] },
  ], { vars: { tenant: "acme" }, setup: [{ name: "seed", do: "POST /seed", expect: { status: 201 }, save: { seat: "id" } }] });
  const r = corpus.check(corpus.load("tokens"));
  assert.equal(r.ok, false);
  const joined = r.errors.join("\n");
  assert.match(joined, /\{\{tenatn\}\}/);                 // a typo
  assert.match(joined, /\{\{\+90\}\}/);                    // an offset with no unit
  assert.match(joined, /\{\{item\}\}/);                     // saved by a LATER step in the same scenario
  // and nothing else: a persona var, a setup save, an earlier save and four
  // built-ins all resolve without a server.
  assert.equal(joined.match(/resolves to nothing/g).length, 3);
});

test("a corpus with no base is refused rather than run against a guess", async () => {
  writeCorpus("nobase", [{ id: "ok", surface: "items", severity: "low", rule: ["x"], steps: [{ name: "a", do: "GET /health", expect: { status: 200 } }] }]);
  const cookbook = await import("../src/cookbook/index.js");
  const r = await cookbook.runCorpus("nobase", {});
  assert.equal(r.rc, 2);
  assert.match(r.why, /no base/);
});

// ── the two engines agree ───────────────────────────────────────────────────

const SCENARIOS = [
  { id: "write-read", surface: "items", severity: "high", title: "a write round-trips", rule: ["POST /items returns 201 with version 1"],
    steps: [
      { name: "create", do: "POST /items", body: { title: "x {{run}}", due: "{{+2d}}" },
        expect: { status: 201, json: { version: 1 }, json_matches: { id: "^it-[0-9]+$" }, json_present: ["id"] }, save: { item: "id" } },
      { name: "read back", do: "GET /items/{{item}}", expect: { status: 200, json: { id: "{{item}}" } } },
      { name: "in the list", do: "GET /items", expect: { json_len_at_least: { _list: 1 }, contains: { _list: { id: "{{item}}" } } } },
    ] },
  { id: "missing", surface: "items", severity: "medium", title: "a missing item", rule: ["404 names the id"],
    steps: [{ name: "404", do: "GET /items/nope", expect: { status: 404, json: { error: "no such item", id: "nope" } } }] },
  { id: "blocked", surface: "items", severity: "low", title: "a precondition blocks the rest", rule: ["x"],
    steps: [
      { name: "PRECONDITION", precondition: true, do: "GET /nowhere", expect: { status: 200 } },
      { name: "never runs", do: "GET /items", expect: { status: 200 } },
    ] },
  { id: "typo", surface: "items", severity: "low", title: "an unresolved token errors", rule: ["x"],
    steps: [{ name: "typo", do: "GET /items/{{tem}}", expect: { status: 200 } }] },
];

// The fixture server runs in its own PROCESS, not in this one. `kernel.call`
// is spawnSync: it blocks the Node event loop for as long as the kernel runs,
// so an in-process http server could never answer it and every kernel request
// would time out. That is fine in the CLI, where the process exists to make
// exactly one kernel call, and it is a trap in a test.
const SERVER = `
const http = require("node:http");
const items = [];
const s = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const send = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/items" && req.method === "POST") { const o = JSON.parse(b || "{}"); const row = { id: "it-" + (items.length + 1), title: o.title, version: 1 }; items.push(row); return send(201, row); }
    if (u.pathname === "/items") return send(200, items);
    if (u.pathname.startsWith("/items/")) { const r = items.find((x) => x.id === u.pathname.split("/")[2]); return r ? send(200, r) : send(404, { error: "no such item" }); }
    send(404, { error: "not found" });
  });
});
s.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));
`;

function server() {
  const file = path.join(tmp, `srv-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, SERVER);
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fixture server did not start")), 10000);
    child.stdout.on("data", (d) => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m) { clearTimeout(t); resolve({ port: Number(m[1]), server: { close: () => child.kill() } }); }
    });
  });
}

const shape = (board) => ({
  totals: board.totals,
  setup: board.setup.state,
  scenarios: board.scenarios.map((sc) => ({ id: sc.id, state: sc.state,
    steps: sc.steps.map((st) => ({ name: st.name, state: st.state, status: st.status, why: st.why })) })),
});

test("the kernel and the JS engine return the same board for the same corpus", async (t) => {
  if (!kernel.available()) return t.skip("no bbk on this box");
  const a = await server(), b = await server();
  try {
    const input = (port) => ({ base: `http://127.0.0.1:${port}`, rpm: 0, parallel: 1, timezone: "UTC", tz_offset_minutes: 0,
      root, run: "RUN", setup: [{ name: "up", do: "GET /items", expect: { status: 200 } }], scenarios: SCENARIOS });
    const kb = await engine.run(input(a.port), { engine: "kernel" });
    const jb = await engine.run(input(b.port), { engine: "js" });
    assert.equal(kb.engine, "kernel");
    assert.equal(jb.engine, "js");
    assert.deepEqual(shape(kb), shape(jb));
    assert.equal(kb.totals.blocked, 1, "the precondition blocks exactly the step after it");
    assert.equal(kb.totals.error, 1, "the unresolved token is an error, not a failure");
    assert.ok(kb.scenarios.find((s) => s.id === "missing").state === "failed");
  } finally { a.server.close(); b.server.close(); }
});

test("a setup that fails blocks every scenario rather than reporting on the product", async () => {
  const board = await engine.runJs({ base: "http://127.0.0.1:1", rpm: 0, root, timeout_ms: 300,
    setup: [{ name: "up", do: "GET /health", expect: { status: 200 } }], scenarios: SCENARIOS });
  assert.equal(board.setup.state, "failed");
  assert.equal(board.totals.passed, 0);
  assert.ok(board.scenarios.every((s) => s.state === "blocked"));
  assert.match(board.scenarios[0].steps[0].why[0], /setup failed/);
});

test("pick names the engine and says why the other one is not running", () => {
  const https = engine.pick({ base: "https://example.com", scenarios: [] });
  assert.equal(https.engine, "js");
  assert.match(https.why, /https|kernel binary/);
});

test("the expectation vocabulary is closed: every key check() handles is in KEYS", () => {
  for (const k of ["status", "json", "each", "contains", "not_both", "json_matches"]) assert.ok(KEYS.includes(k));
  assert.equal(KEYS.length, new Set(KEYS).size);
});
