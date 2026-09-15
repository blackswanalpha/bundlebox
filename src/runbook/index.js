// runbook/index.js — run the local system, watch it, and pay almost nothing to
// do either.
//
// `bb scan` answers questions about the SOURCE for nothing. This answers the
// same class of question about the RUNNING system: is it up, is it answering,
// what broke, what is it costing. Every one of those has a cheap local answer
// that a session should never be spent deriving, and a scenario run against a
// service that is not up is the most expensive kind of red board there is —
// every step fails, every failure is filed, and a session pays to read a board
// about nothing.
//
// Six mechanisms, and they are the whole design:
//
// 1. **A service is a declared row, not a remembered command.** `services.json`
//    holds the command, the health URL, the cage and the group. `up` reads it.
// 2. **A group is the unit of work.** Nobody starts one service; they start the
//    set a test needs. Groups are declared, so the set is reviewable.
// 3. **`up` refuses what will not fit.** Ceilings are summed against available
//    memory before anything starts. A box that swaps reports a product that is
//    fine as a product that is slow.
// 4. **`up --wait` returns when the service ANSWERS**, not when the process
//    exists. Waiting costs wall clock and no tokens; not waiting costs a board.
// 5. **Logs go to files and the digest reads them by OFFSET.** A cursor per log
//    means the second `logs` call reads only what arrived since the first.
// 6. **Nothing prints log lines by default.** Lines become SIGNATURES and known
//    failures arrive NAMED. Forty thousand lines become about twenty rows in
//    60 ms, and the raw file stays on disk with its path printed.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as kernel from "../core/kernel.js";
import { BB_DIR, VAR, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { run as execRun, which } from "../core/exec.js";
import { out, warn, emit } from "../core/log.js";
import { now, pad, table, human as humanN } from "../core/util.js";
import { digest as digestFrom, signature, levelOf, initBuckets, BUCKETS } from "./digest.js";
import * as mem from "./memory.js";

export const FILE = () => path.join(BB_DIR, "runbook", "services.json");
export const LOGS = () => path.join(VAR, "logs");
export const STATE = () => path.join(VAR, "runbook.json");

const doc = () => readJson(FILE(), null);
export const services = () => { const v = doc(); return Array.isArray(v) ? v : (v?.services || []); };
export const byId = (id) => services().find((s) => s.id === id) || null;

/** The declared groups, plus the two every workspace gets for free: `all`, and
 *  a group per service id so `up app` still means something. A group declared
 *  in `groups` wins over the comma list on a service row, because the table is
 *  the reviewable form. */
export function groups() {
  const v = doc();
  const declared = (!Array.isArray(v) && v?.groups) || {};
  const all = services();
  const g = {};
  for (const s of all) for (const name of String(s.group || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    (g[name] ||= []).push(s.id);
  }
  for (const [name, ids] of Object.entries(declared)) g[name] = Array.isArray(ids) ? ids : [];
  // `all` is derived last and always means every declared service, so a row
  // that also names itself `all` cannot make the group list it twice and start
  // it twice.
  g.all = all.map((s) => s.id);
  for (const k of Object.keys(g)) g[k] = [...new Set(g[k])].filter((id) => byId(id));
  return g;
}
export function groupOf(name) {
  const g = groups();
  const ids = g[name] || (byId(name) ? [name] : null);
  if (!ids) return [];
  return ids.map((id) => byId(id)).filter(Boolean);
}

const state = () => readJson(STATE(), {}) || {};
const setState = (id, row) => { const s = state(); if (row) s[id] = row; else delete s[id]; writeJson(STATE(), s); return s; };

export function init() {
  const b = initBuckets();
  if (fs.existsSync(FILE())) return { rc: 2, why: `${rel(FILE())} exists`, buckets: b.rc === 0 ? b.file : "" };
  writeJson(FILE(), {
    groups: { web: ["app"], all: ["app"] },
    services: [
      { id: "app", group: "web", cmd: "npm start", cwd: ".", port: 3000, health: "http://127.0.0.1:3000/health", memory: "1G", boot: 20, env: {} },
    ],
  });
  return { rc: 0, file: rel(FILE()), buckets: b.rc === 0 ? b.file : rel(BUCKETS()),
    why: "one example service and the seed failure buckets written; edit them, then `bb runbook up all --apply --wait`" };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
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
    args.push("bash", "-lc", s.cmd);
    const r = execRun(["systemd-run", ...args], { timeout: 30000 });
    if (r.rc !== 0) return { rc: r.rc, id, state: "failed", why: (r.err || r.out).trim().slice(-300) };
    setState(id, { id, unit: unit(id), started: now(), cmd: s.cmd, log: rel(logFile), via: "systemd" });
    return { rc: 0, id, state: "up", via: "systemd", unit: unit(id), log: rel(logFile) };
  }
  const fd = fs.openSync(logFile, "a");
  const child = spawn("bash", ["-lc", s.cmd], { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...(s.env || {}) } });
  child.unref();
  setState(id, { id, pid: child.pid, started: now(), cmd: s.cmd, log: rel(logFile), via: "spawn" });
  return { rc: 0, id, state: "up", via: "spawn", pid: child.pid, log: rel(logFile),
    why: s.memory ? "no cage: systemd-run is not available, so `memory` is not enforced" : "" };
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

/** The digest of every service log. Kept as a no-argument-first call because
 *  `failsafe` asks this of the runbook rather than of a directory: the runbook
 *  owns where logs live, and one caller knowing that path is one caller that
 *  breaks when it moves. */
export const digest = (opts = {}) => digestFrom(LOGS(), opts);
export { signature, levelOf };

// ── the verb ────────────────────────────────────────────────────────────────

const SUBS = "status | up <group> | down <group> | wait <group> | logs [id] | perf | services | groups | init";

async function cmd({ _, flags }) {
  const sub = _[0] || "status";

  if (sub === "init") {
    const r = init();
    if (flags.json) { emit(r); return r.rc; }
    out(`  ${r.why || r.file}`);
    if (r.file) out(`  ${r.file}`);
    if (r.buckets) out(`  ${r.buckets}`);
    return r.rc;
  }

  if (sub === "services") {
    const rows = services();
    if (flags.json) { emit({ services: rows, file: rel(FILE()) }); return 0; }
    if (!rows.length) { out(`  no services declared. bb runbook init writes ${rel(FILE())}`); return 0; }
    out(table(rows.map((s) => [s.id, s.group || "", s.cmd, s.health || "", s.memory || "", s.boot ? `${s.boot}s` : ""]),
      { header: ["id", "group", "command", "health", "cage", "boot"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "groups") {
    const g = groups();
    if (flags.json) { emit({ groups: g }); return 0; }
    const rows = Object.entries(g).map(([name, ids]) => [name, ids.length, ids.join(" ")]);
    out(table(rows, { header: ["group", "n", "services"] }).split("\n").map((l) => "  " + l).join("\n"));
    out("\n  a group is the unit of work: nobody starts one service, they start the set a test needs.");
    return 0;
  }

  if (sub === "up" || sub === "down") {
    const target = _[1] || "all";
    const list = groupOf(target);
    if (!list.length) { warn(`no service or group \`${target}\`. bb runbook groups`); return 2; }

    if (sub === "up") {
      const st = state();
      const already = new Set(Object.keys(st));
      const starting = list.filter((s) => !already.has(s.id));
      const check = mem.admit(starting, services().filter((s) => already.has(s.id)),
        { reserve: mem.bytes(flags.reserve) || 1024 ** 3 });
      if (!check.ok && !flags.force) {
        if (flags.json) { emit({ up: [], admit: check }); return 1; }
        warn(check.why);
        out(`  asked for ${starting.map((s) => s.id).join(", ") || "nothing"}`);
        return 1;
      }
      if (check.undeclared.length && !flags.json) {
        out(`  no ceiling declared for ${check.undeclared.join(", ")} — counted as zero, so the check below is a floor`);
      }
    }

    const rows = list.map((s) => (sub === "up" ? up(s.id, { apply: !!flags.apply }) : down(s.id, { apply: !!flags.apply })));
    let waited = null;
    if (sub === "up" && flags.apply && flags.wait !== false && (flags.wait || flags.wait === undefined)) {
      if (flags.wait !== undefined || list.some((s) => s.health)) {
        waited = wait(list, { seconds: Number(flags.wait) || 0 });
      }
    }

    if (flags.json) { emit({ [sub]: rows, ...(waited ? { wait: waited } : {}) }); return rows.some((r) => r.rc) || (waited && !waited.ok) ? 1 : 0; }
    for (const r of rows) out(`  ${pad(r.id, 14)} ${pad(r.state, 14)} ${r.via ? `via ${r.via}  ` : ""}${r.why || r.cmd || ""}${r.log ? `  ${r.log}` : ""}`);
    if (!flags.apply) { out(`\n  dry run. --apply ${sub === "up" ? "starts" : "stops"} them.`); return 0; }
    if (waited) {
      out("");
      if (waited.why && !waited.targets.length) out(`  ${waited.why}`);
      for (const t of waited.targets) {
        out(`  ${pad(t.name, 14)} ${pad(t.state, 10)} ${t.status ?? ""} ${t.ms != null ? `${t.ms}ms` : ""} ${t.attempts ? `after ${t.attempts} probe${t.attempts === 1 ? "" : "s"}` : ""} ${t.why || ""}`.trimEnd());
      }
      if (!waited.ok) { warn("not every service answered. Do not run a corpus against this — every step would fail for the same reason."); return 1; }
      out("  every service answers. A board run now is about the product.");
    }
    return rows.some((r) => r.rc) ? 1 : 0;
  }

  if (sub === "wait") {
    const list = groupOf(_[1] || "all");
    if (!list.length) { warn(`no service or group \`${_[1] || "all"}\``); return 2; }
    const r = wait(list, { seconds: Number(flags.seconds) || Number(flags.wait) || 0 });
    if (flags.json) { emit(r); return r.ok ? 0 : 1; }
    if (!r.targets.length) { out(`  ${r.why}`); return r.ok ? 0 : 1; }
    for (const t of r.targets) out(`  ${pad(t.name, 14)} ${pad(t.state, 10)} ${t.status ?? ""} ${t.ms != null ? `${t.ms}ms` : ""} ${t.attempts ? `after ${t.attempts} probe${t.attempts === 1 ? "" : "s"}` : ""} ${t.why || ""}`.trimEnd());
    return r.ok ? 0 : 1;
  }

  if (sub === "logs") {
    const r = digestFrom(LOGS(), {
      id: _[1] || "", since: flags.all !== true, level: String(flags.level || ""),
      grep: String(flags.grep || ""), sample: !!flags.sample, top: Number(flags.top) || 40,
      engine: flags.js ? "js" : "auto",
    });
    if (flags.json) { emit(r); return r.high ? 1 : 0; }
    if (!r.files.length) { out("  no logs yet"); return 0; }
    for (const f of r.files) {
      out(`  ${f.file}  ${humanN(f.bytes)}B ${flags.all ? "in full" : "since the last call"} (${f.from}→${f.to})${f.rotated ? "  ROTATED, re-read from the top" : ""}${f.why ? `  ${f.why}` : ""}`);
    }
    const t = r.totals;
    out(`\n  ${t.lines} line${t.lines === 1 ? "" : "s"} · ${t.errors} E · ${t.warnings} W · ${r.files.reduce((a, f) => a + (f.distinct || 0), 0)} distinct signatures · via ${r.via}`);

    if (r.buckets.length) {
      out("\n  known failures");
      for (const b of r.buckets) out(`    ${pad(b.severity, 7)} ${pad(b.id, 22)} ×${pad(String(b.n), 5)} ${b.says}`);
    }
    for (const b of r.refused || []) warn(`bucket ${b.id} is not being matched: ${b.why}`);

    const sigs = r.files.flatMap((f) => (f.signatures || []).map((s) => ({ ...s, file: f.file })));
    if (!sigs.length) out("\n  nothing new");
    else {
      out("\n  top signatures");
      out(table(sigs.sort((a, b) => b.n - a.n).slice(0, Number(flags.top) || 40)
        .map((s) => (flags.sample ? [s.n, s.sig, s.sample || ""] : [s.n, s.sig])),
        { header: flags.sample ? ["n", "signature", "one real line"] : ["n", "signature"] })
        .split("\n").map((l) => "    " + l).join("\n"));
    }
    out("\n  signatures, not lines: every digit, uuid, hash and path erased. The raw file is on disk at the path above.");
    if (r.high) { out(""); warn("a high bucket fired. Nothing below it is evidence about the product."); return 1; }
    return 0;
  }

  if (sub === "perf") {
    const rows = status().filter((r) => r.state === "up");
    if (flags.json) { emit({ perf: rows }); return 0; }
    if (!rows.length) { out("  nothing is up"); return 0; }
    out(table(rows.map((r) => [r.id,
      r.memory_bytes ? `${Math.round(r.memory_bytes / 1048576)}M` : "?",
      r.cap_bytes ? mem.human(r.cap_bytes) : "no cage",
      r.memory_bytes && r.cap_bytes ? `${Math.round((r.memory_bytes / r.cap_bytes) * 100)}%` : "",
      r.cpu_s != null ? `${r.cpu_s}s` : "", r.ms != null ? `${r.ms}ms` : ""]),
      { header: ["service", "memory", "cage", "of cage", "cpu", "latency"] }).split("\n").map((l) => "  " + l).join("\n"));
    const a = mem.available();
    out(`\n  ${mem.human(a.bytes)} available on this box (${a.via})`);
    // Reclaim starts at 90% of the cage. A service sitting above that is being
    // throttled by the kernel, and its timings describe the cage, not the code.
    const hot = rows.filter((r) => r.memory_bytes && r.cap_bytes && r.memory_bytes / r.cap_bytes >= 0.9);
    if (hot.length) warn(`${hot.map((r) => r.id).join(", ")} is at or past MemoryHigh — the kernel is reclaiming, so any timing from it is about the cage`);
    return 0;
  }

  if (sub === "status") {
    const rows = status();
    if (flags.json) { emit({ services: rows }); return 0; }
    if (!rows.length) { out(`  no services declared. bb runbook init`); return 0; }
    out(table(rows.map((r) => [r.id, r.state, r.answering || (r.health ? "?" : ""), r.status ?? "", r.ms != null ? `${r.ms}ms` : "",
      r.memory_bytes ? `${Math.round(r.memory_bytes / 1048576)}M` : "", r.why || ""]),
      { header: ["service", "process", "answering", "code", "latency", "memory", ""] }).split("\n").map((l) => "  " + l).join("\n"));
    return rows.some((r) => r.state !== "up") ? 1 : 0;
  }

  warn(`unknown runbook sub-verb: ${sub}. ${SUBS}`);
  return 2;
}

export const commands = {
  runbook: {
    help: "the running system: is it up, is it answering, what broke since the last call, what is it costing (0 model tokens)",
    usage: `bb runbook [${SUBS}] [--apply] [--wait[=s]] [--force] [--level E] [--grep <rx>] [--sample] [--all] [--json]`,
    long: [
      "  bb runbook up chat --apply --wait   start the group, caged, and return when every service ANSWERS",
      "  bb runbook status                   process state, health probe, memory",
      "  bb runbook logs                     what arrived since the last call, as signatures and named failures",
      "  bb runbook logs --level E --sample  errors only, with one real line per signature",
      "  bb runbook perf                     memory against the cage, cpu, latency",
      "",
      "Services and groups are declared in .bundlebox/runbook/services.json; the named failures in",
      "digest.json beside it. `up` refuses a set whose ceilings exceed available memory (--force overrides),",
      "and `logs` exits 1 when a high bucket fired, so it works as a gate. Every verb is a dry run until --apply.",
    ].join("\n"),
    run: cmd,
  },
};
