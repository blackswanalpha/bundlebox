// dead-deps — a dependency declared and never imported.
//
// Exact because it is a set difference over the manifest and the corpus; the
// tool-only cases (a linter run from `scripts`, a plugin named in a config)
// are looked up, not guessed: a name that appears nowhere but the manifest is
// installed for nothing on every CI run.
import fs from "node:fs";
import path from "node:path";
import { cachedSpecs, corpus, finding, importGraph, packageJson } from "./_shared.js";

// dist name -> import name where they differ. The rest follow `-` -> `_`, lower.
const PY_ALIAS = { pillow: "PIL", beautifulsoup4: "bs4", pyyaml: "yaml", "scikit-learn": "sklearn", "python-dotenv": "dotenv",
  "opencv-python": "cv2", "psycopg2-binary": "psycopg2", attrs: "attr", "python-dateutil": "dateutil", msgpack: "msgpack",
  "google-api-python-client": "googleapiclient", "protobuf": "google.protobuf", "pyjwt": "jwt", "python-multipart": "multipart" };
const ROOT_DOTFILES = [".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".prettierrc", ".prettierrc.json",
  ".babelrc", ".babelrc.json", ".mocharc.yml", ".mocharc.json", ".npmrc", ".nvmrc", ".stylelintrc", ".lintstagedrc", ".huskyrc", ".github/workflows"];

function lineOf(src, needle) { const i = src.indexOf(needle); return i < 0 ? null : src.slice(0, i).split("\n").length; }

function rootDotfileText(ctx) {
  let s = "";
  for (const d of ROOT_DOTFILES) {
    const p = path.join(ctx.root, d);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) s += fs.readFileSync(p, "utf8") + "\n";
      else for (const f of fs.readdirSync(p)) s += fs.readFileSync(path.join(p, f), "utf8") + "\n";
    } catch { /* absent */ }
  }
  return s;
}

function npm(ctx, text) {
  const pj = packageJson(ctx);
  if (!pj) return null;
  const declared = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}), ...(pj.peerDependencies || {}) };
  const names = Object.keys(declared);
  if (!names.length) return null;
  const { pkgs } = importGraph(ctx);
  const scripts = Object.values(pj.scripts || {}).join("\n");
  // Everything that is not the manifest: configs, sources, docs, CI.
  let rest = rootDotfileText(ctx);
  for (const [r, t] of text) if (r !== "package.json") rest += t + "\n";
  const configKey = (n) => n.replace(/^@[^/]+\//, "").replace(/^(eslint-plugin-|eslint-config-|prettier-plugin-|babel-plugin-|babel-preset-|postcss-|rollup-plugin-|vite-plugin-|stylelint-)/, "");
  const dead = [];
  for (const n of names) {
    if (pkgs.has(n)) continue;
    if (n.startsWith("@types/")) { const base = n.slice(7).replace(/^(.+)__(.+)$/, "@$1/$2"); if (pkgs.has(base) || rest.includes(n)) continue; }
    if (new RegExp(`(^|[^\\w@/-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(scripts)) continue;   // a bin-only tool
    const key = configKey(n);
    if (rest.includes(n) || (key !== n && key.length > 2 && rest.includes(key))) continue;   // named in a config, a doc, a workflow
    dead.push({ name: n, version: declared[n], line: lineOf(text.get("package.json"), `"${n}"`) });
  }
  return dead;
}

function pyDeps(src, r) {
  const out = [];
  if (r.endsWith(".toml")) {
    const m = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(src);
    if (m) for (const x of m[1].matchAll(/["']([A-Za-z0-9][\w.-]*)/g)) out.push(x[1]);
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(src);
    if (poetry) for (const x of poetry[1].matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=/gm)) if (x[1] !== "python") out.push(x[1]);
  } else {
    for (const line of src.split("\n")) {
      const l = line.trim();
      if (!l || l.startsWith("#") || l.startsWith("-")) continue;
      const m = /^([A-Za-z0-9][\w.-]*)/.exec(l);
      if (m) out.push(m[1]);
    }
  }
  return [...new Set(out)];
}

function python(ctx, text, r) {
  const src = text.get(r);
  const deps = pyDeps(src, r);
  if (!deps.length) return null;
  const imported = new Set();
  for (const [o, t] of text) if (o.endsWith(".py")) for (const s of cachedSpecs(ctx, o, t)) {
    if (s.kind !== "abs") continue;
    for (const m of s.multi || [s.spec]) imported.add(m.split(".")[0]);
  }
  let rest = "";
  for (const [o, t] of text) if (o !== r && !o.endsWith(".py")) rest += t + "\n";
  const dead = [];
  for (const d of deps) {
    const lower = d.toLowerCase();
    const mod = PY_ALIAS[lower] || lower.replace(/-/g, "_");
    if (imported.has(mod.split(".")[0]) || imported.has(lower.replace(/-/g, "_"))) continue;
    // A tool: configured in its own `[tool.x]` table or run from a Makefile/CI.
    if (new RegExp(`\\[tool\\.${lower}[\\].]`).test(src) || new RegExp(`(^|[^\\w-])${lower}([^\\w-]|$)`, "m").test(rest)) continue;
    dead.push({ name: d, module: mod, line: lineOf(src, d) });
  }
  return dead;
}

export default {
  name: "dead-deps", precision: "exact", severity: "low",
  description: "declared dependencies no source imports and no script or config names",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    const emit = (manifest, dead) => {
      if (!dead || !dead.length) return;
      out.push(finding({
        severity: "low", files: [manifest], key: manifest,
        // A key in package.json and a line in a requirements file are both a
        // delete. A pyproject array is TOML, and this box owns no TOML writer.
        auto_fix: manifest === "package.json" || /^requirements[^/]*\.txt$/.test(manifest) ? "remove-dead-dep" : null,
        title: `${manifest}: ${dead.length} dependenc${dead.length === 1 ? "y" : "ies"} nothing imports`,
        detail: dead.slice(0, 20).map((d) => `  L${d.line ?? "?"}  ${d.name}`).join("\n"),
        evidence: { deps: dead.slice(0, 50), count: dead.length },
        fix_hint: "Remove it from the manifest, or if a tool loads it by name, name it in a script so the next scan can see the use.",
      }));
    };
    if (text.has("package.json")) emit("package.json", npm(ctx, text));
    for (const r of text.keys()) if (/^(pyproject\.toml|requirements[^/]*\.txt)$/.test(r)) emit(r, python(ctx, text, r));
    return out;
  },
};
