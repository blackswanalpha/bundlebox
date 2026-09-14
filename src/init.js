// init.js — `bb init`: look at the tree once and write the config a session
// would otherwise be paid to infer. Only non-default keys are written, so the
// file stays a statement of what this repo changed, not a copy of the defaults.
import fs from "node:fs";
import path from "node:path";
import { ROOT, BB_DIR, ensureDirs, rel } from "./core/paths.js";
import { DEFAULTS, configPath, userConfig, save } from "./core/config.js";
import { out, warn, emit } from "./core/log.js";
import { walk, langOf } from "./core/fs.js";

const MANIFESTS = { "package.json": "node", "pyproject.toml": "python", "requirements.txt": "python", "Cargo.toml": "rust", "go.mod": "go", "pubspec.yaml": "dart", "Gemfile": "ruby", "composer.json": "php", "build.gradle": "jvm", "pom.xml": "jvm", "Package.swift": "swift", "mix.exs": "elixir" };

export function detectRepo(root = ROOT) {
  const manifests = Object.keys(MANIFESTS).filter((m) => fs.existsSync(path.join(root, m)));
  const langs = {};
  for (const f of walk(root)) { const l = langOf(f); if (l !== "other" && l !== "md") langs[l] = (langs[l] || 0) + 1; }
  const top = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 5);
  // Sub-trees with their own .git are separate repos: a lane can only get a worktree in one of those.
  const subrepos = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(root, e.name, ".git"))).map((e) => e.name);
  return { manifests, ecosystems: [...new Set(manifests.map((m) => MANIFESTS[m]))], languages: top, subrepos, git: fs.existsSync(path.join(root, ".git")) };
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
      let gates = {};
      try { gates = (await import("./compile/compiler.js")).detectGates(ROOT) || {}; } catch { /* no compiler: gates stay empty */ }
      const cfg = existing ? userConfig() : {};
      cfg.workspace = { ...(cfg.workspace || {}) };
      if (repo.subrepos.length) cfg.workspace.subrepos = repo.subrepos;
      if (!Object.keys(cfg.workspace).length) delete cfg.workspace;
      if (agents.length && agents[0].name !== DEFAULTS.lanes.agent) cfg.lanes = { ...(cfg.lanes || {}), agent: agents[0].name };
      if (Object.keys(gates).length) cfg.kernel = { ...(cfg.kernel || {}), gates };
      cfg.$schema = "https://github.com/blackswanalpha/bundlebox/blob/main/src/core/config.js";
      cfg.initialised = new Date().toISOString().slice(0, 10);
      save(cfg);
      const gi = gitignore(ROOT);
      const summary = { config: rel(configPath()), repo, agents: agents.map((a) => `${a.name}${a.version ? " " + a.version : ""}`), gates, gitignore: gi };
      if (flags.json) { emit(summary); return 0; }
      out(`  wrote ${summary.config}`);
      out(`  repo: ${repo.ecosystems.join(", ") || "no manifest"}; languages ${repo.languages.map(([l, n]) => `${l} ${n}`).join(", ") || "none"}${repo.subrepos.length ? `; subrepos ${repo.subrepos.join(", ")}` : ""}${repo.git ? "" : "; NOT a git repository (lanes will not get worktrees or PRs)"}`);
      out(`  agents: ${summary.agents.join(", ") || "none found on PATH — lanes need one of claude, codex, gemini, opencode, aider, or lanes.custom_command"}`);
      const flat = gates && typeof gates.quick === "string" ? { ".": gates } : gates;
      const shown = Object.entries(flat).map(([k, v]) => `${k}: ${v.quick || v.full || "?"}`).filter((x) => !x.endsWith("?"));
      out(`  gates: ${shown.length ? shown.join("; ") : "none detected — set kernel.gates so lanes can prove their work"}`);
      if (gi.changed) out(`  .gitignore: added ${gi.added.join(", ")}`);
      out("\n  next:  bb doctor  ·  bb wire --apply  ·  bb scan  ·  bb kernel install (optional, faster)");
      return 0;
    },
  },
};
