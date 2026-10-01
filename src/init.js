// init.js — `bb init`: look at the tree once and write the config a session
// would otherwise be paid to infer. Only non-default keys are written, so the
// file stays a statement of what this repo changed, not a copy of the defaults.
import fs from "node:fs";
import path from "node:path";
import { ROOT, BB_DIR, ensureDirs, rel } from "./core/paths.js";
import { DEFAULTS, configPath, userConfig, save } from "./core/config.js";
import { out, warn, emit } from "./core/log.js";
import { walk, langOf, isIgnored } from "./core/fs.js";

const MANIFESTS = { "package.json": "node", "pyproject.toml": "python", "requirements.txt": "python", "Cargo.toml": "rust", "go.mod": "go", "pubspec.yaml": "dart", "Gemfile": "ruby", "composer.json": "php", "build.gradle": "jvm", "pom.xml": "jvm", "Package.swift": "swift", "mix.exs": "elixir" };

const manifestsIn = (dir) => Object.keys(MANIFESTS).filter((m) => fs.existsSync(path.join(dir, m)));
const dirsOf = (root) => {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !isIgnored(e.name)).map((e) => e.name).sort(); }
  catch { return []; }  // unreadable root: no subdirs to offer
};

export function detectRepo(root = ROOT) {
  const manifests = manifestsIn(root);
  const langs = {};
  for (const f of walk(root)) { const l = langOf(f); if (l !== "other" && l !== "md") langs[l] = (langs[l] || 0) + 1; }
  const top = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const dirs = dirsOf(root);
  // A workspace of projects has no manifest at the top and one per project. It
  // is a real shape — this repo is used that way — and reading only the root
  // reported "no manifest" over a tree where every project declared a gate.
  // One level: two is a monorepo's package directory, and that needs its own
  // walker rather than a guess here.
  const projects = dirs.map((d) => ({ dir: d, manifests: manifestsIn(path.join(root, d)) }))
    .filter((p) => p.manifests.length)
    .map((p) => ({ ...p, ecosystems: [...new Set(p.manifests.map((m) => MANIFESTS[m]))] }));
  // Sub-trees with their own .git are separate repos: a lane can only get a worktree in one of those.
  const subrepos = dirs.filter((d) => fs.existsSync(path.join(root, d, ".git")));
  return { manifests, ecosystems: [...new Set(manifests.map((m) => MANIFESTS[m]))], languages: top,
    projects, subrepos, git: fs.existsSync(path.join(root, ".git")) };
}

function gitignore(root) {
  const p = path.join(root, ".gitignore");
  const had = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const want = [".bundlebox/var/", ".bundlebox/out/"].filter((l) => !had.split("\n").some((x) => x.trim() === l));
  if (!want.length) return { changed: false };
  fs.writeFileSync(p, (had.endsWith("\n") || !had ? had : had + "\n") + "\n# bundlebox: derived state, rebuilt by bb scan / bb snapgen\n" + want.join("\n") + "\n");
  return { changed: true, added: want };
}

export const commands = {
  init: {
    help: "detect languages, agents and gates; write .bundlebox/config.json",
    usage: "bb init [--force] [--json]",
    run: async ({ flags }) => {
      ensureDirs();
      const existing = fs.existsSync(configPath());
      if (existing && !flags.force) { out(`  ${rel(configPath())} exists; --force rewrites it. Next: bb doctor`); return 0; }
      const repo = detectRepo();
      let agents = [];
      try { agents = (await import("./adapters/index.js")).detect(); } catch { /* adapters absent: agent stays auto */ }
      // Per directory, always: the workspace root and every project under it.
      // A gate is only worth a row when that directory proves itself — a
      // project with no manifest is proven the way the workspace is.
      let gates = {};
      try {
        const { detectGates } = await import("./compile/compiler.js");
        for (const scope of [".", ...repo.projects.map((p) => p.dir)]) {
          const g = detectGates(ROOT, scope);
          if (g.scope !== scope) continue;
          const keep = Object.fromEntries(["quick", "full", "lint", "typecheck", "test"].map((k) => [k, g[k]]).filter(([, v]) => v));
          if (Object.keys(keep).length) gates[scope] = keep;
        }
      } catch { /* no compiler: gates stay empty */ }
      const cfg = existing ? userConfig() : {};
      cfg.workspace = { ...(cfg.workspace || {}) };
      if (repo.subrepos.length) cfg.workspace.subrepos = repo.subrepos;
      if (!Object.keys(cfg.workspace).length) delete cfg.workspace;
      if (agents.length && agents[0].name !== DEFAULTS.lanes.agent) cfg.lanes = { ...(cfg.lanes || {}), agent: agents[0].name };
      // Detection fills the scopes nobody declared; a hand-written entry wins,
      // because somebody wrote it on purpose and `--force` is not a licence to
      // forget that.
      if (Object.keys(gates).length || cfg.kernel?.gates) {
        const prior = cfg.kernel?.gates || {};
        const declared = Object.values(prior).some((v) => v && typeof v === "object") ? prior : Object.keys(prior).length ? { ".": prior } : {};
        cfg.kernel = { ...(cfg.kernel || {}), gates: { ...gates, ...declared } };
      }
      cfg.$schema = "https://github.com/blackswanalpha/bundlebox/blob/main/src/core/config.js";
      cfg.initialised = new Date().toISOString().slice(0, 10);
      save(cfg);
      const gi = gitignore(ROOT);
      const summary = { config: rel(configPath()), repo, agents: agents.map((a) => `${a.name}${a.version ? " " + a.version : ""}`), gates, gitignore: gi };
      if (flags.json) { emit(summary); return 0; }
      out(`  wrote ${summary.config}`);
      const where = repo.ecosystems.length ? repo.ecosystems.join(", ")
        : repo.projects.length ? `${repo.projects.length} project${repo.projects.length === 1 ? "" : "s"} (${repo.projects.map((p) => `${p.dir}: ${p.ecosystems.join("/")}`).join(", ")}), none at the top`
        : "no manifest";
      out(`  repo: ${where}; languages ${repo.languages.map(([l, n]) => `${l} ${n}`).join(", ") || "none"}${repo.subrepos.length ? `; subrepos ${repo.subrepos.join(", ")}` : ""}${repo.git ? "" : repo.subrepos.length ? "; the workspace itself is not a git repository, so only lanes inside a subrepo get worktrees and PRs" : "; NOT a git repository (lanes will not get worktrees or PRs)"}`);
      out(`  agents: ${summary.agents.join(", ") || "none found on PATH — lanes need one of claude, codex, gemini, opencode, aider, or lanes.custom_command"}`);
      const flat = gates && typeof gates.quick === "string" ? { ".": gates } : gates;
      const shown = Object.entries(flat).map(([k, v]) => `${k}: ${v.quick || v.full || "?"}`).filter((x) => !x.endsWith("?"));
      out(`  gates: ${shown.length ? shown.join("; ") : "none detected — set kernel.gates so lanes can prove their work"}`);
      if (gi.changed) out(`  .gitignore: added ${gi.added.join(", ")}`);
      // A config file is not an environment. `bb init` used to stop here, so a
      // fresh workspace had no tables, no index, no findings and no page, and
      // nothing said so — the first session simply searched the tree, which is
      // the cost this box exists to remove. The row below names what is still
      // missing and the one command that builds all of it.
      try {
        const env = await import("./env.js");
        const rep = await env.report();
        out(`  environment: ${rep.present} of ${rep.total} artefacts${rep.complete ? " — complete" : `; missing ${rep.missing.join(", ")}`}`);
        out(`\n  next:  bb wire --apply  ·  bb env up --apply${rep.complete ? "" : "   (builds the missing artefacts; no tokens)"}  ·  bb cron --apply   (keeps them fresh, no agent)`);
        out("         bb doctor  ·  bb kernel install  ·  cargo build --release --manifest-path arc/Cargo.toml   (optional, faster)");
      } catch {
        out("\n  next:  bb doctor  ·  bb wire --apply  ·  bb scan  ·  bb kernel install (optional, faster)");
      }
      return 0;
    },
  },
};
