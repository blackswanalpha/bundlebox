// foreman — a responsibility policy that watches the coding agent.
//
//   bb foreman [assess]        score the agent's session and pick one action
//   bb foreman verify          run the verification command and record it
//   bb foreman replay          re-decide the timeline under other thresholds
//   bb foreman label <i> right|wrong   mark a recorded action for replay
//   bb foreman log | checks
//
// The design is thruwire/foreman's: responsibilities own yes/no checks, Jev
// answers every check in one pass, and a deterministic policy in
// `bundlebox_expert/foreman.py` turns the probabilities into continue, steer,
// stop, verify, resume, finish or escalate. This side gathers the evidence and
// owns the clock, the network and the timeline; the policy reads none of them.
//
// Jev is the same call `grapple/jev.js` makes and follows its rules: off
// unless TYPESAFE_API_KEY is set, BB_JEV=off turns it off, and every failure
// falls back. Without it the checks come from the box's own evidence: the
// grapple drift window, git's changed files and the last verification run.
//
// Every assessment is one row of `.bundlebox/var/foreman-timeline.jsonl` with
// the scores and state it was decided on, so `replay` can re-run any
// threshold change and count what would have moved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { load } from "../core/config.js";
import { out, emit as emitJson } from "../core/log.js";
import { ROOT } from "../core/paths.js";
import { sha1, table } from "../core/util.js";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import * as brief from "../wire/brief.js";
import * as gs from "../grapple/store.js";
import * as detect from "../grapple/detect.js";
import * as jev from "../grapple/jev.js";

export const TIMELINE = "foreman-timeline";    // .bundlebox/var/foreman-timeline.jsonl
export const HOOK_STATE = "foreman-hook";      // .bundlebox/var/foreman-hook.json: per-session call count and base
export const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const OUTPUT_TAIL = 4000;

export const settings = (cfg = load()) => ({ ...(cfg.foreman && typeof cfg.foreman === "object" ? cfg.foreman : {}) });

function git(...args) {
  const env = typeof args[args.length - 1] === "object" ? { ...process.env, ...args.pop() } : process.env;
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024, env });
  return r.status === 0 ? String(r.stdout || "") : "";
}

/** The tree object the working tree would commit as, ignores applied, built in
 *  a throwaway index so the real one is never touched. Same content, same
 *  hash, whether the content is committed, staged or neither. */
export function contentHash() {
  const idx = path.join(os.tmpdir(), `bb-foreman-${process.pid}-${Date.now()}.idx`);
  try {
    const env = { GIT_INDEX_FILE: idx };
    git("read-tree", "HEAD", env);
    git("add", "-A", env);
    return git("write-tree", env).trim();
  } finally { try { fs.unlinkSync(idx); } catch { /* never written */ } }
}

export const rev = (r) => (r ? git("rev-parse", "--verify", "--quiet", `${r}^{commit}`).trim() : "");

/** The commit a run is measured from: `--since`, else the base the run's
 *  first assessment recorded, else HEAD when the hook first saw the session,
 *  else HEAD now. Measuring from HEAD alone saw only uncommitted work, so a
 *  run that committed as it went looked like a run that had done nothing. */
export function baseOf({ since = "", rows = [], session = "" } = {}) {
  if (since) return rev(since);
  const recorded = rows.find((r) => r.base)?.base;
  if (recorded && rev(recorded)) return recorded;
  const seen = session ? (store.get(HOOK_STATE, {}) || {})[session]?.base : "";
  if (seen && rev(seen)) return seen;
  return rev("HEAD");
}

/** The work since `base`, committed or not. The fingerprint is the content
 *  hash, so committing a verified change leaves it verified and any edit to
 *  the content makes the verification stale. */
export function tree(base = "") {
  const b = base || rev("HEAD");
  const head = rev("HEAD");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  const diff = b ? git("diff", "--no-ext-diff", b) : "";
  const files = [...new Set([...(b ? git("diff", "--name-only", b).split("\n") : []), ...untracked].filter(Boolean))];
  const commits = b && head && b !== head ? git("log", "-n", "200", "--format=%h %s", `${b}..HEAD`).split("\n").filter(Boolean) : [];
  return { base: b, status: git("status", "--short"), diff, files, commits, fingerprint: contentHash() || sha1(diff + "\0" + untracked.join("\n")).slice(0, 16) };
}

/** The first repository instruction file that is a real, non-empty file. */
export function instructions() {
  for (const f of INSTRUCTION_FILES) {
    const p = path.join(ROOT, f);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) continue;
      const text = fs.readFileSync(p, "utf8");
      if (text.trim()) return { path: f, text };
    } catch { /* absent */ }
  }
  return { path: null, text: "" };
}

export const timeline = ({ run = "" } = {}) => store.rows(TIMELINE).filter((r) => !run || r.run === run);

/** The run's history as the policy's state: iteration, steers, retries, the
 *  last action, and how many turns have passed since the last steer. */
export function history(rows, turnCount) {
  const assessed = rows.filter((r) => r.kind === "assess");
  const steers = assessed.filter((r) => r.action === "steer");
  let retries = 0;
  for (let i = 1; i < assessed.length; i++) if (assessed[i].action === "resume" && assessed[i - 1].action === "stop") retries += 1;
  const last = steers[steers.length - 1];
  return {
    iteration: assessed.length,
    steers: steers.length,
    retries,
    previous: assessed.length ? assessed[assessed.length - 1].action : null,
    turns_since_steer: last ? Math.max(0, turnCount - (Number(last.turns) || 0)) : null,
  };
}

/** The latest verification run, and whether the tree has moved since. */
export function verification(rows, fingerprint) {
  const v = [...rows].reverse().find((r) => r.kind === "verify");
  if (!v) return {};
  return { command: v.command, ok: v.ok, output: v.output, current: v.fingerprint === fingerprint };
}

/** Everything the policy sees, gathered once. */
export function observe({ session = "", job = "", active = false, since = "", cfg = load() } = {}) {
  const events = gs.events();
  const sid = session || [...events].reverse().find((e) => e.kind === "tool" && e.session_id)?.session_id || "";
  const rec = brief.current({ maxAgeMin: Number(cfg.wire?.brief_max_age_min) || 45, sessionId: sid });
  const w = detect.windowOf(events, { scope: rec?.scope || [], session: sid });
  const run = sid || "cli";
  const rows = timeline({ run });
  const base = baseOf({ since, rows, session: sid });
  if (since && !base) return { error: `--since ${since} is not a commit` };
  const t = tree(base);
  const lastJob = [...rows].reverse().find((r) => r.job)?.job || "";
  return {
    run,
    base: t.base,
    fingerprint: t.fingerprint,
    observation: {
      job: job || lastJob || rec?.problem || "",
      active: Boolean(active),
      turns: w.turns,
      scope: w.scope,
      git: { base: t.base, commits: t.commits, status: t.status, diff: t.diff, files: t.files },
      instructions: instructions(),
      verification: verification(rows, t.fingerprint),
      ...history(rows, w.turns.length),
    },
  };
}

/** One assessment, recorded. `{ error }` when there is no interpreter. */
export function assess(opts = {}) {
  const cfg = opts.cfg || load();
  const fcfg = settings(cfg);
  const o = observe({ ...opts, cfg });
  if (o.error) return o;
  let answers = null, jevMs = null, jevAttempts = null;
  if (opts.jev !== false && jev.available()) {
    const q = expert.call("foreman", { op: "questions", observation: o.observation, cfg: fcfg });
    const r = q && jev.probabilities(q.state, q.questions, opts.jevRetries == null ? {} : { retries: opts.jevRetries });
    if (r) { answers = r.by; jevMs = r.ms; jevAttempts = r.attempts; }
  }
  const d = expert.call("foreman", { op: "assess", observation: o.observation, jev: answers, cfg: fcfg });
  if (!d || d.error) return { error: d?.error || expert.lastError || "python3 >= 3.9 required" };
  const row = { kind: "assess", run: o.run, job: o.observation.job, action: d.action, reason: d.reason, responsibility: d.responsibility,
    confidence: d.confidence, via: d.via, drift: d.drift, scores: d.scores, sources: d.sources, state: d.state,
    turns: o.observation.turns.length, base: o.base, commits: o.observation.git.commits.length, fingerprint: o.fingerprint, jev_ms: jevMs, jev_attempts: jevAttempts, ...(opts.extra || {}) };
  store.append(TIMELINE, row);
  return { ...row, proposed: d.proposed };
}

/** What a steer or stop says to the agent. Short, because it lands inside the
 *  agent's window on a tool call, and concrete, because "you may be stuck" with
 *  no next step is a sentence the agent reads and ignores. */
export function steerText(r) {
  const why = `${r.reason} (${r.responsibility}${r.confidence != null ? `, p ${Number(r.confidence).toFixed(2)}` : ""}; drift ${r.drift})`;
  const job = r.job ? ` The job: "${String(r.job).slice(0, 300)}".` : "";
  if (r.action === "stop") return `bundlebox foreman STOP: ${why}. You were already steered once. Stop this approach: state what you tried and why it did not work, then re-plan against the job before the next tool call, or ask the user if you are blocked.${job}`;
  return `bundlebox foreman STEER: ${why}. Re-read the job and name the next concrete step toward it; if you are blocked on a decision or a credential, ask the user instead of looping.${job}`;
}

/** The verification command: the flag, then config, then the package's test script. */
export function verifyCommand(flag, cfg = load()) {
  if (flag) return String(flag);
  if (settings(cfg).verify) return String(settings(cfg).verify);
  try { if (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts?.test) return "npm test"; } catch { /* no package */ }
  return "";
}

/** Run the verification command and record the result against the tree it ran on. */
export function verify({ command, session = "", timeoutMs = 20 * 60 * 1000 } = {}) {
  if (!command) return { error: "no verification command: pass --cmd, set foreman.verify, or add a test script" };
  const run = session || lastRun() || "cli";
  const base = baseOf({ rows: timeline({ run }), session: run });
  const before = tree(base).fingerprint;
  const t0 = Date.now();
  const r = spawnSync(command, { cwd: ROOT, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  const row = { kind: "verify", run, base, command, ok: r.status === 0, exit: r.status,
    output: output.slice(-OUTPUT_TAIL), ms: Date.now() - t0,
    // A command that changed the tree verified a tree that no longer exists.
    fingerprint: tree(base).fingerprint === before ? before : "" };
  store.append(TIMELINE, row);
  return row;
}

const lastRun = () => [...store.rows(TIMELINE)].reverse().find((r) => r.run)?.run || "";

/** Recorded assessments with their labels joined on, in replay's row shape. */
export function replayRows(run = "") {
  const all = store.rows(TIMELINE);
  const labels = {};
  for (const r of all) if (r.kind === "label") labels[r.ref] = r.label;
  return all.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === "assess" && (!run || r.run === run))
    .map(({ r, i }) => ({ scores: r.scores, state: r.state, action: r.action, label: labels[i], ref: i }));
}

/** `--set key=value` pairs onto the foreman config: a check key or route key
 *  sets a threshold, anything else a setting. */
export function overrides(base, sets) {
  const cfg = { ...base, thresholds: { ...(base.thresholds || {}) } };
  for (const s of [].concat(sets || []).filter(Boolean)) {
    const [k, v] = String(s).split("=");
    if (!k || v === undefined || Number.isNaN(Number(v))) continue;
    if (k.includes("__")) cfg.thresholds[k] = Number(v); else cfg[k] = Number(v);
  }
  return cfg;
}

const pct = (x) => (typeof x === "number" ? x.toFixed(2) : "-");

async function cmd({ _, flags }) {
  const sub = _[0] || "assess";
  const cfg = load();
  if (settings(cfg).enabled === false) { out("  foreman is off (foreman.enabled = false)"); return 0; }
  const session = String(flags.session || "");
  if (sub === "assess") {
    const r = assess({ session, job: String(flags.job || ""), active: Boolean(flags.active), since: String(flags.since || ""), cfg });
    if (r.error) { out(`  ${r.error}`); return 1; }
    if (flags.json) { emitJson(r); return 0; }
    out(`  ${r.action.toUpperCase()}  ${r.reason}  (${r.responsibility}${r.confidence != null ? `, ${pct(r.confidence)}` : ""}; scores via ${r.via}; drift ${r.drift}; ${r.commits} commit(s) since ${String(r.base).slice(0, 7)})`);
    out(table(Object.entries(r.scores).map(([k, v]) => [k, pct(v), r.sources[k]]), { header: ["check", "p", "from"] }).split("\n").map((l) => "  " + l).join("\n"));
    if (r.action === "verify") out(`  next: bb foreman verify${verifyCommand("", cfg) ? ` (runs ${verifyCommand("", cfg)})` : " --cmd \"<command>\""}`);
    return 0;
  }
  if (sub === "verify") {
    const r = verify({ command: verifyCommand(flags.cmd, cfg), session });
    if (r.error) { out(`  ${r.error}`); return 1; }
    if (flags.json) emitJson(r); else out(`  ${r.ok ? "passed" : `failed (exit ${r.exit})`}: ${r.command} in ${Math.round(r.ms / 1000)}s${r.fingerprint ? "" : "; it changed the tree, so it verified nothing"}`);
    return r.ok ? 0 : 1;
  }
  if (sub === "replay") {
    const rows = replayRows(String(flags.run || ""));
    const r = expert.call("foreman", { op: "replay", rows, cfg: overrides(settings(cfg), flags.set) });
    if (!r || r.error) { out(`  ${r?.error || expert.lastError}`); return 1; }
    if (flags.json) { emitJson(r); return 0; }
    out(`  ${r.n} assessment(s): ${r.agree} unchanged, ${r.changed.length} moved; ${r.labelled} labelled, ${r.candidate_fixes} candidate fix(es), ${r.candidate_regressions} candidate regression(s)`);
    for (const c of r.changed.slice(0, Number(flags.limit) || 20)) out(`    #${rows[c.i].ref}  ${c.was} → ${c.now}${c.label ? `  (labelled ${c.label})` : ""}`);
    return 0;
  }
  if (sub === "label") {
    const ref = Number(_[1]), label = String(_[2] || "");
    const row = store.rows(TIMELINE)[ref];
    if (!row || row.kind !== "assess" || !["right", "wrong"].includes(label)) { out("  bb foreman label <#> right|wrong   (# from bb foreman log)"); return 1; }
    store.append(TIMELINE, { kind: "label", ref, label, reason: String(flags.reason || "") });
    out(`  #${ref} ${row.action} labelled ${label}`);
    return 0;
  }
  if (sub === "log") {
    const all = store.rows(TIMELINE).map((r, i) => ({ ...r, ref: i })).filter((r) => r.kind !== "label");
    const rows = all.slice(-(Number(flags.limit) || 20));
    if (flags.json) { emitJson(rows); return 0; }
    if (!rows.length) { out("  no assessments yet: bb foreman"); return 0; }
    out(table(rows.map((r) => [`#${r.ref}`, String(r.at || "").slice(0, 19), r.kind, r.kind === "assess" ? r.action : (r.ok ? "passed" : "failed"),
      String(r.kind === "assess" ? r.reason : r.command).slice(0, 70)]), { header: ["#", "at", "kind", "result", "why"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }
  if (sub === "checks") {
    const r = expert.call("foreman", { op: "checks", cfg: settings(cfg) });
    if (!r) { out(`  ${expert.lastError}`); return 1; }
    if (flags.json) { emitJson(r); return 0; }
    out(table([...r.checks, ...r.routes].map((c) => [c.key, c.min == null ? "-" : String(c.min), c.instructions.slice(0, 80)]), { header: ["check", "bar", "question"] }).split("\n").map((l) => "  " + l).join("\n"));
    out(`  jev: ${jev.available() ? "on" : "off (set TYPESAFE_API_KEY)"}; settings ${JSON.stringify(r.settings)}`);
    return 0;
  }
  out(`  unknown: bb foreman ${sub}`);
  return 1;
}

export const commands = {
  foreman: {
    help: "watch the coding agent: responsibility checks, Jev or evidence, one action (0 tokens without Jev)",
    usage: "bb foreman [assess|verify|replay|label|log|checks] [--json]",
    long: [
      "  bb foreman [assess] [--job \"...\"] [--active] [--session id] [--since <rev>]   score the run, pick one action",
      "  bb foreman verify [--cmd \"npm test\"]      run verification against the current tree and record it",
      "  bb foreman replay [--set key=value ...]   re-decide every recorded assessment under other bars",
      "  bb foreman label <#> right|wrong          mark a recorded action; replay counts fixes and regressions",
      "  bb foreman log | checks",
      "",
      "Actions: continue, steer, stop, verify, resume, finish, escalate. --active means the agent is",
      "still running, so health and instruction warnings apply and completion does not.",
      "The run is measured from --since, else the commit its first assessment recorded: commits made",
      "during the run count as its work.",
      "Jev answers the checks when TYPESAFE_API_KEY is set; otherwise the box's own evidence does,",
      "and finishing then needs a passing `bb foreman verify` on the current tree.",
    ].join("\n"),
    run: cmd,
  },
};
