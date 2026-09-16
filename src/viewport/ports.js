// viewport/ports.js — which ports are open on this box, and which part of this
// workspace each one serves.
//
// `bb runbook` answers about the DECLARED system: the services `services.json`
// names, whether their processes are alive, whether their health URL answers.
// That is the right question and it is not the only one. A workspace is served
// by whatever is listening, not by whatever was declared — a dev server somebody
// started by hand in another terminal holds the port the declared one wants, and
// runbook reports the declared service as down without ever saying why.
//
// So this file measures the socket table directly and joins it to the
// declaration. Three sets come out of that join and they mean different things:
// a declared service that is listening, a declared service that is not, and a
// listener nobody declared whose process is working inside this tree. The third
// is the one no other verb reports and the one that explains the second.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel } from "../core/paths.js";
import { run, which } from "../core/exec.js";
import { services } from "../runbook/services.js";
import { status } from "../runbook/lifecycle.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** The port at the end of an address field, for both `127.0.0.1:8080` and
 *  `[::1]:8080`. Split on the LAST colon: an IPv6 address is full of them. */
function portOf(addr) {
  const i = String(addr).lastIndexOf(":");
  return i < 0 ? null : num(String(addr).slice(i + 1));
}
function hostOf(addr) {
  const i = String(addr).lastIndexOf(":");
  const h = i < 0 ? String(addr) : String(addr).slice(0, i);
  return h.replace(/^\[|\]$/g, "") || "*";
}

/** `users:(("momento",pid=1234,fd=7))` → { pid, proc }. First entry only: a
 *  socket with several is one process and its forks, and the parent is first. */
function usersField(s) {
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(s || "");
  return m ? { proc: m[1], pid: num(m[2]) } : { proc: "", pid: null };
}

function fromSs() {
  const r = run(["ss", "-ltnpH"], { timeout: 8000 });
  if (r.rc !== 0) return null;
  const rows = [];
  for (const line of r.out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[0] !== "LISTEN") continue;
    const port = portOf(f[3]);
    if (port === null) continue;
    rows.push({ port, host: hostOf(f[3]), ...usersField(line) });
  }
  return rows;
}

function fromLsof() {
  const r = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 10000 });
  if (r.rc !== 0) return null;
  const rows = [];
  let pid = null, proc = "";
  for (const line of r.out.split("\n")) {
    if (line.startsWith("p")) { pid = num(line.slice(1)); proc = ""; continue; }
    if (line.startsWith("c")) { proc = line.slice(1); continue; }
    if (!line.startsWith("n")) continue;
    const port = portOf(line.slice(1));
    if (port !== null) rows.push({ port, host: hostOf(line.slice(1)), pid, proc });
  }
  return rows;
}

function fromNetstat() {
  const r = run(["netstat", "-ltnp"], { timeout: 8000 });
  if (r.rc !== 0) return null;
  const rows = [];
  for (const line of r.out.split("\n")) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const f = line.trim().split(/\s+/);
    const addr = f[3];
    const port = portOf(addr);
    if (port === null) continue;
    const m = /(\d+)\/(\S+)/.exec(f[f.length - 1] || "");
    rows.push({ port, host: hostOf(addr), pid: m ? num(m[1]) : null, proc: m ? m[2] : "" });
  }
  return rows;
}

/** Every listening TCP socket on this box, deduplicated by port+host.
 *
 *  Three readers because the one that exists differs by box: `ss` on modern
 *  Linux, `lsof` on macOS, `netstat` on older images and inside containers that
 *  ship neither. `how` names the reader, because a table with no rows means
 *  "nothing is listening" under one reader and "no reader was available" under
 *  none, and a page that cannot tell those apart is lying quietly. */
export function listening() {
  const readers = [["ss", fromSs], ["lsof", fromLsof], ["netstat", fromNetstat]];
  for (const [bin, read] of readers) {
    if (!which(bin)) continue;
    const rows = read();
    if (!rows) continue;
    const seen = new Set(), keep = [];
    for (const r of rows) {
      const k = `${r.port}|${r.host}`;
      if (seen.has(k)) continue;
      seen.add(k);
      keep.push({ ...r, cwd: procCwd(r.pid) });
    }
    keep.sort((a, b) => a.port - b.port);
    return { how: bin, rows: keep };
  }
  return { how: "", rows: [], why: "no socket reader on this box (ss, lsof or netstat)" };
}

/** The working directory of a listening process, when the box will say. This is
 *  what attributes an undeclared listener to this workspace rather than to the
 *  rest of the machine, so a null here means "not attributable", never "not
 *  ours". */
function procCwd(pid) {
  if (!pid) return null;
  try { return fs.realpathSync(path.join("/proc", String(pid), "cwd")); } catch { /* not Linux, or not ours to read */ }
  const r = run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5000 });
  if (r.rc !== 0) return null;
  const line = r.out.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

const under = (p) => !!p && (p === ROOT || p.startsWith(ROOT + path.sep));

/** The join: every declared service, every observed listener, and which of them
 *  the other explains. */
export function ports() {
  const obs = listening();
  const live = status();
  const claimed = new Set();
  const rows = services().map((s) => {
    const st = live.find((r) => r.id === s.id) || {};
    const port = num(s.port);
    const hit = port === null ? null : obs.rows.find((o) => o.port === port) || null;
    if (hit) claimed.add(`${hit.port}|${hit.host}`);
    const cwd = String(s.cwd || ".");
    return {
      id: s.id, group: s.group || "", port, host: hit ? hit.host : "",
      supports: cwd === "." ? rel(ROOT) || "." : cwd,
      declared: s.cmd || "", health: s.health || "", url: port === null ? "" : `http://127.0.0.1:${port}`,
      listening: !!hit, pid: hit ? hit.pid : (st.pid || null), proc: hit ? hit.proc : "",
      process_state: st.state || "down", answering: st.answering || "", http: st.status ?? null, ms: st.ms ?? null,
      why: st.why || "", memory_bytes: st.memory_bytes ?? null, cap_bytes: st.cap_bytes ?? null,
      cpu_s: st.cpu_s ?? null, log: st.log || "",
      // The one row that explains a "down" nobody could explain from runbook
      // alone: the port is held, and not by us.
      held_by_other: !!(hit && st.state !== "up"),
    };
  });
  // One row per PORT, not per socket: a server bound to both 0.0.0.0 and :: is
  // one thing a person can open, and listing it twice makes the table look like
  // a leak that is not there.
  const strays = [];
  const seen = new Set();
  for (const o of obs.rows) {
    if (claimed.has(`${o.port}|${o.host}`) || !under(o.cwd) || seen.has(o.port)) continue;
    seen.add(o.port);
    strays.push({ ...o, supports: rel(o.cwd) || "." });
  }
  return {
    root: ROOT, generated: new Date().toISOString(), how: obs.how, why: obs.why || "",
    services: rows, strays, observed: obs.rows.length,
    up: rows.filter((r) => r.listening).length, of: rows.length,
  };
}
