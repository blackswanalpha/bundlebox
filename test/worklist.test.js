// worklist.test.js — the audit finds it, pinpoint locates it, the agent judges
// it. What is checked here is the join: that a measured gap arrives as a brief
// with the files of its CAUSE in scope, that the concrete gap is ordered before
// the summary of it, and that `next` leaves behind the record the PreToolUse
// guards answer from.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-worklist-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

w("package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test", lint: "eslint ." } }));
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000, min_tokens: 1000 } }));
w("src/token.js", "export function loginToken(id) {\n  return `tok-${id}`;\n}\n");
w("src/session.js", "export function refreshSession(id) {\n  return loginToken(id);\n}\n");
w("src/unrelated.js", "export function nothing() { return 0; }\n");

const store = await import("../src/core/store.js");
store.put("findings", [
  { id: "f-low", detector: "debug-leftovers", severity: "low", status: "open", title: "a console.log survived", path: "src/unrelated.js", files: ["src/unrelated.js"] },
  { id: "f-crit", detector: "secrets", severity: "critical", status: "open", title: "a token literal is committed in loginToken", path: "src/token.js", files: ["src/token.js"] },
  { id: "f-high", detector: "oversight:size", severity: "high", status: "open", title: "refreshSession is 4x this tree's median", path: "src/session.js", files: ["src/session.js"] },
  { id: "f-closed", detector: "secrets", severity: "critical", status: "fixed", title: "already closed", path: "src/token.js", files: ["src/token.js"] },
]);

const wl = await import("../src/pinpoint/worklist.js");
const brief = await import("../src/wire/brief.js");

test("fromFindings: open only, worst first, and oversight is named as its own source", () => {
  const rows = wl.fromFindings();
  assert.deepEqual(rows.map((r) => r.id), ["f-crit", "f-high", "f-low"], "the fixed finding is not a gap");
  assert.equal(rows[0].severity, "critical");
  assert.equal(rows.find((r) => r.id === "f-high").source, "oversight");
  assert.equal(rows.find((r) => r.id === "f-crit").source, "scan");
  assert.deepEqual(rows[0].files, ["src/token.js"]);
});

test("an area with no charter contributes nothing, and says so by being empty", async () => {
  assert.deepEqual(await wl.fromAuditor({}), [], "no charter means nothing was declared, so nothing is unproven");
});

test("compile writes the queue and locates each gap", async () => {
  const doc = await wl.compile({ auditor: false, max: 3 });
  assert.equal(doc.count, 3);
  assert.equal(doc.rows[0].id, "f-crit", "the critical finding is row 1");
  assert.ok(doc.rows[0].scope.includes("src/token.js"), "the finding's own file is in scope");
  assert.ok(doc.rows[0].brief.endsWith(".md"));
  assert.ok(fs.existsSync(path.join(root, doc.rows[0].brief)), "the brief is on disk before any model sees it");
  assert.ok(fs.existsSync(wl.FILE()) && fs.existsSync(wl.STATE()));
  assert.match(fs.readFileSync(wl.FILE(), "utf8"), /\| 1 \| scan \| critical \|/);
});

test("next makes a row the active brief the guards answer from", async () => {
  await wl.compile({ auditor: false, max: 3 });
  const r = await wl.next({ n: 2, sessionId: "S9" });
  assert.equal(r.rc, 0);
  assert.equal(r.row.id, "f-high");
  const rec = brief.current({ sessionId: "S9" });
  assert.ok(rec, "the record is there");
  assert.equal(rec.problem, r.row.statement);
  assert.ok(rec.scope.includes("src/session.js"));
  assert.ok(brief.readVerdict(rec, "src/session.js", { capacity: 48000, minShare: 0 }), "and the read guard now has an opinion about the gap's own file");
});

test("next says which row it cannot serve", async () => {
  assert.equal((await wl.next({ n: 99 })).rc, 2);
});

test("an empty worklist renders a row saying what to run", () => {
  assert.match(wl.render({ at: "now", count: 0, rows: [] }), /nothing measured is open/);
});
