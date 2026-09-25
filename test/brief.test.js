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
  const v = brief.readVerdict(brief.current({}), "src/big.js", { offset: 401, limit: 3, capacity });
  assert.equal(v.permissionDecision, "deny");
});

test("a range reaching past the quote goes through: the quote cannot hand those lines back", () => {
  brief.activate(REC());
  assert.equal(brief.readVerdict(brief.current({}), "src/big.js", { offset: 400, limit: 10, capacity }), null);
});

test("a truncated region denies only the lines it carries, and says where it stops", () => {
  // The shape that broke a session: a region that spans 400 lines whose
  // stored text is its first 30.
  const rec = REC();
  const text = Array.from({ length: 30 }, (_, i) => `const a${400 + i} = compute(${400 + i}) + other(${400 + i});`).join("\n");
  rec.anchors = [{ path: "src/big.js", symbol: "wide", line_start: 401, line_end: 800, tokens: 9000, text }];
  brief.activate(rec);
  assert.equal(brief.readVerdict(brief.current({}), "src/big.js", { offset: 600, limit: 30, capacity }), null, "lines the quote does not hold are read");
  assert.equal(brief.readVerdict(brief.current({}), "src/big.js", { offset: 425, limit: 10, capacity }), null, "a range straddling the cut is read");
  assert.equal(brief.readVerdict(brief.current({}), "src/big.js", { capacity }), null, "a whole read is not answered by part of a region");
  const v = brief.readVerdict(brief.current({}), "src/big.js", { offset: 405, limit: 10, capacity });
  assert.equal(v.permissionDecision, "deny", "a range the quote holds is still served from it");
  assert.match(v.permissionDecisionReason, /lines 431-800 not quoted; read them/);
});

test("the quote cap is counted in lines, not cut mid-line", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const q = brief.quoteOf([{ path: "f.js", line_start: 1, line_end: 200, text: long }]);
  assert.equal(q.complete, false);
  assert.ok(q.body.length <= brief.QUOTE_CHARS + 80);
  const [a, b] = q.spans[0];
  assert.equal(a, 1);
  assert.ok(q.body.includes(`line ${b - 1} `) && !q.body.includes(`line ${b} `), "the last carried line is whole and the next is absent");
  assert.equal(brief.covers([[1, 5], [6, 9]], 2, 9), true);
  assert.equal(brief.covers([[1, 5], [7, 9]], 2, 9), false);
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

test("the same words over a different file is a different search, not a duplicate", () => {
  brief.activate(REC());
  assert.equal(brief.searchVerdict(brief.current({}), "^export", { pathArg: "src/big.js" }), null);
  assert.equal(brief.searchVerdict(brief.current({}), "^export", { pathArg: "src/small.js" }), null, "a second file is a second question");
  assert.equal(brief.searchVerdict(brief.current({}), "^export", { glob: "test/*.js" }), null, "a glob is a third");
  const v = brief.searchVerdict(brief.current({}), "^export", { pathArg: "src/small.js" });
  assert.equal(v.permissionDecision, "deny", "the same file again is the duplicate");
  assert.match(v.permissionDecisionReason, /in src\/small\.js/);
  // a search of the whole tree is keyed to the whole tree, and repeats as one
  assert.equal(brief.searchVerdict(brief.current({}), "^export", {}), null);
  assert.equal(brief.searchVerdict(brief.current({}), "^export", {}).permissionDecision, "deny");
});

test("tableHits never builds a table it cannot find", () => {
  assert.deepEqual(brief.tableHits(["nothingmatcheshere"]), []);
});

// ── bash, which is how a session actually reads ──────────────────────────────

test("parseBash finds the one read or the one search, and nothing else", () => {
  assert.deepEqual(brief.parseBash("grep -rn 'refreshSession' src/"), { kind: "search", pattern: "refreshSession", pathArg: "src/", stdin: false });
  assert.deepEqual(brief.parseBash("rg -n --include '*.js' loginToken"), { kind: "search", pattern: "loginToken", pathArg: "", stdin: false });
  assert.deepEqual(brief.parseBash("grep -rln addClaudeHooks test/"), { kind: "search", pattern: "addClaudeHooks", pathArg: "test/", stdin: false }, "the search this guard wrongly denied on its first day");
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

// ── one identifier is the whole boundary of what an index may refuse ─────────
//
// Both of these were measured on this guard's first hour, against its own
// author. A declaration index answers "where is X declared" and nothing else,
// so it may only stand in for a search that asks exactly that.

test("a multi-term pattern is never answered from the index", () => {
  const v = brief.searchVerdict(null, "usage|process.argv|exitCode|loginToken", {});
  assert.equal(v, null, "one of four alternatives is a symbol name; the other three are not, and a quarter of an answer is a wrong one");
});

test("a single identifier still is", () => {
  assert.equal(brief.searchVerdict(null, "loginToken", {}).permissionDecision, "deny");
});

test("the shell's cwd scopes a search with no path argument", () => {
  assert.equal(brief.dirFilter("", "", path.join(root, "src", "finish", "vendor")), "src/finish/vendor/");
  assert.equal(brief.dirFilter("", "", root), "");
  assert.equal(brief.dirFilter("lib/", "", path.join(root, "src", "finish")), "src/finish/lib/");
  assert.equal(brief.dirFilter("src/finish/lib/", "", path.join(root, "src", "finish")), "src/finish/lib/", "an argument already under cwd is not doubled");
  assert.equal(brief.searchVerdict(null, "loginToken", { cwd: path.join(root, "src", "finish") }), null, "the declaration is in src/, and this search cannot reach it");
});

test("segments respects quotes, so an alternation is one search", () => {
  assert.deepEqual(brief.segments('grep -n "effect\\|GROUPS\\|groupOf" src/cli.js | head -20'),
    ['grep -n "effect\\|GROUPS\\|groupOf" src/cli.js', "head -20"]);
  assert.deepEqual(brief.segments("cat a.js && npm test"), ["cat a.js", "npm test"]);
  assert.deepEqual(brief.segments("echo 'a;b' ; ls"), ["echo 'a;b'", "ls"]);
  assert.deepEqual(brief.segments("git commit -m 'one || two'"), ["git commit -m 'one || two'"]);
});

test("an alternation through the shell is not a declaration lookup", () => {
  const seg = brief.parseBash('grep -n "effect\\|GROUPS\\|groupOf" src/cli.js');
  assert.equal(seg.kind, "search");
  assert.equal(seg.pattern, "effect\\|GROUPS\\|groupOf");
  assert.equal(brief.searchVerdict(null, seg.pattern, { pathArg: seg.pathArg }), null, "three terms, one of which is a symbol name, is not a lookup the index owns");
});

// ── one slot per session ────────────────────────────────────────────────────
//
// A single brief.json is wrong the moment two sessions share a checkout, which
// is the normal case here: `bb uptake` counts fifteen sessions on this tree.
// Session B's prompt overwrote session A's brief, A's guards refused to answer
// from a record belonging to B, and the whole benefit quietly stopped arriving.

test("two sessions keep their own brief", () => {
  const a = REC(); a.session_id = "SA"; a.problem = "task A";
  const b = REC(); b.session_id = "SB"; b.problem = "task B";
  brief.activate(a);
  brief.activate(b);
  assert.equal(brief.current({ sessionId: "SA" }).problem, "task A");
  assert.equal(brief.current({ sessionId: "SB" }).problem, "task B", "and B did not overwrite A");
});

test("a record with no session id is picked up by anyone, one with another's id is not", () => {
  fs.rmSync(brief.DIR(), { recursive: true, force: true });
  const g = REC(); g.session_id = ""; g.problem = "handed over from the command line";
  brief.activate(g);
  assert.equal(brief.current({ sessionId: "SC" }).problem, "handed over from the command line");
  const other = REC(); other.session_id = "SD";
  brief.activate(other);
  assert.equal(brief.current({ sessionId: "SC" }).problem, "handed over from the command line", "SD's record is not SC's to read");
});

test("with no session id the command line gets the newest brief anybody is working on", () => {
  fs.rmSync(brief.DIR(), { recursive: true, force: true });
  fs.rmSync(brief.GLOBAL(), { force: true });
  const old = REC(); old.session_id = "SE"; old.problem = "older"; old.at = new Date(Date.now() - 20 * 60000).toISOString();
  const now = REC(); now.session_id = "SF"; now.problem = "newer";
  brief.activate(old);
  brief.activate(now);
  assert.equal(brief.current({}).problem, "newer");
});

test("sweep drops the records of sessions that ended", () => {
  const stale = REC(); stale.session_id = "SG"; stale.at = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const live = REC(); live.session_id = "SH";
  brief.activate(stale);
  brief.activate(live);
  assert.equal(brief.sweep({ maxAgeMin: 60 }), 1);
  assert.ok(brief.current({ sessionId: "SH" }));
  assert.equal(brief.current({ sessionId: "SG" }), null);
});

test("a search that filters a pipe is never guarded", () => {
  // `npm test | grep fail` filters output that did not exist a moment ago.
  // Refusing it as a duplicate refuses to look at the new result — which this
  // guard did, to its own author, while running the suite that tests it.
  const seg = brief.parseBash("npm test 2>&1 | grep -E 'pass|fail'");
  assert.equal(seg.kind, "search");
  assert.equal(seg.stdin, true, "nothing precedes it in the pipeline but another command");
  assert.equal(brief.searchVerdict(null, seg.pattern, { stdin: seg.stdin }), null);

  const tree = brief.parseBash("grep -rn loginToken src/");
  assert.equal(tree.stdin, false, "a path argument makes it a tree search");
  assert.equal(brief.parseBash("grep -rn loginToken").stdin, false, "first in the pipeline is the tree, even with no path");

  // And the duplicate rule still holds for a real tree search.
  brief.activate(REC());
  brief.searchVerdict(brief.current({}), "someTreeSearchTerm", { pathArg: "src/" });
  const dup = brief.searchVerdict(brief.current({}), "someTreeSearchTerm", { pathArg: "src/" });
  assert.equal(dup.permissionDecision, "deny");
  assert.match(dup.permissionDecisionReason, /already ran in this session/);
});

// ── the log ─────────────────────────────────────────────────────────────────
// The active record is one per session, so a session that locates four tasks
// keeps only the fourth. The log is what `bb echos` learns a locator's aim
// from, and it has to keep the three that were overwritten.

test("every activation appends a row, where the active record keeps only the last", () => {
  const before = brief.logged({}).length;
  const a = brief.record({ problem: "first task", scope: ["src/a.js"] }, { sessionId: "L1" });
  const b = brief.record({ problem: "second task", scope: ["src/b.js", "src/c.js"] }, { sessionId: "L1" });
  brief.activate(a);
  brief.activate(b);
  const rows = brief.logged({});
  assert.equal(rows.length - before, 2, "two briefs, two rows");
  assert.deepEqual(rows.at(-2).scope, ["src/a.js"]);
  assert.deepEqual(rows.at(-1).scope, ["src/b.js", "src/c.js"]);
  // The active record is still one, and still the last one.
  assert.equal(brief.current({ sessionId: "L1" }).problem, "second task");
});

test("a brief that located nothing is not a sample and is not logged", () => {
  const before = brief.logged({}).length;
  brief.activate(brief.record({ problem: "located nothing", scope: [] }, { sessionId: "L2" }));
  assert.equal(brief.logged({}).length, before);
});

test("the log carries the scope and none of the quoted regions", () => {
  brief.activate(REC());
  const row = brief.logged({}).at(-1);
  assert.ok(Array.isArray(row.scope) && row.scope.length);
  assert.equal(row.anchors, undefined, "an anchor is a quote the guards need and the echo does not");
  assert.equal(row.seen, undefined);
  assert.ok(row.at && row.session_id === "S1");
});

test("rotateLog drops the oldest half rather than growing without a bound", () => {
  for (let i = 0; i < 12; i++) brief.activate(brief.record({ problem: `t${i}`, scope: ["src/a.js"] }, { sessionId: "L3" }));
  const n = brief.logged({}).length;
  const dropped = brief.rotateLog({ max: 6 });
  assert.ok(dropped > 0, "past the cap something is dropped");
  assert.equal(brief.logged({}).length, n - dropped);
  // The newest survive: what a locator did last is what its aim is now.
  assert.equal(brief.logged({}).at(-1).problem, "t11");
});

test("sweep clears expired session records and leaves the log alone", () => {
  // `sweep` deletes every `.json` in the brief directory that has aged out. The
  // log lives in the same directory and holds every sample the locator has ever
  // produced; losing it to a sweep would be silent and total.
  const before = brief.logged({}).length;
  assert.ok(before > 0);
  brief.sweep({ maxAgeMin: -1 });
  assert.equal(brief.logged({}).length, before);
});

test("taskArg: the suggested re-pinpoint command is one clean shell argument", () => {
  const raw = 'ensure to also include \n\n<pasted_content id="8842">\n A1. Let "cron" close $fixes the `gap`\n<\\pasted_content id="8842">';
  const a = brief.taskArg(raw);
  assert.equal(a, "ensure to also include A1. Let cron close fixes the gap");
  assert.doesNotMatch(a, /[\n"$`\\<>]/);
  const long = brief.taskArg("word ".repeat(40));
  assert.ok(long.length <= 80 && long.endsWith("word"));
});
