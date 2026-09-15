// digest.test.js — the kernel and the port must answer identically.
//
// Two normalisers would eventually disagree, and the one that drifted would be
// the one reporting that nothing changed since the last call. So every shape
// the digest claims to erase is asserted against BOTH engines on the same
// bytes, and the answers are compared field by field.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-digest-")));
process.env.BB_ROOT = root;
const logs = path.join(root, "logs");

const LINES = [
  "09-15 10:15:00.123 12345 12377 E ConvexClient: auth error for 550e8400-e29b-41d4-a716-446655440000",
  "09-15 10:15:01.456 12345 12377 E ConvexClient: auth error for 7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "09-15 10:15:02.001 12345 12377 W Davey! duration=240ms Flags=0x7fae21",
  "09-15 10:15:03.001 12345 12377 W Davey! duration=9ms Flags=0xbe11",
  "2026-09-15T10:15:04.000Z INFO  GET /api/v1/orders/9931 200 12ms",
  "2026-09-15T10:15:05.000Z INFO  GET /api/v1/orders/2 200 3ms",
  '2026-09-15T10:15:06.000Z ERROR payload="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" at /home/app/src/handlers/orders.js:88',
  "10:15:07 MissingPluginException(No implementation found for method a3f9c1d2e4b6)",
  "worker exited: EADDRINUSE 127.0.0.1:4400",
  "GET /health 200",
  "",
  "  ",
];

before(() => {
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(root, ".bundlebox", "runbook"), { recursive: true });
  fs.writeFileSync(path.join(logs, "app.log"), LINES.join("\n") + "\n");
  fs.writeFileSync(path.join(root, ".bundlebox", "runbook", "digest.json"), JSON.stringify([
    { id: "port-in-use", severity: "high", match: "EADDRINUSE", says: "the port is already held" },
    { id: "missing-plugin", severity: "medium", match: "MissingPluginException", says: "a platform channel is not registered" },
  ]));
});

const reset = () => { try { fs.unlinkSync(path.join(root, ".bundlebox", "var", "log-cursors.json")); } catch { /* first run */ } };

test("a signature erases identity and keeps the fact", async () => {
  const { signature } = await import("../src/runbook/digest.js");
  const a = signature(LINES[0]);
  const b = signature(LINES[1]);
  assert.equal(a, b, "two instances of one failure collapse to one row");
  assert.ok(/ConvexClient: auth error/.test(a), "the message is the fact and survives");
  assert.ok(!/550e8400|7c9e|10:15/.test(a));

  // The unit is part of the event: 240ms and 240MB are not the same row.
  assert.notEqual(signature("read 240ms"), signature("read 240MB"));
  // A digit inside a word is part of the word, not an identifier: erasing it
  // would make `http2 refused` and `http3 refused` one row.
  assert.equal(signature("connected to h2 backend"), "connected to h2 backend");
  // One path segment is usually the fact; three is a location.
  assert.equal(signature("GET /health 200"), "GET /health #");
});

test("a level is read from logcat's rank and from the words other runtimes print", async () => {
  const { levelOf } = await import("../src/runbook/digest.js");
  assert.equal(levelOf(LINES[0]), "E");
  assert.equal(levelOf(LINES[2]), "W");
  assert.equal(levelOf("2026-09-15T00:00:00Z ERROR boom"), "E");
  assert.equal(levelOf("plain progress line"), " ");
});

test("the kernel and the port return the same digest for the same bytes", async (t) => {
  // Imported here, not at the top: a static import runs before BB_ROOT is set,
  // and paths.js reads it once at load.
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary on this box");
  const { digest } = await import("../src/runbook/digest.js");
  reset();
  const k = digest(logs, { since: false, sample: true, engine: "auto" });
  reset();
  const j = digest(logs, { since: false, sample: true, engine: "js" });
  assert.equal(k.via, "kernel");
  assert.equal(j.via, "js");
  const strip = (r) => ({
    files: r.files.map(({ path: _p, ...f }) => f),
    buckets: r.buckets, high: r.high, totals: r.totals,
  });
  assert.deepEqual(strip(k), strip(j), "one normaliser, two implementations");
});

test("the second call reads only what arrived since the first", async () => {
  const { digest } = await import("../src/runbook/digest.js");
  reset();
  const first = digest(logs, { since: true });
  assert.ok(first.totals.bytes > 0);
  const quiet = digest(logs, { since: true });
  assert.equal(quiet.totals.bytes, 0, "nothing arrived, so nothing is read");
  assert.equal(quiet.totals.lines, 0);

  fs.appendFileSync(path.join(logs, "app.log"), "worker exited: EADDRINUSE 127.0.0.1:4401\n");
  const next = digest(logs, { since: true });
  assert.equal(next.totals.lines, 1, "only the new line");
  assert.ok(next.totals.bytes < 60, "and only the new bytes");
});

test("a truncated file is re-read from the top rather than reported as quiet", async () => {
  const { digest } = await import("../src/runbook/digest.js");
  const f = path.join(logs, "app.log");
  fs.writeFileSync(f, "restarted\n");
  const r = digest(logs, { since: true });
  const row = r.files.find((x) => x.file.endsWith("app.log"));
  assert.equal(row.rotated, true);
  assert.equal(row.from, 0);
  assert.equal(row.lines, 1);
});

test("a known failure arrives named, and a high one is a gate", async () => {
  const { digest } = await import("../src/runbook/digest.js");
  fs.writeFileSync(path.join(logs, "app.log"), LINES.join("\n") + "\n");
  reset();
  const r = digest(logs, { since: false });
  const ids = r.buckets.map((b) => b.id);
  assert.deepEqual(ids, ["port-in-use", "missing-plugin"], "high first");
  assert.equal(r.high, true, "`bb runbook logs` exits 1 on this, so it works as a gate");
  assert.equal(r.buckets[0].n, 1);
  assert.ok(r.buckets[0].says);
});

test("--level and --grep narrow the signatures and never the buckets", async () => {
  const { digest } = await import("../src/runbook/digest.js");
  reset();
  const errs = digest(logs, { since: false, level: "E" });
  assert.ok(errs.files[0].kept < errs.files[0].lines, "a filter keeps fewer lines than it read");
  assert.ok(errs.buckets.length, "a known failure that a filter hid is still a known failure that fired");

  reset();
  const grepped = digest(logs, { since: false, grep: "auth error" });
  assert.equal(grepped.files[0].kept, 2);
  assert.equal(grepped.files[0].distinct, 1);
});
