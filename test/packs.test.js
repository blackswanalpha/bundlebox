// packs.test.js — src/genesis/world.js (the three inlets, seed, plan) and
// src/genesis/packs.js (the brief per surface) called directly, not through
// the CLI. The derivation runs in the local python expert; no model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-packs-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;

const expert = await import("../src/core/expert.js");
const world = await import("../src/genesis/world.js");
const packs = await import("../src/genesis/packs.js");
const store = await import("../src/core/store.js");
const noPython = !expert.pythonName();

const DOC = `# Orders

An order must have at least one line before it can be submitted.
The API exposes GET /orders and POST /orders.

## Members

A member must not read another tenant's orders. GET /tenant/{id}/members lists them.
`;

test("world.derive: refusals name what is missing", () => {
  assert.match(world.derive({}).why, /nothing to read/);
  assert.match(world.derive({ doc: "nope.md" }).why, /cannot read nope\.md/);
  assert.match(world.derive({ finding: "zz" }).why, /no finding `zz`/);
  store.put("findings", [{ id: "ab1", title: "x" }, { id: "ab2", title: "y" }]);
  assert.match(world.derive({ finding: "ab" }).why, /`ab` matches 2 findings: ab1, ab2/);
  fs.writeFileSync(path.join(root, "blank.md"), "\n  \n");
  assert.match(world.derive({ ticket: "blank.md" }).why, /blank\.md is empty/);
  assert.match(world.seed("none").why, /no world `none`/);
  assert.match(world.plan("none").why, /no world `none`/);
});

test("world.derive: a document is written with its source, and becomes current", { skip: noPython && "python3 not found" }, () => {
  assert.deepEqual(world.ids(), []);
  const r = world.derive({ prompt: DOC, name: "Orders Doc" });
  assert.equal(r.rc, 0);
  assert.equal(r.id, "orders-doc");
  assert.equal(fs.readFileSync(path.join(world.DIR(), "orders-doc", "source.txt"), "utf8"), DOC);
  const w = world.world("orders-doc");
  assert.equal(w.from, "--prompt");
  assert.equal(w.source_bytes, Buffer.byteLength(DOC));
  assert.ok(w.surfaces.length >= 2);
  assert.ok(w.capabilities.some((c) => c.path === "/orders"));
  assert.deepEqual(world.ids(), ["orders-doc"]);
  assert.equal(world.current(), "orders-doc");
  assert.equal(world.current("other"), "other", "an explicit id wins");
});

test("world.derive: a finding by unique prefix and a ticket file reach the same world file", { skip: noPython && "python3 not found" }, () => {
  store.put("findings", [{ id: "f00d1", title: "timeout ignored", path: "src/net/client.js", detector: "x", detail: "the client must retry" }]);
  const f = world.derive({ finding: "f00d" });
  assert.equal(f.rc, 0);
  assert.equal(f.id, "client");
  assert.equal(f.world.from, "finding f00d1");
  assert.equal(f.world.rules[0].text, "the client must retry");
  fs.writeFileSync(path.join(root, "bug.md"), "\n# Checkout crashes\nsteps: POST /cart\n");
  const t = world.derive({ ticket: "bug.md", name: "crash" });
  assert.equal(t.rc, 0);
  assert.equal(t.world.from, "ticket Checkout crashes");
  assert.match(fs.readFileSync(path.join(world.DIR(), "crash", "source.txt"), "utf8"), /^Checkout crashes/);
});

test("world.seed: keeps what the persona already declared and lays out one dir per surface", { skip: noPython && "python3 not found" }, () => {
  const s1 = world.seed("orders-doc", { base: "http://localhost:9" });
  assert.equal(s1.rc, 0);
  assert.equal(s1.existed, false);
  const dir = path.join(root, s1.dir);
  const persona = JSON.parse(fs.readFileSync(path.join(dir, "persona.json"), "utf8"));
  assert.equal(persona.base, "http://localhost:9");
  assert.equal(persona.from_world, "orders-doc");
  const surfaces = JSON.parse(fs.readFileSync(path.join(dir, "surfaces.json"), "utf8"));
  assert.equal(surfaces.length, s1.surfaces);
  assert.ok(fs.existsSync(path.join(dir, "scenarios", `01-${surfaces[0].id}`)));
  fs.writeFileSync(path.join(dir, "persona.json"), JSON.stringify({ ...persona, excluded: ["POST /orders"], rpm: 5 }));
  const s2 = world.seed("orders-doc");
  assert.equal(s2.existed, true);
  const again = JSON.parse(fs.readFileSync(path.join(dir, "persona.json"), "utf8"));
  assert.deepEqual([again.excluded, again.rpm, again.base], [["POST /orders"], 5, "http://localhost:9"]);
});

test("packs.pack: one brief per surface, fixed half first, indexed with its acceptance", { skip: noPython && "python3 not found" }, () => {
  const r = packs.pack("orders-doc", { batch: 1 });
  assert.equal(r.rc, 0);
  assert.ok(r.packs.length >= 1);
  const idx = JSON.parse(fs.readFileSync(path.join(world.PACKS(), "orders-doc", "index.json"), "utf8"));
  assert.equal(idx.packs.length, r.packs.length);
  for (const p of r.packs) {
    assert.equal(p.specs.length, 1, "batch 1 is one spec per pack");
    assert.equal(p.acceptance, "bb cookbook check --persona orders-doc");
    const text = fs.readFileSync(path.join(root, p.file), "utf8");
    assert.ok(text.indexOf("## The shape, exactly") < text.indexOf(`for \`${p.surface}\``), "the fixed half comes first");
    assert.ok(p.est_tokens > 0);
  }
  assert.equal(packs.pack("orders-doc", { batch: 1, max: 1 }).packs.length, 1);
});

test("packs.send: refuses when there is nothing to send, before any draft", async () => {
  assert.match((await packs.send("never-packed")).why, /no packs for `never-packed`/);
  if (noPython) return;
  assert.match((await packs.send("orders-doc", "no-such-surface")).why, /no pack matching `no-such-surface`/);
});

test("packs.packText: the corpus's own tokens, the quoted rules, and a skeleton per capability", () => {
  const specs = [
    { surface: "orders", capability: "GET /orders", tier: "simple", why: "no scenario reaches it", skeleton: { steps: [] }, cite: [{ id: "R1", line: 3, text: "An order must have a line." }] },
    { surface: "orders", capability: "POST /orders", tier: "complex", why: "shallow", skeleton: { steps: [1] }, cite: [{ id: "R1", line: 3, text: "An order must have a line." }] },
  ];
  const t = packs.packText("w", specs, { corpusId: "shop", w: { surfaces: [{ id: "orders" }] },
    persona: { vars: { user: "u" }, setup: [{ save: { token: "t" } }, null] } });
  assert.match(t, /# Write 2 scenarios for `orders`/);
  assert.match(t, /\.bundlebox\/cookbook\/shop\/scenarios\/NN-orders/);
  assert.match(t, /`\{\{user\}\}` from `persona\.json` vars · `\{\{token\}\}` saved by the persona's `setup`/);
  assert.equal(t.match(/\*\*R1\*\* \(line 3\)/g).length, 1, "a rule cited twice is quoted once");
  assert.match(t, /### `POST \/orders` — complex/);
  assert.match(t, /bb cookbook check --persona shop/);
  const bare = packs.packText("w", [{ ...specs[0], surface: "", cite: [] }], { corpusId: "c", w: {} });
  assert.match(bare, /# Write 1 scenario for `\(none\)`/);
  assert.match(bare, /the document states no rule for this surface/);
  assert.doesNotMatch(bare, /persona\.json` vars/);
  assert.ok(t.startsWith(bare.slice(0, bare.indexOf("# Write"))), "two packs share the fixed prefix byte for byte");
});
