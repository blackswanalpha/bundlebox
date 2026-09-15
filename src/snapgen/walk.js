// snapgen/walk.js — one walk of the workspace, and the kernel call every table
// may use. Split out of tables.js because every other module in this directory
// needs these six things and none of them needs the tables: a file that both
// defines the shared floor and renders eight tables is read in full to change
// either.
import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT, rel } from "../core/paths.js";
import { walk, isIgnored } from "../core/fs.js";
import * as kernel from "../core/kernel.js";

export const DIR = path.join(OUT, "snapgen");
/** A symbols table past this is read less often than it is skipped. */
export const MAX_TABLE_TOKENS = 40000;

/** The kernel, unless BB_KERNEL names a binary that is not there. An explicit
 *  override that silently falls through to the packaged binary would make
 *  "force the JS path" impossible to test, and would hide a broken install. */
export function kcall(op, payload) {
  const forced = process.env.BB_KERNEL;
  if (forced) { try { fs.accessSync(forced, fs.constants.X_OK); } catch { return null; } }
  return kernel.call(op, payload);
}

export const SYMBOL_SUFFIX = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".dart", ".java", ".kt", ".swift", ".cs", ".rb", ".php"];
export const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml", "go.mod", "pubspec.yaml",
  "Gemfile", "composer.json", "Makefile", "justfile", "Justfile", "build.gradle", "pom.xml", "CMakeLists.txt", "Dockerfile", "mix.exs"];

let _walked = null;
/** One walk per process; every table's inputs() reads it. */
export function sourceFiles() { return _walked || (_walked = walk(ROOT)); }
export const codeFiles = () => sourceFiles().filter((p) => SYMBOL_SUFFIX.some((s) => p.endsWith(s)));
export function resetWalk() { _walked = null; }

/** Does the workspace root carry this file? Both the commands table and the
 *  deps table ask, so it lives with the walk rather than in one of them. */
export const has = (n) => fs.existsSync(path.join(ROOT, n));

export const topOf = (p) => { const r = rel(p); const i = r.indexOf("/"); return i < 0 ? "." : r.slice(0, i); };
export function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !isIgnored(e.name)).map((e) => e.name).sort(); } catch { return []; }
}
