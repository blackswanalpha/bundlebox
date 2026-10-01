// ratify.test.js — src/grapple/ratify.js: one batched proposal over the open
// questions, rows about files already open first, and one disposition per row.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-ratify-")));
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;

const ratify = await import("../src/grapple/ratify.js");
const gs = await import("../src/grapple/store.js");
const core = await import("../src/core/store.js");

const q = (key, over = {}) => ({ key, shape: "instance", text: `question ${key}`, state: "open", ev: 1, paths: [], brief: "", ...over });

test("propose: nothing open is no proposal", () => {
  assert.equal(ratify.propose({ questions: {} }), null);
  assert.equal(ratify.propose({ questions: { a: q("a", { state: "answered" }) } }), null);
  assert.match(ratify.render(null), /nothing to ratify/);
});

test("propose: rows about open files sort first, then by ev, then by key, capped at the batch", () => {
  const qs = { a: q("a", { ev: 5 }), b: q("b", { ev: 9 }), c: q("c", { ev: 1, paths: ["src/x.js"] }), d: q("d", { ev: 9 }), e: q("e", { state: "answered", paths: ["src/x.js"] }) };
  const p = ratify.propose({ open: ["src/x.js"], batch: 3, questions: qs });
  assert.deepEqual(p.rows.map((r) => [r.key, r.contact]), [["c", 1], ["b", 0], ["d", 0]]);
  assert.equal(p.state, "open");
  assert.equal(ratify.current().id, p.id, "the proposal on the table is the one just made");
  const again = ratify.propose({ open: [], batch: 3, questions: { d: qs.d, b: qs.b, c: qs.c } });
  assert.equal(again.id, p.id, "the id is a function of the key set, not its order");
  const ev = gs.events({ kind: "proposed" });
  assert.ok(ev.length >= 1);
  assert.equal(ev.at(-1).proposal, p.id);
});

test("propose: a brief question is about the session once anything is open", () => {
  const p = ratify.propose({ open: ["anything.js"], questions: { z: q("z", { brief: "b1" }) } });
  assert.equal(p.rows[0].contact, 1);
  assert.equal(ratify.propose({ open: [], questions: { z: q("z", { brief: "b1" }) } }).rows[0].contact, 0);
});

test("decide: confirmed and rejected rows are answered, the rest stay open and the proposal is partial", () => {
  core.put(gs.QUESTIONS, { k1: q("k1"), k2: q("k2"), k3: q("k3") });
  const p = ratify.propose({ questions: gs.questions() });
  const out = ratify.decide(p, { confirm: ["k1"], reject: ["k2", "not-in-proposal"], reason: "checked" });
  assert.deepEqual([out.confirmed, out.rejected, out.untouched, out.labels], [["k1"], ["k2"], ["k3"], 2]);
  assert.equal(gs.questions().k1.state, "answered");
  assert.equal(gs.questions().k1.value, "yes");
  assert.equal(gs.questions().k2.value, "no");
  assert.equal(gs.questions().k3.state, "open");
  assert.equal(ratify.current().state, "partial");
  const all = ratify.decide(ratify.propose({ questions: gs.questions() }), { confirm: ["k3"] });
  assert.deepEqual(all.confirmed, ["k3"]);
  assert.equal(ratify.current().state, "decided");
});

test("decide: a row whose question has gone is left untouched, not counted", () => {
  const p = { id: "p1", rows: [{ key: "ghost", shape: "instance", text: "", reaches: 1, contact: 0 }] };
  assert.deepEqual(ratify.decide(p, { confirm: ["ghost"] }), { proposal: "p1", confirmed: [], rejected: [], untouched: ["ghost"], labels: 0 });
});

test("render: one line per row with the command that answers it", () => {
  const p = { id: "abc", rows: [{ key: "k1", shape: "pattern", text: "x".repeat(200), reaches: 12, contact: 1 }, { key: "k2", shape: "instance", text: "short", reaches: 1, contact: 0 }] };
  const s = ratify.render(p);
  assert.match(s, /proposal abc — 2 row\(s\), 1 about files already open/);
  assert.match(s, /\[open\] k1 {2}pattern {2}reaches {2}12 {2}x{110}\n/);
  assert.match(s, /\[ {4}\] k2/);
  assert.match(s, /bb grapple ratify abc --confirm/);
  core.put(ratify.PROPOSALS, { nope: true });
  assert.equal(ratify.current(), null, "a stored value without id and rows is no proposal");
});
