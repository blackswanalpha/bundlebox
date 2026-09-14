import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-bridge-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;
const bridge = await import("../src/bridge/index.js");
const scripts = await import("../src/scripts/index.js");
const store = await import("../src/core/store.js");
const { DEFAULTS } = await import("../src/core/config.js");

store.put("findings", [{ id: "f1", detector: "doc-links", severity: "low", status: "open", title: "dead link", path: "README.md", files: ["README.md"], detail: "README.md points at docs/gone.md" }]);
store.append("episodes", { id: "e1", kind: "stage", verb: "scan", stage: "scan", gear: "intake", run_id: "R1", rc: 0, seconds: 0.4, produced: 1, state: "ran", detail: {} });

test("draft writes the brief with its sections in order and a drafted call row", async () => {
  const r = await bridge.draft({ problem: "dead link in README.md", reason: "exhausted", gear: "intake", stage: "scan", runId: "R1" });
  assert.equal(r.rc, 0);
  assert.equal(r.state, "drafted");
  const text = fs.readFileSync(path.join(root, r.brief_file), "utf8");
  const heads = ["# Call: dead link in README.md", "## What memory recalls", "## Local evidence", "## What already ran, and what it got — do not repeat these", "## Done when"];
  const lines = text.split("\n");
  const at = heads.map((h) => lines.indexOf(h));
  assert.ok(at.every((i) => i >= 0), JSON.stringify(at));
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `${heads[i]} after ${heads[i - 1]}`);
  assert.equal(lines.filter((l) => /^#{1,2}\s/.test(l)).length, 5);   // exactly five top-level sections, whatever pinpoint nested
  assert.match(text, /\(none\)/);                          // no memory on this box
  assert.ok(["pinpoint", "findings"].includes(r.evidence_via), r.evidence_via);
  if (r.evidence_via === "findings") assert.match(text, /doc-links: dead link/);   // fallback found the named file
  assert.match(text, /`scan` \(scan\)/);                   // this run's episode
  assert.match(text, /```bash\n.+\n```/);                  // one acceptance command
  assert.equal(bridge.calls().find((c) => c.id === r.id).state, "drafted");
  assert.ok(fs.existsSync(path.join(root, ".bundlebox", "out", "bridge", r.id, "call.json")));
});

test("send refuses when the bridge is disabled (the default)", async () => {
  const d = await bridge.draft({ problem: "disabled test" });
  const r = await bridge.send(d.id, { run: true, spend: true });
  assert.equal(r.state, "refused");
  assert.match(r.why, /disabled/);
  assert.equal(bridge.calls().find((c) => c.id === d.id).state, "refused");
  // The block exists so every knob has a documented default in one place; the
  // one that matters is still off until somebody turns it on.
  assert.equal(DEFAULTS.bridge.enabled, false);
  assert.equal(DEFAULTS.bridge.window_guard, true);         // and a spend is gated on the window as well as the ceiling
});

test("send fails closed when the ceiling check throws, and without --run only drafts", async () => {
  const cfg = { ...DEFAULTS, bridge: { enabled: true, daily_budget_usd: 5 }, lanes: { ...DEFAULTS.lanes, agent: "file" } };
  const d = await bridge.draft({ problem: "ceiling test" });
  const dry = await bridge.send(d.id, { cfg, run: false, readUsage: () => { throw new Error("ledger torn"); } });
  assert.equal(dry.state, "drafted");
  assert.match(dry.why, /--run/);
  const r = await bridge.send(d.id, { cfg, run: true, spend: true, readUsage: () => { throw new Error("ledger torn"); } });
  assert.equal(r.state, "refused");
  assert.match(r.why, /budget check failed \(ledger torn\)/);
  // The ceiling counts only attributed rows: an unattributed row today does not spend the cap.
  const c = bridge.ceiling(cfg, () => [
    { session_id: "s", msg_id: "1", model: "claude-opus-5", input: 1e6, output: 1e6, ts: new Date().toISOString() },
    { session_id: "s", msg_id: "2", model: "claude-opus-5", input: 1e6, output: 1e6, ts: new Date().toISOString(), call_id: "x" },
  ]);
  assert.equal(c.ok, false);
  assert.ok(c.spent > 5 && c.spent < 200, String(c.spent));
  assert.equal(bridge.ceiling(cfg, () => []).ok, true);
});

test("send with the file adapter queues the call on disk; a paid adapter needs --spend", async () => {
  const cfg = { ...DEFAULTS, bridge: { enabled: true }, lanes: { ...DEFAULTS.lanes, agent: "file" } };
  const d = await bridge.draft({ problem: "queue test" });
  const q = await bridge.send(d.id, { cfg, run: true });
  assert.equal(q.state, "queued");
  const d2 = await bridge.draft({ problem: "spend test" });
  const paid = await bridge.send(d2.id, { cfg, run: true, agent: "claude" });
  assert.equal(paid.state, "refused");
  assert.match(paid.why, /--spend/);
});

test("scripts scan warns on a non-numeric @turns, counts untagged, and removes a deleted row", () => {
  const a = path.join(root, "scripts", "a.sh");
  const b = path.join(root, "scripts", "b.sh");
  fs.writeFileSync(a, "#!/bin/sh\n# @tag alpha\n# @title says hi\n# @turns lots\n# @needs scripts/b.sh, nonesuch-bin-xyz\n# @safe yes\necho hi\n");
  fs.writeFileSync(b, "#!/bin/sh\n# @tag beta\n# @title beta\n# @turns 3\necho b\n");
  fs.writeFileSync(path.join(root, "scripts", "plain.sh"), "#!/bin/sh\necho no tags\n");
  const r1 = scripts.scan();
  assert.equal(r1.tagged, 2);
  assert.equal(r1.untagged, 1);
  assert.ok(r1.warnings.some((w) => w.tag === "alpha" && /@turns is not a number/.test(w.warning)), JSON.stringify(r1.warnings));
  const alpha = store.get("scripts").find((s) => s.tag === "alpha");
  assert.equal(alpha.turns, null);
  assert.equal(alpha.turns_kind, "ESTIMATE");
  assert.deepEqual(alpha.needs, ["scripts/b.sh", "nonesuch-bin-xyz"]);
  assert.deepEqual(scripts.missing(alpha), ["binary missing: nonesuch-bin-xyz"]);
  const refused = scripts.run("alpha", { apply: true });
  assert.equal(refused.ran, false);
  assert.match(refused.why, /nonesuch-bin-xyz/);
  const dry = scripts.run("beta", {});
  assert.equal(dry.ran, false);
  assert.match(dry.why, /dry run/);
  fs.chmodSync(b, 0o755);
  const ran = scripts.run("beta", { apply: true });
  assert.equal(ran.rc, 0);
  assert.equal(ran.ran, true);
  const ep = store.rows("episodes").find((e) => e.id === ran.episode);
  assert.equal(ep.features.declared_turns, 3);
  assert.equal(ep.features.declared_turns_kind, "ESTIMATE");
  assert.equal(ep.turns_saved, 0);
  fs.unlinkSync(b);
  const r2 = scripts.scan();
  assert.deepEqual(r2.removed, ["scripts/b.sh"]);
  assert.equal(store.get("scripts").some((s) => s.tag === "beta"), false);
  assert.match(scripts.tableText(), /`alpha`/);
});
