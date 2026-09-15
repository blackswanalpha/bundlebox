// episodes.test.js — what the free verbs displaced, and which session may claim
// it. The bracket used to be [first turn, last turn], which excluded every
// episode this line exists to report: scan, compile and route run BEFORE a
// session opens. These tests pin both halves — the counting and the claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-eps-"));
process.env.BB_ROOT = root;
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });

const store = await import("../src/core/store.js");
const episodes = await import("../src/buckmaster/episodes.js");
const session = await import("../src/tokens/session.js");

const iso = (d) => new Date(d).toISOString();
const T0 = Date.parse("2026-05-01T10:00:00.000Z");
const mins = (n) => iso(T0 + n * 60000);

// ── counting ───────────────────────────────────────────────────────────────
test("a verb with a store artefact counts the turns it displaced", () => {
  store.put("findings", [
    { id: "a1", status: "open", severity: "high" },
    { id: "b2", status: "open", severity: "low" },
    { id: "c3", status: "resolved", severity: "low" },
  ]);
  store.put("scan", { ran: [{ name: "d1" }, { name: "d2" }] });
  const e = episodes.record({ verb: "scan", rc: 0, seconds: 0.1 });
  // 2 open findings -> 4 file reads, 2 searches, 0 pages
  assert.equal(e.turns_saved, 6);
  assert.equal(e.produced, 2);
  assert.ok(e.detail.digest, "an answer that can be recognised again");
});

test("the same answer twice claims the turns once", () => {
  const again = episodes.record({ verb: "scan", rc: 0, seconds: 0.1 });
  assert.equal(again.turns_saved, 0);
  assert.match(again.detail.why, /already given/);
  assert.equal(again.detail.turns_if_fresh, 6, "what it would have been is still recorded");
});

test("a second verb reprinting the first one's answer adds nothing", () => {
  const e = episodes.record({ verb: "findings", rc: 0, seconds: 0 });
  assert.equal(e.turns_saved, 0, "`bb findings` after `bb scan` prints what scan just computed");
});

test("a changed answer is fresh again", () => {
  store.put("findings", [{ id: "a1", status: "open" }, { id: "b2", status: "open" }, { id: "d4", status: "open" }]);
  const e = episodes.record({ verb: "scan", rc: 0, seconds: 0.1 });
  assert.equal(e.turns_saved, 8);
});

test("a verb with no digest claims nothing rather than a plausible number", () => {
  const e = episodes.record({ verb: "doctor", rc: 0, seconds: 0 });
  assert.equal(e.turns_saved, 0);
  assert.match(e.detail.why, /no digest/);
  assert.equal(e.detail.turns_if_fresh, 3, "what it would be worth is still on the row");
});

test("a verb the table does not know yields zero, never a guess", () => {
  const y = episodes.yieldOf("nonesuch");
  assert.deepEqual([y.turns, y.digest, y.produced], [0, null, null]);
});

test("a verb can publish its own count, and it is taken exactly once", () => {
  episodes.publish({ screens: 4, rules: 19, digest: "abc123" });
  const e = episodes.record({ verb: "designlabs check", rc: 0, seconds: 0, detail: episodes.takeDetail() });
  assert.equal(e.turns_saved, 6);           // 4 files + 2 commands
  assert.equal(episodes.takeDetail(), null, "it cannot leak into the next verb");
});

// ── attribution ────────────────────────────────────────────────────────────
test("a session claims the free work that prepared it, not just what ran during it", () => {
  fs.writeFileSync(path.join(root, ".bundlebox", "var", "episodes.jsonl"), "");
  const w = (row) => store.append("episodes", episodes.normalise(row));

  w({ verb: "scan", kind: "verb", turns_saved: 12, ts: mins(-20) });      // prepared it
  w({ verb: "compile", kind: "verb", turns_saved: 4, ts: mins(-15) });    // prepared it
  w({ verb: "route", kind: "verb", turns_saved: 3, ts: mins(-14) });      // prepared it
  w({ verb: "run", kind: "lane", turns_saved: 0, run_id: "R1", ts: mins(11) });   // its own lane, after the last turn
  w({ verb: "run", kind: "lane", turns_saved: 99, run_id: "R2", ts: mins(-16) }); // another run's lane
  w({ verb: "scan", kind: "verb", turns_saved: 7, ts: mins(-3000) });     // older than the prep window

  const rows = [
    { session_id: "S1", msg_id: "m1", ts: mins(0), run_id: "R1", lane_id: "L01" },
    { session_id: "S1", msg_id: "m2", ts: mins(10), run_id: "R1", lane_id: "L01" },
  ];
  const claimed = session.attribute({ first: mins(0), last: mins(10), rows, sessionId: "S1" });
  const verbs = claimed.map((e) => `${e.verb}:${e.turns_saved}`).sort();
  assert.deepEqual(verbs, ["compile:4", "route:3", "run:0", "scan:12"]);
  assert.equal(claimed.reduce((a, e) => a + e.turns_saved, 0), 19);
});

test("free work is claimed by one session only: the one it prepared", () => {
  const rows2 = [{ session_id: "S2", msg_id: "m1", ts: mins(40) }, { session_id: "S2", msg_id: "m2", ts: mins(50) }];
  // S1's turns are already in the store from the test above, so S2's window
  // starts where S1 ended rather than reaching back over S1's preparation.
  store.append("usage", { session_id: "S1", msg_id: "m1", ts: mins(0), model: "claude-sonnet-5" });
  store.append("usage", { session_id: "S1", msg_id: "m2", ts: mins(10), model: "claude-sonnet-5" });
  const claimed = session.attribute({ first: mins(40), last: mins(50), rows: rows2, sessionId: "S2" });
  assert.deepEqual(claimed.map((e) => e.verb), [], "S1's preparation is S1's");
});

test("the bill reports the turns, and says how they were attributed", async () => {
  for (const r of [
    { session_id: "S3", msg_id: "m1", ts: mins(100), model: "claude-sonnet-5", input: 500, output: 1200, cache_write: 20000, cache_read: 80000, run_id: "R3" },
    { session_id: "S3", msg_id: "m2", ts: mins(108), model: "claude-sonnet-5", input: 40, output: 900, cache_write: 1000, cache_read: 120000, run_id: "R3" },
  ]) store.append("usage", r);
  store.append("episodes", episodes.normalise({ verb: "scan", kind: "verb", turns_saved: 12, ts: mins(95) }));
  store.append("episodes", episodes.normalise({ verb: "compile", kind: "verb", turns_saved: 4, ts: mins(97) }));

  const m = await session.measure({ sessionId: "S3" });
  assert.equal(m.saved.automation_turns, 16, "the free verbs that prepared this session");
  assert.ok(m.saved.automation_tokens > 0, "and they are worth something");
  assert.ok(m.saved.automation_tokens_high > m.saved.automation_tokens, "reported as a range");
  assert.match(m.basis.attribution, /prepared this session/);
  assert.equal(m.by_verb.find((v) => v.verb === "scan").turns, 12);
});
