// git/repo.js — the floor every other git module stands on: which directory is
// a checkout, which flags are refused before a command is built, and what the
// working tree currently says.
//
// It is its own file because the rules here are the ones that must hold for
// EVERY git call in the factory. A guard that lives inside the module that
// commits is a guard the module that pushes can forget.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { run, which, gitOk } from "../core/exec.js";
import { ROOT, rel } from "../core/paths.js";
import { out } from "../core/log.js";
import { now } from "../core/util.js";

// Substring, on purpose: `--force-with-lease=main` and `--force-if-includes`
// both contain `--force`, and `-c core.hooksPath=/dev/null` arrives as one or
// two argv entries. The short `-f` is matched as a flag cluster (`-f`, `-fu`)
// rather than as a substring so `--format` and file names stay legal.
export const REFUSED_SUBSTRINGS = ["--no-verify", "--force", "--force-with-lease", "--force-if-includes", "core.hooksPath"];
const SHORT_FORCE = /^-[a-zA-Z]*f[a-zA-Z]*$/;

/** Throws on any argument that would bypass a hook or rewrite a remote. */
export function guardArgs(args) {
  const joined = (args || []).map(String);
  const bad = joined.filter((a) => REFUSED_SUBSTRINGS.some((s) => a.includes(s)) || SHORT_FORCE.test(a));
  if (bad.length) throw new Error(`refused git flags ${JSON.stringify(bad)}: hooks are the gate, fix the failure instead`);
  return joined;
}

/** The top level of the checkout that contains `cwd`. Throws outside a repo:
 *  a git command that lands in a plain directory either does nothing or does
 *  something to the wrong tree. */
export function repoDir(cwd = ROOT) {
  const d = path.resolve(cwd || ROOT);
  if (!fs.existsSync(d)) throw new Error(`not a directory: ${d}`);
  if (!gitOk(d)) throw new Error(`not a git repository: ${rel(d)}`);
  const r = run(["git", "rev-parse", "--show-toplevel"], { cwd: d, timeout: 30000 });
  return r.rc === 0 && r.out.trim() ? r.out.trim() : d;
}

/** Every git call in this module goes through here, so the guard is not a caller's choice. */
export function gitx(args, cwd, { timeout = 120000 } = {}) {
  return run(["git", ...guardArgs(args)], { cwd, timeout });
}

// Basename rules. `.env.example` is the one documented exception: it is the
// template a secret file is copied from, and has no values in it.
const SECRET_NAME = [
  (b) => b.startsWith(".env") && b !== ".env.example",
  (b) => /^client_secret.*\.json$/.test(b),
  (b) => /\.(pem|p12|keystore|jks|key)$/.test(b),
  (b) => b.startsWith("id_rsa"),
  (b) => b === ".npmrc",
  (b) => /^serviceAccount.*\.json$/i.test(b),
  (b) => b === "credentials.json",
];
/** Paths that must never be staged, sorted. */
export function secretSweep(paths) {
  return [...new Set((paths || []).map(String))].filter((p) => { const b = path.posix.basename(p.replace(/\\/g, "/")); return SECRET_NAME.some((f) => f(b)); }).sort();
}

// ── status ───────────────────────────────────────────────────────────────────

/** `git status --porcelain -z` parsed. -z is used because it never quotes: a
 *  path with a space or a quote arrives as bytes, not as an escaped string.
 *  A rename is `R  new\0old\0` (git reverses the pair under -z), so `path` is
 *  where the file is now and `from` is where it was. Paths are relative to the
 *  repo top level, which is what `git add` from that dir expects. */
export function dirtyFiles(cwd) {
  const d = repoDir(cwd);
  const r = gitx(["status", "--porcelain", "-z", "--untracked-files=all"], d);
  if (r.rc !== 0) throw new Error(`git status failed in ${rel(d)}: ${r.err.trim().slice(-200)}`);
  return parsePorcelainZ(r.out);
}
export function parsePorcelainZ(text) {
  const parts = String(text || "").split("\0");
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    const row = { status: xy.trim() || "?", path: p };
    if (/[RC]/.test(xy)) { row.from = parts[i + 1] || ""; i++; }
    rows.push(row);
  }
  return rows;
}

export function branch(cwd) {
  const r = gitx(["branch", "--show-current"], repoDir(cwd));
  return r.rc === 0 ? r.out.trim() : "";
}
/** The remote's default branch when the clone recorded it, else `main`. */
export function defaultBranch(cwd) {
  const r = gitx(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoDir(cwd));
  const ref = r.rc === 0 ? r.out.trim() : "";
  return ref ? ref.split("/").pop() : "main";
}

// ── what one run changed ─────────────────────────────────────────────────────
//
// A lane spawned into the shared checkout starts on a tree that may already be
// dirty, and `git status` at exit cannot tell the lane's edits from the ones
// that were there first. So the tree is snapshotted at spawn: every dirty
// path's bytes are written to the object store as a blob (`hash-object -w`),
// and at exit each path is compared blob to blob. A path clean at spawn is
// compared against HEAD-at-spawn. What differs is what the run did, including
// a commit it made, and `diff --numstat` between the two blobs gives its lines.
// Adapted from jive's file-changes.ts, which does the same before/after cut.

const EDIT_PATH_CAP = 2000;
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** path -> blob id for the files that exist, written to the object store. */
function writeBlobs(top, paths) {
  const out = new Map();
  const present = paths.filter((p) => { try { return fs.statSync(path.join(top, p)).isFile(); } catch { return false; } });
  for (const part of chunks(present, 200)) {
    const r = gitx(["hash-object", "-w", "--", ...part], top);
    if (r.rc !== 0) continue;
    r.out.trim().split("\n").forEach((id, i) => { if (id) out.set(part[i], id.trim()); });
  }
  return out;
}

/** The tree as it stands, enough to subtract later. Null outside a repo. */
export function snapshot(cwd) {
  let top;
  try { top = repoDir(cwd); } catch { return null; }
  const h = gitx(["rev-parse", "--verify", "--quiet", "HEAD"], top);
  const st = gitx(["status", "--porcelain", "-z", "--untracked-files=all"], top);
  if (st.rc !== 0) return null;
  const dirty = parsePorcelainZ(st.out).slice(0, EDIT_PATH_CAP).map((r) => r.path);
  const blobs = writeBlobs(top, dirty);
  return { top, head: h.rc === 0 ? h.out.trim() : "", dirty: Object.fromEntries(dirty.map((p) => [p, blobs.get(p) || null])) };
}

/** Blob id of `p` in commit `head`, or null when it is not there. */
function blobAt(top, head, p) {
  if (!head) return null;
  const r = gitx(["rev-parse", "--verify", "--quiet", `${head}:${p}`], top);
  return r.rc === 0 ? r.out.trim() : null;
}

let emptyBlob = null;
function empty(top) {
  if (emptyBlob) return emptyBlob;
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bb-empty-")), "empty");
  fs.writeFileSync(f, "");
  const r = gitx(["hash-object", "-w", "--", f], top);
  try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* temp */ }
  emptyBlob = r.rc === 0 ? r.out.trim() : null;
  return emptyBlob;
}

/** Lines added and deleted between two blobs; null for binary or on error. */
function blobLines(top, a, b) {
  const e = empty(top);
  const r = gitx(["diff", "--numstat", a || e, b || e], top);
  const m = r.rc === 0 ? /^(\d+|-)\t(\d+|-)/.exec(r.out) : null;
  return !m || m[1] === "-" ? { add: null, del: null } : { add: Number(m[1]), del: Number(m[2]) };
}

/** What changed since `snap`, and only that: `{ files: [{ path, kind, add,
 *  del }], added, modified, deleted, lines_added, lines_deleted, committed }`.
 *  `kind` is added | modified | deleted. `committed` is true when HEAD moved. */
export function editsSince(snap) {
  if (!snap) return null;
  const { top } = snap;
  const h = gitx(["rev-parse", "--verify", "--quiet", "HEAD"], top);
  const head = h.rc === 0 ? h.out.trim() : "";
  const st = gitx(["status", "--porcelain", "-z", "--untracked-files=all"], top);
  if (st.rc !== 0) return null;
  const paths = new Set([...Object.keys(snap.dirty), ...parsePorcelainZ(st.out).slice(0, EDIT_PATH_CAP).map((r) => r.path)]);
  if (snap.head && head && head !== snap.head) {
    const d = gitx(["diff", "--name-only", "-z", snap.head, head], top);
    if (d.rc === 0) for (const p of d.out.split("\0")) if (p) paths.add(p);
  }
  const current = writeBlobs(top, [...paths]);
  const files = [];
  for (const p of [...paths].sort()) {
    const before = p in snap.dirty ? snap.dirty[p] : blobAt(top, snap.head, p);
    const after = current.get(p) || null;
    if (before === after) continue;
    files.push({ path: p, kind: !before ? "added" : !after ? "deleted" : "modified", ...blobLines(top, before, after) });
  }
  const count = (k) => files.filter((f) => f.kind === k).length;
  const total = (k) => files.reduce((a, f) => a + (f[k] || 0), 0);
  return { files, added: count("added"), modified: count("modified"), deleted: count("deleted"),
    lines_added: total("add"), lines_deleted: total("del"), committed: Boolean(snap.head && head && head !== snap.head) };
}
