// facts.test.js — src/pipeline/facts.js: what a gear's gates read. A source that
// cannot be read is null, never 0, and every count comes off disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-facts-")));
const bb = path.join(root, ".bundlebox");
fs.mkdirSync(path.join(bb, "var"), { recursive: true });
process.env.BB_ROOT = root;
const w = (rel, s) => { const p = path.join(bb, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof s === "string" ? s : JSON.stringify(s)); };

const facts = await import("../src/pipeline/facts.js");
const store = await import("../src/core/store.js");

test("scenarioFacts: an empty workspace knows nothing, which is null not 0", () => {
  assert.deepEqual(facts.scenarioFacts(), { corpora: null, corpus_base: null, base_up: null, scenarios: null, world: null, services: null });
});

test("storeFacts: no store is null; a store counts open and open-high findings and ready units", () => {
  assert.deepEqual(facts.storeFacts(), { open_findings: null, open_high: null, units_ready: null });
  store.put("findings", [{ status: "open", severity: "high" }, { status: "open", severity: "critical" }, { status: "open", severity: "low" }, { status: "closed", severity: "high" }, null]);
  store.put("units", [{ status: "ready" }, { status: "done" }]);
  assert.deepEqual(facts.storeFacts(), { open_findings: 3, open_high: 2, units_ready: 1 });
});

test("scenarioFacts: only a corpus with a persona counts, scenarios are nested json files", () => {
  w("cookbook/shop/persona.json", {});
  w("cookbook/shop/scenarios/01-cart/01-add.json", {});
  w("cookbook/shop/scenarios/01-cart/02-remove.json", {});
  w("cookbook/shop/scenarios/notes.md", "x");
  w("cookbook/stray/scenarios/01.json", {});
  w("genesis/shop/world.json", {});
  fs.mkdirSync(path.join(bb, "genesis", "half"), { recursive: true });
  w("runbook/services.json", { services: [{ name: "api" }, { name: "db" }] });
  const f = facts.scenarioFacts();
  assert.deepEqual(f, { corpora: 1, corpus_base: 0, base_up: null, scenarios: 2, world: 1, services: 2 });
  w("runbook/services.json", [{ name: "api" }]);
  assert.equal(facts.scenarioFacts().services, 1, "a bare array is the list");
});

test("reachable: null for a non-URL, 1 for a listening port, 0 for a closed one", async () => {
  assert.equal(facts.reachable("not a url"), null);
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  // `reachable` blocks this event loop on a child process. The kernel completes
  // the child's handshake from the listen backlog, so the block does not matter.
  assert.equal(facts.reachable(`http://127.0.0.1:${port}`), 1);
  await new Promise((r) => srv.close(r));
  assert.equal(facts.reachable(`http://127.0.0.1:${port}`, { timeout: 300 }), 0);
});

test("scenarioFacts: a declared base is probed; context carries the gear's minutes since its last run", () => {
  w("cookbook/shop/persona.json", { base: "not-a-url" });
  const f = facts.scenarioFacts();
  assert.equal(f.corpus_base, 1);
  assert.equal(f.base_up, null, "a base that is not a URL has unknown reachability");
  store.append("gear_runs", { gear: "tick", at: new Date(Date.now() - 5 * 60000).toISOString() });
  const ctx = facts.context("tick");
  assert.equal(ctx.gear, "tick");
  assert.equal(ctx.since_min, 5);
  assert.equal(ctx.open_findings, 3);
  assert.equal(facts.context("never-ran").since_min, null);
});

test("features: pre-run facts only, optional as 0/1", () => {
  assert.deepEqual(facts.features({ optional: true }, { open_findings: 2, dirty: null, since_min: 7, extra: 1 }, 3),
    { inputs: 3, open_findings: 2, dirty: null, since_min: 7, optional: 1 });
  assert.equal(facts.features({}, {}, 0).optional, 0);
});
