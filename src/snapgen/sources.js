// snapgen/sources.js — the tables that answer "what is moving?": the files git
// says change most (signatures only, never bodies), what each test file
// asserts, and which declared dependency is actually imported.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, abs } from "../core/paths.js";
import { readText, langOf } from "../core/fs.js";
import { readJson } from "../core/config.js";
import { git, gitOk } from "../core/exec.js";
import * as store from "../core/store.js";
import { human, pad } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { isTest, specsOf, pkgName } from "../detectors/_shared.js";
import { codeFiles, has } from "./walk.js";

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
