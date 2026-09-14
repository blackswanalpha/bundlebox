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
