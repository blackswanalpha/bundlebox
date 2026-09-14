// estimate.js — how many tokens is this text, without asking anyone.
//
// chars/4 under-counts code by 15-25% because code is punctuation-dense; an
// under-count is what blows a window mid-lane. The model is linear in three
// counts a BPE tokenizer actually reacts to:
//
//     tokens ~= w*words + p*punctuation + s*indent_runs
//
// Coefficients ship fitted and are refit against real transcripts by
// `bb tokens calibrate`, so the estimator is corrected by the thing it estimates.
import fs from "node:fs";
import { load, DEFAULTS } from "../core/config.js";
import { kindOf, readText, walk } from "../core/fs.js";
import { abs, rel } from "../core/paths.js";
import * as kernel from "../core/kernel.js";
import { PROSE_SUFFIX } from "../core/fs.js";

const WORD = /\w+/g, PUNCT = /[^\w\s]/g, INDENT = /[ \t]{2,}|\n/g;
const count = (re, s) => { let n = 0; re.lastIndex = 0; while (re.exec(s)) n++; return n; };

function coef(kind, base = false) {
  const t = base ? DEFAULTS.tokens : load().tokens;
  return kind === "prose" ? [t.prose_w, t.prose_p, t.prose_s] : [t.code_w, t.code_p, t.code_s];
}
export function features(s) { return { words: count(WORD, s), punct: count(PUNCT, s), indent: count(INDENT, s), chars: s.length }; }
export function text(s, kind = "prose", base = false) {
  if (!s) return 0;
  const [w, p, sp] = coef(kind, base);
  const f = features(s);
  return Math.round(w * f.words + p * f.punct + sp * f.indent);
}
export function file(p) {
  const a = abs(p);
  try { if (!fs.statSync(a).isFile()) return 0; } catch { return 0; }
  return text(readText(a), kindOf(a));
}
/** Per-file estimates plus total; the router bin-packs on the per-file numbers. */
export function files(paths) {
  // `estimate <paths>` says paths, so a directory is the tree under it, not a
  // miss. Expanding here rather than in the verb keeps one walker for every
  // caller; an unreadable entry stays in the list so it is still reported.
  const list = [];
  for (const raw of paths) {
    let st; try { st = fs.statSync(abs(raw)); } catch { list.push(raw); continue; }
    if (st.isDirectory()) list.push(...walk(abs(raw)));
    else list.push(raw);
  }
  // Over a few hundred files the kernel reads and counts in one process; the
  // coefficients travel with the call so both sides use the calibrated set.
  if (list.length > 150) {
    const t = load().tokens;
    const k = kernel.call("estimate", { paths: list.map(abs), prose_suffix: PROSE_SUFFIX, ...t });
    if (k && k.files) {
      const out = { files: {}, total: k.total, bytes: k.bytes, missing: k.missing || [], via: "kernel" };
      for (const [p, n] of Object.entries(k.files)) out.files[rel(p)] = n;
      return out;
    }
  }
  return filesJs(list);
}
export function filesJs(paths) {
  const out = { files: {}, total: 0, bytes: 0, missing: [] };
  for (const raw of paths) {
    const a = abs(raw);
    let st; try { st = fs.statSync(a); } catch { out.missing.push(raw); continue; }
    if (!st.isFile()) { out.missing.push(raw); continue; }
    const n = file(a);
    out.files[rel(a)] = n; out.total += n; out.bytes += st.size;
  }
  return out;
}
export function tree(base, suffixes) { return files(walk(abs(base), suffixes ? { suffixes } : {})); }
/** Cheap upper bound used when the caller only has a byte count. */
export const fromBytes = (bytes, kind = "code") => Math.round(bytes / (kind === "prose" ? 4.2 : 3.3));
