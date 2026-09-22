// occurred.test.js — when a thing happened, as distinct from when we noticed.
//
// The test that matters most here is a negative one. `first_seen` is on every
// row and it is always available, so the tempting implementation dates
// everything and produces a timeline that is really a record of when the scans
// ran. Half of these assert that an undated row STAYS undated.
import { test } from "node:test";
import assert from "node:assert/strict";

const occurred = await import("../src/case/occurred.js");

/** A fake `git log --no-merges --format=%x00%cI --name-only`, newest first. */
const log = (commits) => () => commits.map(([at, ...paths]) => `\0${at}\n${paths.join("\n")}`).join("\n") + "\n";

test("touches: newest first wins, and every date comes back UTC", () => {
  const t = occurred.touches({ exec: log([
    ["2026-09-20T18:44:12+03:00", "src/a.js"],
    ["2026-09-14T17:16:00+00:00", "src/a.js", "src/b.js"],
  ]) });
  assert.equal(t.get("src/a.js"), "2026-09-20T15:44:12.000Z", "the later commit, normalised off the committer's offset");
  assert.equal(t.get("src/b.js"), "2026-09-14T17:16:00.000Z");
  // Two dates with different offsets do not sort as strings however they compare
  // as instants, and sorting is the one thing everything downstream does.
  assert.ok([...t.values()].every((v) => v.endsWith("Z")));
});

test("touches: no git is an empty map, never a guessed date", () => {
  const t = occurred.touches({ exec: () => { throw new Error("not a git repository"); } });
  assert.equal(t.size, 0);
  assert.deepEqual(occurred.occurredAt({ path: "src/a.js", files: ["src/a.js"] }, { touched: t }),
    { at: null, via: "none", why: "git has no commit touching this row's files" });
});

test("spans: the earliest event of each session", () => {
  const s = occurred.spans({ events: [
    { session: "s1", at: 3000 }, { session: "s1", at: 1000 }, { session: "s2", at: 2000 },
    { session: "", at: 500 }, { session: "s3", at: 0 },
  ] });
  assert.equal(s.get("s1"), new Date(1000).toISOString());
  assert.equal(s.get("s2"), new Date(2000).toISOString());
  assert.equal(s.has("s3"), false, "an event with no clock is not a time");
  assert.equal(s.has(""), false);
});

test("occurredAt: a file beats a session, and the earliest file wins", () => {
  const touched = new Map([["src/a.js", "2026-09-20T00:00:00.000Z"], ["src/b.js", "2026-09-10T00:00:00.000Z"]]);
  const sessions = new Map([["s1", "2026-09-01T00:00:00.000Z"]]);
  const r = occurred.occurredAt({ path: "src/a.js", files: ["src/a.js", "src/b.js"], evidence: { session: "s1" } }, { touched, sessions });
  assert.equal(r.at, "2026-09-10T00:00:00.000Z", "a row about two files is about both, and the older one is the earliest this could have started");
  assert.equal(r.via, "git:last-touch");
  assert.equal(r.bound, "upper", "the last commit is when this could have started, never when it did");
});

test("occurredAt: a session when there is no file", () => {
  const r = occurred.occurredAt({ path: ".", files: [], evidence: { session: "s1" } },
    { sessions: new Map([["s1", "2026-09-01T00:00:00.000Z"]]) });
  assert.equal(r.at, "2026-09-01T00:00:00.000Z");
  assert.equal(r.via, "session:first-event");
  assert.equal(r.bound, "exact");
});

test("occurredAt never falls back to first_seen", () => {
  // The whole discipline of this module in one assertion. `first_seen` is on
  // every row and always available, so a fallback to it would date everything
  // and make every timeline a record of when the scans ran.
  const f = { path: ".", files: [], evidence: {}, first_seen: "2026-09-01T00:00:00.000Z", last_seen: "2026-09-21T00:00:00.000Z" };
  const r = occurred.occurredAt(f, {});
  assert.equal(r.at, null);
  assert.equal(r.via, "none");
  assert.match(r.why, /neither a tracked file nor a session/);
});

test("occurredAt: the repository root is not a path to date", () => {
  const touched = new Map([[".", "2026-09-20T00:00:00.000Z"]]);
  assert.equal(occurred.occurredAt({ path: ".", files: ["."] }, { touched }).at, null,
    "`.` is every row at once — the same rule that keeps it out of a scope and out of a subject");
});
