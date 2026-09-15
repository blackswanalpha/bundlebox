// slop.test.js — the prose ruleset fires on the shape it names, stays quiet on
// the shape next to it, and never touches a fact.
//
// The last of those is the one that matters. A cleaner that deletes a word out
// of a command, a count or an aligned table has done more damage than the slop
// it removed, so the stripping half is asserted against code fences, indented
// commands, tables and byte-for-byte lines that nothing fired on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lint, strip, clean, RULES } from "../src/slop/index.js";

const ids = (text) => Object.keys(lint(text).byRule).sort();

test("each rule fires on the shape it names", () => {
  assert.deepEqual(ids("Basically, the handler is wrong."), ["filler-opener"]);
  assert.deepEqual(ids("Let me check the order table.\n"), ["announcement", "pointer"]);
  assert.deepEqual(ids("The retry is very slow."), ["intensifier"]);
  assert.deepEqual(ids("We utilize a helper in order to parse."), ["long-form"]);
  assert.deepEqual(ids("It might possibly be null."), ["hedge-stack"]);
  assert.deepEqual(ids("A robust, comprehensive parser."), ["empty-superlative"]);
  assert.deepEqual(ids("Several files are affected."), ["uncounted"]);
  assert.deepEqual(ids("This should work now."), ["unproven-claim"]);
  assert.deepEqual(ids("In summary, the parser is wrong."), ["closing-recap"]);
});

test("the shape next to each one stays quiet", () => {
  // A count, a named file, a command and a measured claim are what the rules
  // are asking for, so none of them may fire.
  const good = [
    "3 files parse the address: checkout/address.js, cart/total.js, api/orders.js.",
    "`npm test -- checkout` exits 1 at address.js:44.",
    "The p95 is 240ms against a 200ms budget.",
    "The order total is null when the cart is empty.",
  ].join("\n");
  assert.deepEqual(lint(good).hits, []);
});

test("a fenced block and an indented command are never prose", () => {
  const doc = [
    "Basically, run it.",
    "",
    "```bash",
    "# in order to check this, utilize the very simple runner",
    "npm run check",
    "```",
    "",
    "    set -o pipefail; npm test | tail -c 4000",
  ].join("\n");
  const r = strip(doc);
  assert.ok(r.text.includes("# in order to check this, utilize the very simple runner"), "a comment inside a fence is part of the command block");
  assert.ok(r.text.includes("set -o pipefail; npm test | tail -c 4000"));
  assert.ok(r.text.startsWith("Run it."), "and the prose above it is still stripped, and re-capitalised");
});

test("a line nothing fired on comes back byte for byte", () => {
  const table = [
    "Common to every item below:",
    "  count: 1",
    "  table: exports",
    "",
    "  L12  filter-then-map: two eager passes over the same array",
  ].join("\n");
  assert.equal(clean(table), table, "alignment in an evidence block is structure, not whitespace to tidy");
});

test("strip only applies rules that cannot lose a fact", () => {
  const reportOnly = RULES.filter((r) => !r.fix).map((r) => r.id);
  assert.ok(reportOnly.includes("uncounted"));
  assert.ok(reportOnly.includes("pointer"));
  assert.ok(reportOnly.includes("unproven-claim"));
  const s = "Several files are wrong. You may want to check the config.";
  assert.equal(clean(s), s, "a claim the rule cannot correct is reported, never rewritten");
});

test("stripping is measured in tokens, because that is what it costs", () => {
  const before = "Basically, it is worth noting that we utilize the parser in order to handle very large payloads.";
  const r = strip(before);
  assert.ok(r.tokens_saved > 0);
  assert.equal(r.tokens_before - r.tokens_after, r.tokens_saved);
  assert.ok(!/Basically|utilize|in order to|very /.test(r.text));
  assert.ok(/parser/.test(r.text), "every noun in the sentence survives");
});

test("the guardrails block is already written to these rules", async () => {
  const { GUARDRAILS } = await import("../src/compile/brief.js");
  // If a rule ever fires here, every lane in a run loses its shared cache
  // prefix the moment somebody wires the cleaner one layer higher.
  assert.deepEqual(lint(GUARDRAILS).hits, []);
});
