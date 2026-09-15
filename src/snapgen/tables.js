// snapgen/tables.js — the registry over the reference tables, and the one name
// every caller outside this directory imports.
//
// A session reads a table instead of searching the tree, so the tables must
// agree about what is in it: one walk (walk.js), one symbol index (symbols.js),
// and two families of table over them — where things are (views.js) and what is
// moving (sources.js). This file only registers them and re-exports, which is
// what keeps `import { codeFiles } from "../snapgen/tables.js"` working from
// anywhere without anyone having to know which of the four files it lives in.
import { makeRegistry } from "../kit/registry.js";
import { PKG_ROOT } from "../core/paths.js";
import { DIR, resetWalk } from "./walk.js";
import { symbolTables, resetSymbols } from "./symbols.js";
import { layout, routes, docs, commands } from "./views.js";
import { hot, tests, deps } from "./sources.js";

export { DIR, MAX_TABLE_TOKENS, kcall, sourceFiles, codeFiles, has, topOf, subdirs, SYMBOL_SUFFIX, MANIFESTS } from "./walk.js";
export { symbolsOfJs, symbolIndex, symbolTables } from "./symbols.js";
export { layout, routes, docs, commands, routeRows, renderRoutes } from "./views.js";
export { hot, tests, deps, signatureLines, hotFiles } from "./sources.js";
export { PKG_ROOT };

/** One walk, one symbol index. Both are per-process caches, so a test that
 *  changes the tree under the process resets both or reads the old tree. */
export function resetCache() { resetWalk(); resetSymbols(); }

let _reg = null;
/** The snapgen registry, built once per process. Symbols tables depend on the
 *  tree's top-level dirs, so registration walks; everything after is cached. */
export function registry() {
  if (_reg) return _reg;
  _reg = makeRegistry("snapgen", DIR, {
    title: "snapgen — the reference tables",
    blurb: "Read the table before searching the tree. Each is a set difference, a parse or a count over the\nworkspace, rebuilt only when its inputs change (`bb snapgen stale` / `bb snapgen build`).",
  });
  for (const t of [layout, ...symbolTables(), routes, docs, commands, hot, tests, deps]) _reg.add(t);
  return _reg;
}
export function resetRegistry() { _reg = null; resetCache(); }
