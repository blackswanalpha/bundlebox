// snapgen/symbols.js — the symbols tables: every top-level declaration in the
// tree, with the file and the line it is on.
//
// Kernel first (`bbk symbols`) and the same rules in JS otherwise, so a table
// built on a box with the binary reads identically to one built without it.
// The tables split per top-level directory and again at MAX_TABLE_TOKENS,
// because a table that costs more to read than the search it replaces is not a
// saving.
import path from "node:path";
import { rel, abs } from "../core/paths.js";
import { readText, langOf } from "../core/fs.js";
import { pad } from "../core/util.js";
import * as kernel from "../core/kernel.js";
import * as estimate from "../tokens/estimate.js";
import { codeFiles, kcall, topOf, MAX_TABLE_TOKENS } from "./walk.js";

const ID = "[A-Za-z_$][\\w$]*";
// Mirrors kernel/src/symbols.rs `decl`: top-level only, one name per line.
const DECL = {
  py: [new RegExp(`^(?:async\\s+)?(?:def|class)\\s+(${ID})`)],
  js: [new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class)\\s+(${ID})`),
    new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})(?=.*=)`),
    /^export default function\b(?![\s\S]*\w)()/],
  go: [/^func\s+\([^)]*\)\s*(\w+)/, /^(?:func|type)\s+(\w+)/],
  rust: [new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+|unsafe\\s+|const\\s+)*(?:fn|struct|enum|trait|impl|mod|const|static|type)\\s+(${ID})`)],
  cfamily: [new RegExp(`^(?:(?:public|private|protected|abstract|final|sealed|static|open|data|internal|export)\\s+)*(?:class|enum|fun|func|interface|mixin|extension|void|record|struct|protocol)\\s+(${ID})`)],
  ruby: [/^(?:def|class|module)\s+(?:self\.)?(\w+)/],
  php: [/^(?:(?:abstract|final)\s+)?(?:function|class|interface|trait)\s+(\w+)/],
};
const family = (lang) => DECL[lang] ? lang : lang === "ts" ? "js" : ["dart", "java", "kotlin", "swift", "csharp"].includes(lang) ? "cfamily" : null;

/** [{name, file, line}] for one file, JS path. `file` is the absolute path, as the kernel returns it. */
export function symbolsOfJs(p, src = readText(p)) {
  const rules = DECL[family(langOf(p))];
  if (!rules || !src) return [];
  const out = [];
  src.split("\n").forEach((line, i) => {
    if (!line || /^\s/.test(line) || /^(\/\/|\*)/.test(line)) return;
    for (const re of rules) {
      const m = re.exec(line);
      if (m) { out.push({ name: m[1] || "default", file: p, line: i + 1 }); return; }
    }
  });
  return out;
}

let _symbols = null;
/** {via, byFile: Map<abs, [{name, line}]>} over every code file, computed once. */
export function symbolIndex(paths = codeFiles()) {
  if (_symbols) return _symbols;
  const byFile = new Map(paths.map((p) => [p, []]));
  const k = paths.length ? kcall("symbols", { paths }) : null;
  let via = "js";
  if (k && Array.isArray(k.symbols)) {
    via = "kernel";
    for (const s of k.symbols) if (byFile.has(s.file)) byFile.get(s.file).push({ name: s.name, line: s.line });
  } else {
    for (const p of paths) byFile.set(p, symbolsOfJs(p).map(({ name, line }) => ({ name, line })));
  }
  return (_symbols = { via, byFile });
}

const SYMBOL_SKIP = /^(if|for|while|switch|catch|return|else|do|try)$/;
function symbolRows(files) {
  const idx = symbolIndex();
  const rows = [];
  for (const p of files) {
    const r = rel(p);
    // Private helpers are not what a session greps for; a listing that includes
    // them doubles the table and halves the hit rate.
    for (const s of idx.byFile.get(p) || []) if (s.name.length >= 2 && !s.name.startsWith("_") && !SYMBOL_SKIP.test(s.name)) rows.push([s.name, r, s.line]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return rows;
}
const renderRows = (rows) => rows.map(([n, r, ln]) => `${pad(n, 40)} ${r}:${ln}`);

function symbolsTable(name, top, files) {
  return {
    name, group: "symbols", description: `top-level declarations in ${top === "." ? "the root" : top + "/"} as \`name  file:line\``,
    inputs: () => files,
    build: () => {
      const rows = symbolRows(files);
      const via = symbolIndex().via;
      const L = [`# ${name} — declarations in \`${top === "." ? "." : top + "/"}\``, "",
        `\`name  file:line\`, top-level only (${rows.length} symbols, ${files.length} files). Grep this before grepping the tree.`, "",
        "```", ...renderRows(rows), "```"];
      return { payload: L.join("\n"), notes: { via, symbols: rows.length } };
    },
  };
}

/** Group code files by top-level dir; split a group whose rendered table would
 *  pass MAX_TABLE_TOKENS into `symbols-<top>-<n>` chunks of whole files. */
export function symbolTables() {
  const groups = new Map();
  for (const p of codeFiles()) { const t = topOf(p); if (!groups.has(t)) groups.set(t, []); groups.get(t).push(p); }
  const out = [];
  for (const [top, files] of [...groups].sort()) {
    const stem = `symbols-${top === "." ? "root" : top.replace(/[^\w.-]/g, "_")}`;
    const chunks = [[]];
    let spent = 0;
    for (const p of files) {
      const cost = estimate.text(renderRows(symbolRows([p])).join("\n"), "code");
      if (spent + cost > MAX_TABLE_TOKENS && chunks[chunks.length - 1].length) { chunks.push([]); spent = 0; }
      chunks[chunks.length - 1].push(p); spent += cost;
    }
    if (chunks.length === 1) out.push(symbolsTable(stem, top, chunks[0]));
    else chunks.forEach((c, i) => out.push(symbolsTable(`${stem}-${i + 1}`, top, c)));
  }
  return out;
}

export function resetSymbols() { _symbols = null; }
