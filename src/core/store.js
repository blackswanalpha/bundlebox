// store.js — the factory's ledger. JSON documents for state that is replaced
// (findings, units, lanes) and append-only JSONL for state that accumulates
// (episodes, sessions, outcomes). No database process, no dependency; a cron
// worker reads what is on disk or it does not run.
import fs from "node:fs";
import path from "node:path";
import { VAR, ensureDirs } from "./paths.js";
import { readJson, writeJson } from "./config.js";
import { now, sha1 } from "./util.js";

const doc = (name) => path.join(VAR, `${name}.json`);
const log = (name) => path.join(VAR, `${name}.jsonl`);

export function get(name, fallback = []) { return readJson(doc(name), fallback); }
export function put(name, value) { ensureDirs(); writeJson(doc(name), value); return value; }
export function append(name, row) {
  ensureDirs();
  fs.appendFileSync(log(name), JSON.stringify({ at: now(), ...row }) + "\n");
  return row;
}
export function rows(name, { limit = 0 } = {}) {
  let text;
  try { text = fs.readFileSync(log(name), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn write is a skipped row, never a crash */ }
  }
  return limit ? out.slice(-limit) : out;
}

/** Findings: keyed by a stable id so a re-scan updates rather than duplicates,
 *  and a finding that stopped appearing is closed rather than deleted. */
export function findingId(f) { return sha1(`${f.detector}|${f.path || ""}|${f.key || f.title}`).slice(0, 10); }
export function mergeFindings(fresh, { detectors }) {
  const prev = get("findings", []);
  const seen = new Set();
  const out = [];
  const byId = new Map(prev.map((f) => [f.id, f]));
  for (const f of fresh) {
    const id = f.id || findingId(f);
    seen.add(id);
    const old = byId.get(id);
    out.push({ ...f, id, first_seen: old?.first_seen || now(), last_seen: now(), status: old?.status === "resolved" ? "open" : old?.status === "fixed" ? "fixed" : (old?.status || "open"), seen_count: (old?.seen_count || 0) + 1 });
  }
  for (const f of prev) {
    if (seen.has(f.id)) continue;
    if (detectors.has(f.detector) && f.status === "open") out.push({ ...f, status: "resolved", resolved_at: now() });
    else out.push(f);
  }
  put("findings", out);
  return out;
}
export function openFindings() { return get("findings", []).filter((f) => f.status === "open"); }
