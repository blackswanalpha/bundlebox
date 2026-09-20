// practice.test.js — the loop that spends, run here with an actor that does
// not. What is under test is the verifier and the memory: which of the files
// an actor wrote survive, why the rest were set aside, and that the reason
// lands where `bb pinpoint` will read it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-practice-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
const expert = await import("../src/core/expert.js");
const genesis = await import("../src/genesis/index.js");
const practice = await import("../src/genesis/practice.js");
const store = await import("../src/core/store.js");

const DOC = `
# Orders
An order must have at least one line before it can be submitted.
The API exposes GET /orders and POST /orders, and GET /orders/{id} for one.
## Tenancy
A member must not read another tenant's orders. GET /tenant/{id}/members lists them.
`;
const py = expert.available();
const skipIfNoPython = (t) => { if (!py) { t.skip("python3 >= 3.9 is not on this box"); return true; } return false; };

// The base the verifier runs against: its own process, because the engine is
// awaited from this one. GET /orders is 200 [], everything else 404.
const server = path.join(tmp, "server.mjs");
fs.writeFileSync(server, `import http from "node:http";
const s = http.createServer((req, res) => { res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/orders") { res.end("[]"); return; } res.statusCode = 404; res.end("{}"); });
s.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));`);
const child = spawn(process.execPath, [server], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => child.stdout.once("data", (d) => r(String(d).trim().replace("PORT ", ""))));
const base = `http://127.0.0.1:${port}`;

const sc = (dir, name, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2)); };

test("practice: broad round, the verifier keeps green and rule-backed red, sets aside the rest, and the lessons reach edge-cases.md", async (t) => {
  if (skipIfNoPython(t)) return;
  const doc = path.join(root, "PRD.md");
  fs.writeFileSync(doc, DOC);
  const r = genesis.derive({ doc, name: "orders" });
  assert.equal(r.rc, 0);
  const s = genesis.seed("orders", { base });
  assert.equal(s.rc, 0);
  const scen = path.join(root, ".bundlebox", "cookbook", "orders", "scenarios");
  const ordersDir = fs.readdirSync(scen).find((d) => /orders/.test(d));
  assert.ok(ordersDir, `no orders surface dir in ${fs.readdirSync(scen).join(", ")}`);
  const surface = ordersDir.replace(/^\d+-/, "");
  const written = [];
  // The actor: one pack, four files. A model would write these; here the test does.
  const actor = async (pack) => {
    if (pack.surface !== surface) return { state: "done", why: "nothing for this surface" };
    const d = path.join(scen, ordersDir);
    sc(d, "01-list.json", { id: "orders-list", surface, severity: "medium", title: "list is reachable", question: "does GET /orders answer?", rule: ["GET /orders is exposed (line 3)"], steps: [{ name: "list", do: "GET /orders", expect: { status: 200 } }] });
    sc(d, "02-empty.json", { id: "orders-empty", surface, severity: "low", title: "asserts nothing", question: "?", rule: ["x"], steps: [{ name: "look", do: "GET /orders" }] });
    sc(d, "03-opinion.json", { id: "orders-opinion", surface, severity: "low", title: "an opinion", question: "?", steps: [{ name: "wish", do: "GET /orders", expect: { status: 204 } }] });
    sc(d, "04-contradiction.json", { id: "orders-submit", surface, severity: "high", title: "submit with no line", question: "is an empty order refused?", rule: ["An order must have at least one line before it can be submitted (line 2)"], steps: [{ name: "submit empty", do: "POST /orders", body: { lines: [] }, expect: { status: 422 } }] });
    written.push(pack.file);
    return { state: "done", why: "wrote 4" };
  };
  const out = await practice.practice("orders", { rounds: 1, actor });
  assert.equal(out.rc, 0, out.why);
  assert.equal(out.rounds.length, 1);
  const round = out.rounds[0];
  assert.equal(round.phase, "broad");
  assert.equal(written.length, 1, "one pack per surface in the broad round, and this actor writes for one surface");
  assert.equal(round.wrote, 4);
  const keptIds = round.kept.map((k) => k.id).sort();
  assert.deepEqual(keptIds, ["orders-list", "orders-submit"], JSON.stringify(round, null, 1).slice(0, 1500));
  assert.match(round.kept.find((k) => k.id === "orders-submit").why, /red under a quoted rule/);
  const rej = Object.fromEntries(round.rejected.map((x) => [x.id || path.basename(x.file, ".json"), x]));
  assert.equal(rej["orders-empty"].kind, "check");
  assert.match(rej["orders-empty"].why, /asserts anything/);
  assert.equal(rej["orders-opinion"].kind, "corpus-opinion");
  // set aside, not deleted; the kept files stay
  assert.ok(!fs.existsSync(path.join(scen, ordersDir, "02-empty.json")));
  assert.ok(fs.existsSync(path.join(root, rej["orders-empty"].moved_to)));
  assert.ok(fs.existsSync(path.join(scen, ordersDir, "01-list.json")));
  // the red step under a rule is a finding; the opinion's is not
  const f = store.get("findings", []);
  assert.ok(f.some((x) => x.path === "orders-submit"), "the contradiction became a finding");
  assert.ok(!f.some((x) => x.path === "orders-opinion"), "the opinion did not");
  // the lessons
  const md = fs.readFileSync(path.join(root, ".bundlebox", "edge-cases.md"), "utf8");
  assert.match(md, /\| E1 \| orders\/orders-empty .*\| check: /);
  assert.match(md, /\| E2 \| orders\/orders-opinion .*\| corpus-opinion: /);
  assert.equal(round.lessons.added, 2);
  assert.ok(fs.existsSync(path.join(root, out.file)));
  assert.match(out.stopped, /1 round/);
});

test("practice: the memory dedups by what and why, and drops what nobody re-saw inside the TTL", () => {
  const file = path.join(tmp, "edge.md");
  fs.writeFileSync(file, "# Traps\n\n| E1 | a person's row | keep it | always |\n");
  const a = practice.remember([{ file: "x/01.json", id: "one", kind: "check", why: "no steps" }], { corpusId: "c", file, at: "2026-01-01" });
  assert.deepEqual([a.rows, a.added, a.bumped], [1, 1, 0]);
  const b = practice.remember([{ file: "x/01.json", id: "one", kind: "check", why: "no steps" }, { file: "x/02.json", id: "two", kind: "blocked", why: "401" }], { corpusId: "c", file, at: "2026-02-01" });
  assert.deepEqual([b.rows, b.added, b.bumped], [2, 1, 1]);
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /^\| E1 \| a person's row/m, "rows above the section are untouched");
  assert.match(md, /\| E1 \| c\/one \(x\/01\.json\) \| check: no steps \| seen 2026-02-01 ×2 \|/);
  const c = practice.remember([], { corpusId: "c", file, at: "2026-06-01", ttlDays: 90 });
  assert.equal(c.rows, 0, "both rows are older than 90 days and nobody re-saw them");
  assert.equal(c.dropped, 2);
});

test("practice with the default actor and no bridge spends nothing and says so", async (t) => {
  if (skipIfNoPython(t)) return;
  const out = await practice.practice("orders", { rounds: 2, run: true, spend: true });
  assert.equal(out.rc, 0);
  assert.equal(out.rounds.length, 1);
  assert.equal(out.rounds[0].wrote, 0);
  assert.match(out.stopped, /nothing spent/);
  assert.ok(out.rounds[0].sent.every((s) => s.state !== "done"));
});

test.after(() => child.kill());
