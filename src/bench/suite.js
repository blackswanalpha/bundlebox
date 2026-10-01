// bench/suite.js — the tasks a benchmark runs, and where they come from.
//
// A suite is data on disk so a run is reproducible and a number can be argued
// with. `derive` writes one from what this workspace already knows: the open
// findings that name a file are exactly the tasks a session would be given, so
// a suite nobody wrote by hand is still a suite about real work.
import fs from "node:fs";
import path from "node:path";
import { BB_DIR, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import * as store from "../core/store.js";

export const DIR = () => path.join(BB_DIR, "bench");
export const file = (id) => path.join(DIR(), `${id}.json`);

export function ids() {
  try { return fs.readdirSync(DIR()).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort(); }
  catch { return []; } // no suites directory yet
}

export function load(id) {
  const s = readJson(file(id), null);
  if (!s) return null;
  return { id, title: s.title || id, note: s.note || "", tasks: (s.tasks || []).filter((t) => t && t.problem) };
}

/** Findings become tasks: the title is the problem statement a session would be
 *  handed, and the finding's own path is the file it names. Highest severity
 *  first, one task per file so the suite is not six variations of one read. */
export function derive({ limit = 12 } = {}) {
  const SEV = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  const open = store.get("findings", []).filter((f) => f.status === "open" && f.path);
  const seen = new Set();
  const tasks = [];
  for (const f of open.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0))) {
    if (seen.has(f.path) || tasks.length >= limit) continue;
    seen.add(f.path);
    tasks.push({ id: f.id, title: String(f.title || "").slice(0, 120),
      problem: String(f.title || "").replace(/`/g, "").slice(0, 200), files: [f.path], from: f.detector });
  }
  return tasks;
}

export function write(id, spec) {
  fs.mkdirSync(DIR(), { recursive: true });
  writeJson(file(id), spec);
  return rel(file(id));
}
