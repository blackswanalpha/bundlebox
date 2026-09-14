// doctor.js — what this box can run, and which runtime serves each op. Every
// row carries a one-line fix. Doctor reports; it never fails the process,
// because a box that cannot run lanes can still scan.
import fs from "node:fs";
import path from "node:path";
import { ROOT, BB_DIR, VAR } from "./core/paths.js";
import { load, configPath, calibrationPath, readJson } from "./core/config.js";
import { run, which } from "./core/exec.js";
import { out, emit } from "./core/log.js";
import * as kernel from "./core/kernel.js";
import * as expert from "./core/expert.js";
import { human } from "./core/util.js";

const row = (name, state, value, fix = "") => ({ name, state, value, fix });
function du(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) { const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else { try { n += fs.statSync(p).size; } catch { /* gone */ } } } }
  return n;
}

export async function rows() {
  const cfg = load();
  const r = [];
  const [maj] = process.versions.node.split(".").map(Number);
  r.push(row("node", maj >= 20 ? "ok" : "warn", process.version, maj >= 20 ? "" : "bundlebox needs Node >= 20"));
  r.push(row("git", which("git") ? "ok" : "missing", which("git") || "", which("git") ? "" : "install git; lanes, worktrees and PRs need it"));
  const inRepo = run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: ROOT }).rc === 0;
  r.push(row("repository", inRepo ? "ok" : "warn", inRepo ? ROOT : `${ROOT} is not a git repository`, inRepo ? "" : "git init; without it bb run gets no worktrees and bb git refuses"));
  const gh = which("gh");
  const auth = gh ? run(["gh", "auth", "status"], { timeout: 15000 }) : null;
  r.push(row("gh", !gh ? "warn" : auth.rc === 0 ? "ok" : "warn", !gh ? "not installed" : auth.rc === 0 ? "authenticated" : "not authenticated", !gh ? "install gh for PRs and reviews (optional)" : auth.rc === 0 ? "" : "gh auth login"));
  const kb = kernel.binary();
  r.push(row("kernel", kb ? "ok" : "warn", kb ? `${kernel.version()} at ${kb}` : "absent — JS fallbacks serve walk, estimate, dupes, symbols, gate", kb ? "" : "bb kernel install (release binary) or bb kernel build (cargo)"));
  const py = expert.python();
  r.push(row("expert", py ? "ok" : "warn", py ? `python ${py}, bundlebox_expert ${expert.version() || "?"}` : "python3 >= 3.9 not found — bb learn unavailable", py ? "" : "install python3; the zero-token path does not need it"));
  let agents = [];
  try { agents = (await import("./adapters/index.js")).detect(); } catch (e) { r.push(row("adapters", "warn", String(e.message).split("\n")[0])); }
  r.push(row("agents", agents.length ? "ok" : "warn", agents.length ? agents.map((a) => `${a.name}${a.version ? " " + a.version : ""}`).join(", ") : "none on PATH", agents.length ? "" : "install claude, codex, gemini, opencode or aider, or set lanes.custom_command"));
  r.push(row("lane agent", "ok", cfg.lanes.agent === "auto" ? `auto → ${agents[0]?.name || "none"}` : cfg.lanes.agent));
  const hr = which("headroom");
  r.push(row("headroom", hr ? "ok" : "warn", hr ? `${hr} (wire ${cfg.headroom.enabled ? "enabled" : "disabled"})` : "not installed (optional compression proxy)", ""));
  try {
    const { transcripts } = await import("./tokens/ledger.js");
    const t = transcripts(ROOT) || [];
    const by = {};
    for (const x of t) by[x.adapter || x.agent || "?"] = (by[x.adapter || x.agent || "?"] || 0) + 1;
    r.push(row("transcripts", t.length ? "ok" : "warn", t.length ? Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ") : "none found for this workspace", t.length ? "" : "run a session here; bb session and bb learn read what the agent writes"));
  } catch (e) { r.push(row("transcripts", "warn", String(e.message).split("\n")[0])); }
  r.push(row("config", fs.existsSync(configPath()) ? "ok" : "warn", fs.existsSync(configPath()) ? path.relative(ROOT, configPath()) : "defaults only", fs.existsSync(configPath()) ? "" : "bb init"));
  // Gates: `{quick, full, ...}` for the root, or `{<dir>: {quick, full}}` per subrepo.
  let gates = cfg.kernel.gates || {};
  if (!Object.keys(gates).length) { try { gates = (await import("./compile/compiler.js")).detectGates(ROOT) || {}; } catch { /* none */ } }
  const perDir = Object.values(gates).some((v) => v && typeof v === "object") ? gates : { ".": gates };
  let any = false;
  for (const [dir, g] of Object.entries(perDir)) {
    for (const level of ["quick", "full"]) {
      const cmd = (g && g[level]) || "";
      if (!cmd) continue;
      any = true;
      const bin = cmd.split(/\s+/)[0];
      r.push(row(`gate ${dir} ${level}`, which(bin) ? "ok" : "warn", cmd, which(bin) ? "" : `${bin} is not on PATH`));
    }
  }
  if (!any) r.push(row("gates", "warn", "none detected", "set kernel.gates.quick; a unit with no gate is unproven"));
  const cal = readJson(calibrationPath(), {}) || {};
  r.push(row("calibration", cal.fitted_at ? "ok" : "warn", cal.fitted_at ? `fitted ${cal.fitted_at}` : "shipped coefficients", cal.fitted_at ? "" : "bb tokens calibrate --write (needs transcripts)"));
  const over = cfg.budget.overhead_lean ? `${human(cfg.budget.overhead_lean)} (probed lean)` : cfg.budget.overhead_tokens ? `${human(cfg.budget.overhead_tokens)} (calibrated)` : "25.0k (floor, not measured)";
  r.push(row("session overhead", cfg.budget.overhead_lean || cfg.budget.overhead_tokens ? "ok" : "warn", over, cfg.budget.overhead_lean ? "" : "bb tokens profile --probe (spends one short turn)"));
  r.push(row("state", "ok", `${human(du(BB_DIR))}B under ${path.relative(ROOT, BB_DIR)}`, ""));
  return r;
}

export const commands = {
  doctor: {
    help: "what this box can run, and which runtime serves each op",
    usage: "bb doctor [--json]",
    run: async ({ flags }) => {
      const r = await rows();
      if (flags.json) { emit({ rows: r }); return 0; }
      const mark = { ok: "ok  ", warn: "warn", missing: "MISS" };
      for (const x of r) out(`  ${mark[x.state] || x.state}  ${x.name.padEnd(18)} ${x.value}${x.fix ? `\n        fix: ${x.fix}` : ""}`);
      const bad = r.filter((x) => x.state !== "ok").length;
      out(`\n  ${r.length} rows, ${bad} need attention`);
      return 0;
    },
  },
};
