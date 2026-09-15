// snapgen/views.js — the tables that answer "where is this?": the tree's
// layout, the HTTP routes it serves, the documents it ships and the commands it
// declares. One parse or one count each, none of them reading a file body.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel } from "../core/paths.js";
import { readText, walk, langOf } from "../core/fs.js";
import { readJson } from "../core/config.js";
import { git } from "../core/exec.js";
import { uniq } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { codeFiles, has, sourceFiles, subdirs, topOf, MANIFESTS } from "./walk.js";

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
