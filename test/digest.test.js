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

// One case per eraser. The lexer is a sequence of named erasers over one scan,
// and the only property each has to hold is the property the whole file turns
// on: erase what identifies an OCCURRENCE, keep what identifies the EVENT.
test("each eraser keeps the event and drops the occurrence", async () => {
  const { signature } = await import("../src/runbook/digest.js");
  const sig = (l) => signature(l);

  // timestamp — six digits and two separators, leading, optionally bracketed.
  assert.equal(sig("2026-01-02T03:04:05Z boom"), "boom");
  assert.equal(sig("[2026-01-02 03:04:05] boom"), "boom");
  // ...and a number the line is ABOUT is not a timestamp.
  assert.ok(sig("2026 boom").includes("boom"));

  // pid/tid — two 3-to-7 digit integers side by side at the head of a line.
  // The numeric eraser would reach the same TEXT for this input; what the
  // pid/tid rule buys is that it consumes them as a pair before the scan
  // starts, so a logcat header cannot be mistaken for a measurement and pick
  // up a unit from the level letter that follows it.
  assert.equal(sig("09-14 10:00:00.123  1234  5678 E tag: boom"), "# # E tag: boom");

  // quoted — long payloads go, short ones stay.
  assert.match(sig('msg "a very long payload string that must be erased"'), /msg "…"/);
  assert.equal(sig('msg "short"'), 'msg "short"');

  // hex literal — an address is never the fact.
  assert.equal(sig("at 0xdeadbeef"), "at X");

  // numeric — identity becomes X, a measurement keeps its unit.
  assert.equal(sig("id 550e8400-e29b-41d4-a716-446655440000"), "id X");
  assert.equal(sig("took 12.5s"), "took #s");
  assert.equal(sig("cpu 12.5%"), "cpu #%");
  assert.notEqual(sig("read 240ms"), sig("read 240"));

  // path — three segments or more is a location.
  assert.equal(sig("at /a/b/c/d.js"), "at P");
  assert.equal(sig("at /a/b"), "at /a/b");
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

// ── the admission check ─────────────────────────────────────────────────────
//
// `up` refusing a set is the one place the runbook says no, and the cost of
// getting it wrong is asymmetric. Refuse when it would have fit and a person
// passes --force and stops reading the check. Admit when it would not and the
// box swaps — every timing in every board afterwards is wrong, and the session
// that reads that board pays to investigate a product that is fine.
test("a ceiling is parsed, or it is absent — never zero by accident", async () => {
  const mem = await import("../src/runbook/memory.js");
  assert.equal(mem.bytes("1G"), 1024 ** 3);
  assert.equal(mem.bytes("512M"), 512 * 1024 ** 2);
  assert.equal(mem.bytes("1.5g"), Math.round(1.5 * 1024 ** 3));
  assert.equal(mem.bytes(2048), 2048);
  assert.equal(mem.bytes("  256m  "), 256 * 1024 ** 2);
  // A typo must read as "no ceiling declared", not as a ceiling of zero: zero
  // would admit anything and the check would be silently off.
  assert.equal(mem.bytes("1Gb!"), null);
  assert.equal(mem.bytes("lots"), null);
  assert.equal(mem.bytes(""), null);
  assert.equal(mem.bytes(0), null);
  assert.equal(mem.bytes(-1), null);
  assert.equal(mem.bytes(undefined), null);
});

test("admission sums ceilings against what is free, and names what had none", async () => {
  const mem = await import("../src/runbook/memory.js");
  const free = mem.available();
  assert.ok(free.bytes > 0 && free.via, "available memory is measured and says how");

  // Asking for more than exists, with the reserve on top, is refused and the
  // refusal says what it would have needed.
  const tooBig = mem.admit([{ id: "a", memory: `${Math.ceil(free.bytes / 1024 ** 3) + 64}G` }], [], { reserve: 1024 ** 3 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.why, /not enough memory/);
  assert.match(tooBig.why, /--force/);

  // A tiny ask fits, and `held` reports what is already running separately from
  // `ask`, because the two are never added into one number a reader can misread.
  const fits = mem.admit([{ id: "a", memory: "1M" }], [{ id: "b", memory: "8M" }], { reserve: 0 });
  assert.equal(fits.ok, true);
  assert.equal(fits.ask, 1024 ** 2);
  assert.equal(fits.held, 8 * 1024 ** 2);
  assert.equal(fits.why, "");

  // A row with no ceiling counts as zero and is NAMED, so the check reads as a
  // floor rather than as an answer.
  const partial = mem.admit([{ id: "a", memory: "1M" }, { id: "b" }], [], { reserve: 0 });
  assert.deepEqual(partial.undeclared, ["b"]);
  assert.equal(partial.ask, 1024 ** 2, "an undeclared ceiling adds nothing, it does not refuse everything");
});

test("the declared system is readable without touching the running one", async () => {
  const svc = await import("../src/runbook/services.js");
  // `all` is derived last and always means every declared service, so a row
  // that also names itself `all` cannot make the group list it twice.
  const g = svc.groups();
  assert.ok(Object.prototype.hasOwnProperty.call(g, "all"), "every workspace gets `all` free");
  for (const [name, ids] of Object.entries(g)) {
    assert.equal(ids.length, new Set(ids).size, `group ${name} lists a service twice`);
    for (const id of ids) assert.ok(svc.byId(id), `group ${name} names ${id}, which is not declared`);
  }
  assert.deepEqual(svc.groupOf("no-such-group-anywhere"), []);
});
