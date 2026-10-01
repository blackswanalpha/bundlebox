// brief-content.test.js — what a brief may say. The Terminal-Bench 2.0 re-run
// got one bb_pinpoint answer: 600 tokens that located nothing, widened the
// task's one editable file to two, and told a crash fix to go and clean up
// comments. Each test pins one of those back.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-brief-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 }, wire: { auto_init: false } }));
w("user.cpp", "int user_main() { return 0; }\n");
w("main.cpp", "int main() { return user_main(); }\n");
w("src/session.js", "export function refreshToken(s) {\n  return s.token;\n}\n");
w("src/store.js", "export function saveSession(s) {\n  try { return s; } catch { return null; }\n}\n");
const finding = (id, detector, title, file) => ({ id, detector, severity: "medium", status: "open", title, files: [file], path: file });
w(".bundlebox/var/findings.json", JSON.stringify([
  finding("f1", "oversight:vibe-coded", "`src/session.js`: 4.73 marks per 100 code lines", "src/session.js"),
  finding("f2", "swallowed-errors", "catch block returns null without logging", "src/session.js"),
  finding("f3", "duplicate-blocks", "refreshToken body repeats in two files", "src/session.js"),
]));

const pinpoint = await import("../src/pinpoint/index.js");
const brief = await import("../src/wire/brief.js");

test("G18: the task's own 'only' and 'do not modify' bound the scope; held files are named, not offered", async () => {
  const b = await pinpoint.build("It crashes in release. You shall not modify any other existing files in the system\nexcept for `/tmp/x/user.cpp` or `user.cpp`.", { files: ["user.cpp", "main.cpp"] });
  assert.deepEqual(b.scope, ["user.cpp"]);
  assert.deepEqual(b.held, ["main.cpp"]);
  assert.ok(!b.candidates.some((c) => c.file === "main.cpp"), "a held file is not a candidate");
  const k = await pinpoint.build("fix refreshToken in src/session.js so an expired session is refused. Do not modify `src/store.js`.");
  assert.ok(k.scope.includes("src/session.js"));
  assert.ok(!k.scope.includes("src/store.js"));
});

test("G18: bounds reads the phrasings task statements use and ignores the ones that are not about editing", () => {
  assert.deepEqual(pinpoint.bounds("Do not modify `/app/a.ics`, `/app/b.ics`, or `/app/c.ics`.").keepOut, ["/app/a.ics", "/app/b.ics", "/app/c.ics"]);
  assert.deepEqual(pinpoint.bounds("In doing so, the only edits you may make are to input.tex").only, ["input.tex"]);
  assert.deepEqual(pinpoint.bounds("The following files are read-only and must NOT be modified: `x/types.py`, `x/DESIGN.md`").keepOut, ["x/types.py", "x/DESIGN.md"]);
  assert.deepEqual(pinpoint.bounds("Do not remove, restore, or replace the shim in `megatron_parallel.py`"), { only: [], keepOut: [], create: [] }, "the shim is protected, not the file");
  assert.deepEqual(pinpoint.bounds("Don't modify the tests, fix src/foo.py"), { only: [], keepOut: [], create: [] });
  assert.deepEqual(pinpoint.bounds("Use /app/packet as the only source of rules; API.md lists the services"), { only: [], keepOut: [], create: [] });
  assert.deepEqual(pinpoint.bounds("Write a file eval.scm that is a metacircular evaluator for interp.py").create, ["eval.scm", "interp.py"], "the tree decides which one is new");
  assert.deepEqual(pinpoint.bounds("create a /app/report.jsonl file in /app folder. Format: {\"file_path\": \"/app/example.cpp\"}").create, ["/app/report.jsonl"]);
  assert.deepEqual(pinpoint.bounds("Do not write to out.txt").create, [], "a negated write makes nothing");
  assert.deepEqual(pinpoint.bounds("Call it HeadlessTerminal and put it in a file called `/app/headless_terminal.py`").create, ["/app/headless_terminal.py"]);
  assert.deepEqual(pinpoint.bounds("Write the answer, e.g. 42, to /app/answer.txt and email alice@example.com").create, ["/app/answer.txt"], "not e.g, not an address");
  assert.deepEqual(pinpoint.bounds("Save <name>_pb2.py beside it and match with re.findall").create, [], "a template or an attribute is not a file");
});

test("G21: a file the task says to create joins the scope, marked new, and adds nothing on its own", async () => {
  const b = await pinpoint.build("fix refreshToken in src/session.js and write the expiry report to reports/expiry.json");
  assert.ok(b.scope.includes("reports/expiry.json"), b.scope.join(", "));
  assert.deepEqual(b.creates, ["reports/expiry.json"]);
  assert.match(b.prompt, /`reports\/expiry\.json` \(new: the task says to create it\)/);
  const rec = brief.record(b);
  assert.match(brief.band(rec), /reports\/expiry\.json \(new\)/);
  const existing = await pinpoint.build("write the refreshToken fix into src/session.js");
  assert.deepEqual(existing.creates, [], "a file the tree holds is not new");
});

test("G17/G20: a locate that adds nothing to the named files is two lines, and says so", async () => {
  const b = await pinpoint.build("Program crashes in release but not debug; fix in /tmp/x/user.cpp only", { files: ["user.cpp", "main.cpp"] });
  assert.equal(b.adds, false);
  assert.match(b.prompt, /found nothing beyond the files named/);
  assert.ok(b.prompt.length < 600, `short, got ${b.prompt.length} chars`);
  assert.ok(!/Edit only the files under Scope/.test(b.prompt), "no rulebook around an empty answer");
  const hit = await pinpoint.build("fix refreshToken in src/session.js so an expired session is refused");
  assert.equal(hit.adds, true);
  assert.match(hit.prompt, /## Where — located/);
});

test("G19: hygiene findings on a scoped file stay out unless the task is about them; faults stay in", async () => {
  const b = await pinpoint.build("fix refreshToken in src/session.js so an expired session is refused");
  const ids = b.evidence.map((e) => e.id);
  assert.ok(ids.includes("f2"), "a swallowed error on the file is evidence");
  assert.ok(!ids.includes("f1"), "a style score is not");
  assert.ok(ids.includes("f3"), "a hygiene finding that names the task's own symbol still rides along");
});
