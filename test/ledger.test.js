import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HOME and BB_ROOT are pointed at a scratch dir BEFORE the modules load: ROOT
// and the transcript locations are resolved at import time.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-ledger-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;
const ledger = await import("../src/tokens/ledger.js");
const session = await import("../src/tokens/session.js");
const store = await import("../src/core/store.js");
const { slug } = await import("../src/adapters/claude.js");

const usage = (input, cw, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });
const assistant = (sid, id, model, u, content, ts) => JSON.stringify({ type: "assistant", message: { id, model, content, usage: u }, timestamp: ts, sessionId: sid, cwd: root });
const toolResult = (sid, chars) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "y".repeat(chars) }] }, sessionId: sid, cwd: root });

const projects = path.join(tmp, ".claude", "projects");
const dir = path.join(projects, slug(root));
fs.mkdirSync(dir, { recursive: true });
// A worktree child whose directory exists under root, and a look-alike that does not.
fs.mkdirSync(path.join(root, "wt1"), { recursive: true });
fs.mkdirSync(path.join(projects, slug(root) + "-wt1"), { recursive: true });
fs.mkdirSync(path.join(projects, slug(root) + "-other"), { recursive: true });
fs.writeFileSync(path.join(projects, slug(root) + "-other", "z.jsonl"), assistant("zzz", "m", "claude-sonnet-5", usage(1, 1, 1, 1), [], "2026-09-13T01:00:00.000Z") + "\n");

fs.writeFileSync(path.join(dir, "s-known.jsonl"), [
  assistant("s-known", "msg_1", "claude-sonnet-5", usage(10, 1000, 0, 5), [{ type: "text", text: "hi" }], "2026-09-13T10:00:00.000Z"),
  assistant("s-known", "msg_1", "claude-sonnet-5", usage(10, 1000, 0, 50), [{ type: "tool_use", name: "Read", input: {} }], "2026-09-13T10:00:01.000Z"),
  toolResult("s-known", 4000),
  assistant("s-known", "msg_2", "claude-sonnet-5", usage(0, 2000, 1010, 100), [{ type: "text", text: "done" }], "2026-09-13T10:00:10.000Z"),
].join("\n") + "\n");
fs.writeFileSync(path.join(dir, "s-unknown.jsonl"), [
  assistant("s-unknown", "msg_9", "mystery-model-9", usage(500, 0, 0, 200), [{ type: "text", text: "?" }], "2026-09-13T11:00:00.000Z"),
].join("\n") + "\n");

const claudeMod0 = await import("../src/adapters/claude.js");
test("transcripts: exact slug and real worktree children only, never a loose prefix", () => {
  const files = ledger.transcripts(root).map((t) => t.file);
  assert.ok(files.some((f) => f.endsWith("s-known.jsonl")));
  assert.ok(!files.some((f) => f.includes("-other")), "a slug prefix without a matching directory is another workspace");
  const dirs = claudeMod0.default.transcriptDirs(root, []);
  assert.ok(dirs.some((d) => d.endsWith("-wt1")) && !dirs.some((d) => d.endsWith("-other")));
});

test("fold dedups by (session, msg) last-wins and attributes run_id only to laneMap sessions", () => {
  const a = ledger.fold({ runId: "R1", laneMap: { "s-known": "L01" } });
  assert.equal(a.appended, 3);
  const b = ledger.fold({ runId: "R1", laneMap: { "s-known": "L01" } });
  assert.equal(b.appended, 0, "a second fold appends nothing");
  const rows = ledger.usage();
  assert.equal(rows.length, 3);
  const known = rows.filter((r) => r.session_id === "s-known");
  assert.equal(known.find((r) => r.msg_id === "msg_1").output, 50, "the last usage block for a message wins");
  assert.ok(known.every((r) => r.run_id === "R1" && r.lane_id === "L01"));
  assert.equal(rows.find((r) => r.session_id === "s-unknown").run_id, "", "not in laneMap: no run attribution");
  assert.equal(ledger.sessionPeak("s-known"), 3010);
});

test("windowDeltas: window(n+1) - window(n) - output(n) for single large tool results", () => {
  const turns = ledger.turns(path.join(dir, "s-known.jsonl"), "claude");
  const d = ledger.windowDeltas(turns, { minChars: 2000 });
  assert.equal(d.length, 1);
  assert.equal(d[0].delta, 3010 - 1010 - 50);
  assert.equal(d[0].chars, 4000);
  assert.deepEqual(ledger.windowDeltas([{ input: 1, cacheWrite: 0, cacheRead: 0, output: 1, toolResults: [{ chars: 10 }, { chars: 10 }] }, { input: 500, cacheWrite: 0, cacheRead: 0, output: 0 }]), [], "two results: not isolable");
  assert.equal(ledger.turns(path.join(tmp, "nope.jsonl"), "claude"), null);
});

test("session.measure prices a known model and reports an unknown one with tokens only", async () => {
  const k = await session.measure({ sessionId: "s-known" });
  assert.equal(k.used.turns, 2);
  assert.equal(k.used.billed, 10 + 1000 + 50 + 0 + 2000 + 1010 + 100);
  assert.ok(k.usd.total > 0);
  assert.deepEqual(k.unpriced_models, []);
  assert.equal(k.saved.wire_tokens, null, "no proxy: n/a, not zero");
  assert.equal(k.used.peak_window, 3010);
  assert.match(session.report(k), /MEASURED/);
  assert.match(session.report(k), /ESTIMATE/);
  const u = await session.measure({ sessionId: "s-unknown" });
  assert.equal(u.used.input, 500);
  assert.equal(u.usd.total, 0);
  assert.deepEqual(u.unpriced_models, ["mystery-model-9"]);
  assert.match(session.line(u), /cost n\/a/);
  const wrote = session.write(k);
  assert.equal(wrote.length, 2);
  assert.equal(session.list().length, 1);
  session.write(k);
  assert.equal(session.list().length, 1, "re-writing a session replaces its index line");
  assert.ok(fs.existsSync(path.join(root, ".bundlebox", "var", "sessions", "s-known.md")));
});

test("episodes are attributed by time and null timestamps attribute nothing", async () => {
  store.append("episodes", { kind: "script", verb: "scan", turns_saved: 4, seconds: 1.5, at: "2026-09-13T10:00:05.000Z" });
  const k = await session.measure({ sessionId: "s-known" });
  assert.equal(k.saved.automation_turns, 4);
  assert.equal(k.saved.automation_tokens, 4 * k.basis.per_turn_tokens);
  assert.equal(k.saved.automation_tokens_high, 4 * k.basis.per_turn_full);
  store.append("usage", { session_id: "s-nots", msg_id: "m1", agent: "claude", model: "claude-sonnet-5", input: 5, output: 5, cache_write: 0, cache_read: 0, ts: null });
  const n = await session.measure({ sessionId: "s-nots" });
  assert.equal(n.saved.automation_turns, 0);
});

test("the transcript directory name is a legal directory name", () => {
  // `path.join(projects, slug(root))` on Windows used to build
  // `projects\\C:\\Users\\...\\ws` and die with ENOENT, because slug left the
  // backslashes and the drive colon in place.
  assert.ok(!/[\\:]/.test(slug("C:\\Users\\me\\Documents\\ws")), slug("C:\\Users\\me\\Documents\\ws"));
  assert.equal(slug("/home/me/Documents/my_ws"), "-home-me-Documents-my-ws", "POSIX naming is unchanged");
});
