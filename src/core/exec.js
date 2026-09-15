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
