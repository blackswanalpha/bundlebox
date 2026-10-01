// outcomes.js — whether a lane's work was any good, measured after the fact.
//
// `lanes.rc` says a process exited and nothing reads it back. Without this
// table every triage rule stays whatever it was written as, because nothing
// records which promotions were worth the tokens. Five questions, answered
// from git and the store, never from a model's opinion of its own work:
//
//   accepted     did the acceptance command exit 0 (known at lane exit; null
//                when nothing checked, which is a different fact from 0)
//   reverted     a later commit on the base branch that names the lane's sha,
//                or a `Revert` commit that touches the lane's files
//   human_edits  later commits on the base branch touching the same files,
//                and the lines they moved
//   recurred     a finding the lane carried that a later scan re-emitted
//   verdict      worst-first: broken > weak > pending > held. A lane that was
//                reverted is broken whatever its gate said at the time.
//
// `record()` writes the half knowable at lane exit; `score()` fills the half
// only the world can answer. Rows are JSONL, last row per id wins.
import fs from "node:fs";
import * as store from "../core/store.js";
import { git, gitOk } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT } from "../core/paths.js";
import { now, uniq, human, pad } from "../core/util.js";

/** Beyond this a later edit is the file moving on, not a rewrite of the lane. */
export const HUMAN_WINDOW_DAYS = 30;

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }; // absent is not a directory

/** Last row per id wins; the log stays a log. */
export function outcomes() {
  const by = new Map();
  for (const r of store.rows("outcomes")) if (r && r.id) by.set(r.id, r);
  return [...by.values()];
}
const put = (row) => store.append("outcomes", row);

/** null | 0 | 1. Nothing checked is not the same fact as a failed check. */
function triState(v) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  return null;
}

function spend(runId, laneId) {
  const by = new Map();
  for (const r of store.rows("usage")) if (r.run_id === runId && r.lane_id === laneId) by.set(`${r.session_id} ${r.msg_id}`, r);
  let t = 0;
  for (const r of by.values()) t += num(r.input) + num(r.output) + num(r.cache_write) + num(r.cache_read);
  return t;
}

/** Write the lane's outcome row: what is knowable when it exits. Not a verdict. */
export function record(lane, { result = null } = {}) {
  const ids = new Set(lane.unit_ids || []);
  const units = store.get("units", []).filter((u) => u && ids.has(u.id));
  const findingIds = uniq(units.flatMap((u) => u.finding_ids || []));
  const byId = new Map(store.get("findings", []).map((f) => [f.id, f]));
  // Findings per detector inside this lane. Without it a five-detector lane
  // charges its whole spend to each of the five and the backlog ranks
  // co-occurrence, not cost.
  const shares = {};
  for (const id of findingIds) { const d = byId.get(id)?.detector || "(unknown)"; shares[d] = (shares[d] || 0) + 1; }
  const accept = result?.acceptance;
  const accepted = lane.accepted !== undefined ? triState(lane.accepted) : Array.isArray(accept) && accept.length ? (accept.every((a) => a.rc === 0) ? 1 : 0) : null;
  const row = {
    id: `${lane.run_id}:${lane.id}`, run_id: lane.run_id || "", lane_id: lane.id,
    unit_ids: [...ids], finding_ids: findingIds, detectors: Object.keys(shares), by_detector: shares,
    files: uniq(lane.files?.length ? lane.files : units.flatMap((u) => u.scope || [])),
    agent: lane.agent || "", model: lane.model || "", est_tokens: num(lane.est_tokens), peak: num(lane.peak),
    spend_tokens: spend(lane.run_id, lane.id),
    lane_rc: lane.rc == null ? null : num(lane.rc), accepted,
    branch: lane.branch || "", cwd: lane.worktree || lane.cwd || ROOT,
    ended: lane.ended || now(),
    sha: "", lines_changed: 0, reverted: 0, human_edits: 0, human_lines: 0, recurred: 0,
    verdict: "pending", scored_at: "",
  };
  put(row);
  return row;
}

function baseBranch(cwd, cfg) {
  if (cfg.git?.base) return cfg.git.base;
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (r.rc === 0 && r.out.trim()) return r.out.trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (git(["rev-parse", "--verify", "--quiet", b], cwd).rc === 0) return b;
  return "HEAD";
}

function shortstat(cwd, sha) {
  const r = git(["show", "--shortstat", "--format=", sha], cwd);
  if (r.rc !== 0) return 0;
  let n = 0;
  for (const m of r.out.matchAll(/(\d+) (?:insertion|deletion)/g)) n += Number(m[1]);
  return n;
}

/** The lane's commit, its size, whether it was reverted, and who edited after.
 *  Every number is `git log` on a checkout that already exists. */
export function gitFacts(cwd, row, base) {
  const out = { sha: "", lines_changed: 0, reverted: 0, human_edits: 0, human_lines: 0 };
  const refBase = git(["rev-parse", "--verify", "--quiet", `origin/${base}`], cwd).rc === 0 ? `origin/${base}` : base;
  if (row.branch) {
    for (const ref of [row.branch, `origin/${row.branch}`]) {
      const r = git(["rev-parse", "--verify", "--quiet", ref], cwd);
      if (r.rc === 0 && r.out.trim()) { out.sha = r.out.trim().slice(0, 12); break; }
    }
    if (!out.sha) {
      // Merged and pruned: the merge commit still names the branch.
      const r = git(["log", `--grep=${row.branch}`, "--format=%H", "-n", "1", refBase], cwd);
      if (r.rc === 0 && r.out.trim()) out.sha = r.out.trim().slice(0, 12);
    }
  }
  if (out.sha) out.lines_changed = shortstat(cwd, out.sha);
  const since = row.ended ? [`--since=${row.ended}`] : [];
  const files = (row.files || []).filter(Boolean);

  // Later commits on the base branch. A revert names the sha it undid in its
  // own message (git revert and the GitHub button both write it); a `Revert`
  // subject with no sha counts only when it touches the lane's files.
  const log = git(["log", ...since, "--format=%H%x1f%s%x1f%b%x1e", refBase], cwd);
  if (log.rc === 0) {
    for (const rec of log.out.split("\x1e")) {
      const [h, subject = "", body = ""] = rec.trim().split("\x1f");
      if (!h || (out.sha && h.startsWith(out.sha))) continue;
      const msg = `${subject}\n${body}`;
      if (out.sha && msg.includes(out.sha.slice(0, 7))) { out.reverted = 1; break; }
      if (/^revert\b/i.test(subject) && files.length) {
        const touched = git(["show", "--name-only", "--format=", h], cwd);
        if (touched.rc === 0 && touched.out.split("\n").some((f) => files.includes(f.trim()))) { out.reverted = 1; break; }
      }
    }
  }
  if (files.length) {
    const range = out.sha ? [`${out.sha}..${refBase}`] : [refBase];
    const r = git(["log", `--since=${row.ended || `${HUMAN_WINDOW_DAYS}.days.ago`}`, "--format=%H", ...range, "--", ...files], cwd);
    const shas = r.rc === 0 ? r.out.split(/\s+/).filter((h) => h && !(out.sha && h.startsWith(out.sha))) : [];
    out.human_edits = shas.length;
    for (const h of shas.slice(0, 20)) out.human_lines += shortstat(cwd, h);
  }
  return out;
}

/** A finding this lane carried that is open again with a `last_seen` after the
 *  lane ended. `first_seen` never moves on a re-emit, so this is the only signal. */
export function recurred(row) {
  const ids = new Set(row.finding_ids || []);
  if (!ids.size) return 0;
  const ended = row.ended || "";
  return store.get("findings", []).filter((f) => f && ids.has(f.id) && f.status === "open" && String(f.last_seen || "") > ended).length;
}

export function verdictFor(row) {
  if ((row.lane_rc != null && row.lane_rc !== 0) || row.reverted || row.accepted === 0) return "broken";
  if (row.recurred) return "weak";
  const lines = num(row.lines_changed), human_ = num(row.human_lines);
  if (human_ && lines && human_ >= lines) return "weak";
  if (row.human_edits) return "weak";
  // Nothing checked it and nothing shipped: no evidence either way.
  if (row.accepted == null && !row.sha) return "pending";
  return "held";
}

/** Re-measure every unsettled outcome. Zero tokens, no network. */
export function score({ runId = "", all = false, cfg = load() } = {}) {
  const rows = outcomes().filter((r) => (!runId || r.run_id === runId) && (all || r.verdict === "pending"));
  const scored = [];
  for (const r of rows) {
    const row = { ...r };
    const cwd = isDir(row.cwd || "") ? row.cwd : ROOT;
    if (gitOk(cwd)) Object.assign(row, gitFacts(cwd, row, baseBranch(cwd, cfg)));
    row.recurred = recurred(row);
    row.verdict = verdictFor(row);
    row.scored_at = now();
    put(row);
    scored.push(row);
  }
  return scored;
}

/** Per detector: lanes, spend split by finding share, findings, verdict counts. */
export function byDetector(rows = outcomes()) {
  const agg = {};
  for (const r of rows) {
    const shares = r.by_detector && Object.keys(r.by_detector).length ? r.by_detector : Object.fromEntries((r.detectors || ["(none)"]).map((d) => [d, 1]));
    const total = Object.values(shares).reduce((a, b) => a + b, 0) || 1;
    for (const [det, n] of Object.entries(shares)) {
      const frac = n / total;
      const a = agg[det] ||= { detector: det, lanes: 0, spend: 0, findings: 0, closed: 0, held: 0, weak: 0, broken: 0, pending: 0 };
      a.lanes += 1; a.spend += Math.round(num(r.spend_tokens) * frac); a.findings += n;
      a[r.verdict] = (a[r.verdict] || 0) + 1;
      if (r.verdict === "held") a.closed += n;
    }
  }
  for (const a of Object.values(agg)) {
    const settled = a.held + a.weak + a.broken;
    a.settled = settled;
    a.hold_rate = settled ? Math.round((a.held / settled) * 1000) / 1000 : null;
    a.per_closed = a.closed ? Math.round(a.spend / a.closed) : null;
  }
  return Object.values(agg).sort((a, b) => b.spend - a.spend);
}

/** Detectors whose findings no actuator closes, ranked by spend × hold rate: a
 *  detector whose lanes always hold has a reproducible fix, which is what an
 *  actuator is. Unknown hold rate counts as 1: unproven, not exonerated. */
export function backlog() {
  const withActuator = new Set();
  for (const f of store.get("findings", [])) if (f && f.auto_fix) withActuator.add(f.detector);
  return byDetector().filter((a) => a.spend > 0 && !withActuator.has(a.detector))
    .map((a) => ({ ...a, value: Math.round(a.spend * (a.hold_rate == null ? 1 : a.hold_rate)) }))
    .sort((a, b) => b.value - a.value);
}

/** `{detector: {held, weak, broken}}` — what triage's confidence blend reads. */
export function history() {
  const out = {};
  for (const a of byDetector()) out[a.detector] = { held: a.held, weak: a.weak, broken: a.broken };
  return out;
}

export function reportText(rows = outcomes()) {
  if (!rows.length) return "  no outcomes recorded: nothing has run, or the runs predate the outcome loop";
  const lines = [`  ${pad("run", 22)} ${pad("lane", 6)} ${pad("verdict", 8)} ${pad("spend", 8, true)} ${pad("lines", 6, true)} ${pad("human", 6, true)}  detectors`];
  for (const r of rows.slice(-40)) lines.push(`  ${pad(r.run_id, 22)} ${pad(r.lane_id, 6)} ${pad(r.verdict, 8)} ${pad(human(r.spend_tokens || 0), 8, true)} ${pad(r.lines_changed || 0, 6, true)} ${pad(r.human_lines || 0, 6, true)}  ${(r.detectors || []).join(", ")}`);
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  lines.push("  " + "-".repeat(70), "  " + Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join("  "));
  return lines.join("\n");
}

export function backlogText(rows = backlog()) {
  if (!rows.length) return "  every detector that has cost anything already has an actuator, or nothing has been scored yet";
  const lines = ["  the actuator backlog — what NOT having one has cost, worst first", "", `  ${pad("detector", 22)} ${pad("spend", 8, true)} ${pad("lanes", 5, true)} ${pad("hold", 6, true)}  findings`];
  for (const a of rows) lines.push(`  ${pad(a.detector, 22)} ${pad(human(a.spend), 8, true)} ${pad(a.lanes, 5, true)} ${pad(a.hold_rate == null ? "-" : `${Math.round(a.hold_rate * 100)}%`, 6, true)}  ${a.findings}`);
  return lines.join("\n");
}
