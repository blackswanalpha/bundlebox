// git/repo.js — the floor every other git module stands on: which directory is
// a checkout, which flags are refused before a command is built, and what the
// working tree currently says.
//
// It is its own file because the rules here are the ones that must hold for
// EVERY git call in the factory. A guard that lives inside the module that
// commits is a guard the module that pushes can forget.
import fs from "node:fs";
import path from "node:path";
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
