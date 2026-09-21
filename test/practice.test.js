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

test("genesis --finding: the row's path is the surface, its detail is the rule, and what it names is a capability", async (t) => {
  if (skipIfNoPython(t)) return;
  store.put("findings", [...store.get("findings", []), {
    id: "f00dcafe01", detector: "silent-fallback", severity: "high", status: "open",
    path: "src/api/invoices.js", files: ["src/api/invoices.js"],
    title: "src/api/invoices.js: the tenant falls back without a warning",
    detail: "POST /invoices must not fall back to the default tenant when the header is absent. `bb scan --only silent-fallback` shows it.",
    fix_hint: "Return 400 instead of falling back.",
    evidence: { line: 42, snippet: "tenant = header || DEFAULT_TENANT" },
  }]);
  const r = genesis.derive({ finding: "f00dcafe" });
  assert.equal(r.rc, 0, r.why);
  const w = r.world;
  assert.equal(w.row.kind, "finding");
  assert.deepEqual(w.surfaces.map((s2) => s2.id), ["invoices"], "the surface is named from the path");
  assert.equal(w.rules.length, 1);
  assert.match(w.rules[0].text, /must not fall back/);
  assert.equal(w.rules[0].modality, "must_not");
  assert.equal(w.rules[0].surface, "invoices");
  // A capability for every route and command the row names, and nothing else.
  const caps = w.capabilities.map((c) => c.id);
  assert.ok(caps.includes("http:POST /invoices"), caps.join(", "));
  assert.ok(caps.some((c) => c.startsWith("cmd:bb scan")), caps.join(", "));
  assert.ok(w.capabilities.every((c) => c.surface === "invoices"));
  // and unknown rows for what a row cannot settle
  assert.ok(w.unknown.some((u) => /actors/.test(u)), w.unknown.join(" | "));
  assert.ok(w.unknown.some((u) => /base URL/.test(u)), w.unknown.join(" | "));
  assert.ok(fs.existsSync(path.join(root, ".bundlebox", "genesis", "invoices", "source.txt")));
});

test("genesis --finding: an id that matches nothing, and one that matches more than one row, both say so", async (t) => {
  if (skipIfNoPython(t)) return;
  assert.match(genesis.derive({ finding: "nosuchrow" }).why, /no finding/);
  store.put("findings", [...store.get("findings", []),
    { id: "dupe01", detector: "x", path: "a.js", title: "a", detail: "a must hold", status: "open" },
    { id: "dupe02", detector: "x", path: "b.js", title: "b", detail: "b must hold", status: "open" }]);
  assert.match(genesis.derive({ finding: "dupe" }).why, /matches 2 findings/);
});

test("genesis --ticket: a pasted issue reaches the same world shape", async (t) => {
  if (skipIfNoPython(t)) return;
  const f = path.join(tmp, "issue.md");
  fs.writeFileSync(f, "# Checkout hangs\n\nGET /checkout must answer inside 2s. It does not, on every second call.\n");
  const r = genesis.derive({ ticket: f, name: "checkout-ticket" });
  assert.equal(r.rc, 0, r.why);
  const w = r.world;
  assert.equal(w.row.kind, "ticket");
  assert.deepEqual(w.surfaces.map((s2) => s2.id), ["checkout-hangs"], "no path, so the surface is the title");
  assert.equal(w.rules.length, 1);
  assert.match(w.rules[0].text, /must answer inside 2s/);
  assert.deepEqual(w.capabilities.map((c) => c.id), ["http:GET /checkout"]);
  assert.match(genesis.derive({ ticket: path.join(tmp, "nothing.md") }).why, /cannot read/);
});

test("practice: it starts the service that declares the base, and hands what it found to compile and route", async (t) => {
  if (skipIfNoPython(t)) return;
  const doc = path.join(root, "SHOP.md");
  fs.writeFileSync(doc, DOC);
  assert.equal(genesis.derive({ doc, name: "shop" }).rc, 0);
  assert.equal(genesis.seed("shop", { base }).rc, 0);
  // Declared and down: nothing in the runbook state has ever started it. The
  // command exits immediately — what is under test is that the round resolved
  // the base to this row and started it, not what the process then did.
  fs.mkdirSync(path.join(root, ".bundlebox", "runbook"), { recursive: true });
  fs.writeFileSync(path.join(root, ".bundlebox", "runbook", "services.json"), JSON.stringify([
    { id: "probe", group: "all", cmd: `${JSON.stringify(process.execPath)} -e ""`, cwd: ".", port: Number(port), health: `${base}/orders` },
  ]));
  const scen = path.join(root, ".bundlebox", "cookbook", "shop", "scenarios");
  const dir = fs.readdirSync(scen).find((d) => /orders/.test(d));
  const surface = dir.replace(/^\d+-/, "");
  const actor = async (pack) => {
    if (pack.surface !== surface) return { state: "done", why: "nothing for this surface" };
    sc(path.join(scen, dir), "01-submit.json", { id: "shop-submit", surface, severity: "high", title: "submit with no line",
      question: "is an empty order refused?", rule: ["An order must have at least one line before it can be submitted (line 2)"],
      steps: [{ name: "submit empty", do: "POST /orders", body: { lines: [] }, expect: { status: 422 } }] });
    return { state: "done", why: "wrote 1" };
  };
  const out = await practice.practice("shop", { rounds: 1, actor });
  assert.equal(out.rc, 0, out.why);
  // W2: the round names the service it started.
  assert.equal(out.base, base);
  assert.equal(out.service.id, "probe");
  assert.match(out.service.state, /^(up|already up)$/, JSON.stringify(out.service));
  // W3: the red-under-a-rule scenario is a finding, and the round ends holding
  // a packed unit and a lane rather than a row.
  const round = out.rounds[0];
  assert.equal(round.kept.length, 1);
  assert.match(round.kept[0].why, /red under a quoted rule/);
  assert.ok(round.findings >= 1, JSON.stringify(round.kept));
  assert.ok(round.units.length >= 1, `no unit for the kept red scenario: ${JSON.stringify(round)}`);
  const laneIds = new Set(store.get("lanes", []).map((l) => l.id));
  for (const ln of round.lanes) assert.ok(laneIds.has(ln.id), `${ln.id} is not in lanes.json, so \`bb run\` would not list it`);
  assert.ok(round.lanes.length >= 1 && round.lanes.every((l) => l.units > 0), JSON.stringify(round.lanes));
});

test("practice: services declared and none at this base is a mismatch the round refuses to run at", async (t) => {
  if (skipIfNoPython(t)) return;
  fs.writeFileSync(path.join(root, ".bundlebox", "runbook", "services.json"), JSON.stringify([
    { id: "elsewhere", cmd: "true", port: 1, health: "http://127.0.0.1:1/health" },
  ]));
  const scen = path.join(root, ".bundlebox", "cookbook", "shop", "scenarios");
  const dir = fs.readdirSync(scen).find((d) => /tenancy/.test(d)) || fs.readdirSync(scen)[0];
  const surface = dir.replace(/^\d+-/, "");
  const actor = async (pack) => {
    if (pack.surface !== surface) return { state: "done", why: "nothing for this surface" };
    sc(path.join(scen, dir), "01-list.json", { id: "shop-list", surface, severity: "low", title: "list is reachable",
      question: "does GET /orders answer?", rule: ["GET /orders is exposed (line 3)"],
      steps: [{ name: "list", do: "GET /orders", expect: { status: 200 } }] });
    return { state: "done", why: "wrote 1" };
  };
  const out = await practice.practice("shop", { rounds: 1, actor });
  assert.equal(out.service.state, "undeclared");
  assert.match(out.service.why, /no service declares/);
  assert.equal(out.rounds[0].kept[0].why, "validated; not run");
  fs.rmSync(path.join(root, ".bundlebox", "runbook", "services.json"));
});

test("practice: a ceiling already reached stops the loop before it drafts anything, and it is re-read every round", async (t) => {
  if (skipIfNoPython(t)) return;
  const cfg = path.join(root, ".bundlebox", "config.json");
  // A day's worth of priced usage against a $1 lane ceiling.
  store.append("usage", { ts: `${new Date().toISOString().slice(0, 10)}T00:00:00Z`, session_id: "s", msg_id: "m",
    run_id: "r", model: "claude-sonnet-5", input: 4_000_000, output: 400_000 });
  fs.writeFileSync(cfg, JSON.stringify({ lanes: { daily_budget_usd: 1 }, bridge: { enabled: true, daily_budget_usd: 1 } }));
  let sent = 0;
  const out = await practice.practice("shop", { rounds: 3, spend: true, run: true, actor: async () => { sent += 1; return { state: "done" }; } });
  assert.equal(out.rc, 0, out.why);
  assert.equal(sent, 0, "nothing was drafted against a ceiling already reached");
  assert.equal(out.rounds.length, 0);
  assert.match(out.stopped, /^budget: /);
  assert.match(out.stopped, /lanes —/);
  assert.equal(out.budget.ok, false);
  assert.ok(out.budget.lanes.over_by > 0, JSON.stringify(out.budget));

  // Raised between runs: the loop reads it again rather than caching it.
  fs.writeFileSync(cfg, JSON.stringify({ lanes: { daily_budget_usd: 0 }, bridge: { enabled: true, daily_budget_usd: 0 } }));
  const again = await practice.practice("shop", { rounds: 1, spend: true, run: true, actor: async () => { sent += 1; return { state: "done", why: "nothing written" }; } });
  assert.equal(again.budget.ok, true);
  assert.ok(sent > 0, "with no ceiling the round drafts");
  fs.unlinkSync(cfg);
});

test("practice: two rounds that buy no coverage stop the loop, whatever the verifier kept", async (t) => {
  if (skipIfNoPython(t)) return;
  const doc = path.join(root, "REPEAT.md");
  fs.writeFileSync(doc, DOC);
  assert.equal(genesis.derive({ doc, name: "repeat" }).rc, 0);
  assert.equal(genesis.seed("repeat", { base }).rc, 0);
  const scen = path.join(root, ".bundlebox", "cookbook", "repeat", "scenarios");
  const dir = fs.readdirSync(scen).find((d) => /orders/.test(d));
  const surface = dir.replace(/^\d+-/, "");
  let round = 0;
  // Every round: one scenario that is kept, and one that is rejected for the
  // SAME reason under the same name. The lessons bump and never add.
  const actor = async (pack) => {
    if (pack.surface !== surface) return { state: "done", why: "nothing for this surface" };
    round += 1;
    sc(path.join(scen, dir), `0${round}-ok.json`, { id: `repeat-ok-${round}`, surface, severity: "low", title: "list",
      question: "?", rule: ["GET /orders is exposed (line 3)"], steps: [{ name: "list", do: "GET /orders", expect: { status: 200 } }] });
    sc(path.join(scen, dir), "99-same.json", { id: "repeat-same", surface, severity: "low", title: "asserts nothing",
      question: "?", rule: ["x"], steps: [{ name: "look", do: "GET /orders" }] });
    return { state: "done", why: "wrote 2" };
  };
  const out = await practice.practice("repeat", { rounds: 6, actor });
  assert.equal(out.rc, 0, out.why);
  assert.match(out.stopped, /^no progress: coverage held at .+ for 2 rounds/);
  assert.equal(out.rounds[out.rounds.length - 1].stale_rounds, 2);
  assert.ok(out.rounds.length < 6, `it ran every round it was given: ${out.rounds.map((r) => r.coverage_pct).join(", ")}`);
  // It kept a scenario every round and the verifier passed every time: this is
  // the one stop that a round's own verdict cannot reach.
  assert.ok(out.kept >= out.rounds.length, JSON.stringify(out.rounds.map((r) => r.kept.length)));
  const pcts = out.rounds.map((r) => r.coverage_pct);
  assert.equal(pcts[pcts.length - 1], pcts[pcts.length - 2], `coverage moved: ${pcts.join(", ")}`);
});

test.after(() => child.kill());
