// exec.js — every process the factory spawns goes through here, so a timeout,
// a missing binary and a non-zero exit all come back as a row, never a throw.
import { spawnSync, spawn } from "node:child_process";

// On Windows most CLIs installed by npm are `.cmd`/`.bat` shims, and since Node
// 20 spawn refuses to run those without a shell (CVE-2024-27980). Without this
// every agent, gate and git call that resolves to a shim comes back ENOENT and
// the box reports "not installed" for tools that are installed.
const WIN = process.platform === "win32";

/** Does this resolved binary need a shell? Only a script shim does.
 *
 *  A shell is where argument quoting is LOST: with `shell: true` Node hands the
 *  command line to cmd.exe verbatim and quotes nothing, so `-m "a b c"` arrives
 *  as four arguments. That is how a commit message became five pathspecs and
 *  why every path with a space was unreliable on Windows.
 *
 *  Pure, so the Windows branch is testable on a machine that is not Windows. */
export function shellFor(resolved, { win = WIN } = {}) {
  if (!win) return false;
  return !/\.(exe|com)$/i.test(String(resolved || ""));
}

// `git` is `git.exe`; `claude` is usually `claude.cmd`. Node >= 20 refuses to
// spawn a .cmd without a shell (CVE-2024-27980), so the shim still needs one —
// but resolving first means a real executable never pays that price. One
// lookup per binary per process.
const resolved = new Map();
function resolveBin(bin) {
  if (!WIN || /\.(exe|com)$/i.test(bin) || bin.includes("\\") || bin.includes("/")) return bin;
  if (resolved.has(bin)) return resolved.get(bin);
  let out = bin;
  try {
    const r = spawnSync("where", [bin], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const first = String(r.stdout || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    if (first) out = first;
  } catch { /* leave it as given; the shell path below still runs it */ }
  resolved.set(bin, out);
  return out;
}

/** The shell a free-form command string runs under, as argv.
 *
 *  One implementation, because the shell a command runs under is one fact and
 *  the box had four copies of it. Three hard-coded `bash -lc`, which does not
 *  exist on a stock Windows box, so those callers turned every command there
 *  into a spawn error rather than a verdict; the fourth wrote this rule inline.
 *  Worse, the kernel had already made the Windows decision in
 *  `kernel/src/gate.rs::shell` — so on a Windows box WITH git-bash the two
 *  engines ran the same corpus under different shells and disagreed, which is
 *  exactly what `test/runjson.test.js` exists to catch.
 *
 *  This mirrors that Rust function line for line and must keep mirroring it.
 *
 *  `set -o pipefail` is the whole point of the POSIX wrapping: without it a pipe
 *  eats the exit code and EVERY acceptance passes. That was the Windows gap:
 *  cmd.exe has no pipefail and no equivalent, so `npm test | tee log` reported
 *  `tee`'s exit code and a gate that should have failed reported `ok`. A gate
 *  that cannot fail is worse than no gate.
 *
 *  It is closed rather than documented now. Git for Windows ships `bash` and
 *  puts it on PATH, so on Windows the POSIX branch is used WHEN a bash is
 *  there — which is the same shell, the same pipefail and the same exit code as
 *  everywhere else. Only a box with no bash at all falls back to cmd.exe, and
 *  `pipedOn` names that case so a caller can say so instead of trusting a green.
 *
 *  `kernel/src/gate.rs::shell` mirrors this decision line for line and must
 *  keep mirroring it: on a Windows box the two engines running one corpus under
 *  two different shells is exactly what `test/runjson.test.js` exists to catch.
 *
 *  Pure apart from the bash probe, which is memoised and injectable, so the
 *  Windows branch stays testable on a machine that is not Windows. */
let _bash = null;
export function bashPath({ fresh = false } = {}) {
  if (_bash !== null && !fresh) return _bash;
  // `where` rather than `which`: this runs on the Windows side, and a `bash` on
  // PATH there is Git for Windows' one.
  const r = spawnSync(WIN ? "where" : "which", ["bash"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  _bash = r.status === 0 ? String(r.stdout || "").trim().split(/\r?\n/)[0] || null : null;
  return _bash;
}

export function shellCmd(cmd, { merge = false, win = WIN, bash = undefined } = {}) {
  const redir = merge ? " 2>&1" : "";
  const sh = bash === undefined ? (win ? bashPath() : "bash") : bash;
  if (win && !sh) return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `${cmd}${redir}`];
  return [sh || "bash", "-lc", `set -o pipefail; { ${cmd} ; }${redir}`];
}

/** Does a piped command report the FIRST failing stage's code under the shell
 *  this box would pick? False only on a Windows box with no bash, and a caller
 *  that reports a gate verdict says so rather than printing a green it cannot
 *  stand behind. */
export const pipedOn = ({ win = WIN, bash = undefined } = {}) => !win || Boolean(bash === undefined ? bashPath() : bash);

export function run(cmd, { cwd, timeout = 120000, input, env } = {}) {
  const [bin0, ...args] = Array.isArray(cmd) ? cmd : String(cmd).split(/\s+/);
  const bin = resolveBin(bin0);
  const r = spawnSync(bin, args, { cwd, timeout, input, env: env ? { ...process.env, ...env } : process.env,
    shell: shellFor(bin), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { rc: r.error.code === "ETIMEDOUT" ? 124 : 127, out: r.stdout || "", err: String(r.error.message || r.error), missing: r.error.code === "ENOENT" };
  return { rc: r.status ?? 1, out: r.stdout || "", err: r.stderr || "", missing: false };
}
export function which(bin) {
  const r = run(process.platform === "win32" ? ["where", bin] : ["which", bin], { timeout: 5000 });
  return r.rc === 0 ? r.out.trim().split("\n")[0] : null;
}
export function git(args, cwd) { return run(["git", ...args], { cwd, timeout: 60000 }); }
export function gitOk(cwd) { return git(["rev-parse", "--is-inside-work-tree"], cwd).rc === 0; }
/** Async spawn that streams stdout lines to onLine. Resolves {rc, seconds}. */
export function stream(cmd, { cwd, env, input, onLine, onErr, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const [bin0, ...args] = cmd;
    const bin = resolveBin(bin0);
    const t0 = Date.now();
    let child;
    try {
      child = spawn(bin, args, { cwd, env: env ? { ...process.env, ...env } : process.env, shell: shellFor(bin), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { return resolve({ rc: 127, seconds: 0, error: String(e) }); }
    let buf = "", ebuf = "";
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine?.(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on("data", (d) => { ebuf += d; onErr?.(String(d)); });
    const timer = timeout ? setTimeout(() => child.kill("SIGTERM"), timeout) : null;
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ rc: 127, seconds: (Date.now() - t0) / 1000, error: String(e), stderr: ebuf }); });
    child.on("close", (rc) => { if (timer) clearTimeout(timer); if (buf) onLine?.(buf); resolve({ rc: rc ?? 1, seconds: (Date.now() - t0) / 1000, stderr: ebuf }); });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}
