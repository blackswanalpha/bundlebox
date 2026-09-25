// janitor/resolve.js — the pass that makes hallucination a compile error.
//
// The expensive way to catch a model stating something false is to catch it at
// generation: sample the same claim N times and measure disagreement
// (SelfCheckGPT), or cluster the samples by meaning and take the entropy
// (semantic entropy, Nature 2024). Both work. Both cost N generations per
// claim, which is why neither runs over ten thousand memory lines on a cron.
//
// This pass attacks the other end. A large share of what a long-lived agent
// gets confidently wrong is not invented at generation time — it is READ OUT OF
// ITS OWN MEMORY, stated as fact, in a window where it looks exactly as
// authoritative as everything else. "The grow loop is in src/pinpoint/grow.js"
// was true when it was written and the file moved in month four. The model is
// not confabulating; it is quoting a rotted anchor with the full confidence the
// anchor used to deserve.
//
// So every claim that carries an anchor gets it resolved against the tree as it
// is now, and the anchor is the cheapest possible evidence: does the file
// exist, does the line exist, does the symbol still appear. Filesystem calls.
// No model, no tokens, no network.
//
//   live         the anchor resolves. The claim may still be wrong, but it is
//                about something that exists.
//   drifted      the file is there and the line or symbol is not. The most
//                dangerous state, because the claim still looks checkable.
//   dead         the file is gone. Everything downstream of it is a quotation
//                from a tree that no longer exists.
//   external     a URL. Not checked: this pass does not touch the network.
//   none         no anchor at all — and that is itself the finding, because a
//                claim nothing can check is a claim nothing can ever retract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, OUT, abs } from "../core/paths.js";
import { diag } from "./heap.js";
import { isUncheckableClaim } from "./parse.js";

const cache = new Map();
function lines(file) {
  if (cache.has(file)) return cache.get(file);
  let v = null;
  try {
    const st = fs.statSync(file);
    // Two megabytes is a generated bundle, not a file a memory line points at.
    v = st.isFile() && st.size < 2_000_000 ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  } catch { v = null; }
  cache.set(file, v);
  return v;
}
export const resetCache = () => cache.clear();

// The snapgen symbol tables already hold `name  file:line` for the whole tree
// and are rebuilt when their inputs change. Reading them is the difference
// between resolving a bare symbol in constant time and grepping the tree once
// per claim.
let symbolIndex = null;
function symbols() {
  if (symbolIndex) return symbolIndex;
  symbolIndex = new Map();
  const dir = path.join(OUT, "snapgen");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^symbols-.*\.md$/.test(n)); } catch { names = []; }
  for (const n of names) {
    let text; try { text = fs.readFileSync(path.join(dir, n), "utf8"); } catch { continue; }  // table removed since readdir
    for (const m of text.matchAll(/^\s*([A-Za-z_$][\w$]*)\s+(\S+):(\d+)\s*$/gm)) {
      if (!symbolIndex.has(m[1])) symbolIndex.set(m[1], { file: m[2], line: Number(m[3]) });
    }
  }
  return symbolIndex;
}
export const resetSymbols = () => { symbolIndex = null; };

/** Resolve one anchor. Returns the status and, when it can, where the thing
 *  actually is now — which is what makes the diagnostic fixable instead of just
 *  true. */
export function resolveAnchor(a, { root = ROOT, base = "" } = {}) {
  if (!a) return { status: "none" };
  if (a.url && !a.file && !a.symbol) return { status: "external", url: a.url };

  if (a.file) {
    // A path is resolved against the file that WROTE it before it is resolved
    // against the workspace root. This is not a nicety: a MEMORY.md index whose
    // every line reads `- [Title](thing.md)` names its siblings, and resolving
    // those from the root called 1909 of 5736 anchors dead on the first run.
    // Nearly all of them existed, one directory over.
    const candidates = [];
    if (base && !path.isAbsolute(a.file)) candidates.push(path.resolve(base, a.file));
    candidates.push(abs(a.file));
    let p = null, src = null;
    for (const c of candidates) { const l = lines(c); if (l !== null) { p = c; src = l; break; } }
    if (src === null) {
      // Still nothing. Fall back to the symbol table's idea of where that
      // basename lives, so a correct claim written from the wrong cwd is
      // reported as drifted with a destination rather than flatly dead.
      const bn = path.basename(a.file);
      for (const { file } of symbols().values()) if (path.basename(file) === bn) return { status: "drifted", why: "path does not resolve from the root", moved_to: file };
      return { status: "dead", why: "file does not exist" };
    }
    if (a.symbol && !src.some((l) => l.includes(a.symbol))) {
      const hit = symbols().get(a.symbol);
      return { status: "drifted", why: `${a.symbol} is not in this file`, moved_to: hit ? `${hit.file}:${hit.line}` : null };
    }
    if (a.line && a.line > src.length) return { status: "drifted", why: `line ${a.line} is past the end (${src.length} lines)` };
    return { status: "live", at: `${a.file}${a.line ? `:${a.line}` : ""}` };
  }

  if (a.symbol) {
    const hit = symbols().get(a.symbol);
    return hit ? { status: "live", at: `${hit.file}:${hit.line}` } : { status: "dead", why: `no declaration of ${a.symbol} in the symbol tables` };
  }
  return { status: "none" };
}

/** Resolve the whole heap in place and emit one diagnostic per problem.
 *
 *  The severities are chosen so a hook can act on them. A dead anchor on a
 *  rule is an error: it is a constraint about a file that does not exist, so
 *  either the rule is obsolete or the tree is broken, and both need a human.
 *  Everything else is a warning, because a drifted fact is still recoverable
 *  and this pass is not allowed to guess which way. */
// `parse` abbreviates a path outside the workspace with `os.homedir()`, so this
// is the only thing that can expand it back. `process.env.HOME` is unset on
// Windows — it is USERPROFILE there — which left every `~`-prefixed source with
// a base directory of `<root>/~/...` and reported its anchors dead on a platform
// this package ships for.
export function resolve(objects, { root = ROOT, home = os.homedir() } = {}) {
  const diags = [];
  const counts = { live: 0, drifted: 0, dead: 0, external: 0, none: 0, uncheckable: 0 };
  const baseOf = (source) => {
    if (!source) return "";
    const s = source.startsWith("~") && home ? path.join(home, source.slice(1)) : source;
    return path.dirname(path.isAbsolute(s) ? s : abs(s));
  };
  for (const o of objects) {
    const r = resolveAnchor(o.anchor, { root, base: baseOf(o.source) });
    o.resolution = r.status;
    o.meta = { ...o.meta, resolution_why: r.why || "", moved_to: r.moved_to || r.at || "" };
    counts[r.status] = (counts[r.status] || 0) + 1;

    if (r.status === "dead") {
      diags.push(diag(o.kind === "rule" ? "error" : "warning", "dead-anchor",
        `${o.kind} points at ${o.anchor.file || o.anchor.symbol}, which does not exist — anything quoting this is quoting a tree that is gone`, o,
        { fix: "retract it, or repoint it at where the thing moved" }));
    } else if (r.status === "drifted") {
      diags.push(diag("warning", "drifted-anchor",
        `${o.kind} anchor has moved: ${r.why}${r.moved_to ? ` (now ${r.moved_to})` : ""}`, o,
        { fix: r.moved_to ? `repoint to ${r.moved_to}` : "re-check the claim against the file" }));
    } else if (r.status === "none" && isUncheckableClaim(o)) {
      // A specific number with nothing behind it. It reads as authoritative,
      // it can never be proved stale, and so it gets quoted forever at whatever
      // value it had the day somebody wrote it down.
      counts.uncheckable++;
      diags.push(diag("warning", "uncheckable-claim",
        "states a specific number with nothing to check it against — it can never be proved stale, so it will be quoted forever", o,
        { fix: "add a file:line, a commit or a command that reproduces it" }));
    }
  }
  return { diags, counts };
}
