// scan.test.js — the verbs over a small fixture: scan merges into the store,
// a second scan says nothing new, findings/explain read it, fix dry-runs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-scan-")));
process.env.BB_ROOT = root;
const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

before(() => {
  w("package.json", JSON.stringify({ name: "fx", type: "module", dependencies: {} }));
  w("README.md", "# fx\n\nSee [gone](docs/gone.md) and `lib/util.js`.\n");
  w("src/util.js", "export const u = 1;\n");
  w("src/index.js", "import { u } from './util.js';\nexport default u;\n");
  w("src/bad.js", `export const k = "${"AKIA" + "ZZZZZZZZZZZZZZZZ"}";\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("add", "."); git("commit", "-qm", "init");
});

async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { return { rc: await fn(), text: lines.join("\n") }; } finally { console.log = orig; }
}

test("scan: merges into the store and prints a per-detector table", async () => {
  const { commands } = await import("../src/scan.js");
  const store = await import("../src/core/store.js");
  const { rc, text } = await capture(() => commands.scan.run({ _: [], flags: {} }));
  assert.equal(rc, 0);
  assert.match(text, /detector\s+open\s+worst\s+ms/);
  assert.match(text, /secret-scan\s+1\s+critical/);
  const open = store.openFindings();
  assert.ok(open.length >= 2);
  assert.ok(open.every((f) => f.id && f.first_seen && f.seen_count === 1));
  assert.ok(store.get("scan", null)?.ran?.length);
});

test("scan again: nothing new one-liner; --json emits one object", async () => {
  const { commands } = await import("../src/scan.js");
  const { setMode } = await import("../src/core/log.js");
  const again = await capture(() => commands.scan.run({ _: [], flags: {} }));
  assert.match(again.text, /nothing new since the last scan/);
  setMode({ json: true });
  const j = await capture(() => commands.scan.run({ _: [], flags: { json: true } }));
  setMode({});
  const obj = JSON.parse(j.text);
  assert.ok(Array.isArray(obj.ran) && obj.open >= 2);
});

test("scan --only rejects an unknown detector", async () => {
  const { commands } = await import("../src/scan.js");
  const r = await capture(() => commands.scan.run({ _: [], flags: { only: "nope" } }));
  assert.equal(r.rc, 2);
});

test("findings filters and explain prints the derivation", async () => {
  const { commands } = await import("../src/scan.js");
  const store = await import("../src/core/store.js");
  const sec = await capture(() => commands.findings.run({ _: [], flags: { detector: "secret-scan" } }));
  assert.match(sec.text, /secret-scan/); assert.doesNotMatch(sec.text, /doc-links/);
  const high = await capture(() => commands.findings.run({ _: [], flags: { severity: "high" } }));
  assert.match(high.text, /critical/); assert.doesNotMatch(high.text, /\blow\b/);
  const lim = await capture(() => commands.findings.run({ _: [], flags: { limit: 1 } }));
  assert.match(lim.text, /more; --limit/);
  const id = store.openFindings().find((f) => f.detector === "secret-scan").id;
  const ex = await capture(() => commands.explain.run({ _: [id], flags: {} }));
  assert.equal(ex.rc, 0);
  assert.match(ex.text, /triage: PROMOTE/); assert.match(ex.text, /critical-always/); assert.match(ex.text, /"masked"/);
  const miss = await capture(() => commands.explain.run({ _: ["zzz"], flags: {} }));
  assert.equal(miss.rc, 2);
});

test("fix: dry run writes a patch, declines the deleted link, does not touch the doc; --apply marks fixed", async () => {
  const { commands } = await import("../src/scan.js");
  const store = await import("../src/core/store.js");
  const before = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const dry = await capture(() => commands.fix.run({ _: [], flags: {} }));
  assert.match(dry.text, /fix-doc-links\s+would change/);
  assert.match(dry.text, /declined README\.md:3: nothing named gone\.md/);
  assert.match(dry.text, /dry run; re-run with --apply/);
  assert.ok(fs.existsSync(path.join(root, ".bundlebox/var/patches/fix-doc-links-readme-md.patch")));
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), before);
  const wet = await capture(() => commands.fix.run({ _: [], flags: { apply: true } }));
  assert.match(wet.text, /APPLIED/);
  assert.ok(fs.readFileSync(path.join(root, "README.md"), "utf8").includes("`src/util.js`"));
  const f = store.get("findings", []).find((x) => x.detector === "doc-links");
  assert.equal(f.status, "fixed"); assert.equal(f.fixed_by, "fix-doc-links");
  assert.ok(store.rows("episodes").some((e) => e.kind === "actuator"));
});

// ── why a finding closed ────────────────────────────────────────────────────
// `resolved` is the same event whether the code was fixed, the file was deleted
// or a bar moved underneath the detector. These pin the three apart, because a
// policy that learns from closures and cannot tell them apart learns that
// deleting the file is the most reliable fix there is.

test("a closed finding records whether anything was actually done", async () => {
  const store = await import("../src/core/store.js");
  const det = new Set(["d"]);
  const f = (id, p) => ({ id, detector: "d", path: p, title: id, status: "open" });
  w("acted.js", "one\n");
  w("still.js", "one\n");
  w("goes.js", "one\n");

  const open = store.mergeInto([], [f("a", "acted.js"), f("u", "still.js"), f("v", "goes.js")],
    { detectors: det, mark: store.witness });
  assert.ok(open.every((x) => x.witness), "an open finding carries its witness");

  fs.writeFileSync(path.join(root, "acted.js"), "one\ntwo\n");   // edited
  fs.rmSync(path.join(root, "goes.js"));                         // deleted
  const closed = store.mergeInto(open, [], { detectors: det, mark: store.witness });
  const by = Object.fromEntries(closed.map((x) => [x.id, x.closed_by]));
  assert.equal(by.a, "acted_on");
  assert.equal(by.v, "vanished");
  assert.equal(by.u, "unchanged");   // the detector's own inputs moved, not the file
  assert.ok(closed.every((x) => x.status === "resolved" && x.resolved_at));
});

test("a merge with no filesystem stays pure and says unknown rather than guessing", async () => {
  const store = await import("../src/core/store.js");
  const det = new Set(["d"]);
  const open = store.mergeInto([], [{ id: "p", detector: "d", path: "x.js", title: "p", status: "open" }], { detectors: det });
  const closed = store.mergeInto(open, [], { detectors: det });
  assert.equal(closed[0].closed_by, "unknown");
});

test("a finding that comes back is open again and carries no stale closure", async () => {
  const store = await import("../src/core/store.js");
  const det = new Set(["d"]);
  const row = { id: "r", detector: "d", path: "still.js", title: "r", status: "open" };
  const closed = store.mergeInto(store.mergeInto([], [row], { detectors: det, mark: store.witness }), [],
    { detectors: det, mark: store.witness });
  assert.equal(closed[0].status, "resolved");
  const again = store.mergeInto(closed, [row], { detectors: det, mark: store.witness });
  assert.equal(again[0].status, "open");
  assert.equal(again[0].closed_by, undefined);
});
