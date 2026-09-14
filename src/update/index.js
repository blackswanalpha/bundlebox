// update.js — `bb update`: is there a newer bundlebox, and install it.
// Reads the registry once a day at most (cached under ~/.bundlebox), never on
// an ordinary verb: a factory that phones home on every scan is not local.
import fs from "node:fs";
import path from "node:path";
import { HOME, PKG_ROOT } from "../core/paths.js";
import { run } from "../core/exec.js";
import { readJson, writeJson } from "../core/config.js";

export function currentVersion() { return readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0"; }
export function cmp(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
export async function latestVersion({ timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch("https://registry.npmjs.org/bundlebox/latest", { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()).version || null;
  } catch { return null; } finally { clearTimeout(t); }
}
/** Once a day, remember whether a newer version exists. Returns null when unknown. */
export async function checkCached() {
  fs.mkdirSync(HOME, { recursive: true });
  const p = path.join(HOME, "update-check.json");
  const c = readJson(p, {});
  if (c.checked_at && Date.now() - Date.parse(c.checked_at) < 86_400_000) return c.latest || null;
  const latest = await latestVersion();
  writeJson(p, { checked_at: new Date().toISOString(), latest, current: currentVersion() });
  return latest;
}
export async function update({ apply = false, log = console.log } = {}) {
  const cur = currentVersion();
  const latest = await latestVersion();
  if (!latest) { log(`  bundlebox ${cur}; registry unreachable, nothing changed`); return 0; }
  if (cmp(latest, cur) <= 0) { log(`  bundlebox ${cur} is current (registry: ${latest})`); return 0; }
  log(`  bundlebox ${cur} -> ${latest} available`);
  if (!apply) { log(`  run: bb update --apply   (or: npm i -g bundlebox@${latest})`); return 0; }
  const r = run(["npm", "install", "-g", `bundlebox@${latest}`, "--no-fund", "--no-audit", "--loglevel=error"], { timeout: 180000 });
  if (r.rc !== 0) { log(`  update failed (rc ${r.rc}): ${r.err.trim().split("\n").slice(-3).join(" | ")}`); return 1; }
  log(`  installed bundlebox ${latest}`);
  return 0;
}
