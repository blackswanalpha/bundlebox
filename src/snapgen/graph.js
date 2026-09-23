// snapgen/graph.js — who reaches what: the edge set the rest of the box was
// missing, and the two questions it makes answerable for free.
//
//   bb snapgen skeleton <file>   the declarations, not the bodies
//   bb snapgen blast [--since]   what a diff can reach, and what reading it costs
//
// The shape is borrowed from Graft (trailhq/Graft), which showed that a
// persistent, readable graph of a repository is worth more to an agent than
// another search: an agent that can ask "who calls this" stops re-deriving the
// answer on every task. What is NOT borrowed is the storage — no embeddings, no
// vector index, no second database. bundlebox already walks the tree and already
// has a symbol index, so the edges are computed from those and cached under the
// one fingerprint the rest of the box uses.
//
// Two edge kinds, and they are deliberately not merged:
//
//   imports    a resolved module path. Exact: the file named it.
//   references a declared name appearing in another file. Heuristic: a name
//              like `run` or `state` collides, so a reference edge is evidence
//              and never proof, and the report says which kind it is.
//
// A blast radius built only from imports misses dynamic dispatch; one built
// only from references is noise. Reporting them separately is what lets a
// reader decide which they are looking at.
import path from "node:path";
import { ROOT, rel, abs } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { git, gitOk } from "../core/exec.js";
import { human } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { codeFiles, SYMBOL_SUFFIX } from "./walk.js";
import { symbolIndex } from "./symbols.js";
import { signatureLines } from "./sources.js";

// One pattern per family. Every capture group 1 is the module string.
const IMPORTS = [
  /^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/,        // js/ts
  /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/,    // js/ts re-export
  /\brequire\(\s*["']([^"']+)["']\s*\)/,                        // cjs
  /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/,         // py
  /^\s*use\s+(?:crate::)?([\w:]+)/,                             // rust
  /^\s*(?:import|package)\s+"?([\w./-]+)"?/,                    // go, java
];

const INDEXES = ["index.js", "index.mjs", "index.ts", "index.tsx", "__init__.py", "mod.rs"];

/** Resolve a module string written in `from` to a file in this tree, or null.
 *  Only RELATIVE and in-tree specifiers resolve: a bare `react` is a dependency,
 *  not an edge in this graph, and pretending otherwise puts node_modules in a
 *  blast radius. */
export function resolve(from, spec) {
  if (!spec) return null;
  const rel = spec.startsWith(".");
  if (!rel && !spec.includes("/") && !spec.includes(".")) return null;
  // A relative spec depends on the importing file's directory; a dotted or
  // root-relative one on nothing but itself. django repeats a few hundred
  // specs across thousands of import lines, and each miss builds 23 paths.
  const key = rel ? path.dirname(from) + "\0" + spec : spec;
  if (_resolved.has(key)) return _resolved.get(key);
  // A dotted python/java path, or a repo-root-relative one.
  const cand = rel ? path.resolve(path.dirname(from), spec) : path.join(ROOT, spec.replace(/\./g, "/"));
  const tries = [cand, ...SYMBOL_SUFFIX.map((s) => cand + s), ...INDEXES.map((i) => path.join(cand, i))];
  const known = fileSet();
  let hit = null;
  for (const t of tries) if (known.has(t)) { hit = t; break; }
  _resolved.set(key, hit);
  return hit;
}

let _files = null;
const _resolved = new Map();
const fileSet = () => _files || (_files = new Set(codeFiles()));
export function reset() { _files = null; _graph = null; _resolved.clear(); }

let _graph = null;
/** The whole graph, computed once per process.
 *
 *  `out` is what a file imports; `in` is what imports it; `declares` is its
 *  top-level symbols; `mentions` is the reverse of that, keyed by name. One
 *  traversal builds all four, because reading the tree four times to answer
 *  four questions is exactly the cost this module exists to remove. */
export function graph() {
  if (_graph) return _graph;
  const files = codeFiles();
  const sym = symbolIndex(files);
  const out = new Map(), inn = new Map(), declares = new Map(), byName = new Map();
  for (const f of files) { out.set(f, new Set()); inn.set(f, new Set()); }
  for (const f of files) {
    const names = (sym.byFile.get(f) || []).map((s) => s.name);
    declares.set(f, names);
    for (const n of names) {
      if (n.length < 4) continue;      // `x`, `run`, `id`: a reference edge on these is noise, not evidence
      if (!byName.has(n)) byName.set(n, new Set());
      byName.get(n).add(f);
    }
  }
  for (const f of files) {
    const src = readText(f);
    if (!src) continue;
    for (const line of src.split("\n")) {
      if (line.length > 400) continue;
      for (const re of IMPORTS) {
        const m = re.exec(line);
        if (!m) continue;
        const target = resolve(f, m[1] || m[2]);
        if (target && target !== f) { out.get(f).add(target); inn.get(target).add(f); }
        break;
      }
    }
  }
  return (_graph = { files, out, inn, declares, byName, via: sym.via });
}

/** Files that mention a name declared elsewhere. Heuristic by construction, so
 *  the caller is handed the count and the kind, never a claim. */
export function references(name, { limit = 40 } = {}) {
  if (!name || name.length < 4) return [];
  const g = graph();
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const hits = [];
  for (const f of g.files) {
    if ((g.declares.get(f) || []).includes(name)) continue;
    const src = readText(f);
    if (src && re.test(src)) hits.push(rel(f));
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Who reaches these files, to `depth` hops of import edges.
 *
 *  Import edges only. A reference edge is reported beside the radius, not
 *  folded into it: a blast radius that grows every time somebody names a
 *  variable `state` is a radius nobody acts on. */
export function blast(changed, { depth = 2 } = {}) {
  const g = graph();
  const seeds = changed.map((f) => abs(f)).filter((f) => g.inn.has(f));
  const levels = [];
  let frontier = new Set(seeds);
  const seen = new Set(seeds);
  for (let d = 1; d <= depth; d++) {
    const next = new Set();
    for (const f of frontier) for (const dep of g.inn.get(f) || []) if (!seen.has(dep)) { seen.add(dep); next.add(dep); }
    if (!next.size) break;
    levels.push({ depth: d, files: [...next].map(rel).sort() });
    frontier = next;
  }
  const reachedAbs = [...seen].filter((f) => !seeds.includes(f));
  const symbols = seeds.flatMap((f) => (g.declares.get(f) || []).filter((n) => n.length >= 4));
  const loose = new Set();
  for (const n of [...new Set(symbols)].slice(0, 40)) {
    for (const f of references(n, { limit: 12 })) { const a = abs(f); if (!seen.has(a)) loose.add(f); }
  }
  return {
    changed: seeds.map(rel).sort(),
    unresolved: changed.filter((f) => !g.inn.has(abs(f))).map((f) => rel(f)),
    levels, reached: reachedAbs.map(rel).sort(),
    tokens_changed: estimate.files(seeds).total,
    tokens_reached: estimate.files(reachedAbs).total,
    also_mentions: [...loose].sort().slice(0, 30),
    via: g.via,
  };
}

/** What git says changed. `since` is any ref; with none it is the working tree
 *  against HEAD, which is the case that matters before a commit exists. */
export function changedFiles(since = "") {
  if (!gitOk(ROOT)) return { rc: 2, why: "not a git worktree; pass files on the command line" };
  const args = since ? ["diff", "--name-only", `${since}...HEAD`] : ["status", "--porcelain"];
  const r = git(args, ROOT);
  if (r.rc !== 0) return { rc: 2, why: `git ${args.join(" ")}: ${r.err || `rc ${r.rc}`}` };
  const files = since
    ? r.out.split("\n").map((l) => l.trim()).filter(Boolean)
    : r.out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  return { rc: 0, files: files.filter((f) => SYMBOL_SUFFIX.some((s) => f.endsWith(s))),
    how: since ? `git diff --name-only ${since}...HEAD` : "git status --porcelain (the working tree)" };
}

/** The declarations of a file and nothing else, with what the saving was.
 *  The ratio is MEASURED by the same estimator the rest of the box uses, over
 *  text that exists, so it is reproducible rather than asserted. */
export function skeleton(file, { cap = 120 } = {}) {
  const p = abs(file);
  const lines = signatureLines(p, cap);
  const whole = estimate.file(p);
  const text = lines.join("\n");
  const partial = estimate.text(text, "code");
  const g = graph();
  return { file: rel(p), lines, declarations: lines.filter((l) => !l.includes("… capped")).length,
    tokens_whole: whole, tokens_skeleton: partial,
    ratio: partial > 0 ? Math.round((whole / partial) * 10) / 10 : null,
    imported_by: [...(g.inn.get(p) || [])].map(rel).sort(),
    imports: [...(g.out.get(p) || [])].map(rel).sort() };
}
