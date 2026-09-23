// filecache.js — per-file derivations that survive between runs, keyed by the
// file's content sha1. A scan re-derived the same identifier sets, token counts
// and secret hits from the same bytes every thirty minutes; on django that was
// ~2.5 s of a ~10 s scan for files that had not changed.
//
// Only a value that is a pure function of ONE file's path and bytes belongs
// here. Anything that reads a second file (an import graph, a duplicate pair)
// would be served stale when the other file changed.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./config.js";
import { PKG_ROOT, VAR } from "./paths.js";

// Bump when a cached derivation changes what it returns. The package version
// is part of the key too, so a release never reads the previous one's entries.
export const SCHEMA = 1;
const file = () => path.join(VAR, "filecache.json");
const version = () => `${SCHEMA}:${readJson(path.join(PKG_ROOT, "package.json"), {})?.version || "?"}`;

let _doc = null, _dirty = false;
const _touched = new Set();
function doc() {
  if (_doc) return _doc;
  const v = version();
  const d = readJson(file(), null);
  _doc = d && d.version === v && d.files && typeof d.files === "object" ? d : { version: v, files: {} };
  return _doc;
}

/** `compute()` for (rel, kind), unless a previous run already derived it from
 *  bytes with this sha1. The value must survive JSON. */
export function derived(rel, sha, kind, compute) {
  const files = doc().files;
  _touched.add(rel);
  let e = files[rel];
  if (e && e.sha === sha && Object.hasOwn(e.v, kind)) return e.v[kind];
  const v = compute();
  if (!e || e.sha !== sha) e = files[rel] = { sha, v: {} };
  e.v[kind] = v;
  _dirty = true;
  return v;
}

/** Write what changed. With `keep` (the rels of a full walk), entries for files
 *  neither walked nor touched this run are dropped, so a deleted file's entry
 *  does not ride along forever. A partial run passes nothing and prunes nothing. */
export function flush(keep = null) {
  if (!_doc) return;
  if (keep) for (const r of Object.keys(_doc.files)) if (!keep.has(r) && !_touched.has(r)) { delete _doc.files[r]; _dirty = true; }
  _touched.clear();
  if (!_dirty) return;
  // Compact, unlike the documents a person reads: this one is ~10 MB on django
  // and nobody diffs it.
  const p = file(), tmp = p + ".tmp" + process.pid;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_doc));
    fs.renameSync(tmp, p);
    _dirty = false;
  } catch { /* a cache that could not be written is a slower next run, not a failed one */ }
}

/** Drop the in-memory copy, e.g. after a test rewrites the tree. */
export function reset() { _doc = null; _dirty = false; _touched.clear(); }
