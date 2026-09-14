// kernel.js — the bridge to the Rust kernel (`bbk`).
//
// The kernel owns the operations where a scripting runtime fails in ways that
// look like answers: walking a large tree without blowing the heap, hashing
// thousands of files for a fingerprint, sliding-window duplicate detection,
// running an acceptance gate with a real timeout and an output cap, adding and
// seeding a worktree. Every op takes JSON on stdin and returns JSON on stdout.
//
// The bridge degrades: with no `bbk` on this box every op falls back to the
// JavaScript implementation the caller passes in, and `bb doctor` says which
// one is active. A missing kernel must never make a verb return nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, PKG_ROOT } from "./paths.js";

let _bin;
export function binary() {
  if (_bin !== undefined) return _bin;
  const exe = process.platform === "win32" ? "bbk.exe" : "bbk";
  const candidates = [
    process.env.BB_KERNEL,
    path.join(HOME, "bin", exe),
    path.join(PKG_ROOT, "kernel", "target", "release", exe),
    path.join(PKG_ROOT, "kernel", "bin", `${exe}`),
  ].filter(Boolean);
  _bin = candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  return _bin;
}
export const available = () => Boolean(binary());
export function version() {
  const b = binary();
  if (!b) return null;
  const r = spawnSync(b, ["version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
/** Run one kernel op. Returns parsed JSON, or null when the kernel is absent or failed
 *  (the caller then uses its JS fallback). `why` is recorded on the last failure. */
export let lastError = null;
export function call(op, payload = {}, { timeout = 600000, cwd } = {}) {
  const b = binary();
  if (!b) { lastError = "no kernel binary"; return null; }
  const r = spawnSync(b, [op], { input: JSON.stringify(payload), encoding: "utf8", timeout, cwd, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) { lastError = `${op}: ${r.error ? r.error.message : (r.stderr || "").trim().slice(-300) || `rc ${r.status}`}`; return null; }
  try { return JSON.parse(r.stdout); } catch (e) { lastError = `${op}: bad json (${e.message})`; return null; }
}
/** Prefer the kernel, fall back to js. `same` is the contract both must honour. */
export function withFallback(op, payload, js, opts) {
  const k = call(op, payload, opts);
  return k === null ? { result: js(), via: "js" } : { result: k, via: "kernel" };
}
export const target = () => `${process.platform}-${os.arch()}`;
