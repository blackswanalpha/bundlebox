// runbook/lifecycle.js — the RUNNING system: start it, stop it, wait for it to
// answer, and report what it is actually doing.
//
// Two mechanisms carry the weight here:
//
// **The cage is real or it is reported as absent.** Under systemd, `memory`
// becomes MemoryMax with MemoryHigh at 90% so the kernel reclaims before it
// kills, and MemorySwapMax=0 — because swap is not a cage: without it a capped
// service quietly moves to disk and the box grinds instead of the service
// dying, which is the failure the ceiling exists to avoid. Without systemd it
// is a plain child with a pid file, and `status` says so, because a cage that
// is not there must never be reported as one.
//
// **`wait` returns when the service ANSWERS**, not when the process exists.
// Waiting costs wall clock and no tokens; not waiting costs a board in which
// every step failed against a service that had not finished booting.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as kernel from "../core/kernel.js";
import { VAR, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { run as execRun, which, shellCmd } from "../core/exec.js";
import { now } from "../core/util.js";
import { services, byId, FILE } from "./services.js";
import * as mem from "./memory.js";

export const LOGS = () => path.join(VAR, "logs");
export const STATE = () => path.join(VAR, "runbook.json");

/** What is running, as this workspace last recorded it. Exported because the
 *  verb asks "what is already up" before it sums ceilings for what is not. */
export const state = () => readJson(STATE(), {}) || {};
const setState = (id, row) => { const s = state(); if (row) s[id] = row; else delete s[id]; writeJson(STATE(), s); return s; };


const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };  // ESRCH or EPERM: not ours to count as alive
const useSystemd = () => process.platform === "linux" && Boolean(which("systemd-run")) && Boolean(process.env.XDG_RUNTIME_DIR);
const unit = (id) => `bb-${id}.service`;

/** Start one service. Under systemd the cage is real — `memory` becomes
 *  MemoryMax, so a runaway process is killed by the kernel rather than by the
 *  desktop freezing. Without systemd it is a plain child with a pid file, and
 *  `status` says which, because a cage that is not there must not be reported. */
export function up(id, { apply = false } = {}) {
  const s = byId(id);
  if (!s) return { rc: 2, id, state: "unknown", why: `no service \`${id}\` in ${rel(FILE())}` };
  const cur = state()[id];
  if (cur && ((cur.pid && alive(cur.pid)) || (cur.unit && unitActive(cur.unit)))) return { rc: 0, id, state: "already up", pid: cur.pid || null, unit: cur.unit || "" };
  fs.mkdirSync(LOGS(), { recursive: true });
  const logFile = path.join(LOGS(), `${id}.log`);
  const cwd = abs(s.cwd || ".");
  if (!apply) return { rc: 0, id, state: "would start", cmd: s.cmd, cwd: rel(cwd), caged: useSystemd() ? s.memory || "no ceiling" : "no cage (systemd-run not available)", log: rel(logFile) };
  if (useSystemd()) {
    const args = ["--user", `--unit=${unit(id)}`, "--collect", `--working-directory=${cwd}`,
      `--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`];
    const cap = mem.bytes(s.memory);
    if (cap) {
      // MemoryHigh at 90% so the kernel RECLAIMS before it kills, and
      // MemorySwapMax=0 because swap is not a cage: without it a capped
      // service quietly moves to disk and the box grinds instead of the
      // service dying, which is the failure this whole check exists to avoid.
      args.push(`--property=MemoryMax=${cap}`, `--property=MemoryHigh=${Math.floor(cap * 0.9)}`, `--property=MemorySwapMax=0`);
    }
    if (s.cpu) args.push(`--property=CPUQuota=${s.cpu}`);
    for (const [k, v] of Object.entries(s.env || {})) args.push(`--setenv=${k}=${v}`);
    // `bash` on PURPOSE, and not `shellCmd`: this branch is gated on
    // `useSystemd()`, systemd-run is Linux-only, and a Linux box has bash. The
    // line below is the one that had to change, because it is the branch a
    // Windows box actually takes.
    args.push("bash", "-lc", s.cmd);
    const r = execRun(["systemd-run", ...args], { timeout: 30000 });
    if (r.rc !== 0) return { rc: r.rc, id, state: "failed", why: (r.err || r.out).trim().slice(-300) };
    setState(id, { id, unit: unit(id), started: now(), cmd: s.cmd, log: rel(logFile), via: "systemd" });
    return { rc: 0, id, state: "up", via: "systemd", unit: unit(id), log: rel(logFile) };
  }
  const fd = fs.openSync(logFile, "a");
  // The no-cage fallback, and the branch every non-Linux box takes. It used to
  // hard-code bash, so `bb runbook up` on Windows failed to spawn at all rather
  // than starting an uncaged service. `down()` already degrades correctly there:
  // the process-group kill throws and it falls back to killing the pid.
  const [shBin, ...shArgs] = shellCmd(s.cmd);
  const child = spawn(shBin, shArgs, { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...(s.env || {}) } });
  child.unref();
  setState(id, { id, pid: child.pid, started: now(), cmd: s.cmd, log: rel(logFile), via: "spawn" });
  return { rc: 0, id, state: "up", via: "spawn", pid: child.pid, log: rel(logFile),
    why: s.memory ? "no cage: systemd-run is not available, so `memory` is not enforced" : "" };
}

/** The origin of a URL, with localhost and 127.0.0.1 read as the same box: a
 *  persona that says one and a service row that says the other are not two
 *  services, and treating them as two is how a round starts a second copy on a
 *  port that is already taken. */
const origin = (u) => {
  try {
    const x = new URL(String(u));
    const host = x.hostname === "localhost" ? "127.0.0.1" : x.hostname;
    return `${x.protocol}//${host}:${x.port || (x.protocol === "https:" ? 443 : 80)}`;
  } catch { return ""; }  // not a URL: no origin
};

/** The declared service that answers at `base`, by health URL first and port
 *  second, or null. */
export function serviceAt(base) {
  const want = origin(base);
  if (!want) return null;
  const port = Number(want.split(":").pop());
  const all = services();
  return all.find((s) => s.health && origin(s.health) === want)
    || all.find((s) => Number(s.port) === port) || null;
}

/** Start whatever declares `base`, and wait for it to answer.
 *
 *  `bb genesis practice` calls this before its verifier. A round that writes
 *  scenarios and then reds every one of them against a base nothing started has
 *  paid for the writing and learnt nothing about the product; the one measured
 *  round this exists for was started by hand first, and nothing in the loop
 *  said so. When no row declares the base this reports that and starts nothing:
 *  a base somebody keeps up by hand is still a base. */
export function upFor(base, { apply = true, seconds = 0 } = {}) {
  const declared = services().length;
  const s = serviceAt(base);
  if (!s) return { rc: 0, id: "", state: "undeclared", declared, why: `no service declares ${base} in ${rel(FILE())}` };
  const u = up(s.id, { apply });
  if (u.rc) return { rc: u.rc, id: s.id, state: u.state, declared, why: u.why || "" };
  const w = wait([s], { seconds });
  return { rc: 0, id: s.id, state: u.state, declared, answering: w.ok, waited_ms: w.waited_ms ?? null,
    // A ceiling reached is reported, never a rejection: `wait` gives up on the
    // clock and the scenarios it was waiting for are still the scenarios.
    why: w.ok ? "" : w.why || `${s.id} did not answer at ${s.health} inside ${w.waited_ms}ms` };
}

function unitActive(u) {
  const r = execRun(["systemctl", "--user", "show", u, "--property=ActiveState"], { timeout: 8000 });
  return /ActiveState=(active|activating)/.test(r.out);
}

export function down(id, { apply = false } = {}) {
  const cur = state()[id];
  if (!cur) return { rc: 0, id, state: "not running" };
  if (!apply) return { rc: 0, id, state: "would stop", via: cur.via };
  if (cur.via === "systemd") execRun(["systemctl", "--user", "stop", cur.unit], { timeout: 30000 });
  else if (cur.pid && alive(cur.pid)) { try { process.kill(-cur.pid, "SIGTERM"); } catch { try { process.kill(cur.pid, "SIGTERM"); } catch { /* already gone */ } } }
  setState(id, null);
  return { rc: 0, id, state: "stopped" };
}

/** Wait until every named service ANSWERS, or the deadline passes.
 *
 *  This is the difference between a green board and a board about nothing. The
 *  kernel does the waiting — one connection per target, a real timeout, all of
 *  them in parallel — and returns how many attempts each took, so a service
 *  that is merely slow is distinguishable from one that is dead. */
export function wait(list, { seconds = 0 } = {}) {
  const targets = list.filter((s) => s.health).map((s) => ({ name: s.id, url: s.health }));
  if (!targets.length) return { ok: true, targets: [], why: "no service in this group declares `health`" };
  const ms = (seconds || Math.max(...list.map((s) => Number(s.boot) || 0), 30)) * 1000;
  if (!kernel.available()) return { ok: false, targets: [], why: "no kernel to probe with (`bb kernel build`)" };
  const r = kernel.call("probe", { targets, timeout_ms: 3000, wait_ms: ms, gap_ms: 250 }, { timeout: ms + 15000 });
  const rows = r?.targets || [];
  return { ok: rows.length > 0 && rows.every((t) => t.state === "up"), targets: rows, waited_ms: ms };
}

/** One row per declared service: is it up, is it answering, what is it using. */
export function status() {
  const st = state();
  const rows = services().map((s) => {
    const cur = st[s.id];
    const row = { id: s.id, group: s.group || "", declared: s.cmd, health: s.health || "", state: "down",
      via: cur?.via || "", pid: cur?.pid || null, log: cur?.log || "", memory_bytes: null, cap_bytes: mem.bytes(s.memory) };
    if (cur?.via === "systemd") {
      const r = execRun(["systemctl", "--user", "show", cur.unit, "--property=ActiveState,MemoryCurrent,CPUUsageNSec"], { timeout: 8000 });
      const kv = Object.fromEntries(r.out.split("\n").filter(Boolean).map((l) => l.split("=")));
      row.state = kv.ActiveState === "active" ? "up" : kv.ActiveState || "down";
      const m = Number(kv.MemoryCurrent);
      row.memory_bytes = Number.isFinite(m) && m > 0 ? m : null;
      const c = Number(kv.CPUUsageNSec);
      row.cpu_s = Number.isFinite(c) && c > 0 ? Math.round(c / 1e9) : null;
    } else if (cur?.pid) row.state = alive(cur.pid) ? "up" : "gone";
    return row;
  });
  const targets = rows.filter((r) => r.health).map((r) => ({ name: r.id, url: r.health }));
  if (targets.length && kernel.available()) {
    const probe = kernel.call("probe", { targets, timeout_ms: 2500 });
    for (const t of probe?.targets || []) {
      const row = rows.find((r) => r.id === t.name);
      if (row) { row.answering = t.state; row.status = t.status ?? null; row.ms = t.ms ?? null; row.why = t.why || ""; }
    }
  } else if (targets.length) {
    for (const r of rows) if (r.health) { r.answering = "unknown"; r.why = "no kernel to probe with (`bb kernel build`)"; }
  }
  return rows;
}
