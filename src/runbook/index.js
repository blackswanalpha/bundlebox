// runbook/index.js — run the local system, watch it, and pay almost nothing to
// do either.
//
// `bb scan` answers questions about the SOURCE for nothing. This answers the
// same class of question about the RUNNING system: is it up, what broke, what
// is it costing. Every one of those has a cheap local answer that a session
// should never be spent deriving, and a scenario run against a service that is
// not up is the most expensive kind of red board there is.
//
// Three mechanisms, and they are the whole design:
//
// 1. **A service is a declared row, not a remembered command.** `services.json`
//    holds the command, the health URL and the cage. `bb runbook up` reads it.
// 2. **Logs go to files and the digest reads them by OFFSET.** A cursor per log
//    means the second `logs` call reads only what arrived since the first. A
//    40,000-line log is read once; every call after that is a few KB.
// 3. **Nothing prints log lines by default.** Lines are normalised into
//    SIGNATURES — every digit, uuid, hex and timestamp erased — and counted.
//    Forty thousand lines become about twenty rows, and the raw file stays on
//    disk with its path printed, so the evidence is one `sed` away.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as kernel from "../core/kernel.js";
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import { BB_DIR, VAR, ROOT, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { run as execRun, which } from "../core/exec.js";
import { out, warn, emit } from "../core/log.js";
import { now, pad, table, human } from "../core/util.js";

export const FILE = () => path.join(BB_DIR, "runbook", "services.json");
export const LOGS = () => path.join(VAR, "logs");
export const STATE = () => path.join(VAR, "runbook.json");

export const services = () => { const v = readJson(FILE(), null); return Array.isArray(v) ? v : (v?.services || []); };
export const byId = (id) => services().find((s) => s.id === id) || null;
const groupOf = (name) => { const all = services(); const g = all.filter((s) => (s.group || "").split(",").map((x) => x.trim()).includes(name)); return g.length ? g : all.filter((s) => s.id === name); };

const state = () => readJson(STATE(), {}) || {};
const setState = (id, row) => { const s = state(); if (row) s[id] = row; else delete s[id]; writeJson(STATE(), s); return s; };

export function init() {
  if (fs.existsSync(FILE())) return { rc: 2, why: `${rel(FILE())} exists` };
  writeJson(FILE(), [
    { id: "app", group: "all", cmd: "npm start", cwd: ".", port: 3000, health: "http://127.0.0.1:3000/health", memory: "1G", env: {} },
  ]);
  return { rc: 0, file: rel(FILE()), why: "one example service written; edit it, then `bb runbook up all`" };
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
  if (!s) return { rc: 2, id, why: `no service \`${id}\` in ${rel(FILE())}` };
  const cur = state()[id];
  if (cur && cur.pid && alive(cur.pid)) return { rc: 0, id, state: "already up", pid: cur.pid };
  fs.mkdirSync(LOGS(), { recursive: true });
  const logFile = path.join(LOGS(), `${id}.log`);
  const cwd = abs(s.cwd || ".");
  if (!apply) return { rc: 0, id, state: "would start", cmd: s.cmd, cwd: rel(cwd), caged: useSystemd() ? s.memory || "no ceiling" : "no cage (systemd-run not available)", log: rel(logFile) };
  if (useSystemd()) {
    const args = ["--user", `--unit=${unit(id)}`, "--collect", `--working-directory=${cwd}`,
      `--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`];
    if (s.memory) { args.push(`--property=MemoryMax=${s.memory}`, `--property=MemorySwapMax=0`); }
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
  return { rc: 0, id, state: "up", via: "spawn", pid: child.pid, log: rel(logFile), why: s.memory ? "no cage: systemd-run is not available, so `memory` is not enforced" : "" };
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

/** One row per declared service: is it up, is it answering, what is it using. */
export function status() {
  const st = state();
  const rows = services().map((s) => {
    const cur = st[s.id];
    const row = { id: s.id, group: s.group || "", declared: s.cmd, health: s.health || "", state: "down", via: cur?.via || "", pid: cur?.pid || null, log: cur?.log || "", memory_bytes: null };
    if (cur?.via === "systemd") {
      const r = execRun(["systemctl", "--user", "show", cur.unit, "--property=ActiveState,MemoryCurrent"], { timeout: 8000 });
      const kv = Object.fromEntries(r.out.split("\n").filter(Boolean).map((l) => l.split("=")));
      row.state = kv.ActiveState === "active" ? "up" : kv.ActiveState || "down";
      const m = Number(kv.MemoryCurrent);
      row.memory_bytes = Number.isFinite(m) && m > 0 ? m : null;
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

// ── the log digest ──────────────────────────────────────────────────────────

/** Every digit, hex blob, uuid, quoted string and path erased, so forty
 *  thousand lines collapse to the twenty shapes they actually are. */
export function signature(line) {
  return String(line)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hash>")
    .replace(/"[^"]{0,120}"/g, '"<str>"')
    .replace(/(\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|gb|%)?\b/gi, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function digest({ id = "", since = true, cap = 4 * 1024 * 1024 } = {}) {
  const cursors = readJson(path.join(VAR, "log-cursors.json"), {}) || {};
  const rows = [];
  const files = id ? [path.join(LOGS(), `${id}.log`)] : (() => { try { return fs.readdirSync(LOGS()).filter((f) => f.endsWith(".log")).map((f) => path.join(LOGS(), f)); } catch { return []; } })();
  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const from = since ? Math.min(cursors[file] || 0, st.size) : Math.max(0, st.size - cap);
    // A truncated or rotated file has a size below the cursor; start over rather
    // than reporting nothing arrived.
    const start = st.size < (cursors[file] || 0) ? 0 : from;
    const len = Math.min(st.size - start, cap);
    let text = "";
    if (len > 0) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      text = buf.toString("utf8");
    }
    cursors[file] = st.size;
    const counts = new Map();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const sig = signature(t);
      const c = counts.get(sig) || { sig, n: 0, sample: t.slice(0, 200) };
      c.n += 1;
      counts.set(sig, c);
    }
    rows.push({ file: rel(file), bytes: len, from: start, to: st.size,
      signatures: [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 40) });
  }
  writeJson(path.join(VAR, "log-cursors.json"), cursors);
  return rows;
}

async function cmd({ _, flags }) {
  const sub = _[0] || "status";
  if (sub === "init") { const r = init(); out(`  ${r.why || r.file}`); return r.rc; }
  if (sub === "services") {
    const rows = services();
    if (flags.json) { emit({ services: rows, file: rel(FILE()) }); return 0; }
    if (!rows.length) { out(`  no services declared. bb runbook init writes ${rel(FILE())}`); return 0; }
    out(table(rows.map((s) => [s.id, s.group || "", s.cmd, s.health || "", s.memory || ""]), { header: ["id", "group", "command", "health", "cage"] })
      .split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }
  if (sub === "up" || sub === "down") {
    const target = _[1] || "all";
    const list = groupOf(target);
    if (!list.length) { warn(`no service or group \`${target}\``); return 2; }
    const rows = list.map((s) => (sub === "up" ? up(s.id, { apply: !!flags.apply }) : down(s.id, { apply: !!flags.apply })));
    if (flags.json) { emit({ [sub]: rows }); return rows.some((r) => r.rc) ? 1 : 0; }
    for (const r of rows) out(`  ${pad(r.id, 14)} ${pad(r.state, 14)} ${r.via ? `via ${r.via}  ` : ""}${r.why || r.cmd || ""}${r.log ? `  ${r.log}` : ""}`);
    if (!flags.apply) out(`\n  dry run. --apply ${sub === "up" ? "starts" : "stops"} them.`);
    return rows.some((r) => r.rc) ? 1 : 0;
  }
  if (sub === "logs") {
    const rows = digest({ id: _[1] || "", since: flags.all !== true });
    if (flags.json) { emit({ logs: rows }); return 0; }
    if (!rows.length) { out("  no logs yet"); return 0; }
    for (const r of rows) {
      out(`  ${r.file}  ${human(r.bytes)}B since the last call (${r.from}→${r.to})`);
      if (!r.signatures.length) { out("    nothing new"); continue; }
      out(table(r.signatures.map((s) => [s.n, s.sig]), { header: ["n", "signature"] }).split("\n").map((l) => "    " + l).join("\n"));
    }
    out("\n  signatures, not lines: every digit, uuid, hash and path erased. The raw file is on disk at the path above.");
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
  warn(`unknown runbook sub-verb: ${sub}. status | up | down | logs | services | init`);
  return 2;
}

export const commands = {
  runbook: {
    help: "the running system: is it up, what broke since the last call, what is it costing (0 model tokens)",
    usage: "bb runbook [status|up <group>|down <group>|logs [id]|services|init] [--apply] [--json]",
    long: [
      "  bb runbook up all --apply     start every declared service, caged where systemd is available",
      "  bb runbook status             process state, health probe, memory",
      "  bb runbook logs               what arrived since the last call, as signatures rather than lines",
      "",
      "Services are declared in .bundlebox/runbook/services.json. Every verb is a dry run until --apply.",
    ].join("\n"),
    run: cmd,
  },
};
