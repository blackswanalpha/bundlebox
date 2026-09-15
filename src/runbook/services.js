// runbook/services.js — the DECLARED system: which services exist, what starts
// them, and which sets are started together.
//
// Split from the running half because these are different kinds of fact and
// they change at different times. A row in `services.json` is a reviewable
// statement about what this workspace is made of; whether a process is alive
// right now is a measurement. Keeping them apart is what lets `bb runbook
// services` answer without touching a pid, a socket or systemd.
//
// A group is the unit of work: nobody starts one service, they start the set a
// test needs. Two groups come free — `all`, and one per service id — so
// `up app` still means something before any group is declared.
import fs from "node:fs";
import path from "node:path";
import { BB_DIR, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { initBuckets, BUCKETS } from "./digest.js";

export const FILE = () => path.join(BB_DIR, "runbook", "services.json");

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

