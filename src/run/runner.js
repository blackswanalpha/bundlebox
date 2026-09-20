// runner.js — lanes become live agent sessions, in parallel, with a meter on.
//
// One process per lane, through the adapter the config picked. The prompt and
// the exact command are written to `var/runs/<run_id>/` BEFORE anything is
// spawned, so a dry run and a real run leave the same artefacts and the real
// one can be reproduced by hand from the `.cmd` file.
//
// What the runner does that a shell loop would not:
//   * a stable session id per lane, derived from (run_id, lane_id), so a
//     re-run resumes rather than re-priming a fresh window;
//   * peak-window tracking off the stream while the lane is alive, because the
//     budget is a PEAK, and a breach is worth knowing before compaction;
//   * the acceptance command, run after, with its exit code as the verdict. A
//     lane that says it is done and whose acceptance fails is a FAILED lane; a
//     unit with no acceptance is `unproven`, never green;
//   * an env ALLOWLIST. Doctrine 10: the parent env is never inherited whole.
//
// The spawn is local rather than `exec.stream` for one reason: `exec.stream`
// merges `process.env` under whatever env it is handed, which is exactly the
// inheritance the allowlist exists to prevent. The local spawn also carries a
// hard timer that escalates SIGTERM to SIGKILL, independent of output.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { load } from "../core/config.js";
import { run, which, git } from "../core/exec.js";
import { VAR, ROOT, rel } from "../core/paths.js";
import * as store from "../core/store.js";
import { now, sha1, human } from "../core/util.js";
import { warn } from "../core/log.js";
import { pick, get, num } from "../adapters/index.js";
import * as ledger from "../tokens/ledger.js";
import * as prices from "../tokens/prices.js";
import * as headroom from "../tokens/headroom.js";
import { runGate } from "../compile/compiler.js";

// Matched case-INSENSITIVELY, and Windows' own names are in the list.
// `Object.entries(process.env)` hands back the spellings the OS uses: Windows
// says `Path`, `SystemRoot`, `ComSpec`, not the POSIX ones. A case-sensitive
// allowlist admitted none of them, so a lane spawned on Windows got an
// environment with no PATH — the agent binary could not be found — and no
// SystemRoot, which winsock and much of the Windows API need in order to start
// at all. The failure was invisible because the lane never got far enough to
// report it.
//
// Still an allowlist, per doctrine 10: this adds the names a Windows process
// cannot run without, and nothing else.
export const ENV_ALLOW = new RegExp(
  "^(PATH|HOME|USER|SHELL|LANG|LC_ALL|TERM|TMPDIR|SSH_AUTH_SOCK"
  + "|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|SYSTEMDRIVE|TEMP|TMP"
  + "|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA"
  + "|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$"
  + "|^(XDG_|NODE_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|CLAUDE_|CODEX_|GIT_)", "i");

export function runDir(runId) {
  const d = path.join(VAR, "runs", String(runId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** POSIX single-quote quoting; bare only for the safe character set. */
export function shellQuote(s) {
  s = String(s);
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** UUID-shaped, deterministic in (run_id, lane_id): Claude requires a valid UUID
 *  for `--session-id`, and the same lane re-run must land in the same session. */
export function laneSessionId(runId, laneId) {
  const h = sha1(`${runId}:${laneId}`);
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function lanePrompt(lane) {
  const units = lane.units || [];
  const parts = [`Lane ${lane.id}. Checkout: ${lane.worktree || lane.cwd || ROOT}`, "",
    "Everything you need is below, gathered by a local static analysis pass. It is accurate. Re-deriving it spends the budget this lane was given. Read the evidence, make the change, run the acceptance command.", ""];
  units.forEach((u, i) => {
    parts.push(`---\n## Task ${i + 1} of ${units.length}: ${u.title || u.id}\n`, u.brief || "");
    if (u.acceptance) parts.push(`\nAcceptance: \`${u.acceptance}\``);
  });
  parts.push("\n---\nWhen every task is done, print one line per task:\n  BB-RESULT <unit-id> <done|blocked> <one sentence>\nNothing else after those lines. No summary.");
  return parts.join("\n");
}

/** Only what the allowlist admits, plus what the adapter and the wire add. */
export function laneEnv(extra = {}, { source = process.env } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(source)) if (ENV_ALLOW.test(k) && v != null) env[k] = v;
  // Names are kept as the OS spells them, because that is what the child
  // expects. But Windows environment names are case-insensitive while a plain
  // JS object's keys are not, and this tool, its adapters and its tests read
  // `env.PATH`, so the canonical spelling is added when only a variant is there.
  if (env.PATH == null) {
    const k = Object.keys(env).find((x) => x.toUpperCase() === "PATH");
    if (k) env.PATH = env[k];
  }
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") env[k] = String(v);
  return env;
}

function defaultBase(repo) {
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  return r.rc === 0 && r.out.trim() ? r.out.trim() : "origin/main";
}

/** Create the lane's worktree and SEED it. `git worktree add` gives the tracked
 *  files and nothing else; gates here need gitignored files (`.env`, wrappers,
 *  generated clients) or they fail for a reason that is not the lane's. */
export function ensureWorktree(lane, { apply = false, cfg = load() } = {}) {
  const wt = lane.worktree;
  if (!wt || wt === lane.cwd || wt === ROOT) return { ok: true, note: "shared checkout" };
  const repo = lane.cwd && lane.cwd !== wt ? lane.cwd : ROOT;
  const seeds = cfg.kernel?.seed || [];
  const seed = () => { const copied = []; for (const s of seeds) { const src = path.join(repo, s), dst = path.join(wt, s); if (!fs.existsSync(src) || fs.existsSync(dst)) continue; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true }); copied.push(s); } return copied; };
  if (fs.existsSync(wt)) {
    // An existing worktree may predate this plan: dirty or on another branch is stale, and the lane will be told.
    const st = git(["status", "--porcelain"], wt), br = git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
    if (st.rc !== 0) warn(`${lane.id}: ${rel(wt)} exists but is not a git checkout`);
    else if (st.out.trim() || (lane.branch && br.out.trim() !== lane.branch)) warn(`${lane.id}: existing worktree ${rel(wt)} is stale (dirty or on ${br.out.trim() || "?"})`);
    const copied = apply ? seed() : [];
    return { ok: true, note: copied.length ? `worktree exists, seeded ${copied.length} file(s)` : "worktree exists" };
  }
  if (!apply) return { ok: true, note: `would create worktree ${rel(wt)} (${lane.branch || "detached"})${seeds.length ? ` and seed ${seeds.length} file(s)` : ""}` };
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const branch = lane.branch || `bb/${lane.run_id}-${lane.id}`.toLowerCase();
  let r = git(["worktree", "add", "-b", branch, wt, defaultBase(repo)], repo);
  if (r.rc !== 0) r = git(["worktree", "add", "-b", branch, wt], repo);
  if (r.rc !== 0) return { ok: false, note: (r.err || r.out).trim().slice(0, 300) };
  const copied = seed();
  return { ok: true, note: `created${copied.length ? ` and seeded ${copied.length} file(s)` : ""}` };
}

/** Live peak-window tracking off the stream. One row per message id holding the
 *  LATEST event for it: a streamed turn emits several events under one id and
 *  output grows across them, so last-wins is the only reading that matches the
 *  provider. The bill is only knowable at the end, so it is read off the
 *  `result` event and the per-row output is not invented. */
export class LaneMeter {
  constructor(laneId, ceiling) { this.laneId = laneId; this.ceiling = ceiling; this.peak = 0; this.breached = false; this.final = null; this.sessionId = null; this.byMsg = new Map(); }
  feed(evt) {
    if (!evt) return;
    if (evt.sessionId && !this.sessionId) this.sessionId = evt.sessionId;
    if (evt.isResult) { if (evt.resultUsage) this.final = evt.resultUsage; return; }
    if (!evt.msgId) return;
    const window = num(evt.input) + num(evt.cacheWrite) + num(evt.cacheRead);
    this.peak = Math.max(this.peak, window);
    if (this.ceiling && window > this.ceiling && !this.breached) {
      this.breached = true;
      warn(`${this.laneId}: window ${human(window)} past ceiling ${human(this.ceiling)} — this lane will compact`);
    }
    this.byMsg.set(evt.msgId, { msg_id: evt.msgId, model: evt.model || "", input: num(evt.input), output: num(evt.output), cache_write: num(evt.cacheWrite), cache_read: num(evt.cacheRead), ts: now() });
  }
  get turns() { return this.byMsg.size; }
  get outTokens() { return this.final ? num(this.final.output) : [...this.byMsg.values()].reduce((a, r) => a + r.output, 0); }
  /** Rows for the store: per-row output zeroed and the measured total carried on the last one, when a total exists. */
  usageRows() {
    const rows = [...this.byMsg.values()];
    if (!rows.length || !this.final) return rows;
    for (const r of rows) r.output = 0;
    rows[rows.length - 1].output = num(this.final.output);
    return rows;
  }
}

/** Spawn with an allowlisted env and a hard timer. Never throws; a missing binary is rc 127. */
function spawnLane(argv, { cwd, env, input, onLine, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return resolve({ rc: 127, seconds: 0, stderr: String(e.message || e), timedOut: false }); }
    let buf = "", ebuf = "", timedOut = false, settled = false;
    const finish = (rc) => { if (settled) return; settled = true; clearTimeout(soft); clearTimeout(hard); if (buf) onLine(buf); resolve({ rc, seconds: (Date.now() - t0) / 1000, stderr: ebuf.slice(-2000), timedOut }); };
    const soft = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs) : null;
    const hard = timeoutMs ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs + 10000) : null;
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on("data", (d) => { ebuf += d; });
    child.on("error", (e) => finish(e.code === "ENOENT" ? 127 : 1) || (ebuf += String(e.message || e)));
    child.on("close", (rc) => finish(rc ?? 1));
    child.stdin.on("error", () => { /* the child closed stdin first; nothing to do */ });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Spend so far today against `lanes.daily_budget_usd`. Fails CLOSED: an error
 *  reading the ledger refuses the run rather than spending blind. */
export function dailyBudget(cfg = load()) {
  const limit = num(cfg.lanes?.daily_budget_usd);
  if (!limit) return { ok: true, limit: 0, spent: 0 };
  try {
    const today = new Date().toISOString().slice(0, 10);
    let spent = 0;
    for (const r of ledger.usage()) {
      if (!String(r.ts || r.at || "").startsWith(today)) continue;
      const c = prices.cost(r.model, { inp: num(r.input), out: num(r.output), cache_write: num(r.cache_write), cache_read: num(r.cache_read) });
      if (c) spent += c.total;
    }
    return spent >= limit ? { ok: false, limit, spent, why: `daily budget $${limit} reached ($${spent.toFixed(2)} spent today)` } : { ok: true, limit, spent };
  } catch (e) { return { ok: false, limit, spent: null, why: `budget check failed (${e.message}); refusing to spawn` }; }
}

function setLane(laneId, runId, patch) {
  const lanes = store.get("lanes", []);
  const i = lanes.findIndex((l) => l.id === laneId && l.run_id === runId);
  if (i >= 0) lanes[i] = { ...lanes[i], ...patch }; else lanes.push({ id: laneId, run_id: runId, ...patch });
  store.put("lanes", lanes);
}

function pushAndPr(lane, cfg) {
  if (!cfg.git?.allow_push) return { ok: false, why: "git.allow_push = false" };
  const cwd = lane.worktree || lane.cwd || ROOT;
  const p = git(["push", "-u", "origin", lane.branch || "HEAD"], cwd);
  if (p.rc !== 0) return { ok: false, why: (p.err || p.out).trim().slice(0, 300) };
  const args = ["pr", "create", "--fill", ...(cfg.git?.draft_pr ? ["--draft"] : [])];
  const r = run(["gh", ...args], { cwd, timeout: 120000 });
  return r.rc === 0 ? { ok: true, url: r.out.trim().split("\n").pop() } : { ok: false, why: r.missing ? "gh not installed" : (r.err || r.out).trim().slice(0, 300) };
}

export async function executeLane(lane, { apply = false, adapter, wire = {}, pr = false, cfg = load() } = {}) {
  const adp = adapter || pick(cfg);
  const rd = runDir(lane.run_id);
  const cwd = lane.worktree || lane.cwd || ROOT;
  const prompt = lanePrompt(lane);
  const promptFile = path.join(rd, `${lane.id}.prompt.md`);
  const cmdFile = path.join(rd, `${lane.id}.cmd`);
  fs.writeFileSync(promptFile, prompt);
  const sessionId = lane.session_id || laneSessionId(lane.run_id, lane.id);
  const spec = adp.buildCmd({ promptFile, prompt, cwd, model: lane.model || cfg.lanes.model || "", maxTurns: cfg.lanes.max_turns,
    permissionMode: cfg.lanes.permission_mode, sessionId, budgetUsd: cfg.lanes.max_budget_usd, allowedTools: lane.allowed_tools, name: `bb-${lane.id}` });
  const envExtra = { ...(spec.env || {}), ...wire, BB_LANE: lane.id, BB_RUN: lane.run_id };
  const cmdText = spec.argv
    ? `${spec.argv.map(shellQuote).join(" ")}${spec.stdin === "prompt" ? ` < ${shellQuote(promptFile)}` : ""}\n`
    : `# ${adp.name}: spawns nothing\n`;
  fs.writeFileSync(cmdFile, `${cmdText}# cwd: ${cwd}\n# env: ${Object.keys(envExtra).join(" ")}\n${spec.note ? `# ${spec.note}\n` : ""}`);

  const wt = ensureWorktree(lane, { apply, cfg });
  const base = { lane: lane.id, run_id: lane.run_id, agent: adp.name, session_id: sessionId, prompt_file: rel(promptFile), cmd_file: rel(cmdFile) };
  if (!wt.ok) return { ...base, rc: 3, why: `worktree: ${wt.note}`, peak: 0 };
  if (!apply) return { ...base, rc: 0, dry_run: true, peak: 0, why: wt.note };

  const t0 = Date.now();
  const meter = new LaneMeter(lane.id, num(cfg.budget?.max_tokens));
  let rc = 0, why = "", stderr = "", spawned = false;
  if (spec.argv) {
    if (!which(spec.argv[0])) { rc = 127; why = `binary not found: ${spec.argv[0]}`; }
    else {
      spawned = true;
      setLane(lane.id, lane.run_id, { status: "running", started: now(), session_id: sessionId, agent: adp.name });
      const sink = fs.openSync(path.join(rd, `${lane.id}.jsonl`), "w");
      const res = await spawnLane(spec.argv, { cwd, env: laneEnv(envExtra), input: spec.stdin === "prompt" ? prompt : null, timeoutMs: num(cfg.lanes.timeout_s || 3600) * 1000,
        onLine: (line) => { fs.writeSync(sink, line + "\n"); meter.feed(adp.parseEvent(line)); } });
      fs.closeSync(sink);
      rc = res.rc; stderr = res.stderr || "";
      if (res.timedOut) { rc = rc || 124; why = "timeout"; }
      else if (rc === 127) why = `binary not found: ${spec.argv[0]}`;
    }
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const sid = meter.sessionId || sessionId;
  for (const r of meter.usageRows()) store.append("usage", { session_id: sid, agent: adp.name, run_id: lane.run_id, lane_id: lane.id, ...r });

  const result = { ...base, session_id: sid, rc, why, peak: meter.peak, turns: meter.turns, output_tokens: meter.outTokens, breached: meter.breached, seconds, spawned, stderr: stderr.trim().slice(0, 500) };
  const units = lane.units || [];
  const acc = [...new Set(units.map((u) => u.acceptance).filter(Boolean))];
  const unproven = units.filter((u) => !u.acceptance).map((u) => u.id);
  if (acc.length && rc === 0) {
    // The kernel enforces the timeout itself and caps the output, so a gate that
    // hangs before its first byte is still killed and a failing build cannot
    // eat the window explaining that it failed. Without the kernel: bash + timer.
    result.acceptance = acc.map((cmd) => runGate(cmd, { cwd, timeout: num(cfg.kernel?.gate_timeout || 1800) }));
    if (result.acceptance.some((a) => a.rc !== 0)) { result.rc = 1; result.why = "acceptance failed"; }
  }
  // Named, never silent: a unit with no acceptance skipped a check, and that must not read like passing one.
  if (unproven.length) result.unproven = unproven;
  result.pr_eligible = result.rc === 0 && acc.length > 0 && unproven.length === 0;
  if (pr) result.pr = result.pr_eligible ? pushAndPr(lane, cfg) : { ok: false, why: unproven.length ? "unproven units" : result.rc ? "lane failed" : "no acceptance ran" };

  setLane(lane.id, lane.run_id, { status: result.rc === 0 ? "done" : "failed", rc: result.rc, why: result.why, peak: meter.peak, session_id: sid, ended: now(), agent: adp.name });
  store.append("episodes", { kind: "lane", verb: "run", prev: "route", features: { agent: adp.name, model: lane.model || cfg.lanes.model || "", units: units.length, est_tokens: num(lane.est_tokens) },
    rc: result.rc, seconds, produced: meter.peak, reads: 0, turns_saved: 0, run_id: lane.run_id, lane_id: lane.id, useful: -1 });
  return result;
}

/** Run the plan wave by wave: waves sequential, lanes within a wave concurrent up to maxParallel. */
export async function execute(plan, { apply = false, pr = false, maxParallel = 0, adapter = "" } = {}) {
  const cfg = load();
  const adp = adapter ? get(adapter) : pick(cfg);
  if (!adp) return { run_id: plan.run_id, rc: 2, why: `unknown adapter: ${adapter}`, results: [] };
  const limit = Math.max(1, num(maxParallel) || num(cfg.lanes.max_parallel) || 1);
  const hr = await headroom.ensureForRun({ apply, agent: adp.name });
  if (apply) { const b = dailyBudget(cfg); if (!b.ok) return { run_id: plan.run_id, rc: 2, why: b.why, results: [], agent: adp.name, wire: hr.note }; }
  const byId = new Map((plan.lanes || []).map((l) => [l.id, l]));
  const waves = plan.waves?.length ? plan.waves : [[...byId.keys()]];
  const results = [];
  for (const wave of waves) {
    const queue = wave.map((id) => byId.get(id)).filter(Boolean);
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let lane = queue.shift(); lane; lane = queue.shift()) results.push(await executeLane(lane, { apply, adapter: adp, wire: hr.env, pr, cfg }));
    });
    await Promise.all(workers);
  }
  return { run_id: plan.run_id, rc: results.some((r) => r.rc !== 0) ? 1 : 0, agent: adp.name, dry_run: !apply, wire: hr.note, results,
    peak_total: results.reduce((a, r) => a + num(r.peak), 0), failed: results.filter((r) => r.rc !== 0).map((r) => r.lane), unproven: results.flatMap((r) => r.unproven || []) };
}
