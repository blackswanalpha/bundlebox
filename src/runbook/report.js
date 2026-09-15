// runbook/report.js — the printing half of the verb.
//
// Separated from the dispatch because deciding WHAT to do and rendering WHAT
// CAME BACK are different jobs, and the verb had grown into a single 151-line
// function where the two were interleaved. Nothing here decides anything: every
// function takes a result and returns lines.
//
// One rule runs through all of it, and it is the reason `logs` exists at all:
// **nothing prints raw log lines by default.** Lines become signatures and known
// failures arrive NAMED, so forty thousand lines become about twenty rows and
// the raw file stays on disk with its path printed.
import { pad, table, human as humanN } from "../core/util.js";
import * as mem from "./memory.js";

const indent = (s, by = "  ") => s.split("\n").map((l) => by + l).join("\n");

/** One probe result, as one line. Shared by `up --wait` and `wait`, because a
 *  service that answered should read identically whichever verb asked. */
export const probeLine = (t) =>
  `  ${pad(t.name, 14)} ${pad(t.state, 10)} ${t.status ?? ""} ${t.ms != null ? `${t.ms}ms` : ""} ${t.attempts ? `after ${t.attempts} probe${t.attempts === 1 ? "" : "s"}` : ""} ${t.why || ""}`.trimEnd();

export function services(rows, file) {
  if (!rows.length) return [`  no services declared. bb runbook init writes ${file}`];
  return [indent(table(rows.map((s) => [s.id, s.group || "", s.cmd, s.health || "", s.memory || "", s.boot ? `${s.boot}s` : ""]),
    { header: ["id", "group", "command", "health", "cage", "boot"] }))];
}

export function groups(g) {
  return [
    indent(table(Object.entries(g).map(([name, ids]) => [name, ids.length, ids.join(" ")]),
      { header: ["group", "n", "services"] })),
    "\n  a group is the unit of work: nobody starts one service, they start the set a test needs.",
  ];
}

export function status(rows) {
  if (!rows.length) return ["  no services declared. bb runbook init"];
  return [indent(table(rows.map((r) => [r.id, r.state, r.answering || (r.health ? "?" : ""), r.status ?? "",
    r.ms != null ? `${r.ms}ms` : "", r.memory_bytes ? `${Math.round(r.memory_bytes / 1048576)}M` : "", r.why || ""]),
    { header: ["service", "process", "answering", "code", "latency", "memory", ""] }))];
}

export function perf(rows) {
  if (!rows.length) return { lines: ["  nothing is up"], hot: [] };
  const a = mem.available();
  const lines = [indent(table(rows.map((r) => [r.id,
    r.memory_bytes ? `${Math.round(r.memory_bytes / 1048576)}M` : "?",
    r.cap_bytes ? mem.human(r.cap_bytes) : "no cage",
    r.memory_bytes && r.cap_bytes ? `${Math.round((r.memory_bytes / r.cap_bytes) * 100)}%` : "",
    r.cpu_s != null ? `${r.cpu_s}s` : "", r.ms != null ? `${r.ms}ms` : ""]),
    { header: ["service", "memory", "cage", "of cage", "cpu", "latency"] })),
    `\n  ${mem.human(a.bytes)} available on this box (${a.via})`];
  // Reclaim starts at 90% of the cage. A service sitting above that is being
  // throttled by the kernel, and its timings describe the cage, not the code.
  const hot = rows.filter((r) => r.memory_bytes && r.cap_bytes && r.memory_bytes / r.cap_bytes >= 0.9);
  return { lines, hot };
}

/** The digest, as a person reads it: which files moved, the totals, the failures
 *  this workspace already paid to learn, and then the signatures. */
export function logs(r, { all = false, sample = false, top = 40 } = {}) {
  if (!r.files.length) return ["  no logs yet"];
  const L = [];
  for (const f of r.files) {
    L.push(`  ${f.file}  ${humanN(f.bytes)}B ${all ? "in full" : "since the last call"} (${f.from}→${f.to})` +
      `${f.rotated ? "  ROTATED, re-read from the top" : ""}${f.why ? `  ${f.why}` : ""}`);
  }
  const t = r.totals;
  L.push(`\n  ${t.lines} line${t.lines === 1 ? "" : "s"} · ${t.errors} E · ${t.warnings} W · ` +
    `${r.files.reduce((a, f) => a + (f.distinct || 0), 0)} distinct signatures · via ${r.via}`);
  if (r.buckets.length) {
    L.push("\n  known failures");
    for (const b of r.buckets) L.push(`    ${pad(b.severity, 7)} ${pad(b.id, 22)} ×${pad(String(b.n), 5)} ${b.says}`);
  }
  const sigs = r.files.flatMap((f) => (f.signatures || []).map((s) => ({ ...s, file: f.file })));
  if (!sigs.length) L.push("\n  nothing new");
  else {
    L.push("\n  top signatures");
    L.push(indent(table(sigs.sort((a, b) => b.n - a.n).slice(0, top)
      .map((s) => (sample ? [s.n, s.sig, s.sample || ""] : [s.n, s.sig])),
      { header: sample ? ["n", "signature", "one real line"] : ["n", "signature"] }), "    "));
  }
  L.push("\n  signatures, not lines: every digit, uuid, hash and path erased. The raw file is on disk at the path above.");
  return L;
}
