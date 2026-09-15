// store.js — the factory's ledger. JSON documents for state that is replaced
// (findings, units, lanes) and append-only JSONL for state that accumulates
// (episodes, sessions, outcomes). No database process, no dependency; a cron
// worker reads what is on disk or it does not run.
import fs from "node:fs";
import path from "node:path";
import { VAR, ensureDirs } from "./paths.js";
import { readJson, writeJson } from "./config.js";
import { now, sha1 } from "./util.js";

const doc = (name) => path.join(VAR, `${name}.json`);
const log = (name) => path.join(VAR, `${name}.jsonl`);
const lockFile = (name) => path.join(VAR, `${name}.lock`);

// ── the lock ────────────────────────────────────────────────────────────────
//
// `writeJson` is atomic per write: it writes a temp file and renames. That makes
// a reader never see half a document, and it does nothing at all for the case
// that actually loses work — READ, MODIFY, WRITE. Two verbs merging findings at
// once both read the same 254 rows, both add their own, and whichever renames
// second silently discards the other's. `bb cron` sweeping while a session runs
// `bb scan` is not an exotic schedule; it is the normal one.
//
// So: an exclusive-create lock file around the whole read-modify-write. `wx`
// fails if the file exists, which is the one filesystem primitive that is
// atomic across processes on every platform this runs on. A lock older than
// STALE is broken and taken, because a crashed process must not wedge the
// factory forever, and the pid in the file makes an abandoned one identifiable.
export const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 5000;

function acquire(name) {
  const f = lockFile(name);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(f, "wx");
      fs.writeSync(fd, `${process.pid} ${now()}\n`);
      fs.closeSync(fd);
      return f;
    } catch (e) {
      if (e.code !== "EEXIST") return null;     // no lock is better than no write
      let age = 0;
      try { age = Date.now() - fs.statSync(f).mtimeMs; } catch { age = Infinity; }
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(f); } catch { /* somebody else broke it first */ } continue; }
      if (Date.now() > deadline) return null;   // waited long enough; proceed unlocked rather than lose the work
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
const release = (f) => { if (f) try { fs.unlinkSync(f); } catch { /* already broken as stale */ } };

/** Read-modify-write one document under the lock. `fn` is handed the current
 *  value and returns the next one. This is the ONLY safe way to change a
 *  document two processes can both reach. */
export function update(name, fn, fallback = []) {
  ensureDirs();
  const l = acquire(name);
  try {
    const next = fn(readJson(doc(name), fallback));
    writeJson(doc(name), next);
    return next;
  } finally { release(l); }
}

export function get(name, fallback = []) { return readJson(doc(name), fallback); }
export function put(name, value) { ensureDirs(); writeJson(doc(name), value); return value; }
export function append(name, row) {
  ensureDirs();
  fs.appendFileSync(log(name), JSON.stringify({ at: now(), ...row }) + "\n");
  return row;
}
export function rows(name, { limit = 0 } = {}) {
  let text;
  try { text = fs.readFileSync(log(name), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn write is a skipped row, never a crash */ }
  }
  return limit ? out.slice(-limit) : out;
}

/** Findings: keyed by a stable id so a re-scan updates rather than duplicates,
 *  and a finding that stopped appearing is closed rather than deleted. */
export function findingId(f) { return sha1(`${f.detector}|${f.path || ""}|${f.key || f.title}`).slice(0, 10); }
export function mergeFindings(fresh, { detectors }) {
  return update("findings", (prev) => mergeInto(prev, fresh, { detectors }), []);
}

/** The merge itself, pure so it can be tested without a filesystem and reused
 *  by anything that already holds the lock. */
export function mergeInto(prev, fresh, { detectors }) {
  const seen = new Set();
  const out = [];
  const byId = new Map(prev.map((f) => [f.id, f]));
  for (const f of fresh) {
    const id = f.id || findingId(f);
    seen.add(id);
    const old = byId.get(id);
    out.push({ ...f, id, first_seen: old?.first_seen || now(), last_seen: now(), status: old?.status === "resolved" ? "open" : old?.status === "fixed" ? "fixed" : (old?.status || "open"), seen_count: (old?.seen_count || 0) + 1 });
  }
  for (const f of prev) {
    if (seen.has(f.id)) continue;
    if (detectors.has(f.detector) && f.status === "open") out.push({ ...f, status: "resolved", resolved_at: now() });
    else out.push(f);
  }
  return out;
}
export function openFindings() { return get("findings", []).filter((f) => f.status === "open"); }
