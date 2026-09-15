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
  // A workspace of projects carries git per project, not at the top. Telling it
  // to `git init` is the wrong advice and hides that its lanes already get
  // worktrees where the work actually is.
  const subrepos = (cfg.workspace?.subrepos || []).filter((d) => run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: path.join(ROOT, d) }).rc === 0);
  r.push(inRepo
    ? row("repository", "ok", ROOT, "")
    : subrepos.length
      ? row("repository", "ok", `${ROOT} is a workspace; git lives in ${subrepos.join(", ")}`, "")
      : row("repository", "warn", `${ROOT} is not a git repository`, "git init; without it bb run gets no worktrees and bb git refuses"));
  const gh = which("gh");
  const auth = gh ? run(["gh", "auth", "status"], { timeout: 15000 }) : null;
  r.push(row("gh", !gh ? "warn" : auth.rc === 0 ? "ok" : "warn", !gh ? "not installed" : auth.rc === 0 ? "authenticated" : "not authenticated", !gh ? "install gh for PRs and reviews (optional)" : auth.rc === 0 ? "" : "gh auth login"));
  const kb = kernel.binary();
  r.push(row("kernel", kb ? "ok" : "warn", kb ? `${kernel.version()} at ${kb}` : "absent — JS fallbacks serve walk, estimate, dupes, symbols, gate", kb ? "" : "bb kernel install (release binary) or bb kernel build (cargo)"));
  if (kb) {
    // The binary existing is not the same fact as the binary serving. One probe
    // per op, because a wrong payload key falls back silently and looks fine.
    const { OPS } = await import("./kernel-cmd.js");
    const fell = OPS.filter(([, probe]) => probe() === null).map(([op]) => op);
    r.push(row("kernel ops", fell.length ? "warn" : "ok",
      `${OPS.length - fell.length} of ${OPS.length} served by the kernel${fell.length ? `; JS serves ${fell.join(", ")}` : ""}`,
      fell.length ? "bb kernel ops" : ""));
  }
  const py = expert.pythonName();
  r.push(row("expert", py ? "ok" : "warn", py ? `python ${py}, bundlebox_expert ${expert.version() || "?"}` : "python3 >= 3.9 not found — bb buckmaster unavailable", py ? "" : "install python3; the zero-token path does not need it"));
  let agents = [];
  try { agents = (await import("./adapters/index.js")).detect(); } catch (e) { r.push(row("adapters", "warn", String(e.message).split("\n")[0])); }
  r.push(row("agents", agents.length ? "ok" : "warn", agents.length ? agents.map((a) => `${a.name}${a.version ? " " + a.version : ""}`).join(", ") : "none on PATH", agents.length ? "" : "install claude, codex, gemini, opencode or aider, or set lanes.custom_command"));

  // A mobile driver is optional and its absence is not a warning: most
  // repositories have no phone. What IS a warning is a registered driver whose
  // project directory has moved, because an agent with a dead MCP server sees
  // no tools rather than an error.
  try {
    const art = await import("./recom/artemis.js");
    const w = art.wired();
    const d = art.devices();
    if (w.length) {
      const broken = w.filter((x) => x.project_exists === false);
      const attached = d.devices.filter((x) => x.state === "device");
      r.push(row("mobile driver", broken.length ? "warn" : "ok",
        `artemis in ${w.map((x) => x.agent).join(", ")}${attached.length ? `, ${attached.length} device(s) attached` : ", no device attached"}`,
        broken.length ? `${broken.map((x) => x.cwd).join(", ")} does not exist; re-run \`uv run artemis mcp --install\` from the checkout` : ""));
      r.push(row("mobile gate", "ok", "bb recom gate mobile/<id> -- <drive>  decides whether a drive has to happen", ""));
    }
  } catch { /* the driver check must never be the reason doctor cannot answer */ }
  r.push(row("lane agent", "ok", cfg.lanes.agent === "auto" ? `auto → ${agents[0]?.name || "none"}` : cfg.lanes.agent));
  const hr = which("headroom");
  r.push(row("headroom", hr ? "ok" : "warn", hr ? `${hr} (wire ${cfg.headroom.enabled ? "enabled" : "disabled"})` : "not installed (optional compression proxy)", ""));
  try {
    const { transcripts } = await import("./tokens/ledger.js");
    const t = transcripts(ROOT) || [];
    const by = {};
    for (const x of t) by[x.adapter || x.agent || "?"] = (by[x.adapter || x.agent || "?"] || 0) + 1;
    r.push(row("transcripts", t.length ? "ok" : "warn", t.length ? Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ") : "none found for this workspace", t.length ? "" : "run a session here; bb session and bb buckmaster read what the agent writes"));
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
  // `bb tokens calibrate --write` stamps `calibrated_at`; this row read
  // `fitted_at` and so reported "shipped coefficients" forever, however many
  // times it was run. Both keys are accepted, newest wins.
  const fittedAt = cal.calibrated_at || cal.fitted_at || "";
  r.push(row("calibration", fittedAt ? "ok" : "warn", fittedAt ? `fitted ${fittedAt}${cal.fit?.code?.samples ? ` (${cal.fit.code.samples} samples)` : ""}` : "shipped coefficients", fittedAt ? "" : "bb tokens calibrate --write (needs transcripts)"));
  const obs = cal.overhead_observed || null;
  const over = cfg.budget.overhead_lean ? `${human(cfg.budget.overhead_lean)} (probed lean)`
    : obs && cfg.budget.overhead_tokens ? `${human(cfg.budget.overhead_tokens)} (observed min of ${obs.n} transcript${obs.n > 1 ? "s" : ""}; upper bound for a lean lane)`
    : cfg.budget.overhead_tokens ? `${human(cfg.budget.overhead_tokens)} (calibrated)` : "25.0k (floor, not measured)";
  r.push(row("session overhead", cfg.budget.overhead_lean || cfg.budget.overhead_tokens ? "ok" : "warn", over,
    cfg.budget.overhead_lean ? "" : cfg.budget.overhead_tokens ? "bb tokens profile --probe measures a real lane (spends one short turn)" : "bb tokens profile (free, off transcripts) or --probe (spends one short turn)"));
  // The scenario half of the pipeline: what is on disk to work with, and where
  // the first stage that does not hold is. A workspace with none of this is not
  // broken — it has not been through `bb genesis` yet, and the row says so.
  try {
    const stages = await import("./pipeline/stages.js");
    const g = stages.gaps();
    r.push(row("pipeline", g.gaps.length ? "warn" : "ok",
      `${g.ok} of ${g.of} stages hold${g.next ? `; first gap: ${g.next.title.toLowerCase()}` : ""}`,
      g.next ? g.next.fix : ""));
  } catch (e) { r.push(row("pipeline", "warn", `stages could not be evaluated: ${String(e.message).split("\n")[0]}`, "")); }
  try {
    const corpus = await import("./cookbook/corpus.js");
    const rows = corpus.list();
    const steps = rows.reduce((a, c) => a + (c.steps || 0), 0);
    r.push(row("corpora", rows.length ? "ok" : "warn",
      rows.length ? `${rows.length} corpus/corpora, ${rows.reduce((a, c) => a + (c.scenarios || 0), 0)} scenarios, ${steps} steps` : "none — a corpus is how anything checks what the RUNNING system does",
      rows.length ? "" : "bb genesis <doc.md>  seeds one from a document"));
  } catch (e) { r.push(row("corpora", "warn", String(e.message).split("\n")[0], "")); }
  try {
    const monitor = await import("./monitor/index.js");
    const s = monitor.snapshot();
    r.push(row("window", s.state === "hit" || s.state === "indeterminate" ? "warn" : "ok",
      s.state === "indeterminate" ? (s.why || "no limit could be established") :
      `${s.limit.pct ?? "?"}% of the 5-hour block (${s.limit.source})${s.block ? `, ${s.block.minutes_left}m left` : ""}`,
      s.state === "indeterminate" ? "bb tokens ledger, then bb monitor --plan max5" : ""));
  } catch (e) { r.push(row("window", "warn", String(e.message).split("\n")[0], "")); }
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
