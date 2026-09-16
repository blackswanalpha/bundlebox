// env.test.js — is the environment set up, and does a fresh workspace say so?
//
// The gap this closes: `bb init` wrote a config file and stopped. A fresh
// workspace then had no tables, no index, no findings and no page, and nothing
// reported it — the first session simply searched the tree, which is the exact
// cost the box exists to remove.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-env-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", type: "module" }));

const env = await import("../src/env.js");

test("a bare workspace reports every artefact missing, and names the verb for each", () => {
  const r = env.report();
  assert.equal(r.present, 0);
  assert.equal(r.complete, false);
  assert.equal(r.missing.length, r.total);
  for (const row of r.rows) {
    assert.ok(row.what && row.verb, `${row.id} has no description or verb`);
    assert.ok(row.file.startsWith(".bundlebox"), `${row.id} points outside .bundlebox: ${row.file}`);
  }
});

test("commandcenter is one of the artefacts a complete environment holds", () => {
  const ids = env.ROWS.map((r) => r.id);
  assert.ok(ids.includes("commandcenter"), ids.join(","));
  const cc = env.ROWS.find((r) => r.id === "commandcenter");
  assert.match(cc.path(), /\.bundlebox[/\\]out[/\\]commandcenter[/\\]index\.html$/);
  assert.equal(cc.gear, "watch", "the gear that rebuilds it must be named, or a missing page has no fix");
});

test("every row names a gear that exists, or a verb instead", async () => {
  const { GEARS } = await import("../src/pipeline/gears.js");
  const names = new Set(GEARS.map((g) => g.name));
  for (const r of env.ROWS) {
    if (!r.gear) continue;
    assert.ok(names.has(r.gear), `${r.id} names gear \`${r.gear}\`, which is not declared`);
  }
});

test("the bootstrap gear brings up what a session reads, and never folds a transcript", async () => {
  const { GEARS } = await import("../src/pipeline/gears.js");
  const boot = GEARS.find((g) => g.name === env.BOOTSTRAP);
  assert.ok(boot, "bootstrap is not declared");
  const chain = boot.chain.map((c) => c.gear);
  assert.deepEqual(chain, ["intake", "orient", "buckmaster", "watch"]);
  assert.ok(!chain.includes("measure"), "a workspace being bootstrapped has no transcripts to fold");
});

test("an artefact appearing on disk flips its row", () => {
  const tables = env.ROWS.find((r) => r.id === "tables");
  fs.mkdirSync(path.dirname(tables.path()), { recursive: true });
  fs.writeFileSync(tables.path(), "# tables\n");
  const r = env.report();
  assert.equal(r.present, 1);
  assert.ok(!r.missing.includes("tables"));
  assert.ok(r.rows.find((x) => x.id === "tables").bytes > 0);
});

test("the cron tick rebuilds the page, which it used to leave stale", async () => {
  const { GEARS } = await import("../src/pipeline/gears.js");
  const factory = GEARS.find((g) => g.name === "factory");
  assert.ok(factory.chain.map((c) => c.gear).includes("watch"), "the tick folded the ledger and rebuilt nothing");
  const watch = GEARS.find((g) => g.name === "watch");
  assert.ok(watch.stages.some((s) => s.verb === "commandcenter"), "watch is the gear that rebuilds the page");
});

test("nothing on the unattended tick can spend", async () => {
  const cron = await import("../src/cron.js");
  assert.deepEqual(await cron.unsafeVerbs("factory"), [], "a cron line must not be able to say --apply to something that costs money");
  assert.deepEqual(await cron.unsafeVerbs(env.BOOTSTRAP), []);
});

test("a row no gear may build is reported apart from one that is missing", () => {
  const r = env.report();
  assert.ok(r.by_hand.some((h) => h.id === "memory"), "the janitor writes files a person wrote, so no tick gets to run it");
  assert.ok(!r.buildable.includes("memory"), "`bb env up --apply` must not promise to build it");
  assert.ok(r.buildable.includes("tables") || !r.missing.includes("tables"));
  for (const h of r.by_hand) assert.ok(h.by, `${h.id} says nothing about where it comes from`);
});

test("every row names a verb that exists and is spelled the way `bb help` spells it", async () => {
  // `bb janitor --apply` was the first answer for the memory row, and it is
  // read-only — it prints "`bb janitor compile` to write the window". A
  // checklist naming a command that does not produce the row it is named
  // against is worse than a row with no command at all.
  const { VERBS } = await import("../src/cli.js").catch(() => ({ VERBS: null }));
  for (const r of env.ROWS) {
    const m = /^bb ([a-z]+)/.exec(r.verb);
    assert.ok(m, `${r.id}: verb \`${r.verb}\` does not start with \`bb <verb>\``);
    if (VERBS) assert.ok(VERBS.some?.((v) => (Array.isArray(v) ? v[0] : v) === m[1]), `${r.id} names \`bb ${m[1]}\`, which is not a verb`);
  }
  const memory = env.ROWS.find((r) => r.id === "memory");
  assert.equal(memory.verb, "bb janitor compile", "the writing sub-verb, not the read-only bare verb");
  assert.match(memory.by, /bb janitor compile/);
});
