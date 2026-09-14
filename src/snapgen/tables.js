// tables.js — the reference tables a session reads instead of searching.
//
// Every table is a set difference, a parse or a count over the workspace whose
// answer does not change between sessions, so it is computed once, written as
// compact markdown under .bundlebox/out/snapgen/, and fingerprinted against the
// files it was derived from. A table that costs more to read than the search it
// replaces is not a saving, which is why the symbols tables split at 40k tokens
// and `hot` prints signatures and never bodies.
//
// Symbols come from the kernel when it is on the box (`bbk symbols`) and from
// the JS matcher below otherwise. Both answer the same question, top-level
// declarations only, so a table built on one machine reads the same on another.
import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT, PKG_ROOT, rel, abs } from "../core/paths.js";
import { readText, walk, langOf, CODE_SUFFIX, isIgnored } from "../core/fs.js";
import { readJson } from "../core/config.js";
import { git, gitOk } from "../core/exec.js";
import * as store from "../core/store.js";
import * as kernel from "../core/kernel.js";
import { human, pad, uniq } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { makeRegistry } from "../kit/registry.js";
import { isTest, specsOf, pkgName } from "../detectors/_shared.js";

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

// ── walking ──────────────────────────────────────────────────────────────────

const SYMBOL_SUFFIX = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".dart", ".java", ".kt", ".swift", ".cs", ".rb", ".php"];
const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml", "go.mod", "pubspec.yaml",
  "Gemfile", "composer.json", "Makefile", "justfile", "Justfile", "build.gradle", "pom.xml", "CMakeLists.txt", "Dockerfile", "mix.exs"];

let _walked = null;
/** One walk per process; every table's inputs() reads it. */
export function sourceFiles() { return _walked || (_walked = walk(ROOT)); }
export const codeFiles = () => sourceFiles().filter((p) => SYMBOL_SUFFIX.some((s) => p.endsWith(s)));
export function resetCache() { _walked = null; _symbols = null; }

const topOf = (p) => { const r = rel(p); const i = r.indexOf("/"); return i < 0 ? "." : r.slice(0, i); };
function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !isIgnored(e.name)).map((e) => e.name).sort(); } catch { return []; }
}

// ── symbols: kernel first, then the same rules in JS ─────────────────────────

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

// ── layout ───────────────────────────────────────────────────────────────────

export const layout = {
  name: "layout", group: "map", description: "the workspace map: top-level dirs, source dirs two deep, files by language, manifests",
  inputs: () => [...sourceFiles(), ...MANIFESTS.map((m) => path.join(ROOT, m))],
  build: () => {
    const files = sourceFiles();
    const byLang = {};
    for (const p of files) byLang[langOf(p)] = (byLang[langOf(p)] || 0) + 1;
    const langs = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
    const manifests = MANIFESTS.filter((m) => fs.existsSync(path.join(ROOT, m)));
    const ownGit = fs.existsSync(path.join(ROOT, ".git"));
    const L = [`# layout — the workspace map`, "",
      `Root \`${path.basename(ROOT)}/\`: ${files.length} source files, own .git: ${ownGit ? "yes" : "no"}. Manifests: ${manifests.length ? manifests.map((m) => `\`${m}\``).join(", ") : "(none)"}.`, "",
      "| language | files |", "|---|---|", ...langs.map(([l, n]) => `| ${l} | ${n} |`), "",
      "| top-level dir | files | inside |", "|---|---|---|"];
    const perTop = new Map();
    for (const p of files) { const t = topOf(p); perTop.set(t, (perTop.get(t) || 0) + 1); }
    for (const d of subdirs(ROOT)) {
      const inner = subdirs(path.join(ROOT, d));
      L.push(`| \`${d}/\` | ${perTop.get(d) || 0} | ${inner.slice(0, 12).join(", ")}${inner.length > 12 ? " …" : ""} |`);
    }
    if (perTop.get(".")) L.push(`| \`.\` (root files) | ${perTop.get(".")} | |`);
    L.push("", "Source dirs, two deep (code files in each):", "");
    for (const d of subdirs(ROOT)) {
      const codeIn = (q) => codeFiles().filter((p) => p.startsWith(q + path.sep)).length;
      const subs = subdirs(path.join(ROOT, d)).filter((s) => codeIn(path.join(ROOT, d, s)));
      // A dir with no code-bearing subdirs is already fully described by the table above.
      if (!subs.length) continue;
      L.push(`### \`${d}/\` (${codeIn(path.join(ROOT, d))})`);
      for (const s of subs) {
        const inner = subdirs(path.join(ROOT, d, s));
        L.push(`- \`${d}/${s}/\` (${codeIn(path.join(ROOT, d, s))})${inner.length ? " — " + inner.slice(0, 10).join(", ") + (inner.length > 10 ? " …" : "") : ""}`);
      }
      L.push("");
    }
    return L.join("\n");
  },
};

// ── routes ───────────────────────────────────────────────────────────────────

const ROUTE_RULES = [
  // Express / Fastify / Koa / Hono share the `obj.verb("/path", …)` shape.
  { fw: "express-style", langs: ["js", "ts"], re: /\b(?:app|router|server|fastify|api|hono|koa|r)\.(get|post|put|patch|delete|del|all|options|head)\(\s*(['"`])([^'"`]+)\2/g, method: (m) => m[1].toUpperCase(), path: (m) => m[3] },
  { fw: "express-style", langs: ["js", "ts"], re: /\.route\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.(get|post|put|patch|delete|all)\(/g, method: (m) => m[3].toUpperCase(), path: (m) => m[2] },
  { fw: "fastapi/flask", langs: ["py"], re: /@(?:\w+)\.(get|post|put|patch|delete|route|api_route)\(\s*(['"])([^'"]+)\2([^)]*)\)/g,
    method: (m) => (m[1] === "route" || m[1] === "api_route") ? (/methods\s*=\s*\[([^\]]*)\]/.exec(m[4] || "") || [, "GET"])[1].replace(/['"\s]/g, "") : m[1].toUpperCase(), path: (m) => m[2] },
  { fw: "django", langs: ["py"], file: /(^|\/)urls\.py$/, re: /\b(?:re_)?path\(\s*(['"])([^'"]*)\1/g, method: () => "ANY", path: (m) => m[2] || "/" },
  { fw: "rails", langs: ["ruby"], file: /(^|\/)config\/routes\.rb$/, re: /^\s*(get|post|put|patch|delete|resources|resource|namespace|root)\s+(?:['":])([^'",\s]+)/gm, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  { fw: "go net/http", langs: ["go"], re: /\bhttp\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/g, method: () => "ANY", path: (m) => m[1] },
  { fw: "gin/echo/chi", langs: ["go"], re: /\b\w+\.(GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"/g, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
];
const NEST_RE = /@(Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;

export function routeRows(files = sourceFiles()) {
  const rows = [];
  const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
  for (const p of files) {
    const r = rel(p), lang = langOf(p);
    // Next.js: the file system is the router.
    const m = /(^|\/)(app|pages)\/(.*?)(?:\/)?(route|page|index|[^/]+)\.(?:[cm]?[jt]sx?)$/.exec(r);
    if (m && (lang === "js" || lang === "ts")) {
      const [, , kind, dir, leaf] = m;
      if (kind === "app" && (leaf === "route" || leaf === "page")) rows.push({ fw: "next.js app", method: leaf === "route" ? "ANY" : "PAGE", path: "/" + dir.replace(/\/?\([^)]*\)/g, ""), where: `${r}:1` });
      else if (kind === "pages" && !leaf.startsWith("_")) rows.push({ fw: "next.js pages", method: dir.startsWith("api") || leaf === "api" ? "ANY" : "PAGE", path: "/" + [dir, leaf === "index" ? "" : leaf].filter(Boolean).join("/"), where: `${r}:1` });
    }
    const rules = ROUTE_RULES.filter((x) => x.langs.includes(lang) && (!x.file || x.file.test(r)));
    if (!rules.length && lang !== "ts") continue;
    const src = readText(p);
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      let g;
      while ((g = rule.re.exec(src))) rows.push({ fw: rule.fw, method: rule.method(g), path: rule.path(g), where: `${r}:${lineOf(src, g.index)}` });
    }
    if (lang === "ts" && /@Controller\(/.test(src)) {
      const prefix = (/@Controller\(\s*(?:(['"`])([^'"`]*)\1)?/.exec(src) || [])[2] || "";
      NEST_RE.lastIndex = 0;
      let g;
      while ((g = NEST_RE.exec(src))) rows.push({ fw: "nestjs", method: g[1].toUpperCase(), path: "/" + [prefix, g[3] || ""].filter(Boolean).join("/").replace(/\/+/g, "/").replace(/^\//, ""), where: `${r}:${lineOf(src, g.index)}` });
    }
  }
  return rows;
}
export const routes = {
  name: "routes", group: "api", description: "every HTTP route the tree mounts (express/fastify/koa/hono, next.js, fastapi/flask, django, rails, go, nestjs), parsed never requested",
  inputs: () => sourceFiles(),
  build: () => renderRoutes(routeRows()),
};
export function renderRoutes(rows) {
  const L = ["# routes — what this tree mounts", ""];
  if (!rows.length) { L.push("(none detected)", "", "No express/fastify/koa/hono, next.js, fastapi/flask, django, rails, go or nestjs route shapes were found in the source walk."); return L.join("\n"); }
  L.push(`${rows.length} routes across ${uniq(rows.map((x) => x.fw)).join(", ")}.`, "", "| framework | method | path | where |", "|---|---|---|---|");
  for (const x of rows) L.push(`| ${x.fw} | ${x.method} | \`${x.path}\` | ${x.where} |`);
  return L.join("\n");
}

// ── docs ─────────────────────────────────────────────────────────────────────

export const docs = {
  name: "docs", group: "docs", description: "every markdown document with its title, lines and token cost",
  inputs: () => sourceFiles().filter((p) => /\.(md|markdown|mdx)$/.test(p)),
  build: () => {
    const L = ["# docs — every markdown, with its title", "", "| doc | title | lines | ~tokens |", "|---|---|---|---|"];
    for (const p of docs.inputs()) {
      const text = readText(p);
      const title = ((/^#\s+(.+)$/m.exec(text.slice(0, 4000)) || [])[1] || "").trim().slice(0, 70).replace(/\|/g, "\\|");
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      L.push(`| \`${rel(p)}\` | ${title} | ${lines} | ${estimate.text(text, "prose")} |`);
    }
    return L.join("\n");
  },
};

// ── commands ─────────────────────────────────────────────────────────────────

const has = (n) => fs.existsSync(path.join(ROOT, n));
const isBundleboxRepo = () => readJson(path.join(ROOT, "package.json"), {})?.name === "bundlebox" && has("src/cli.js");

export const commands = {
  name: "commands", group: "map", description: "what can be run here: package scripts and bins, Makefile and justfile targets, pyproject scripts, Cargo bins" + (isBundleboxRepo() ? ", every bb verb" : ""),
  inputs: () => ["package.json", "Makefile", "justfile", "Justfile", "pyproject.toml", "Cargo.toml", "src/cli.js"].map((n) => path.join(ROOT, n)),
  build: async () => {
    const L = ["# commands — what can be run here", ""];
    let any = false;
    const section = (title, rows) => { if (!rows.length) return; any = true; L.push(`## ${title}`, "", ...rows, ""); };
    const pkg = readJson(path.join(ROOT, "package.json"), null);
    if (pkg) {
      section("package.json scripts", Object.entries(pkg.scripts || {}).map(([k, v]) => `- \`npm run ${k}\` — \`${String(v).slice(0, 100)}\``));
      const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin || {};
      section("package.json bin", Object.entries(bin).map(([k, v]) => `- \`${k}\` → \`${v}\``));
    }
    if (has("Makefile")) section("Makefile targets", uniq([...readText(path.join(ROOT, "Makefile")).matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1])).map((t) => `- \`make ${t}\``));
    const just = ["justfile", "Justfile"].find(has);
    if (just) section("justfile recipes", uniq([...readText(path.join(ROOT, just)).matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:\n]*)?:(?!=)/gm)].map((m) => m[1])).map((t) => `- \`just ${t}\``));
    if (has("pyproject.toml")) {
      const toml = readText(path.join(ROOT, "pyproject.toml"));
      const blk = /\[project\.scripts\]([\s\S]*?)(?=\n\[|$)/.exec(toml);
      if (blk) section("pyproject scripts", [...blk[1].matchAll(/^\s*([\w.-]+)\s*=\s*"([^"]+)"/gm)].map((m) => `- \`${m[1]}\` → \`${m[2]}\``));
    }
    if (has("Cargo.toml")) {
      const toml = readText(path.join(ROOT, "Cargo.toml"));
      const bins = [...toml.matchAll(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      if (!bins.length && has("src/main.rs")) bins.push((/\[package\][^[]*?name\s*=\s*"([^"]+)"/.exec(toml) || [])[1] || "(package)");
      section("Cargo bins", bins.map((b) => `- \`cargo run --bin ${b}\``));
    }
    if (isBundleboxRepo()) {
      // The verb table is the truth about bb; parsing cli.js by regex would drift the day a module renames a verb.
      try {
        const cli = await import(new URL("file://" + path.join(ROOT, "src", "cli.js")).href);
        const { table } = await cli.loadCommands();
        section("bb verbs", Object.entries(table).sort().map(([n, c]) => `- \`bb ${n}\` — ${c.help || ""}${c.usage ? `  (\`${c.usage}\`)` : ""}`));
      } catch (e) { section("bb verbs", [`- (could not load src/cli.js: ${e.message})`]); }
    }
    if (!any) L.push("(none detected)");
    return L.join("\n");
  },
};

// ── hot ──────────────────────────────────────────────────────────────────────

// Any declaration at any depth: a signature view of a file is the lines a
// reader would scan for, not the top-level index.
const SIG = {
  py: /^\s*(?:async\s+)?(?:def|class)\s+\w+/,
  js: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|(?:static\s+|async\s+|get\s+|set\s+)*\w+\s*\([^)]*\)\s*\{)/,
  go: /^\s*(?:func|type)\s+/, rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?(?:fn|struct|enum|trait|impl|mod)\s+/,
  generic: /^\s*(?:(?:public|private|protected|static|final|abstract|override|async)\s+)*(?:class|enum|interface|fun|func|def|void|[A-Z]\w*(?:<[^>]*>)?)\s+\w+\s*[({<]/,
};
export function signatureLines(p, cap = 120) {
  const lang = langOf(p);
  const re = SIG[lang] || (lang === "ts" ? SIG.js : SIG.generic);
  const out = [];
  const lines = readText(p).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]) || /^\s*(if|for|while|switch|catch|return)\b/.test(lines[i])) continue;
    out.push(`${pad(i + 1, 5, true)}  ${lines[i].trim().slice(0, 110)}`);
    if (out.length >= cap) { out.push(`       … capped at ${cap} declarations`); break; }
  }
  return out;
}
/** {source, files:[rel]} — measured re-reads when `buckmaster` has them, else git churn, else nothing. */
export function hotFiles(n = 20) {
  const sig = store.get("signals", null);
  const top = sig?.aggregate?.top_reread_files;
  if (Array.isArray(top) && top.length) {
    const files = top.map((x) => (typeof x === "string" ? x : x?.path || x?.file || "")).filter(Boolean);
    return { source: "signals.aggregate.top_reread_files (measured re-reads)", files: files.slice(0, n) };
  }
  if (fs.existsSync(path.join(ROOT, ".git")) && gitOk(ROOT)) {
    const r = git(["log", "--name-only", "--pretty=format:", "-n", "300"], ROOT);
    if (r.rc === 0) {
      const counts = new Map();
      for (const line of r.out.split("\n")) { const f = line.trim(); if (f) counts.set(f, (counts.get(f) || 0) + 1); }
      const files = [...counts].filter(([f]) => fs.existsSync(path.join(ROOT, f))).sort((a, b) => b[1] - a[1]).slice(0, n).map(([f]) => f);
      return { source: "git log --name-only -n 300 (most-changed files)", files };
    }
  }
  return { source: "none: no signals measured and no git history", files: [] };
}
export const hot = {
  name: "hot", group: "process", description: "signature views (declarations + line numbers, never bodies) of the 20 files sessions re-read or change most",
  inputs: () => hotFiles().files.map(abs),
  build: () => {
    const h = hotFiles();
    const L = ["# hot — the files that keep getting read, as signatures", "", `Source: ${h.source}. Read the range you need, not the file.`, ""];
    for (const r of h.files) {
      const p = abs(r);
      if (!fs.existsSync(p)) continue;
      const lines = readText(p).split("\n").length;
      L.push(`## \`${r}\` — ${lines} lines, ~${human(estimate.file(p))} tokens whole`, "", "```", ...(signatureLines(p).length ? signatureLines(p) : ["  (no declarations parsed)"]), "```", "");
    }
    if (!h.files.length) L.push("_(empty: nothing measured yet and no git history to fall back on)_");
    return L.join("\n");
  },
};

// ── tests ────────────────────────────────────────────────────────────────────

export const tests = {
  name: "tests", group: "map", description: "every test file and the source basenames it references",
  inputs: () => codeFiles().filter((p) => isTest(rel(p))),
  build: () => {
    const L = ["# tests — what each test file touches", "", "| test | references |", "|---|---|"];
    const files = tests.inputs();
    const known = new Set(codeFiles().filter((p) => !isTest(rel(p))).map((p) => path.basename(p)));
    for (const p of files) {
      const r = rel(p), src = readText(p);
      const refs = new Set();
      for (const { spec } of specsOf(r, src)) if (spec.startsWith(".") || spec.startsWith("/")) refs.add(path.basename(spec));
      // A bare basename in the text (`app.js`, `models.py`) is a reference too;
      // Python tests import by module name and never by path.
      for (const m of src.matchAll(/\b([\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|dart|rb))\b/g)) if (known.has(m[1])) refs.add(m[1]);
      for (const m of src.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) { const b = m[1].split(".").pop() + ".py"; if (known.has(b)) refs.add(b); }
      L.push(`| \`${r}\` | ${[...refs].sort().join(", ") || "(none resolved)"} |`);
    }
    if (!files.length) L.push("| (no test files found) | |");
    return L.join("\n");
  },
};

// ── deps ─────────────────────────────────────────────────────────────────────

function declaredDeps() {
  const out = [];
  const pkg = readJson(path.join(ROOT, "package.json"), null);
  if (pkg) for (const [sec, m] of [["dependencies", pkg.dependencies], ["devDependencies", pkg.devDependencies]]) for (const [k, v] of Object.entries(m || {})) out.push({ name: k, version: String(v), manifest: `package.json ${sec}` });
  if (has("pyproject.toml")) {
    const toml = readText(path.join(ROOT, "pyproject.toml"));
    const blk = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(toml);
    for (const m of (blk ? blk[1] : "").matchAll(/["']([A-Za-z0-9_.-]+)\s*([^"']*)["']/g)) out.push({ name: m[1], version: m[2].trim() || "*", manifest: "pyproject.toml" });
  }
  if (has("requirements.txt")) for (const line of readText(path.join(ROOT, "requirements.txt")).split("\n")) { const m = /^\s*([A-Za-z0-9_.-]+)\s*([=<>!~]=?[^#\s]*)?/.exec(line); if (m && !line.trim().startsWith("#") && !line.trim().startsWith("-")) out.push({ name: m[1], version: m[2] || "*", manifest: "requirements.txt" }); }
  if (has("Cargo.toml")) {
    const blk = /\[dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(readText(path.join(ROOT, "Cargo.toml")));
    for (const m of (blk ? blk[1] : "").matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) out.push({ name: m[1], version: m[2] || m[3] || "*", manifest: "Cargo.toml" });
  }
  if (has("go.mod")) for (const m of readText(path.join(ROOT, "go.mod")).matchAll(/^\s*([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) out.push({ name: m[1], version: m[2], manifest: "go.mod" });
  return out;
}
export const deps = {
  name: "deps", group: "map", description: "direct dependencies with versions and how many files import each",
  inputs: () => [...["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"].map((n) => path.join(ROOT, n)), ...codeFiles()],
  build: () => {
    const declared = declaredDeps();
    const L = ["# deps — direct dependencies and their import counts", ""];
    if (!declared.length) { L.push("(none detected)"); return L.join("\n"); }
    const counts = new Map(declared.map((d) => [d.name, 0]));
    for (const p of codeFiles()) {
      const r = rel(p), src = readText(p), seen = new Set();
      for (const { spec } of specsOf(r, src)) { const n = pkgName(spec); if (n && counts.has(n)) seen.add(n); }
      for (const m of src.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const top = (m[1] || m[2]).split(".")[0];
        for (const d of counts.keys()) if (d.replace(/-/g, "_").toLowerCase() === top.toLowerCase()) seen.add(d);
      }
      for (const m of src.matchAll(/^\s*use\s+([A-Za-z0-9_]+)/gm)) for (const d of counts.keys()) if (d.replace(/-/g, "_") === m[1]) seen.add(d);
      for (const n of seen) counts.set(n, counts.get(n) + 1);
    }
    L.push("| dep | version | manifest | files importing |", "|---|---|---|---|");
    for (const d of declared) L.push(`| \`${d.name}\` | ${d.version} | ${d.manifest} | ${counts.get(d.name)} |`);
    return L.join("\n");
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

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
export { PKG_ROOT };
