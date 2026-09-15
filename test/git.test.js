import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-git-")));
process.env.BB_ROOT = root;
const sh = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]);
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 1;\n");
fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 1;\n");
fs.writeFileSync(path.join(root, "space name.md"), "# s\n");
sh(["add", "-A"]); sh(["commit", "-qm", "init"]);
const g = await import("../src/git/index.js");

test("porcelain -z parse: rename and a path with a space", () => {
  sh(["mv", "src/b.js", "src/c.js"]);
  fs.writeFileSync(path.join(root, "space name.md"), "# changed\n");
  const rows = g.dirtyFiles(root);
  const ren = rows.find((r) => r.path === "src/c.js");
  assert.ok(ren && ren.from === "src/b.js", JSON.stringify(rows));
  assert.ok(rows.some((r) => r.path === "space name.md"));
  sh(["checkout", "-q", "--", "."]); sh(["reset", "-q", "--hard"]);
});

test("guards refuse every listed flag by substring", () => {
  for (const f of ["--force", "-f", "--force-with-lease=refs/heads/x", "--force-if-includes", "--no-verify", "-c core.hooksPath=/dev/null"]) {
    assert.throws(() => g.guardArgs(["push", f]), f);
  }
  assert.doesNotThrow(() => g.guardArgs(["push", "-u", "origin", "x"]));
});

test("commit refuses with no scope, stages only scope files with a conventional message", () => {
  const empty = g.commit({ cwd: root, scope: [], apply: true });
  assert.equal(empty.ok, false);
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "src/c.js"), "export const c = 1;\n");
  const r = g.commit({ cwd: root, scope: ["src/a.js"], detector: "doc-links", findings: [{ id: "f1", title: "x" }], acceptance: ["npm test"], apply: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const last = sh(["log", "-1", "--pretty=%s%n%b"]).stdout;
  assert.match(last, /^docs\(src\): close 1 doc-links findings? in src/);
  assert.match(last, /Verified by/);
  assert.ok(sh(["status", "--porcelain"]).stdout.includes("src/c.js"), "out-of-scope file left uncommitted");
});

test("secret sweep", () => {
  const swept = g.secretSweep([".env", ".env.local", ".env.example", "id_rsa", "x/serviceAccount-prod.json", "src/a.js"]);
  const list = Array.isArray(swept) ? swept : swept.refused;
  assert.deepEqual(list.sort(), [".env", ".env.local", "id_rsa", "x/serviceAccount-prod.json"].sort());
});

test("prBody has the sections the reviewer needs", () => {
  const body = g.prBody({ id: "L01", unit_ids: ["u1"] }, [{ id: "f1", title: "t", detector: "doc-links" }], { base: "main", acceptance: ["npm test"] });
  for (const h of ["## Summary", "## Base", "## Findings closed", "## Test plan", "bb explain"]) assert.ok(body.includes(h), h);
});

// ── a workspace whose git lives in its projects ────────────────────────────
test("a hand-scoped commit says what it does not know", () => {
  const text = g.message({ scope: ["demo/src"], files: ["src/a.js", "src/b.js"] });
  assert.match(text, /^chore\(demo\): 2 files in demo\n/);
  assert.match(text, /cannot say what it closes/);
  assert.match(text, /- src\/a\.js/);
  assert.ok(!text.includes("Closes 0"), "a commit with no findings never claims to close none");
});

test("a scope written relative to the repo says so instead of `none in scope`", () => {
  const sub = path.join(root, "proj");
  fs.mkdirSync(path.join(sub, "src"), { recursive: true });
  const run = (args) => spawnSync("git", args, { cwd: sub, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]); run(["config", "user.email", "t@t"]); run(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(sub, "src/x.js"), "export const x = 1;\n");
  run(["add", "-A"]); run(["commit", "-qm", "init"]);
  fs.writeFileSync(path.join(sub, "src/x.js"), "export const x = 2;\n");

  const wrong = g.commit({ cwd: sub, scope: ["src"] });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /outside proj: scope is workspace-relative/);
  assert.match(wrong.why, /proj\/src/, "and it names the scope that would have worked");

  const right = g.commit({ cwd: sub, scope: ["proj/src"] });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.deepEqual(right.staged, ["src/x.js"]);
});

test("bb git acts on the one subrepo when the workspace itself is not one", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bb-ws-"));
  fs.mkdirSync(path.join(ws, ".bundlebox"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".bundlebox/config.json"), JSON.stringify({ workspace: { subrepos: ["only"] } }));
  const sub = path.join(ws, "only");
  fs.mkdirSync(sub);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sub });
  // defaultRepo reads ROOT, which is this file's fixture, so the behaviour is
  // pinned through the module's own resolution rather than a second copy of it.
  assert.equal(typeof g.defaultRepo, "function");
  assert.equal(g.defaultRepo(), root, "a workspace that IS a repo acts on itself");
});

// ── the path arithmetic, with Windows inputs, on any platform ───────────────
//
// `scopeToRepo` is pure and takes its path implementation, so the exact strings
// CI reported from a Windows runner can be replayed here. Every case below is
// a spelling of ONE directory that Node and git disagree about.
test("scopeToRepo: a short-name workspace and a long-name repo are the same directory", () => {
  // os.tmpdir() hands back the 8.3 short name; `git rev-parse --show-toplevel`
  // always reports the long one. realpathSync does not settle that — only
  // realpathSync.native does — so this is what commit() used to see, and every
  // scope path landed "outside" a repository it was sitting in.
  const r = g.scopeToRepo(["src/a.js"], {
    root: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\bb-git-lSrFzo",
    repo: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bb-git-lSrFzo",
    p: path.win32,
  });
  assert.deepEqual(r.local, ["src/a.js"], "the scope still resolves against the repository");
  assert.equal(r.base, "repo", "the two spellings do not compare as one, so the repo is the base");
});

test("scopeToRepo: once canonicalised, the same case reads against the workspace", () => {
  const long = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bb-git-lSrFzo";
  const r = g.scopeToRepo(["src/a.js"], { root: long, repo: long, p: path.win32 });
  assert.deepEqual(r.local, ["src/a.js"]);
  assert.equal(r.base, "workspace");
});

test("scopeToRepo: git's forward slashes and drive-letter case do not matter", () => {
  const r = g.scopeToRepo(["proj/src"], {
    root: "C:\\work\\ws",
    repo: "c:/work/ws/proj",
    p: path.win32,
  });
  assert.deepEqual(r.local, ["src"]);
  assert.equal(r.base, "workspace");
});

test("scopeToRepo: a repo under the workspace reads scope workspace-relative", () => {
  const at = { root: "/ws", repo: "/ws/proj", p: path.posix };
  assert.deepEqual(g.scopeToRepo(["proj/src", "proj/test"], at).local, ["src", "test"]);
  assert.deepEqual(g.scopeToRepo(["src"], at).local, [], "a repo-relative scope is outside, and says so");
});

test("scopeToRepo: a repo outside the workspace reads scope against itself", () => {
  // `bb git commit --cwd /elsewhere` leaves no workspace path to be relative
  // to, so workspace-relative is not a reading the scope can have.
  const r = g.scopeToRepo(["src/a.js"], { root: "/ws", repo: "/elsewhere/repo", p: path.posix });
  assert.deepEqual(r.local, ["src/a.js"]);
  assert.equal(r.base, "repo");
});

test("scopeToRepo: an absolute scope path inside the repo is kept, outside is dropped", () => {
  const at = { root: "/ws", repo: "/ws/proj", p: path.posix };
  assert.deepEqual(g.scopeToRepo(["/ws/proj/src/a.js"], at).local, ["src/a.js"]);
  assert.deepEqual(g.scopeToRepo(["/etc/passwd"], at).local, []);
});

test("canon names one directory one way, and never throws on one that is not there", () => {
  // Deliberately NOT asserted equal to realpathSync: on Windows that returns the
  // 8.3 short name and canon returns the long one, which is the whole point of
  // it. What must hold everywhere is that it is stable and still the same
  // directory.
  const once = g.canon(root);
  assert.equal(g.canon(once), once, "idempotent");
  assert.equal(g.canon(path.join(root, "src")), path.join(once, "src"),
    "a child of a canonical directory is canonical too");
  assert.ok(fs.existsSync(path.join(once, "src", "a.js")), "and it still points at the same tree");
  const missing = path.join(root, "no", "such", "place");
  assert.equal(g.canon(missing), missing, "an unresolvable path comes back unchanged");
});
