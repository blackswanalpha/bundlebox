// cache.js — is this derived artefact still true?
//
// The fingerprint is stat-based, (rel, mtime_ns, size) per input, rather than a
// content hash: stat-ing a tree costs milliseconds, hashing it costs seconds, and
// the cheap version's failure mode (a touched-but-unchanged file rebuilds one
// table) costs nothing. The count prefix makes a build that silently stopped
// finding its inputs visible as "3:…" instead of reading as "nothing drifted"
// (doctrine 7). This is the ONE fingerprint in the tree (doctrine 6).
import fs from "node:fs";
import path from "node:path";
import { VAR, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { sha1 } from "../core/util.js";
import * as kernel from "../core/kernel.js";
import { ROOT } from "../core/paths.js";

/** `<count>:<sha1>` over (rel, mtime_ns, size) for every input that exists. */
export function fingerprint(inputs) {
  // The kernel stats a large input list in one process; the JS path is the
  // same algorithm and the selftest pins them equal. Small lists stay in JS:
  // a process spawn costs more than a hundred stats.
  if ((inputs || []).length > 200) {
    const k = kernel.call("fingerprint", { root: ROOT, inputs: [...inputs] });
    if (k && k.fingerprint) return k.fingerprint;
  }
  return fingerprintJs(inputs);
}
export function fingerprintJs(inputs) {
  const rows = new Map();
  for (const p of inputs || []) {
    const r = rel(p);
    if (rows.has(r)) continue;
    let st;
    try { st = fs.statSync(p, { bigint: true }); } catch { continue; }
    if (!st.isFile()) continue;
    rows.set(r, `${r}:${st.mtimeNs}:${st.size}`);
  }
  const sorted = [...rows.values()].sort();
  return `${sorted.length}:${sha1(sorted.join("\n"))}`;
}
export function inputsOf(fp) {
  const n = parseInt(String(fp || "").split(":")[0], 10);
  return Number.isFinite(n) ? n : 0;
}

export const metaPath = (name) => path.join(VAR, "kit", `${name}.json`);
export const readMeta = (name) => readJson(metaPath(name), null) || {};
export function writeMeta(name, meta) { writeJson(metaPath(name), meta); return metaPath(name); }

const onDisk = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Fresh means the recorded fingerprint equals the current one AND the artefact
 *  it describes is on disk. Metadata without its artefact is a deleted table. */
export function fresh(meta, artefactPath, fp) {
  return !!(meta && fp && meta.fingerprint === fp && onDisk(artefactPath));
}
export function state(meta, artefactPath, fp) {
  if (!meta || !meta.fingerprint || !onDisk(artefactPath)) return "missing";
  return meta.fingerprint === fp ? "fresh" : "stale";
}
