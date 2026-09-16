// brief.test.js — the enforcement axis. A brief is recorded, and then the two
// guards are asked the questions a PreToolUse hook asks them: is this read
// already answered, is this search already indexed. BB_ROOT is set before any
// src module loads, as everywhere else in this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-brief-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

w("package.json", JSON.stringify({ name: "fixture", type: "module" }));
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 } }));
// A file big enough that serving the region instead of the whole file is worth
// a denial, and a small one that is not.
const filler = (n, tag) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i}) + other(${i});`).join("\n");
w("src/big.js", `${filler(400, "a")}\nexport function refreshSession(id) {\n  return loginToken(id);\n}\n${filler(400, "b")}\n`);
w("src/small.js", "export function tiny() { return 1; }\n");
w(".bundlebox/out/snapgen/symbols-src.md", [
  "# symbols-src",
  "",
  "refreshSession  src/big.js:401",
  "loginToken  src/token.js:12",
  "tiny  src/small.js:1",
].join("\n") + "\n");

const brief = await import("../src/wire/brief.js");

const REC = () => brief.record({
  problem: "refresh the session token",
  verdict: "FITS",
  projected: 40000,
  scope: ["src/big.js"],
  cut: ["src/cut.js"],
  candidates: [{ file: "src/maybe.js" }],
  symbols: [{ file: "src/big.js", symbol: "refreshSession", line: 401 }],
  grep: [],
  anchors: [{ path: "src/big.js", symbol: "refreshSession", line_start: 401, line_end: 403, tokens: 30, text: "export function refreshSession(id) {\n  return loginToken(id);\n}" }],
  gates: { quick: "npm run lint", full: "npm test" },
  tables: ["symbols-src"],
}, { sessionId: "S1", briefPath: ".bundlebox/out/pinpoint/x.md" });

// ── the record ──────────────────────────────────────────────────────────────

test("activate then current round-trips, and another session sees nothing", () => {
  assert.equal(brief.activate(REC()), true);
  const got = brief.current({ sessionId: "S1" });
  assert.equal(got.problem, "refresh the session token");
  assert.equal(got.anchors.length, 1);
  assert.equal(brief.current({ sessionId: "S2" }), null, "a brief located for another session answers nothing");
});

test("a brief past its age answers nothing", () => {
  const rec = REC();
  rec.at = new Date(Date.now() - 120 * 60000).toISOString();
  brief.activate(rec);
  assert.equal(brief.current({ maxAgeMin: 45 }), null);
  assert.ok(brief.current({ maxAgeMin: 240 }), "the same brief inside a wider window still answers");
});

test("band carries the map, not the regions", () => {
  const b = brief.band(REC());
  assert.match(b, /src\/big\.js:401 — refreshSession/);
  assert.match(b, /src\/big\.js:401-403/);
  assert.match(b, /done when: npm run lint {2}\/ {2}npm test/);
  assert.ok(!b.includes("return loginToken(id);"), "the quoted body stays on disk until a read asks for it");
});

// ── the read guard ──────────────────────────────────────────────────────────

const capacity = 48000;

test("a whole-file read of a quoted region is denied, and the quote comes back", () => {
  brief.activate(REC());
  const rec = brief.current({});
  const v = brief.readVerdict(rec, "src/big.js", { capacity });
  assert.equal(v.permissionDecision, "deny");
  assert.match(v.permissionDecisionReason, /return loginToken\(id\);/, "the region is served, not described");
  assert.match(v.permissionDecisionReason, /unlock Edit/, "a scope file says how to read it anyway");
});

test("a range the brief did not locate goes through", () => {
  brief.activate(REC());
  assert.equal(brief.readVerdict(brief.current({}), "src/big.js", { offset: 700, limit: 40, capacity }), null);
});

test("a range inside the quoted region is denied", () => {
  brief.activate(REC());
  const v = brief.readVerdict(brief.current({}), "src/big.js", { offset: 400, limit: 10, capacity });
  assert.equal(v.permissionDecision, "deny");
});

test("a small file is never worth a denial", () => {
  const rec = REC();
  rec.scope = ["src/small.js"];
  rec.anchors = [{ path: "src/small.js", symbol: "tiny", line_start: 1, line_end: 1, tokens: 8, text: "export function tiny() { return 1; }" }];
  brief.activate(rec);
  assert.equal(brief.readVerdict(brief.current({}), "src/small.js", { capacity }), null);
});

test("a file cut for budget is asked about, not denied", () => {
  brief.activate(REC());
  const v = brief.readVerdict(brief.current({}), "src/cut.js", { capacity });
  assert.equal(v.permissionDecision, "ask");
  assert.match(v.permissionDecisionReason, /cut from the pinpoint scope/);
});

test("an exact duplicate read is denied whatever the file is", () => {
  brief.activate(REC());
  const rec = brief.current({});
  assert.equal(brief.readVerdict(rec, "src/small.js", { offset: 0, limit: 0, capacity }), null, "first read of an unquoted file");
  const v = brief.readVerdict(brief.current({}), "src/small.js", { offset: 0, limit: 0, capacity });
  assert.equal(v.permissionDecision, "deny");
  assert.match(v.permissionDecisionReason, /already happened in this session/);
});

test("no brief means no opinion", () => {
  assert.equal(brief.readVerdict(null, "src/big.js", { capacity }), null);
});

// ── the search guard ────────────────────────────────────────────────────────

test("patternTerms keeps the identifier-shaped parts", () => {
  assert.deepEqual(brief.patternTerms("^export (async )?function refreshSession"), ["export", "async", "function", "refreshSession"]);
  assert.deepEqual(brief.patternTerms("\\s+\\d{2}"), []);
});

test("a search the brief already located is denied with its ranked rows", () => {
  brief.activate(REC());
  const v = brief.searchVerdict(brief.current({}), "refreshSession", {});
  assert.equal(v.permissionDecision, "deny");
  assert.match(v.permissionDecisionReason, /src\/big\.js:401 — refreshSession/);
  assert.match(v.permissionDecisionReason, /active pinpoint brief/);
});

test("a search the tables answer is denied with the table rows, brief or no brief", () => {
  const v = brief.searchVerdict(null, "loginToken", {});
  assert.equal(v.permissionDecision, "deny");
  assert.match(v.permissionDecisionReason, /src\/token\.js:12 — loginToken/);
  assert.match(v.permissionDecisionReason, /symbols-\*\.md/);
});

test("a search no declaration index can answer goes through", () => {
  assert.equal(brief.searchVerdict(null, "TODO: rip this out before the release", {}), null);
  assert.equal(brief.searchVerdict(null, "definitelyNotDeclaredAnywhere", {}), null);
});

test("a repeated search is denied as a duplicate", () => {
  brief.activate(REC());
  brief.searchVerdict(brief.current({}), "somethingNovelHere", {});
  const v = brief.searchVerdict(brief.current({}), "somethingNovelHere", {});
  assert.equal(v.permissionDecision, "deny");
  assert.match(v.permissionDecisionReason, /already ran in this session/);
});

test("tableHits never builds a table it cannot find", () => {
  assert.deepEqual(brief.tableHits(["nothingmatcheshere"]), []);
});

// ── bash, which is how a session actually reads ──────────────────────────────

test("parseBash finds the one read or the one search, and nothing else", () => {
  assert.deepEqual(brief.parseBash("grep -rn 'refreshSession' src/"), { kind: "search", pattern: "refreshSession", pathArg: "src/" });
  assert.deepEqual(brief.parseBash("rg -n --include '*.js' loginToken"), { kind: "search", pattern: "loginToken", pathArg: "" });
  assert.deepEqual(brief.parseBash("grep -rln addClaudeHooks test/"), { kind: "search", pattern: "addClaudeHooks", pathArg: "test/" }, "the search this guard wrongly denied on its first day");
  assert.deepEqual(brief.parseBash("sed -n 401,403p src/big.js"), { kind: "read", file: "src/big.js", offset: 401, limit: 3 });
  assert.deepEqual(brief.parseBash("cat src/big.js"), { kind: "read", file: "src/big.js", offset: 0, limit: 0 });
  assert.equal(brief.parseBash("npm test"), null);
  assert.equal(brief.parseBash("git commit -m 'grep'"), null, "a commit message is not a search");
  assert.equal(brief.parseBash("cat a.js b.js > c.js"), null, "two files is a concatenation, not a read to serve");
  assert.equal(brief.parseBash("head -40 src/big.js"), null, "already a ranged read");
  assert.equal(brief.parseBash(""), null);
});

test("a shell read of a quoted region is denied exactly as the Read tool is", () => {
  brief.activate(REC());
  const seg = brief.parseBash("cat src/big.js");
  const v = brief.readVerdict(brief.current({}), seg.file, { offset: seg.offset, limit: seg.limit, capacity });
  assert.equal(v.permissionDecision, "deny");
});

// ── housekeeping ────────────────────────────────────────────────────────────

test("prune keeps the newest briefs and drops the rest", () => {
  const dir = path.join(root, ".bundlebox", "out", "pinpoint");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `2026091600${String(i).padStart(2, "0")}-x.md`), "x");
  assert.equal(brief.prune({ keep: 5 }), 7);
  const left = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  assert.equal(left.length, 5);
  assert.equal(left[4], "202609160011-x.md", "the newest survive");
});

// ── a search restricted to a directory is a different question ───────────────
//
// The declaration index answers "where is X declared". A grep of `test/` for a
// name declared in `src/` asks who CALLS it, and the index holds no rows for
// that. This guard denied exactly that search, of its own author's, one minute
// after it was installed.

test("dirFilter takes the fixed leading path and nothing else", () => {
  assert.equal(brief.dirFilter("test/", ""), "test/");
  assert.equal(brief.dirFilter("test", ""), "test/");
  assert.equal(brief.dirFilter("", "src/wire/*.js"), "src/wire/");
  assert.equal(brief.dirFilter("", "**/*.js"), "");
  assert.equal(brief.dirFilter("", ""), "");
  assert.equal(brief.dirFilter("src/big.js", ""), "src/big.js");
});

test("a search under a directory the declaration is not in goes through", () => {
  assert.equal(brief.searchVerdict(null, "loginToken", { pathArg: "test/" }), null, "the declaration is in src/, so the index cannot answer this");
  const v = brief.searchVerdict(null, "loginToken", { pathArg: "src/" });
  assert.equal(v.permissionDecision, "deny", "under src/ the index does answer it");
});

test("tableHits honours the same filter", () => {
  assert.equal(brief.tableHits(["loginToken"], { under: "src/" }).length, 1);
  assert.deepEqual(brief.tableHits(["loginToken"], { under: "test/" }), []);
});
