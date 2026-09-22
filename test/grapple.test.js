// grapple.test.js — the handoff layer. Every detector here is a set
// operation, a counter or a hash comparison; these tests are the reason the
// three claims the design makes can be trusted: an answer is given once and
// held until the code under it moves, a pattern answer reaches rows it was
// never asked about, and phase 1 changes nothing a session can observe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-grapple-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const cfg = (grapple) => w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 }, wire: { auto_init: false }, grapple }));
w("package.json", JSON.stringify({ name: "fixture", type: "module" }));
cfg({ phase: "observe" });
w("src/a.js", "export const a = 1;\n");
w("src/b.js", "export const b = 2;\n");
w("src/c.js", "export const c = 3;\n");

const gs = await import("../src/grapple/store.js");
const detect = await import("../src/grapple/detect.js");
const ask = await import("../src/grapple/ask.js");
const harvest = await import("../src/grapple/harvest.js");
const promote = await import("../src/grapple/promote.js");
const grapple = await import("../src/grapple/index.js");
const hooks = await import("../src/wire/hooks.js");
const brief = await import("../src/wire/brief.js");
const core = await import("../src/core/store.js");
const { load } = await import("../src/core/config.js");
const { text: estimateText } = await import("../src/tokens/estimate.js");

const row = (over = {}) => ({ detector: "swallowed-errors", path: "src/a.js", key: "src/a.js:12", title: "src/a.js:12 catch block swallows the error", severity: "medium", precision: "heuristic", status: "open", first_seen: "2026-09-01T00:00:00.000Z", last_seen: "2026-09-18T00:00:00.000Z", seen_count: 185, ...over });

// ── 1. store identity ───────────────────────────────────────────────────────
test("same brief, same key, same fingerprint is one answer; a moved fingerprint expires it", () => {
  const key = gs.instanceKey("brief-1", "no-gate");
  gs.answer({ shape: "instance", key, fingerprint: "fp1", value: "yes", reason: "npm test is the gate" });
  gs.answer({ shape: "instance", key, fingerprint: "fp1", value: "yes", reason: "still" });
  const all = Object.values(gs.answers()).filter((a) => a.key === key);
  assert.equal(all.length, 1, "one record, overwritten, never two");
  assert.ok(gs.lookup({ instance: key, fingerprint: "fp1" }), "live under the fingerprint it was answered against");
  assert.equal(gs.lookup({ instance: key, fingerprint: "fp2" }), null, "the fingerprint moved: askable again");
  assert.equal(gs.stale({ [key]: "fp2" }).length, 1);
});

// ── 2. two key shapes ───────────────────────────────────────────────────────
test("a pattern answer reaches a file it never saw; an instance answer reaches one path only", () => {
  const seen = row(), unseen = row({ path: "src/zzz/new.js", key: "src/zzz/new.js:40", title: "src/zzz/new.js:40 catch block swallows the error" });
  const pk = gs.patternKey(seen.detector, seen.title);
  assert.equal(pk, gs.patternKey(unseen.detector, unseen.title), "the shape strips the path and the line");
  gs.answer({ shape: "pattern", key: pk, value: "yes", reason: "hooks swallow on purpose" });
  assert.equal(gs.lookup({ pattern: gs.patternKey(unseen.detector, unseen.title) }).via, "pattern");
  const ik = core.findingId(seen);
  gs.answer({ shape: "instance", key: ik, fingerprint: "w1", value: "no" });
  assert.equal(gs.lookup({ instance: core.findingId(unseen), fingerprint: "w1" }), null, "an instance answer never generalises");
  // the fingerprint moves: the instance answer expires, the pattern answer stands
  assert.equal(gs.lookup({ instance: ik, fingerprint: "w2" }), null);
  assert.ok(gs.lookup({ pattern: pk }));
});

// ── 3. collision detection ──────────────────────────────────────────────────
test("two lanes sharing a file are flagged, disjoint lanes are not, and nothing is called", () => {
  let calls = 0;
  const fetch0 = globalThis.fetch;
  globalThis.fetch = () => { calls += 1; throw new Error("no model call in src/"); };
  try {
    assert.deepEqual(detect.collision(["src/a.js", "src/b.js"], ["src/b.js", "src/c.js"]), ["src/b.js"]);
    assert.deepEqual(detect.collision(["src/a.js"], ["src/c.js"]), []);
    brief.activate(brief.record({ problem: "lane one", scope: ["src/a.js", "src/b.js"] }, { sessionId: "s-one" }));
    brief.activate(brief.record({ problem: "lane two", scope: ["src/b.js"] }, { sessionId: "s-two" }));
    brief.activate(brief.record({ problem: "lane three", scope: ["src/c.js"] }, { sessionId: "s-three" }));
    const c = detect.collisions();
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].shared, ["src/b.js"]);
  } finally { globalThis.fetch = fetch0; }
  assert.equal(calls, 0);
});

// ── 4. scope guard ──────────────────────────────────────────────────────────
test("a write inside the scope passes; outside it is refused within the pre-write budget", () => {
  const rec = brief.record({ problem: "fix the thing", scope: ["src/a.js"], cut: ["src/c.js"] }, { sessionId: "s-guard" });
  assert.equal(detect.writeVerdict(rec, path.join(root, "src/a.js")), null);
  assert.equal(detect.writeVerdict(rec, path.join(root, "test/a.test.js")), null, "a gate for the change is part of the change");
  assert.equal(detect.writeVerdict(rec, path.join(root, ".bundlebox/out/x.json")), null, "the box writes its own artefacts under every brief");
  const deny = detect.writeVerdict(rec, path.join(root, "src/b.js"));
  assert.equal(deny.permissionDecision, "deny");
  assert.ok(estimateText(deny.permissionDecisionReason, "prose") <= hooks.CAPS["pre-write"]);
  assert.equal(detect.writeVerdict(rec, path.join(root, "src/c.js")).permissionDecision, "ask", "a cut file is the brief's own `name it first`");
  assert.ok(hooks.EVENTS.includes("pre-write"));
});

// ── 5. TTL ──────────────────────────────────────────────────────────────────
test("an unanswered question past its TTL is expired-unanswered, which is never answered", () => {
  const q = gs.putQuestion({ key: "q-ttl", shape: "instance", text: "is this deliberate?" });
  const a = gs.putQuestion({ key: "q-ans", shape: "instance", text: "and this?" });
  gs.setState("q-ans", "answered", { value: "yes" });
  const later = Date.parse(q.asked_at) + 100 * 3600000;
  assert.deepEqual(gs.expire({ ttlHours: 72, at: later }), ["q-ttl"]);
  const qs = gs.questions();
  assert.equal(qs["q-ttl"].state, "expired-unanswered");
  assert.equal(qs["q-ans"].state, "answered", "expiry never touches an answered row");
  assert.notEqual(qs["q-ttl"].state, qs["q-ans"].state);
  assert.ok(gs.STATES.includes("expired-unanswered") && gs.STATES.includes("answered"));
  assert.equal(a.state, "open");
  // an observe pass does not resurrect it: expired stays expired until somebody reopens it
  assert.equal(gs.putQuestion({ key: "q-ttl", shape: "instance", text: "again" }).state, "expired-unanswered");
  const r = gs.reopen("q-ttl");
  assert.equal(r.state, "open");
  assert.ok(Date.parse(r.asked_at) > Date.parse(q.asked_at), "reopened on a fresh clock, so the TTL runs again");
  assert.equal(gs.reopen("q-ans"), null, "only an expired question can be reopened");
  // an answered instance question whose fingerprint moved is asked again, under the new fingerprint
  gs.putQuestion({ key: "q-fp", shape: "instance", fingerprint: "fp1", text: "scope?" });
  gs.setState("q-fp", "answered", { value: "yes" });
  assert.equal(gs.putQuestion({ key: "q-fp", shape: "instance", fingerprint: "fp1", text: "scope?" }).state, "answered", "live answer: left alone");
  const moved = gs.putQuestion({ key: "q-fp", shape: "instance", fingerprint: "fp2", text: "scope?" });
  assert.equal(moved.state, "open");
  assert.equal(moved.fingerprint, "fp2");
  assert.equal(moved.reasked_from, "fp1");
});

// ── 6. harvest is conditioned, not counted ──────────────────────────────────
test("a high seen_count with no edit is no label; the same row with commits on its path is one negative", () => {
  const f = row({ seen_count: 185 });
  assert.deepEqual(harvest.survival([f], { count: () => 0 }).labels, [], "four days of survival is not evidence");
  const s = harvest.survival([f], { count: (since, file) => (file === "src/a.js" ? 2 : 0) });
  assert.equal(s.labels.length, 1);
  assert.equal(s.labels[0].label, "not-a-defect");
  assert.equal(s.labels[0].source, "survived-edit");
  assert.equal(harvest.survival([f], { count: () => -1 }).unanswerable, 1, "no git is unknown, never a guess");
  // closures: an explained closure is a label; `unknown` is skipped
  const c = harvest.closures([row({ status: "resolved", closed_by: "acted_on" }), row({ status: "resolved", closed_by: "unknown", path: "src/b.js" })]);
  assert.equal(c.length, 1);
  assert.equal(c[0].label, "defect");
  // the report carries n and refuses a rate under the floor
  core.put("findings", [f, row({ status: "resolved", closed_by: "acted_on", path: "src/b.js" })]);
  const r = harvest.run({ count: () => 1, minLabels: 10 });
  assert.equal(r.n, 2);
  assert.equal(r.defect_rate, "unknown");
});

// ── 7. observe-only is inert ────────────────────────────────────────────────
test("in observe phase no hook returns a decision and no bytes are injected", async () => {
  load({ fresh: true });
  brief.activate(brief.record({ problem: "fix a", scope: ["src/a.js"] }, { sessionId: "s-inert" }));
  const written = [];
  const w0 = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  let v;
  try { v = await hooks.preWrite({ session_id: "s-inert", tool_name: "Write", tool_input: { file_path: path.join(root, "src/b.js") } }); }
  finally { process.stdout.write = w0; }
  assert.equal(v, null);
  assert.deepEqual(written, [], "zero bytes: the token delta is 0");
  const ev = gs.events({ kind: "write_verdict" });
  assert.equal(ev.at(-1).decision, "deny");
  assert.equal(ev.at(-1).emitted, false, "what phase 2 would have done is on the log");
  // and the queue is written, not injected
  const q = ask.emit({ rec: brief.current({ sessionId: "s-inert" }), session: "s-inert" });
  assert.equal(gs.events({ kind: "would_ask" }).length >= 1, true);
  assert.equal(gs.events({ kind: "asked" }).length, 0);
  assert.ok(Array.isArray(q.asked));
  // enforce phase: the same call decides, within the cap
  cfg({ phase: "enforce" });
  load({ fresh: true });
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  try { v = await hooks.preWrite({ session_id: "s-inert", tool_name: "Write", tool_input: { file_path: path.join(root, "src/b.js") } }); }
  finally { process.stdout.write = w0; }
  assert.equal(v.permissionDecision, "deny");
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).hookSpecificOutput.permissionDecision, "deny");
  cfg({ phase: "observe" });
  load({ fresh: true });
});

// ── 8. degradation ──────────────────────────────────────────────────────────
test("with no interpreter every verb exits 0 and the queue keeps the documented order", () => {
  core.put("findings", [
    // `silent-fallback`, not `swallowed-errors`: that shape was answered in test 2 and an answered shape is held, not re-asked
    row({ detector: "silent-fallback", severity: "low", path: "src/a.js", key: "src/a.js:1", title: "src/a.js:1 falls back to a default silently" }),
    row({ detector: "dead-exports", severity: "high", path: "src/b.js", key: "src/b.js", title: "src/b.js: 3 export(s) referenced by no other file" }),
    row({ detector: "missing-tests", severity: "medium", path: "src/c.js", key: "src/c.js", title: "src/c.js has no test" }),
  ]);
  const empty = path.join(root, "no-bin");
  fs.mkdirSync(empty, { recursive: true });
  const env = { ...process.env, BB_ROOT: root, BB_PYTHON: "/bin/false", PATH: empty };
  const bb = path.join(process.cwd(), "bin", "bb.js");
  for (const args of [["grapple", "status", "--json"], ["grapple", "ask", "--json"], ["grapple", "harvest", "--json"], ["grapple", "promote", "--json"], ["grapple", "ratify", "--json"]]) {
    const r = spawnSync(process.execPath, [bb, ...args], { cwd: root, env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  }
  const r = spawnSync(process.execPath, [bb, "grapple", "ask", "--json"], { cwd: root, env, encoding: "utf8", timeout: 60000 });
  const q = JSON.parse(r.stdout);
  assert.equal(q.via, "fallback");
  const sev = q.asked.map((x) => x.severity);
  assert.deepEqual(sev, ["high", "medium", "low"], "severity, then rework cost, then key");
  // in-process, the same order with the interpreter forced off
  const f = ask.fallbackRank(ask.items({ rows: core.get("findings", []) }), {});
  assert.deepEqual(f.asked.map((x) => x.severity), ["high", "medium", "low"]);
  assert.equal(detect.fallbackDrift(detect.counters([], [])).via, "fallback");
});

// ── the pipe, and the blind spot it must keep open ──────────────────────────
test("selective verification samples a class with no detector after N promotion rounds", () => {
  const classes = ["swallowed-errors", "dead-exports", "missing-tests", "undetected-race"];
  const hit = new Set();
  for (let round = 0; round < classes.length; round++) for (const c of promote.sample(classes, { round })) hit.add(c);
  assert.ok(hit.has("undetected-race"), "a failure mode with no detector is still drawn");
  assert.deepEqual(promote.sample(classes, { round: 1 }), promote.sample(classes, { round: 1 }), "deterministic");
  // the tally counts distinct units, never repeated events: two answers to one
  // key are one opinion, one session seen four times is one session
  const ev = [
    { kind: "answered", shape: "pattern", key: "pk", value: "yes", detector: "swallowed-errors" },
    { kind: "answered", shape: "pattern", key: "pk", value: "yes", detector: "swallowed-errors" },
    { kind: "answered", shape: "pattern", key: "pk2", value: "yes", detector: "swallowed-errors" },
    { kind: "override", detector: "dead-exports", key: "a" }, { kind: "override", detector: "dead-exports", key: "a" },
    { kind: "drift", signature: "repeats", session_id: "s1" }, { kind: "drift", signature: "repeats", session_id: "s1" },
    { kind: "drift", signature: "repeats", session_id: "s2" }, { kind: "drift", signature: "repeats", session_id: "" },
  ];
  const t = promote.tally(ev);
  assert.equal(t.answers.find((a) => a.detector === "swallowed-errors").support, 2);
  assert.equal(t.overrides[0].support, 1);
  assert.equal(t.drifts[0].support, 2);
});

test("an answer to a pattern question becomes N labels, decaying with distance", () => {
  // The distance is the fitted scorer's: files first, title words after. A second
  // row in another file with a thinner title is far from the seed, not at it.
  const rows = [row(), row({ path: "src/b.js", key: "src/b.js:3", title: "src/b.js:3 empty catch" })];
  const p = ask.propagate({ value: "yes", confidence: 0.9, paths: ["src/a.js"] }, rows, { detector: "swallowed-errors" });
  assert.equal(p.labels.length, 2);
  const near = p.labels.find((l) => l.path === "src/a.js"), far = p.labels.find((l) => l.path === "src/b.js");
  assert.equal(near.distance, 0);
  assert.equal(near.confidence, 0.9);
  assert.ok(far.distance > 0 && far.distance < 1);
  assert.ok(far.confidence < near.confidence && far.confidence >= 0.6, "toward the prior, never below it");
  // the whole loop: a question on the board, answered, reaches its rows. A
  // fresh shape, because the one test 2 answered is held and never re-asked.
  const loop = [row({ title: "src/a.js:12 error swallowed in retry loop" }), row({ path: "src/b.js", key: "src/b.js:3", title: "src/b.js:3 error swallowed in retry loop" })];
  core.put("findings", loop);
  const q = ask.emit({ rec: null, rows: loop });
  const pat = q.asked.find((x) => x.shape === "pattern" && x.detector === "swallowed-errors");
  assert.ok(pat, "one pattern question for two rows");
  assert.equal(pat.reaches, 2);
  const a = ask.answer(pat.key, { value: "yes", reason: "deliberate", rows: loop });
  assert.equal(a.reaches, 2);
  assert.equal(gs.questions()[pat.key].state, "answered");
  // every answer is a label the harvest counts, and "deliberate" is an override of the detector
  assert.deepEqual(a.labels.map((l) => l.label), ["not-a-defect", "not-a-defect"]);
  assert.equal(ask.answered().filter((l) => l.source === `answer:${pat.key}`).length, 2);
  assert.equal(harvest.run({ rows: loop, count: () => 0, backfilled: [] }).answered, 2);
  assert.equal(gs.events({ kind: "override" }).at(-1).detector, "swallowed-errors");
  assert.equal(gs.events({ kind: "override" }).at(-1).key, pat.key);
  assert.equal(ask.emit({ rec: null, rows: loop }).asked.some((x) => x.key === pat.key), false, "asked once, held");
  // one row, four sources, one label: the person's answer wins
  const d = harvest.dedupe([
    { id: "x", source: "survived-edit", label: "not-a-defect" }, { id: "x", source: "backfill:abc", label: "defect" },
    { id: "x", source: "closure:acted_on", label: "defect" }, { id: "x", source: "answer:k", label: "not-a-defect" }, { id: "y", source: "survived-edit", label: "not-a-defect" },
  ]);
  assert.equal(d.length, 2);
  assert.equal(d.find((l) => l.id === "x").source, "answer:k");
});

test("the observe pass runs every detector and writes plain files", () => {
  const s = grapple.observe({ session: "s-inert" });
  assert.equal(s.phase, "observe");
  for (const f of ["questions.md", "questions.json", "answers.json", "harvest.md", "harvest.json", "proposals.md", "proposals.json", "status.json"]) {
    assert.ok(fs.existsSync(path.join(gs.DIR(), f)), f);
  }
  assert.equal(typeof s.labels.n, "number");
  assert.ok(fs.readFileSync(path.join(gs.DIR(), "harvest.md"), "utf8").includes("n = "));
});

// ── C1 and C2: labels from history, and the prior they fit ──────────────────
test("the git backfill labels a historical row by what git did to it since, and refuses when git saw nothing", () => {
  const then = [
    row({ path: "src/a.js", key: "src/a.js:12" }),                                   // still open today, path edited: not a defect
    row({ path: "src/b.js", key: "src/b.js:3", title: "src/b.js:3 catch block swallows the error" }),   // gone today, path edited: a defect
    row({ path: "src/c.js", key: "src/c.js:9", title: "src/c.js:9 catch block swallows the error" }),   // gone today, no commit: unchanged, no label
    row({ path: "src/gone.js", key: "src/gone.js:1", title: "src/gone.js:1 catch block swallows the error" }),
  ];
  const today = [row({ path: "src/a.js", key: "src/a.js:12" })];
  const count = (since, file) => (file === "src/a.js" ? 3 : file === "src/b.js" ? 1 : 0);
  const exists = (p) => p !== "src/gone.js";
  const r = harvest.labelBackfill(then, today, { count, exists, since: "2026-03-01", rev: "abc" });
  const by = Object.fromEntries(r.labels.map((l) => [l.path, l.label]));
  assert.deepEqual(by, { "src/a.js": "not-a-defect", "src/b.js": "defect", "src/gone.js": "vanished" });
  assert.equal(r.unchanged, 1, "gone with no commit is the detector's inputs moving, not a fix");
  assert.equal(harvest.labelBackfill(then, today, { count: () => -1, exists }).unanswerable, 3);
  // the verb stores what it found, and the harvest counts it with its n
  const b = harvest.backfill({ rev: "abc", scan: () => then, count, today });
  // the git counter answers every row from one log: same shape as the injected one
  const counter = harvest.gitCounter("2026-09-01");
  assert.equal(typeof counter("2026-09-01", "src/a.js"), "number");
  assert.equal(b.n, 3);
  assert.equal(harvest.stored().length, 3);
  const h = harvest.run({ rows: today, count: () => 0 });
  assert.equal(h.backfilled, 3);
  assert.ok(h.n >= 3);
  assert.deepEqual(harvest.backfill({ rev: "nope", scan: () => null, today }).n, 0, "a scan that cannot answer is an error, not zero labels");
});

test("priors are held/broken counts per detector, local beats shipped, and the expert reads them through for_rule", () => {
  const labels = [
    { detector: "swallowed-errors", label: "defect" }, { detector: "swallowed-errors", label: "not-a-defect" }, { detector: "swallowed-errors", label: "not-a-defect" },
    { detector: "dead-exports", label: "defect" }, { detector: "dead-exports", label: "vanished" },
  ];
  const by = harvest.fitPriors(labels);
  assert.deepEqual(by["swallowed-errors"], { held: 1, broken: 2, n: 3, hold_rate: 0.333 });
  assert.deepEqual(by["dead-exports"], { held: 1, broken: 0, n: 1, hold_rate: 1 }, "vanished counts for neither side");
  const f = harvest.fit({ labels });
  assert.equal(f.shipped, false);
  assert.equal(harvest.priors().via, "local");
  assert.ok(fs.existsSync(path.join(gs.DIR(), "priors.json")));
  // the queue carries the prior it ranked with
  const q = ask.rank([{ key: "k1", shape: "pattern", detector: "swallowed-errors", severity: "medium", precision: "heuristic", est_tokens: 1000, n: 10 }], { answers: {} });
  if (q.via === "expert") {
    assert.equal(q.priors, "local");
    assert.ok(q.asked[0].prior < 0.6, "three labels at one-third pull a 0.60 base down, by SHRINKAGE and not further");
    assert.ok(q.asked[0].prior > 0.4);
  }
});

test("jev: a calibrated opinion on a pattern replaces its prior as the item's uncertainty, and a sure shape ranks below an unsure one", async () => {
  const { spawn } = await import("node:child_process");
  const jev = await import("../src/grapple/jev.js");
  const sure = gs.patternKey("swallowed-errors", "src/a.js:1 swallows an error");
  const unsure = gs.patternKey("silent-fallback", "src/b.js:1 falls back to a default silently");
  // The fake endpoint is its own process: `jev.call` blocks this one while it
  // waits, so a server here would never get to answer.
  const log = path.join(root, "jev-seen.json");
  w("jev-server.mjs", `import http from "node:http"; import fs from "node:fs";
    const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
      const body = JSON.parse(b); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ auth: req.headers.authorization, body }));
      const answers = {}; for (const k of Object.keys(body.questions)) answers[k] = { probability: k === ${JSON.stringify(sure)} ? 0.98 : 0.5 };
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ answers })); }); });
    srv.listen(0, "127.0.0.1", () => process.stdout.write(String(srv.address().port) + "\\n"));`);
  const child = spawn(process.execPath, [path.join(root, "jev-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((r) => child.stdout.once("data", (d) => r(String(d).trim())));
  const items = [
    { key: sure, shape: "pattern", detector: "swallowed-errors", severity: "high", precision: "heuristic", est_tokens: 1000, n: 1, text: "swallowed-errors: is this deliberate?", rows: [{ path: "src/a.js", key: "src/a.js:1" }] },
    { key: unsure, shape: "pattern", detector: "silent-fallback", severity: "medium", precision: "heuristic", est_tokens: 1000, n: 1, text: "silent-fallback: is this deliberate?", rows: [{ path: "src/b.js", key: "src/b.js:1" }] },
  ];
  try {
    // off: no key, nothing changes
    delete process.env.TYPESAFE_API_KEY;
    assert.equal(jev.available(), false);
    assert.equal(jev.opinions(items), null);
    const plain = ask.rank(items, { answers: {} });
    assert.equal(plain.jev, null);
    assert.equal(plain.asked[0].key, sure, "without Jev the high-severity shape leads");
    // on: one call, one noul per pattern item, the window in the state
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.TYPESAFE_API_URL = `http://127.0.0.1:${port}/v1/systemone`;
    const o = jev.opinions(items);
    const seen = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(seen.auth, "Bearer test-key");
    assert.deepEqual(Object.keys(seen.body.questions).sort(), [sure, unsure].sort());
    assert.equal(seen.body.questions[sure].type, "noul");
    assert.ok(seen.body.state.includes("1> export const a = 1;"), "the row's code window is the state");
    assert.deepEqual(o.by[sure], { p: 0.98, uncertainty: 0.04 });
    assert.deepEqual(o.by[unsure], { p: 0.5, uncertainty: 1 });
    assert.equal(o.answered, 2);
    const q = ask.rank(items, { answers: {}, opinions: o });
    assert.equal(q.jev.answered, 2);
    const byKey = Object.fromEntries([...q.asked, ...q.dropped].map((it) => [it.key, it]));
    assert.ok(byKey[sure] && byKey[unsure]);
    assert.equal(q.asked[0].key, unsure, `the coin-flip shape is asked first (${q.via})`);
    assert.ok(byKey[unsure].ev > byKey[sure].ev, "a sure high beats an unsure medium on stake alone; uncertainty is what reverses it");
    // the queue file never carries the rows Jev read
    ask.emit({ rows: [] });
    for (const st of Object.values(gs.questions())) assert.equal(st.rows, undefined);
    // a dead endpoint is a null, not a throw, and the order is the plain one
    process.env.TYPESAFE_API_URL = "http://127.0.0.1:9/";
    assert.equal(jev.opinions(items), null);
    assert.equal(ask.rank(items, { answers: {} }).asked[0].key, sure);
  } finally {
    delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_URL;
    child.kill();
  }
});

test("priorByFinding: one pattern opinion reaches every row of its shape, and a human answer retires it", () => {
  const rows = [
    { id: "f1", status: "open", precision: "heuristic", detector: "swallowed-errors", title: "src/a.js:1 swallows an error", path: "src/a.js" },
    { id: "f2", status: "open", precision: "heuristic", detector: "swallowed-errors", title: "src/c.js:9 swallows an error", path: "src/c.js" },
    { id: "f3", status: "open", precision: "heuristic", detector: "silent-fallback", title: "src/b.js:1 falls back silently", path: "src/b.js" },
    { id: "f4", status: "open", precision: "exact", detector: "doc-links", title: "README.md:3 dead link", path: "README.md" },
    { id: "f5", status: "closed", precision: "heuristic", detector: "swallowed-errors", title: "src/a.js:1 swallows an error", path: "src/a.js" },
  ];
  const kA = gs.patternKey("swallowed-errors", "src/a.js:1 swallows an error");
  const kB = gs.patternKey("silent-fallback", "src/b.js:1 falls back silently");
  const stored = {
    [kA]: { key: kA, state: "open", n: 82, jev: { p: 0.91, uncertainty: 0.18 } },
    [kB]: { key: kB, state: "answered", n: 4, jev: { p: 0.2, uncertainty: 0.4 } },
  };
  const by = ask.priorByFinding(rows, stored);

  // Both open rows of the shape inherit the one opinion; the pattern reaches
  // 82 rows but Jev read three windows, and three is what the weight may use.
  assert.deepEqual(by.f1, { p: 0.91, n: 3 });
  assert.deepEqual(by.f2, by.f1);
  assert.equal(by.f3, undefined, "a shape a human answered is settled, not seconded");
  assert.equal(by.f4, undefined, "an exact method is not contested");
  assert.equal(by.f5, undefined, "a closed finding is not priced");

  // No Jev on the question, or no question at all: no prior, not a zero.
  assert.deepEqual(ask.priorByFinding(rows, { [kA]: { key: kA, state: "open", n: 82 } }), {});
  assert.deepEqual(ask.priorByFinding(rows, {}), {});
});
