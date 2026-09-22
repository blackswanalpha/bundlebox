// case.test.js — the rows that are one story, and the joins this verb refuses.
//
// Two halves, and the second is the one worth having. A join that fires is easy
// to test and easy to get wrong in the generous direction: the first build of
// this module joined by connected component, every edge was correct, and it
// produced one case of 622 rows. So half of these tests are about pairs that
// must NOT be joined, and about the module saying what it could not place.
import { test } from "node:test";
import assert from "node:assert/strict";

const kase = await import("../src/case/index.js");

const DAY = 86400000;
const now = Date.parse("2026-09-21T00:00:00Z");
const row = (o) => ({ id: "r1", detector: "d", status: "open", severity: "medium", path: "", files: [], title: "t",
  first_seen: new Date(now - DAY).toISOString(), evidence: {}, ...o });
const subjectsOf = (f) => [...kase.subjects(f)].sort();
const find = (r, subject) => r.cases.find((c) => c.subject === subject) || null;

test("subjects: a real file, a named evidence key, a stage in the path", () => {
  assert.deepEqual(subjectsOf(row({ path: "src/a.js", files: ["src/a.js", "src/b.js"] })), ["file:src/a.js", "file:src/b.js"]);
  assert.deepEqual(subjectsOf(row({ evidence: { service: "console", count: 4 } })), ["service:console"],
    "`count` is not a subject: rows collide on it constantly and a case built on count=4 is noise with a title");
  assert.deepEqual(subjectsOf(row({ path: "echos" })), ["stage:echos"]);
  assert.deepEqual(subjectsOf(row({ path: "stages" })), [], "`stages` is not a declared stage, so it joins nothing");
});

test("the repository root is not a subject", () => {
  assert.deepEqual(subjectsOf(row({ path: ".", files: [] })), [],
    "`.` is every row at once — the same mistake that scoped a unit to the whole tree");
  assert.deepEqual(subjectsOf(row({ evidence: { service: "." } })), []);
});

test("one level into `worst`, and a bare id only when it names a declared stage", () => {
  assert.deepEqual(subjectsOf(row({ evidence: { worst: [{ id: "echos", why: "x" }] } })), ["stage:echos"]);
  assert.deepEqual(subjectsOf(row({ evidence: { worst: [{ id: "some-eval-row" }] } })), [],
    "`id` is the most overloaded key on the board; anything looser joins rows by coincidence");
  assert.deepEqual(subjectsOf(row({ evidence: { worst: [{ stage: "viewport build" }] } })), ["stage:viewport build"]);
  const many = row({ evidence: { worst: Array.from({ length: 50 }, (_, i) => ({ service: `s${i}` })) } });
  assert.equal(subjectsOf(many).length, kase.NESTED_AT_MOST, "an eval names thousands of rows; the first few are what it is about");
});

test("a case is one subject, and a row naming two subjects is in both", () => {
  const rows = [
    row({ id: "dup", detector: "duplicate-blocks", files: ["a/x.js", "b/y.js"], title: "a/x.js and b/y.js share 40 lines" }),
    row({ id: "big", detector: "god-file", path: "a/x.js", files: ["a/x.js"], title: "a/x.js is 900 lines" }),
    row({ id: "dead", detector: "dead-exports", path: "b/y.js", files: ["b/y.js"], title: "b/y.js has 3 unused exports" }),
  ];
  const r = kase.cases({ rows });
  assert.equal(r.cases.length, 2, "two files, two cases — a subject cannot chain into a third");
  assert.deepEqual(find(r, "file:a/x.js").rows.concat(find(r, "file:a/x.js").root).map((x) => x.id).sort(), ["big", "dup"]);
  assert.deepEqual(find(r, "file:b/y.js").rows.concat(find(r, "file:b/y.js").root).map((x) => x.id).sort(), ["dead", "dup"]);
});

test("a subject only one row names is not a case, and the leftovers are declared", () => {
  const r = kase.cases({ rows: [row({ id: "a", path: "src/a.js", files: ["src/a.js"] }), row({ id: "b", path: "src/b.js", files: ["src/b.js"] })] });
  assert.equal(r.cases.length, 0, "one row is a finding, and `bb findings` already prints those");
  assert.equal(r.facts.placed, 0);
  assert.ok(r.blind.some((b) => /2 open row\(s\) name no subject shared/.test(b)),
    "how many were not placed is the only thing between one story and all that could be assembled");
});

test("closed rows are not in a case", () => {
  const rows = [row({ id: "a", path: "src/a.js", files: ["src/a.js"] }), row({ id: "b", path: "src/a.js", files: ["src/a.js"], status: "resolved" })];
  assert.equal(kase.cases({ rows }).cases.length, 0);
});

test("the root is the row that carries a cause, not the loudest row", () => {
  const b = { byId: new Map([["service-down", { id: "service-down", why: "a declared service is not running", op: "start-services", doc: "bb runbook services" }]]),
    ops: new Map([["start-services", { id: "start-services", cmd: "bb runbook up all --apply" }]]) };
  const rows = [
    row({ id: "loud", severity: "critical", evidence: { service: "console" }, title: "everything is on fire" }),
    row({ id: "cause", severity: "low", evidence: { service: "console", playbook_entry: "service-down" }, title: "console is down" }),
  ];
  const c = find(kase.cases({ rows, book: b }), "service:console");
  assert.equal(c.root.id, "cause", "the loudest row in a case is routinely the symptom of the quietest");
  assert.equal(c.severity, "critical", "the case still carries the worst severity in it");
  assert.equal(c.cause.why, "a declared service is not running");
  assert.equal(c.cause.op, "bb runbook up all --apply");
});

test("no playbook entry means no cause, never an invented one", () => {
  const rows = [row({ id: "a", evidence: { service: "api" } }), row({ id: "b", evidence: { service: "api" } })];
  assert.equal(find(kase.cases({ rows }), "service:api").cause, null);
});

test("the kind comes from bb intent and says so when the table did not decide", () => {
  const rows = [row({ id: "a", path: "src/a.js", files: ["src/a.js"] }), row({ id: "b", path: "src/a.js", files: ["src/a.js"] })];
  const r = kase.cases({ rows, head: null });
  const c = find(r, "file:src/a.js");
  assert.equal(c.why.via, "default");
  assert.ok(c.why.steps.some((s) => /no table on disk/.test(s)), "a budget nobody can argue with is not what a case carries");
  assert.ok(r.blind.some((b) => /no case kind was decided/.test(b)));

  // A table that exists and is not deciding is the failure a boolean hides:
  // every case still reads `fix`, and from outside that is the same as agreement.
  const idle = kase.cases({ rows, head: { useful: false, why: "no kind beat its base rate", kinds: {} } });
  assert.ok(idle.blind.some((b) => /the table is not useful: no kind beat its base rate/.test(b)));
});

test("an undated row has no age, and does not date a case to the millennium", () => {
  // `Date.parse(0)` coerces to the string "0" and returns 2000-01-01, so the
  // tempting `f.first_seen || f.last_seen || 0` makes every window 26 years wide.
  const rows = [
    row({ id: "a", path: "src/a.js", files: ["src/a.js"], first_seen: undefined, last_seen: undefined }),
    row({ id: "b", path: "src/a.js", files: ["src/a.js"], first_seen: new Date(now - DAY).toISOString() }),
  ];
  const c = find(kase.cases({ rows }), "file:src/a.js");
  assert.equal(c.window.days, 0);
  assert.equal(c.window.first_seen, new Date(now - DAY).toISOString());
});

test("a stage case names the earlier stages that also have one", () => {
  const at = (id, n) => Array.from({ length: n }, (_, i) => row({ id: `${id}${i}`, path: id }));
  const r = kase.cases({ rows: [...at("corpus", 2), ...at("echos", 2), ...at("ship", 2)] });
  assert.deepEqual(find(r, "stage:echos").upstream, ["stage:corpus"],
    "declared order, never a claim that one caused the other");
  assert.deepEqual(find(r, "stage:corpus").upstream, []);
  assert.deepEqual(find(r, "stage:ship").upstream, ["stage:corpus", "stage:echos"]);
});

test("a case id is the subject, so it survives its rows changing", () => {
  const one = row({ id: "a", path: "src/a.js", files: ["src/a.js"] });
  const two = row({ id: "b", path: "src/a.js", files: ["src/a.js"] });
  const three = row({ id: "c", path: "src/a.js", files: ["src/a.js"] });
  const before = find(kase.cases({ rows: [one, two] }), "file:src/a.js");
  const after = find(kase.cases({ rows: [one, two, three] }), "file:src/a.js");
  assert.equal(before.id, after.id, "an id derived from the members files a second case every time one closes");
  assert.equal(after.size, 3);
});

test("a case is ordered by when things happened, with the undated rows after them", () => {
  const clock = { touched: new Map([["src/a.js", "2026-03-01T00:00:00.000Z"], ["src/b.js", "2026-08-01T00:00:00.000Z"]]), sessions: new Map() };
  const rows = [
    // Deliberately the reverse of every other order in the row: newest first_seen,
    // highest severity, earliest occurrence. Only the occurrence may decide.
    row({ id: "old", severity: "low", path: "src/x.js", files: ["src/x.js", "src/a.js"], title: "written in March", first_seen: new Date(now).toISOString() }),
    row({ id: "new", severity: "critical", path: "src/x.js", files: ["src/x.js", "src/b.js"], title: "written in August", first_seen: new Date(now - 9 * DAY).toISOString() }),
    row({ id: "undated", severity: "high", path: "src/x.js", files: ["src/x.js"], title: "no commit touches this", first_seen: new Date(now - 5 * DAY).toISOString() }),
  ];
  const c = find(kase.cases({ rows, clock }), "file:src/x.js");
  assert.equal(c.root.id, "old", "the root is what happened first, not what was noticed first or shouted loudest");
  assert.equal(c.root.occurred_at, "2026-03-01T00:00:00.000Z");
  assert.equal(c.root.occurred_via, "git:last-touch");
  assert.deepEqual(c.rows.map((m) => m.id), ["new", "undated"],
    "ordered by occurrence; an undated row goes after the dated ones, not at position zero");
  assert.equal(c.rows[0].occurred_at, "2026-08-01T00:00:00.000Z");
  assert.equal(c.rows[1].occurred_at, null);
});

test("a case counts what it could place in time, and the board declares the rest", () => {
  const clock = { touched: new Map([["src/a.js", "2026-03-01T00:00:00.000Z"]]), sessions: new Map() };
  const rows = [
    row({ id: "a", path: "src/a.js", files: ["src/a.js"] }),
    row({ id: "b", path: "src/a.js", files: ["src/a.js"] }),
    row({ id: "c", path: "src/a.js", files: ["src/a.js", "src/gone.js"] }),
  ];
  const r = kase.cases({ rows, clock });
  const c = find(r, "file:src/a.js");
  assert.equal(c.occurred.dated, 3);
  assert.equal(c.occurred.of, 3);
  assert.deepEqual(c.occurred.via, ["git:last-touch"]);

  const blindClock = { touched: new Map(), sessions: new Map() };
  const none = kase.cases({ rows, clock: blindClock });
  assert.equal(find(none, "file:src/a.js").occurred.dated, 0);
  assert.ok(none.blind.some((b) => /git proved no dates/.test(b)));
  assert.ok(none.blind.some((b) => /3 row\(s\) in a case name neither a tracked file nor a recorded session/.test(b)));
});

test("the noticed window and the occurred window are two different facts", () => {
  // Ordering a case by `first_seen` orders the SCANS. Both are reported because
  // one of them is what the board did and the other is what happened.
  const clock = { touched: new Map([["src/a.js", "2026-01-01T00:00:00.000Z"], ["src/b.js", "2026-06-01T00:00:00.000Z"]]), sessions: new Map() };
  const rows = [
    row({ id: "a", path: "src/x.js", files: ["src/x.js", "src/a.js"], first_seen: new Date(now - DAY).toISOString() }),
    row({ id: "b", path: "src/x.js", files: ["src/x.js", "src/b.js"], first_seen: new Date(now - DAY).toISOString() }),
  ];
  const c = find(kase.cases({ rows, clock }), "file:src/x.js");
  assert.equal(c.window.days, 0, "both rows were noticed in the same scan");
  assert.equal(c.occurred.days, 151, "and the things they are about are five months apart");
});
