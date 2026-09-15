// memory.js — the admission check, and the reason `up` can refuse.
//
// Two emulators, a backend and a frontend have ceilings summing to more memory
// than most boxes have. Starting them anyway does not fail loudly: the box
// swaps, every timing in every board afterwards is wrong, and the session that
// reads that board pays to investigate a product that is fine. So `up` refuses
// a set whose ceilings exceed what is free, and says what it would have needed.
//
// `memory` is a CEILING, not a reservation, and it is not the guest RAM of a
// VM. An emulator asked for 3 GB of guest peaks near 5 GB once QEMU, the GPU
// buffers and the snapshot machinery are counted, and a cage set to the guest
// size is a phone that boots, runs for ninety seconds and is OOM-killed. Keep
// `guest` and `memory` separate and derive neither from the other.
import fs from "node:fs";
import os from "node:os";
import { run as execRun, which } from "../core/exec.js";

const UNITS = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 };

/** `"1G"`, `"512M"`, `"1.5g"`, `1073741824` → bytes. Null when unparseable, so
 *  a typo reads as "no ceiling declared" rather than as a ceiling of zero. */
export function bytes(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (m[2] || "b").toLowerCase();
  return UNITS[u] ? Math.round(n * UNITS[u]) : null;
}

export const human = (n) => {
  if (!Number.isFinite(n)) return "?";
  const g = n / 1024 ** 3;
  return g >= 1 ? `${g.toFixed(1)}G` : `${Math.round(n / 1024 ** 2)}M`;
};

/** What is actually available, which is not `os.freemem()`. On Linux the page
 *  cache is reclaimable and MemAvailable says so; free memory alone reports a
 *  box with a warm cache as full and refuses every start. */
export function available() {
  if (process.platform === "linux") {
    try {
      const txt = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = /MemAvailable:\s+(\d+) kB/.exec(txt);
      if (kb) return { bytes: Number(kb[1]) * 1024, via: "MemAvailable" };
    } catch { /* fall through to the portable answer */ }
  }
  if (process.platform === "darwin" && which("vm_stat")) {
    const r = execRun(["vm_stat"], { timeout: 5000 });
    const size = Number(/page size of (\d+)/.exec(r.out)?.[1] || 4096);
    const pages = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(r.out)?.[1] || 0);
    const free = pages("Pages free") + pages("Pages inactive") + pages("Pages purgeable");
    if (free > 0) return { bytes: free * size, via: "vm_stat" };
  }
  return { bytes: os.freemem(), via: "os.freemem" };
}

/** Would starting `wanted` fit, given what `running` already holds?
 *
 *  A service with no declared ceiling counts as zero rather than as unlimited:
 *  refusing every start because one row forgot a number is a check nobody
 *  leaves on, and `status` already reports what each one is really using. */
export function admit(wanted, running, { reserve = 1024 ** 3 } = {}) {
  const sum = (rows) => rows.reduce((a, s) => a + (bytes(s.memory) || 0), 0);
  const ask = sum(wanted);
  const held = sum(running);
  const free = available();
  const ok = ask + reserve <= free.bytes;
  return {
    ok, ask, held, reserve, free: free.bytes, via: free.via,
    why: ok ? "" : `not enough memory: ${human(ask)} of new ceilings + ${human(reserve)} reserve against ${human(free.bytes)} available`
      + (held ? `\n  already running ${human(held)} of ceilings` : "")
      + `\n  stop something, ask for a smaller group, or --force`,
    undeclared: wanted.filter((s) => bytes(s.memory) === null).map((s) => s.id),
  };
}
