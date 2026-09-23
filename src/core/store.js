// store.js — the factory's ledger. JSON documents for state that is replaced
// (findings, units, lanes) and append-only JSONL for state that accumulates
// (episodes, sessions, outcomes). No database process, no dependency; a cron
// worker reads what is on disk or it does not run.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { VAR, ROOT, ensureDirs } from "./paths.js";
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

/** Rows kept in findings.json. Past this the oldest CLOSED rows go — resolved
 *  and fixed findings are history, and the open ones are the work list.
 *
 *  A bound and not a policy of keeping everything, for the reason `record.js`
 *  bounds shapes.jsonl: on one workspace this document reached 165MB, in the
 *  directory every verb writes to, and it is a single JSON value that must be
 *  parsed WHOLE to answer `bb findings`. A rotation that keeps everything is a
 *  file somebody eventually deletes by hand. */
export const MAX_FINDINGS = 20000;

/** Hold the document to MAX_FINDINGS, oldest history first. Order is otherwise
 *  preserved, so a bounded write still diffs against the last one. */
export function bound(rows, max = MAX_FINDINGS) {
  if (rows.length <= max) return rows;
  const when = (f) => Date.parse(f.last_seen || f.first_seen || f.at || 0) || 0;
  const open = rows.filter((f) => f.status === "open");
  const closed = rows.filter((f) => f.status !== "open").sort((a, b) => when(b) - when(a));
  // Open findings are the work list and outlive any amount of history. Past the
  // cap on those alone, the newest win: an open finding nothing has re-seen in
  // twenty thousand rows is one the detectors stopped producing.
  const keep = new Set((open.length >= max ? open.sort((a, b) => when(b) - when(a)).slice(0, max) : [...open, ...closed.slice(0, max - open.length)]).map((f) => f.id));
  return rows.filter((f) => keep.has(f.id));
}

/** A cheap witness that a finding's files are as they were: size and mtime per
 *  path, hashed, never content. Recorded while the finding is open and compared
 *  when it closes, which is the whole difference between somebody fixing a
 *  finding and the file it was about going away.
 *
 *  size+mtime rather than a hash of the bytes because this runs over every open
 *  finding on every scan, and a read per file would move the scan into the
 *  detectors' cost class. A touch fools it, which is exactly why `acted_on`
 *  means "these files changed" and never "the change was a fix". */
export function witness(f, root = ROOT, stats = null) {
  const paths = [...new Set([f.path, ...(Array.isArray(f.files) ? f.files : [])].filter(Boolean).map(String))].sort();
  if (!paths.length) return "";
  const parts = [];
  let alive = 0;
  for (const p of paths) {
    let part = stats?.get(p);
    if (part === undefined) {
      try { const st = fs.statSync(path.join(root, p)); part = `${p}:${st.size}:${Math.round(st.mtimeMs)}`; }
      catch { part = null; }
      stats?.set(p, part);
    }
    if (part) { parts.push(part); alive += 1; } else parts.push(`${p}:gone`);
  }
  return alive ? sha1(parts.join("\n")).slice(0, 12) : "gone";
}

/** Why a finding stopped being open. `resolved` on its own cannot answer it:
 *  the detector going quiet is the same event whether the code was fixed, the
 *  file was deleted or a threshold moved underneath it. Anything that learns
 *  from closures needs the three kept apart, because a policy trained on
 *  "resolved" learns that deleting the file is the most reliable fix.
 *
 *  `unchanged` is the one worth reading twice: the files did not move and the
 *  detector stopped firing anyway, so what changed was the detector's own
 *  inputs — a bar, a median, a config — and no work was done at all. */
export const CLOSED_BY = ["acted_on", "vanished", "unchanged", "unknown"];
function closedBy(old, fresh) {
  if (fresh === "gone") return "vanished";
  if (!fresh || !old.witness) return "unknown";
  return old.witness === fresh ? "unchanged" : "acted_on";
}

// ── backfilling a closure git can still prove ───────────────────────────────
//
// `witness` only exists on rows written since it shipped, so every finding that
// closed before it has `closed_by: unknown` forever. Git can recover some of
// them, and it is worth being exact about WHICH, because the tempting version
// of this is wrong: "no commit touched the path in the window" does not mean
// nobody fixed it. Scans here run every thirty minutes and work sits in the
// working tree for hours, so 128 of 201 closure windows on this repo contain no
// commit at all. Labelling those `unchanged` would manufacture 128 negatives
// out of git's blind spot, and a policy fitted on them would learn that the
// findings people actually fix are the ones nobody touches.
//
// So the rule refuses more than it answers:
//
//   vanished   the path is gone from the tree. True whatever git saw.
//   acted_on   a commit in the window touched the path.
//   unchanged  the window HAS commits and none touched the path. Something was
//              being done and it was not this.
//   unknown    the window has no commits. Git cannot see a working tree, and
//              this is the case it cannot see.
const gitLog = (since, until, file) => {
  try {
    const args = ["log", "--format=%H", "--since", since, "--until", until];
    if (file) args.push("--", file);
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }   // no git, no history, a path git refuses: unknown, never a guess
};

/** What git can still prove about one closed finding, or null to leave it. */
export function provenClosure(f, { log = gitLog, exists = (p) => fs.existsSync(path.join(ROOT, p)) } = {}) {
  const p = f.path || (Array.isArray(f.files) ? f.files[0] : "");
  const since = f.last_seen, until = f.resolved_at;
  if (!p || !since || !until) return null;
  if (!exists(p)) return "vanished";
  if (!log(since, until, "")) return null;          // git saw nothing happen at all
  return log(since, until, p) ? "acted_on" : "unchanged";
};

/** Label the closures git can still prove. Rows it cannot settle are left
 *  exactly as they were: a missing label is a sample this box does not have,
 *  and inventing one is worse than not having it. */
export function backfillClosures(opts = {}) {
  const counts = { acted_on: 0, vanished: 0, unchanged: 0, left_unknown: 0, already: 0 };
  update("findings", (rows) => rows.map((f) => {
    if (f.status === "open") return f;
    if (f.closed_by && f.closed_by !== "unknown") { counts.already += 1; return f; }
    const got = provenClosure(f, opts);
    if (!got) { counts.left_unknown += 1; return f; }
    counts[got] += 1;
    return { ...f, closed_by: got, closed_by_from: "git" };
  }), []);
  return counts;
}

/** Keep a fitted promotion rule where every other per-repo factor lives, so
 *  `bb doctor` shows them together and a workspace that never calibrated runs
 *  on the shipped one. */
export function applyTriagePolicy(policy, fit = {}) {
  const p = path.join(VAR, "calibration.json");
  const cal = readJson(p, {}) || {};
  cal.triage = { policy, ...fit, calibrated_at: now() };
  writeJson(p, cal);
  return p;
}

/** Findings: keyed by a stable id so a re-scan updates rather than duplicates,
 *  and a finding that stopped appearing is closed rather than deleted. */
export function findingId(f) { return sha1(`${f.detector}|${f.path || ""}|${f.key || f.title}`).slice(0, 10); }
export function mergeFindings(fresh, { detectors }) {
  // One stat per path per merge: django's 8,764 findings name 761 files, and a
  // stat per finding per path was a third of a second.
  const stats = new Map();
  return update("findings", (prev) => mergeInto(prev, fresh, { detectors, mark: (f) => witness(f, ROOT, stats) }), []);
}

/** The merge itself, pure so it can be tested without a filesystem and reused
 *  by anything that already holds the lock. */
export function mergeInto(prev, fresh, { detectors, mark = () => "" }) {
  const seen = new Set();
  const out = [];
  const byId = new Map(prev.map((f) => [f.id, f]));
  for (const f of fresh) {
    const id = f.id || findingId(f);
    seen.add(id);
    const old = byId.get(id);
    out.push({ ...f, id, first_seen: old?.first_seen || now(), last_seen: now(), status: old?.status === "resolved" ? "open" : old?.status === "fixed" ? "fixed" : (old?.status || "open"), seen_count: (old?.seen_count || 0) + 1, witness: mark(f) });
  }
  for (const f of prev) {
    if (seen.has(f.id)) continue;
    if (detectors.has(f.detector) && f.status === "open") {
      const w = mark(f);
      out.push({ ...f, status: "resolved", resolved_at: now(), closed_by: closedBy(f, w), witness: w });
    }
    else out.push(f);
  }
  return bound(out);
}
export function openFindings() { return get("findings", []).filter((f) => f.status === "open"); }
