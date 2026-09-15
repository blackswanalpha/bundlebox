// sieve.test.js — the input axis, and mostly the half that must NOT happen.
//
// The compressor's win is easy to assert and worth little on its own: any
// truncator saves bytes. What earns the lossy tier its place is the set of
// things it refuses to do — never touch a tool whose output a later edit is
// matched against, never drop an error line, never hand the harness a shape it
// will silently reject, never claim a saving it did not produce. Those are the
// assertions here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scrub, elide, transform, rebuild, duplicateMarker, limitsFor, allowed, extractText,
  SAFE_TOOLS, REPEAT_MIN, MIN_WIN, SCRUB_MIN,
} from "../src/sieve/compress.js";
import { replaySession, measuredRatio } from "../src/sieve/replay.js";

const ESC = String.fromCharCode(27);
const cfg = { budget: { max_tokens: 160000, reserve_output: 30000 }, sieve: { max_share: 0.02, head_lines: 4, tail_lines: 2, tools: [] } };
const limits = limitsFor(cfg);

test("Read, Edit and Write are never eligible, and the list is an allowlist", () => {
  for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.equal(allowed(tool, limits), false, `${tool} must never be compressed`);
    assert.ok(!SAFE_TOOLS.includes(tool));
  }
  assert.equal(allowed("Bash", limits), true);
  // An unknown tool is not admitted by default: a blocklist would let the next
  // edit-shaped tool through on the day it ships.
  assert.equal(allowed("SomeNewTool", limits), false);
  // ...except an MCP tool, which answers rather than hands back editable text.
  assert.equal(allowed("mcp__x__query", limits), true);
  // A caller that names its own list replaces the rule entirely, prefix included.
  const own = limitsFor({ ...cfg, sieve: { ...cfg.sieve, tools: ["Bash"] } });
  assert.equal(allowed("mcp__x__query", own), false);
  assert.equal(allowed("Bash", own), true);
});

test("the cap is a share of the working window, not a constant", () => {
  const small = limitsFor({ budget: { max_tokens: 40000, reserve_output: 10000 }, sieve: { max_share: 0.02 } });
  const big = limitsFor({ budget: { max_tokens: 1000000, reserve_output: 30000 }, sieve: { max_share: 0.02 } });
  assert.ok(big.maxTokens > small.maxTokens * 10);
  // And it never collapses to something that would elide a paragraph.
  assert.ok(limitsFor({ budget: {}, sieve: {} }).maxTokens >= 200);
});

test("scrub is lossless: every distinct line survives, and a repeat keeps its count", () => {
  const raw = [`${ESC}[32mok${ESC}[0m`, "same", "same", "same", "same", "same", "", "", "", "tail   "].join("\n");
  const got = scrub(raw);
  assert.ok(!got.includes(ESC), "ANSI escapes are invisible to the model and cost tokens");
  assert.ok(got.includes("ok") && got.includes("tail"), "no content line is dropped");
  assert.equal(got.split("\n").filter((l) => l === "same").length, 1);
  assert.match(got, /line repeated 5x/);
  assert.ok(!/\n\n\n/.test(got));
  // Three identical lines are a table, not a repeat, and are left alone.
  assert.equal(scrub("a\nx\nx\nx\nb").split("\n").filter((l) => l === "x").length, REPEAT_MIN - 1);
});

test("elide keeps the head, keeps the tail, and carries the error out of the middle", () => {
  const lines = ["START", "h2", "h3", "h4",
    ...Array.from({ length: 400 }, (_, i) => `noise ${i}`),
    "ERROR: the gate failed at line 9",
    ...Array.from({ length: 400 }, (_, i) => `more ${i}`),
    "t1", "END"];
  const raw = lines.join("\n");
  const got = elide(raw, limits, "/tmp/spill.txt");
  assert.ok(got.startsWith("START"));
  assert.ok(got.endsWith("END"));
  assert.match(got, /ERROR: the gate failed at line 9/, "the one line that mattered survives the cut");
  assert.match(got, /Full output: \/tmp\/spill\.txt/, "recovery is a grep, never a re-run");
  assert.ok(got.length < raw.length / 2);
});

test("with no spill path the marker says the middle is gone rather than pointing at nothing", () => {
  const got = elide(Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n"), limits, "");
  assert.match(got, /not recoverable/);
  assert.ok(!got.includes("Full output:"));
});

test("transform declines when there is nothing worth a hook", () => {
  assert.equal(transform("", limits), null);
  assert.equal(transform("x".repeat(SCRUB_MIN - 1), limits), null);
  // Clean text under the cap: scrub finds nothing, so no replacement is emitted.
  const clean = Array.from({ length: 30 }, (_, i) => `a distinct line number ${i}`).join("\n") + "\n" + "y".repeat(SCRUB_MIN);
  const got = transform(clean, limits);
  assert.ok(got === null || got.before - got.after >= MIN_WIN);
});

test("transform names the tier, because a lossless saving and a lossy one are different claims", () => {
  const ansi = (`${ESC}[32m` + "a distinct line ".repeat(6) + `${ESC}[0m\n`).repeat(120);
  const got = transform(ansi, limits);
  assert.ok(got);
  assert.ok(["scrub", "elide"].includes(got.tier));
  assert.ok(got.tokens_before > got.tokens_after);
  const huge = Array.from({ length: 4000 }, (_, i) => `line ${i} of a very long build log with words in it`).join("\n");
  assert.equal(transform(huge, limits).tier, "elide");
});

test("rebuild returns the shape the harness will accept, or nothing at all", () => {
  assert.equal(rebuild("raw string", "short"), "short");
  const bash = { stdout: "long", stderr: "boom", interrupted: false };
  const out = rebuild(bash, "short");
  assert.equal(out.stdout, "short");
  assert.equal(out.stderr, "", "stderr was already folded into the compressed text; leaving it duplicates it");
  assert.equal(out.interrupted, false, "every other field survives");
  // A shape we cannot rebuild is rejected by the harness without a word, so a
  // guess here would fill the ledger with savings the session never received.
  assert.equal(rebuild([{ type: "text", text: "x" }], "short"), null);
  assert.equal(rebuild({ blocks: [] }, "short"), null);
});

test("extractText separates 'nothing readable' from 'empty'", () => {
  assert.equal(extractText(null), null);
  assert.equal(extractText(""), null);
  assert.equal(extractText({ stdout: "a", stderr: "b" }), "a\nb");
  assert.equal(extractText([{ text: "a" }, { text: "b" }]), "a\nb");
});

test("the duplicate marker is smaller than the body and says which output it replaced", () => {
  const body = "a line of output\n".repeat(400);
  const m = duplicateMarker("Bash", body);
  assert.ok(m.length < body.length);
  assert.match(m, /Bash/);
  assert.match(m, /already above in this window/);
});

const result = (tool, text) => ({ tool, text, chars: text.length });
const turnOf = (results) => ({ toolUses: [], toolResults: results, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

test("replay dedups per tool, and an identical output from another tool is not one", () => {
  const body = ("x".repeat(80) + "\n").repeat(60);
  // Two tools, one output each: neither has a previous output of its own.
  const first = replaySession([turnOf([result("Bash", body), result("Grep", body)])], limits);
  assert.equal(first.dedup, 0, "Grep's first output is not a repeat of Bash's");
  // The same tool twice IS, and an unrelated call in between does not break the
  // chain: the bytes are still in the window either way.
  const again = replaySession([turnOf([result("Bash", body), result("Grep", "other\n".repeat(400)), result("Bash", body)])], limits);
  assert.equal(again.dedup, 1);
  assert.ok(again.dedup_chars > 0);
});

test("a result whose tool this box cannot name is unknown, never zero", () => {
  const body = ("y".repeat(100) + "\n").repeat(60);
  const acc = replaySession([turnOf([result("", body)])], limits);
  assert.equal(acc.results, 1);
  assert.equal(acc.named, 0);
  assert.equal(acc.touched, 0);
  assert.equal(acc.before, 0, "it is not counted as a saving of zero, it is not counted at all");
});

test("a big result on a tool the allowlist refuses is recorded as refused, not as a miss", () => {
  const body = Array.from({ length: 3000 }, (_, i) => `  export function handler${i}(req, res) { return res.json({ ok: true }); }`).join("\n");
  const acc = replaySession([turnOf([result("Read", body)])], limits);
  assert.equal(acc.touched, 0);
  assert.ok(acc.skipped.Read > 0, "the report has to be able to show what it declined and why");
});

test("the measured ratio refuses to exist without enough billed samples", () => {
  assert.equal(measuredRatio([]).ratio, null);
  const turns = Array.from({ length: 8 }, (_, i) => ({
    input: 1000 * i, output: 10, cacheWrite: 0, cacheRead: 0,
    toolUses: [], toolResults: [{ chars: 4000, text: "x".repeat(4000) }],
  }));
  // Window grows by 1000 per turn and output is 10, so each result "cost" 990.
  const m = measuredRatio(turns, { min: 3 });
  assert.ok(m.ratio > 0 && m.ratio < 1);
  assert.equal(measuredRatio(turns, { min: 99 }).ratio, null);
});

test("the replay splits the saving by tier, because lossless and lossy are different trades", () => {
  // A run that can only scrub: repeated lines, but nowhere near the token cap.
  const repeated = ("the same line of output\n".repeat(200));
  const scrubbed = replaySession([turnOf([result("Bash", repeated)])], limits);
  assert.ok(scrubbed.by_tier.scrub > 0);
  assert.equal(scrubbed.by_tier.elide, 0);

  // A run that must elide: distinct lines, well past the cap.
  const huge = Array.from({ length: 4000 }, (_, i) => `line ${i} of a very long build log with words in it`).join("\n");
  const elided = replaySession([turnOf([result("Bash", huge)])], limits);
  assert.ok(elided.by_tier.elide > 0);
  assert.equal(elided.by_tier.scrub, 0);

  // Every char saved is attributed to exactly one tier, so the split can never
  // quietly disagree with the total it sits beside.
  const both = replaySession([turnOf([result("Bash", repeated), result("Grep", huge)])], limits);
  const tiers = both.by_tier.scrub + both.by_tier.dedup + both.by_tier.elide;
  assert.equal(tiers, both.before - both.after + both.dedup_chars);
});
