// arc/read.js — the JavaScript reader for the index `arc` compiles.
//
// Why this exists, measured rather than assumed. `arc lookup` answers a
// declaration query in 0.082ms against the markdown scan's 2.29ms, which is 28
// times faster and completely irrelevant: spawning the process costs 2.20ms, so
// end to end the two were 2.28ms and 2.29ms. A guard that runs once per tool
// call cannot pay for a process.
//
// So the win is the FORMAT, not the language. `arc` is the compiler — it turns
// six markdown tables into one binary index, and it is the right place for that
// work because it scales with the tree. This file is the hot path: it reads the
// compiled file and binary-searches it in the same process, which is where the
// 28x actually lands.
//
// The format is arc/src/index.rs. Two sorted id arrays — one by lowercased
// name, one by the REVERSED lowercased name — so exact, prefix and suffix are
// all one binary search, a suffix being a prefix of the reversal.
import fs from "node:fs";
import path from "node:path";
import { OUT } from "../core/paths.js";

export const FILE = () => path.join(OUT, "arc", "index.arc");
export const MAGIC = "ARC1";
const HEADER = 20;
const REC = 24;

let cache = null;

/** The index, or null when it is absent or was written by another version.
 *
 *  Cached per process against mtime and size. A hook process makes one query
 *  and exits, so the cache is for the CLI and the MCP server, where one process
 *  answers many. */
export function open(file = FILE()) {
  let st;
  try { st = fs.statSync(file); } catch { return null; } // no index yet: the guards scan the tables
  if (cache && cache.file === file && cache.mtime === st.mtimeMs && cache.size === st.size) return cache;
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; } // removed between the stat and the read
  if (buf.length < HEADER || buf.toString("latin1", 0, 4) !== MAGIC) return null;
  const count = buf.readUInt32LE(4);
  const poolLen = buf.readUInt32LE(8);
  const built = Number(buf.readBigUInt64LE(12));
  const fwd = HEADER;
  const rev = fwd + count * 4;
  const recs = rev + count * 4;
  const pool = recs + count * REC;
  if (pool + poolLen > buf.length) return null;              // truncated: a half index answers wrongly
  cache = { file, mtime: st.mtimeMs, size: st.size, buf, count, poolLen, built, fwd, rev, recs, pool };
  return cache;
}

export function reset() { cache = null; }

const idAt = (ix, arr, i) => ix.buf.readUInt32LE(arr + i * 4);
function rowAt(ix, id) {
  const o = ix.recs + id * REC;
  const no = ix.buf.readUInt32LE(o), nl = ix.buf.readUInt16LE(o + 4);
  const fo = ix.buf.readUInt32LE(o + 6), fl = ix.buf.readUInt16LE(o + 10);
  return {
    symbol: ix.buf.toString("utf8", ix.pool + no, ix.pool + no + nl),
    file: ix.buf.toString("utf8", ix.pool + fo, ix.pool + fo + fl),
    line: ix.buf.readUInt32LE(o + 12),
  };
}
const reverse = (s) => [...s].reverse().join("");
const keyOf = (ix, arr, i, reversed) => {
  const k = rowAt(ix, idAt(ix, arr, i)).symbol.toLowerCase();
  return reversed ? reverse(k) : k;
};

/** First position whose key is >= needle. */
function lowerBound(ix, needle, reversed) {
  const arr = reversed ? ix.rev : ix.fwd;
  let lo = 0, hi = ix.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyOf(ix, arr, mid, reversed) < needle) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Ids whose lowercased name starts with `p`, or ends with it when reversed. */
export function walk(ix, p, reversed, cap) {
  const needle = reversed ? reverse(p) : p;
  const arr = reversed ? ix.rev : ix.fwd;
  const out = [];
  for (let i = lowerBound(ix, needle, reversed); i < ix.count && out.length < cap; i++) {
    if (!keyOf(ix, arr, i, reversed).startsWith(needle)) break;
    out.push(idAt(ix, arr, i));
  }
  return out;
}

/** The same question `bb`'s search guard asks the markdown tables, answered
 *  from the compiled index. `shapes` is what the caller will accept; the guard
 *  wants exact, prefix and suffix, and asking for fewer keeps a lookup precise.
 *
 *  Returns null when there is no usable index, so a caller can fall back
 *  instead of reporting "nothing is declared" — which is a different answer. */
export function lookup(terms, { cap = 14, under = "", shapes = ["exact", "prefix", "suffix"], file = FILE() } = {}) {
  const ix = open(file);
  if (!ix) return null;
  const tl = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!tl.length) return [];
  const want = (k) => shapes.includes(k);
  const ids = new Set();
  for (const t of tl) {
    if (want("prefix") || want("exact")) for (const id of walk(ix, t, false, cap * 4)) ids.add(id);
    if (want("suffix")) for (const id of walk(ix, t, true, cap * 4)) ids.add(id);
  }
  const exactOnly = want("exact") && !want("prefix") && !want("suffix");
  const hits = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const r = rowAt(ix, id);
    if (exactOnly && !tl.includes(r.symbol.toLowerCase())) continue;
    if (under && !r.file.startsWith(under)) continue;
    hits.push(r);
    if (hits.length >= cap) break;
  }
  return hits;
}

/** Every declared name, once. The one full pass over the index anybody makes,
 *  and `bb lathe` makes it once per learn rather than once per query. */
export function names(file = FILE()) {
  const ix = open(file);
  if (!ix) return null;
  const seen = new Set();
  for (let id = 0; id < ix.count; id++) seen.add(rowAt(ix, id).symbol);
  return [...seen];
}

export function stat(file = FILE()) {
  const ix = open(file);
  if (!ix) return null;
  return { symbols: ix.count, pool_bytes: ix.poolLen, bytes: ix.size, built: new Date(ix.built * 1000).toISOString(), age_seconds: Math.max(0, Math.round(Date.now() / 1000 - ix.built)) };
}
