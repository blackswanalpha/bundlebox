// headroom.js — the wire: what a lane sends, compressed before it leaves the box.
//
// The lean stack, anchoring and the brief all shrink what a lane is ASKED.
// None of them touch the turns after the first, which is where a lane spends:
// the file it reads, the test output it pipes, the table it re-reads. Headroom
// is a local proxy the lane's ANTHROPIC_BASE_URL points at; it compresses tool
// results on the way to the provider, reversibly. bundlebox never imports it:
// a `headroom` binary on PATH is detected, spawned, and read over HTTP, and
// every function here degrades to "not installed" rather than throwing.
//
// `enabled` defaults to false. A proxy in front of every lane is a decision
// about where the workspace's traffic goes, made in config, not inherited from
// whether a package happened to install.
//
// Two env flags a Claude Code lane needs when the proxy is up:
//   ANTHROPIC_BASE_URL   the proxy. This is the whole integration.
//   ENABLE_TOOL_SEARCH   headroom GH #746: with a custom base URL and this
//                        unset, Claude Code stops deferring tool schemas and
//                        materialises every one into the window.
// Codex talks OpenAI-shaped, so it gets OPENAI_BASE_URL=<proxy>/v1 instead.
//
// The proxy is on the critical path of every lane, so `laneEnv()` is only ever
// non-empty when `/health` answered just now; a dead proxy degrades a run to
// direct traffic with a warning and never fails a lane.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { load } from "../core/config.js";
import { run, which } from "../core/exec.js";
import { VAR, ROOT, rel } from "../core/paths.js";
import { now, human } from "../core/util.js";

export const PID_FILE = path.join(VAR, "headroom.pid");
export const LOG_FILE = path.join(VAR, "logs", "headroom-proxy.log");

export const cfg = () => load().headroom || {};
export const port = (p = 0) => Number(p) || Number(cfg().port) || 8787;
export const host = () => String(cfg().host || "127.0.0.1");
export const baseUrl = (p = 0) => `http://${host()}:${port(p)}`;

/** The `headroom` command, or null. ~/.local/bin is checked explicitly because a
 *  cron PATH is `/usr/bin:/bin` and a proxy that only works interactively is a
 *  savings figure that means nothing. */
export function binary() {
  const found = which("headroom");
  if (found) return found;
  for (const c of [path.join(os.homedir(), ".local", "bin", "headroom"), "/usr/local/bin/headroom"]) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}
export function version() {
  const exe = binary();
  if (!exe) return null;
  const r = run([exe, "--version"], { timeout: 60000 });
  return r.rc === 0 ? (r.out || r.err).trim().split("\n").pop().slice(0, 60) : null;
}
export function available() {
  const exe = binary();
  if (!exe) return { ok: false, why: "headroom not installed", how: 'uv tool install "headroom-ai[sandbox]"' };
  return { ok: true, bin: exe, version: version() };
}

async function getJson(p, { port: pt = 0, timeout = 2000 } = {}) {
  try {
    const r = await fetch(baseUrl(pt) + p, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }  // proxy down or slow: null means no reading
}

/** Is anything bound to the port. Cheaper than a GET, and a refused connect is a clean "no". */
export function listening(p = 0) {
  return new Promise((resolve) => {
    const s = net.connect({ host: host(), port: port(p) });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(350, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
export async function health(p = 0) {
  const h = await getJson("/health", { port: p });
  if (h === null) return { ok: false, why: "no proxy on " + baseUrl(p) };
  return { ok: true, port: port(p), raw: h };
}
export async function stats(p = 0) { return getJson("/stats", { port: p, timeout: 8000 }); }

/** Env additions for one lane, or {} — the safe and common answer. Empty
 *  unless enabled AND installed AND `/health` answered right now. */
export async function laneEnv({ agent = "claude" } = {}) {
  if (!cfg().enabled) return {};
  if (!binary()) return {};
  if (!(await health()).ok) return {};
  const env = { ANTHROPIC_BASE_URL: baseUrl(), ENABLE_TOOL_SEARCH: "true" };
  if (agent === "codex") env.OPENAI_BASE_URL = baseUrl() + "/v1";
  return env;
}

export function proxyCmd() {
  // Only flags `headroom proxy --help` 0.37.0 lists: --host, --port.
  const argv = [binary() || "headroom", "proxy", "--host", host(), "--port", String(port())];
  for (const x of cfg().extra_args || []) argv.push(String(x));
  return argv;
}
function proxyEnv() {
  const env = { HEADROOM_PORT: String(port()) };
  if (!cfg().telemetry) { env.HEADROOM_TELEMETRY = "off"; env.DO_NOT_TRACK = "1"; }
  for (const [k, v] of Object.entries(cfg().env || {})) env[String(k)] = String(v);
  return env;
}

/** Bring a proxy up on our port, or adopt the one already there. Adoption is
 *  deliberate: an interactive `headroom wrap` may own the port, and killing
 *  somebody's session to start our own is not a saving. */
export async function start({ apply = false, wait = 90 } = {}) {
  const av = available();
  if (!av.ok) return { ...av, started: false };
  if (await listening()) {
    const h = await health();
    return { ok: h.ok, started: false, adopted: true, port: port(), why: h.ok ? "" : h.why };
  }
  if (!apply) return { ok: false, started: false, dry_run: true, cmd: proxyCmd().join(" "), port: port() };
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const fd = fs.openSync(LOG_FILE, "a");
  fs.writeSync(fd, `\n=== ${now()} ${proxyCmd().join(" ")}\n`);
  let child;
  try {
    child = spawn(proxyCmd()[0], proxyCmd().slice(1), { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...proxyEnv() } });
  } catch (e) { return { ok: false, started: false, why: String(e.message || e) }; }
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  let exited = null;
  child.on("exit", (code) => { exited = code ?? 1; });
  // The first start loads an ML stack, so the wait is generous and the poll cheap.
  const t0 = Date.now();
  while (Date.now() - t0 < wait * 1000) {
    if (exited !== null) return { ok: false, started: false, pid: child.pid, why: `proxy exited rc ${exited} — see ${rel(LOG_FILE)}` };
    if ((await health()).ok) return { ok: true, started: true, pid: child.pid, port: port(), seconds: Math.round((Date.now() - t0) / 100) / 10 };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, started: true, pid: child.pid, why: `no /health within ${wait}s — see ${rel(LOG_FILE)}` };
}

/** Only ever stops a proxy this factory started, and only after checking the
 *  pid still belongs to a headroom process: pids are recycled, and a stale
 *  pid file must not become a kill of whatever took the number. */
export function stop() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_FILE, "utf8").trim()); } catch { return { ok: false, why: "no proxy started by bb (var/headroom.pid absent)" }; }
  if (!pid) { rmPid(); return { ok: false, why: "pid file unreadable" }; }
  let cmdline = "";
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { rmPid(); return { ok: false, why: `pid ${pid} is not running` }; }
  if (!cmdline.includes("headroom")) return { ok: false, why: `pid ${pid} is not a headroom process (${cmdline.split("\0")[0]}); pid file left in place` };
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch (e) { rmPid(); return { ok: false, why: `pid ${pid}: ${e.message}` }; } }
  rmPid();
  return { ok: true, pid };
}
function rmPid() { try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ } }

/** What `bb run` calls once, before the first wave. Never blocks a run. */
export async function ensureForRun({ apply = false, agent = "claude" } = {}) {
  if (!cfg().enabled) return { env: {}, note: "headroom off (headroom.enabled = false)" };
  const av = available();
  if (!av.ok) return { env: {}, note: `headroom enabled but ${av.why} — lanes go direct` };
  if (!(await listening()) && cfg().autostart !== false) {
    const s = await start({ apply });
    if (!apply) return { env: {}, note: `would start: ${s.cmd || ""}` };
    if (!s.ok) return { env: {}, note: `headroom proxy failed: ${s.why || ""} — lanes go direct` };
  }
  const env = await laneEnv({ agent });
  if (!Object.keys(env).length) return { env: {}, note: "headroom proxy not answering — lanes go direct" };
  return { env, note: `lanes route through ${baseUrl()}` };
}

const numAt = (d, ...ks) => { let c = d; for (const k of ks) { if (!c || typeof c !== "object" || !(k in c)) return 0; c = c[k]; } return typeof c === "number" ? c : 0; };

/** The WIRE number, read off the proxy's own counters. Field names have moved
 *  between releases, so every read has a fallback and a zero is a zero, not a
 *  confident saving. Gross compression is reported next to the NET figure:
 *  rewriting bytes inside a cached prefix busts that prefix, and on a client
 *  as cache-heavy as a lane the re-write can cost more than it saved. */
export async function wire(p = 0) {
  const s = await stats(p);
  if (!s) return { ok: false, why: `no proxy on ${baseUrl(p)}` };
  const tok = s.tokens || {}, comp = s.compression || {}, tele = s.telemetry || {};
  const pc = s.prefix_cache || {}, cvc = pc.compression_vs_cache || {}, tot = pc.totals || {};
  const before = numAt(tok, "proxy_total_before_compression") || numAt(s, "summary", "compression", "total_tokens_before");
  const saved = numAt(tok, "proxy_compression_saved") || numAt(s, "summary", "compression", "total_tokens_removed");
  const allSaved = numAt(tok, "all_layers_saved") || numAt(s, "summary", "compression", "total_tokens_saved_all_layers");
  return {
    ok: true,
    requests: numAt(s, "requests", "total"),
    compressed: numAt(s, "summary", "compression", "requests_compressed"),
    before, after: Math.max(0, before - saved), saved,
    pct: numAt(tok, "proxy_savings_percent") || (before ? Math.round(1000 * saved / before) / 10 : 0),
    all_layers_saved: allSaved, all_layers_pct: numAt(tok, "all_layers_savings_percent"),
    output_saved: numAt(tok, "output_saved"), output_pct: numAt(tok, "output_reduction_percent"),
    cost_saved: numAt(s, "cost", "savings_usd") || numAt(s, "summary", "cost", "total_saved_usd"),
    cache_lost: numAt(cvc, "tokens_lost_to_cache_bust"), busts: numAt(cvc, "cache_bust_count"),
    net_saved: numAt(cvc, "net_tokens") || saved,
    cache_hit_rate: numAt(tot, "hit_rate"), cache_reads: numAt(tot, "cache_read_tokens"),
    ccr_entries: numAt(comp, "ccr_entries"), retrievals: numAt(comp, "ccr_retrievals"), retrieval_rate: numAt(tele, "global_retrieval_rate"),
  };
}

export async function doctor() {
  const av = available();
  const up = av.ok ? await listening() : false;
  const h = up ? await health() : { ok: false, why: "not listening" };
  const st = h.ok ? await stats() : null;
  return { installed: av.ok, bin: av.bin || null, version: av.version || null, enabled: Boolean(cfg().enabled), port: port(), listening: up,
    health: h.ok, stats: st !== null, pid_file: fs.existsSync(PID_FILE), why: av.ok ? (h.ok ? "" : h.why) : av.why };
}

export async function report() {
  const av = available();
  if (!av.ok) return `    not installed — ${av.how}`;
  const lines = [`    ${av.version || "headroom"}   ${cfg().enabled ? "ENABLED" : "off (headroom.enabled = false)"}`];
  const up = await listening();
  lines.push(`    proxy ${baseUrl()}   ${up ? "up" : "not running"}`);
  const w = up ? await wire() : { ok: false, why: "not running" };
  if (!w.ok) { lines.push(`    wire   ${w.why}`); return lines.join("\n"); }
  if (!w.requests) { lines.push("    wire   up, but no request has gone through it yet"); return lines.join("\n"); }
  lines.push(`    wire   ${w.requests} requests (${w.compressed} compressed)   ${human(w.before)} -> ${human(w.after)}   saved ${human(w.saved)} (${w.pct}%)   MEASURED`);
  if (w.cache_lost) lines.push(`    net    ${human(w.net_saved)} after ${human(w.cache_lost)} lost to ${w.busts} cache bust(s) — this is the number that is real`);
  if (w.cache_reads) lines.push(`    cache  ${w.cache_hit_rate}% prefix hit rate, ${human(w.cache_reads)} read back`);
  if (w.all_layers_saved && w.all_layers_saved !== w.saved) lines.push(`    all layers   ${human(w.all_layers_saved)} (${w.all_layers_pct}%) — includes deferred tool schemas, which are the harness, not the compressor`);
  if (w.output_saved) lines.push(`    output ${human(w.output_saved)} tokens the model did not write (${w.output_pct}%)`);
  if (w.ccr_entries) lines.push(`    CCR    ${w.ccr_entries} originals cached, ${w.retrievals} retrieved back`);
  return lines.join("\n");
}
