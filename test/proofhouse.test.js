// proofhouse.test.js — the view whose subject is this box's own output.
//
// Two things are worth a test here and they are not the same thing. One is that
// each check fires on the shape it is for. The other is that a check which
// COULD NOT LOOK says so, because a proofhouse reporting nothing wrong when it
// read nothing is the failure it exists to catch, one level up.
import { test } from "node:test";
import assert from "node:assert/strict";

const proofhouse = await import("../src/mainboard/proofhouse.js");
const mainboard = await import("../src/mainboard/index.js");
const views = await import("../src/mainboard/views.js");

const DAY = 86400000;
const now = Date.parse("2026-09-21T00:00:00Z");
const unit = (o) => ({ id: "u1", detector: "d", status: "ready", scope: [], verdict: "FITS", projected: 1000, title: "t", unproven: false, ...o });
const found = (o) => ({ id: "f1", detector: "d", status: "open", first_seen: new Date(now - 5 * DAY).toISOString(), seen_count: 2, auto_fix: null, ...o });
const byId = (r, id) => r.findings.find((f) => f.id.startsWith(id)) || null;

test("a unit scoped to the tree is a finding, and the share is in the evidence", () => {
  const r = proofhouse.check({ universe: 100, now, units: [unit({ id: "u-big", scope: Array.from({ length: 40 }, (_, i) => `src/f${i}.js`) })] });
  const f = byId(r, "PH-scope-");
  assert.ok(f, "40 of 100 code files is past the bar");
  assert.equal(f.severity, "high");
  assert.equal(f.evidence.scope_files, 40);
  assert.equal(f.evidence.code_files, 100);
  assert.equal(f.evidence.share, 0.4);
  assert.equal(proofhouse.check({ universe: 100, now, units: [unit({ scope: ["src/a.js"] })] }).findings.length, 0,
    "one file of a hundred is a located scope, which is the point of a unit");
});

test("no code-file count is a blind spot, never a pass", () => {
  const r = proofhouse.check({ universe: 0, now, units: [unit({ scope: Array.from({ length: 400 }, (_, i) => `src/f${i}.js`) })] });
  assert.equal(byId(r, "PH-scope-"), null, "nothing to size the scope against");
  assert.ok(r.blind.some((b) => /code-file count/.test(b)), "a check that could not look has to say so");
});

test("one detector owning the queue is a finding; too few units is a blind spot", () => {
  const many = [...Array.from({ length: 9 }, (_, i) => unit({ id: `a${i}`, detector: "echo:spin" })), unit({ id: "b", detector: "doc-links" })];
  const f = byId(proofhouse.check({ universe: 100, now, units: many }), "PH-concentration");
  assert.ok(f);
  assert.equal(f.evidence.detector, "echo:spin");
  assert.equal(f.evidence.units, 9);
  assert.equal(f.evidence.share, 0.9);

  const few = proofhouse.check({ universe: 100, now, units: [unit({ id: "a", detector: "x" }), unit({ id: "b", detector: "x" })] });
  assert.equal(byId(few, "PH-concentration"), null, "two of two is 100% and means nothing");
  assert.ok(few.blind.some((b) => /noise/.test(b)));
});

test("a queue that cannot come back green is one finding, not one per unit", () => {
  const r = proofhouse.check({ universe: 100, now, units: [unit({ id: "a", unproven: true }), unit({ id: "b", unproven: true }), unit({ id: "c" })] });
  const f = byId(r, "PH-unproven-queue");
  assert.ok(f);
  assert.equal(f.evidence.unproven, 2);
  assert.equal(f.evidence.ready, 3);
  assert.deepEqual(f.evidence.units, ["a", "b"]);
});

test("stuck: a free actuator that has been available for days, and the three rows that are not that", () => {
  const rows = [
    found({ id: "old", auto_fix: "drop-dead-export", first_seen: new Date(now - 6 * DAY).toISOString(), seen_count: 9 }),
    found({ id: "fresh", auto_fix: "drop-dead-export", first_seen: new Date(now - 1 * DAY).toISOString() }),
    found({ id: "plan", auto_fix: "plan-block-lift", first_seen: new Date(now - 30 * DAY).toISOString() }),
    found({ id: "none", auto_fix: null, first_seen: new Date(now - 30 * DAY).toISOString() }),
  ];
  const f = byId(proofhouse.check({ universe: 100, now, findings: rows }), "PH-stuck-actuated");
  assert.ok(f);
  assert.equal(f.evidence.stuck, 1, "a plan is not a closure and a day is not three");
  assert.equal(f.evidence.oldest, "old");
  assert.equal(f.evidence.oldest_days, 6);
  assert.equal(f.kind, "fix", "the work is `bb fix --apply`, not a lane");
});

test("open findings with no first_seen are a blind spot, not an empty age", () => {
  const r = proofhouse.check({ universe: 100, now, findings: [found({ first_seen: undefined, auto_fix: "drop-dead-export" })] });
  assert.equal(byId(r, "PH-stuck-actuated"), null);
  assert.ok(r.blind.some((b) => /first_seen/.test(b)));
  assert.equal(r.facts.oldest_open_days, null);
});

test("every row this view can produce passes the board's own recorder", () => {
  // The contract the whole board turns on: a finding with no evidence, an
  // unknown category or an id that is not stable across runs is refused. A view
  // that files one is a view the board cannot hold, so the checks are bound to
  // `normalise` here rather than to a copy of its rules.
  const r = proofhouse.check({
    universe: 100, now,
    units: [unit({ id: "u-big", detector: "echo:spin", scope: Array.from({ length: 40 }, (_, i) => `src/f${i}.js`), unproven: true }),
      ...Array.from({ length: 5 }, (_, i) => unit({ id: `e${i}`, detector: "echo:spin" }))],
    findings: [found({ auto_fix: "drop-dead-export", first_seen: new Date(now - 6 * DAY).toISOString() })],
  });
  assert.equal(r.findings.length, 4, "all four checks fire on this input");
  for (const f of r.findings) {
    const n = mainboard.normalise(f, "proofhouse");
    assert.equal(n.bad, undefined, `refused: ${(n.bad || []).join("; ")}`);
    assert.equal(n.row.detector, "mainboard:proofhouse");
    assert.equal(n.row.precision, "exact", "every check is arithmetic over an artefact, never a probe");
  }
});

test("the view is declared, writes FACTORY, and reads no service", () => {
  const v = views.view("proofhouse");
  assert.ok(v);
  assert.deepEqual(v.writes, ["FACTORY"]);
  assert.ok(views.CATEGORIES.includes("FACTORY"));
  assert.equal(v.run.length, 0, "no base, no corpus, no world: its subject is already on disk");
});
