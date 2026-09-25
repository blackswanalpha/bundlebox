// sprint — the paid half of Sentinel: what the free path could not close,
// run as agent lanes, and what reviewers say about the result, sent back.
//
//   bb sprint [--apply] [--top N]            A2: compile the top N, route, run the lanes
//   bb sprint review [--apply] [--rounds N]  A3: a PR asked for changes or failed CI -> a lane on its branch
//
// Both spend, so both are refused unless `bridge.enabled`,
// `bridge.daily_budget_usd` and `lanes.daily_budget_usd` are set, read fresh
// here and again by the runner's own daily ceiling before any lane spawns.
// Lanes run WITHOUT the runner's own push: every lane branch passes ironguard
// first, and foreman's last word on the lane's session can veto the PR.
import path from "node:path";
import { load } from "../core/config.js";
import { VAR } from "../core/paths.js";
import { out, warn, emit } from "../core/log.js";
import { sha1, table } from "../core/util.js";
import * as store from "../core/store.js";
import { spendKeys } from "../pipeline/spec.js";
import { execute } from "../run/runner.js";
import { loadPlan } from "../run/index.js";
import * as foreman from "../foreman/index.js";
import * as ironguard from "../ironguard/index.js";
import { git } from "../core/exec.js";
import { addWorktree, removeWorktree, openPr, gh, writable } from "../sentinel/git.js";

export const ROUNDS = "sentinel-rounds";
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

/** The permission, read fresh: `{ ok, missing }`. */
export const permission = () => spendKeys(load({ fresh: true }));

/** Foreman's last action on a lane's session, when it assessed one. A lane it
 *  told to stop, or escalated, does not get a PR: a person reads it first. */
export function veto(sessionId, rows = foreman.timeline({ run: sessionId })) {
  const last = [...rows].reverse().find((r) => r.kind === "assess");
  return last && ["stop", "escalate"].includes(last.action) ? `foreman ${last.action}: ${last.reason || ""}`.trim() : "";
}

async function verb(name, _, flags) {
  const { loadCommands } = await import("../cli.js");
  const { table: cmds } = await loadCommands();
  if (!cmds[name]) return 2;
  return cmds[name].run({ _, flags: { quiet: true, ...flags }, rest: [] });
}

/** After the lanes: ironguard, foreman, then a draft PR per passing lane. */
function ship(results, plan, cfg, { apply }) {
  const lanes = new Map(plan.lanes.map((l) => [l.id, l]));
  return results.map((r) => {
    const lane = lanes.get(r.lane) || {};
    const branch = lane.branch || `bb/${r.run_id}-${r.lane}`.toLowerCase();
    const row = { lane: r.lane, rc: r.rc, branch, why: r.why || "" };
    if (!apply || r.dry_run) return { ...row, state: "dry-run" };
    if (!r.pr_eligible) return { ...row, state: "not-eligible", why: r.unproven?.length ? "unproven units" : r.why || "no acceptance ran" };
    const v = veto(r.session_id);
    if (v) return { ...row, state: "vetoed", why: v };
    const wt = lane.worktree;
    if (!wt) return { ...row, state: "not-eligible", why: "the lane ran in the shared checkout; nothing to push" };
    const guard = ironguard.check({ cwd: wt, cfg });
    if (!guard.ok) return { ...row, state: "blocked", why: ironguard.summary(guard) };
    git(["add", "-A"], wt);
    git(["commit", "-q", "-m", `fix(lane): ${(lane.units || []).map((u) => u.title || u.id).join("; ").slice(0, 120) || r.lane}`], wt);
    const pr = openPr(wt, branch, { title: `lane ${r.lane}: ${(lane.units || [])[0]?.title || "routed work"}`.slice(0, 120),
      body: [`Run \`${r.run_id}\`, lane \`${r.lane}\`, ${r.turns || 0} turns.`, "", ironguard.summary(guard)].join("\n"), draft: true, cfg });
    return { ...row, state: pr.ok ? "pr" : "unpushed", pr, why: pr.ok ? pr.url : pr.why };
  });
}

/** A2: the agent tier, capped at `top`. */
export async function handoff({ apply = false, top = 0, cfg = load() } = {}) {
  const n = Math.max(1, Number(top) || Number(cfg.sentinel?.top) || 5);
  if (apply) { const p = permission(); if (!p.ok) return { state: "refused", why: `spend: ${p.missing.join(", ")} — not set` }; }
  await verb("compile", [], { write: true, maxUnits: n });
  await verb("route", [], { write: true });
  const plan = loadPlan("latest");
  if (!plan || !plan.lanes.length) return { state: "nothing", why: "no lanes routed" };
  const r = await execute(plan, { apply, pr: false });
  if (r.rc === 2 && !r.results.length) return { state: "refused", why: r.why };
  return { state: apply ? "ran" : "would-run", run_id: r.run_id, lanes: plan.lanes.length, shipped: ship(r.results, plan, cfg, { apply }) };
}

/** Why a PR needs another round: its review decision and its failed checks. */
export function needsRound(pr) {
  const failed = (pr.statusCheckRollup || []).filter((c) => FAILED.has(String(c.conclusion || c.state || "").toUpperCase()));
  return { changes: pr.reviewDecision === "CHANGES_REQUESTED", failed };
}

/** The brief for one round: every review, comment and failed check, verbatim. */
export function feedbackBrief(pr, { reviews = [], comments = [], inline = [], failed = [], logs = "" } = {}) {
  const parts = [`PR #${pr.number} on \`${pr.headRefName}\` needs another round. Address every point below on this branch, then run the acceptance command.`, ""];
  for (const r of reviews.filter((x) => x.body || x.state === "CHANGES_REQUESTED")) parts.push(`Review (${r.state}) by ${r.author?.login || "?"}:\n${r.body || "(no text)"}\n`);
  for (const c of inline) parts.push(`Inline on ${c.path}:${c.line || c.original_line || "?"} by ${c.user?.login || "?"}:\n${c.body}\n`);
  for (const c of comments) parts.push(`Comment by ${c.author?.login || "?"}:\n${c.body}\n`);
  for (const f of failed) parts.push(`Failed check: ${f.name || f.context} (${f.conclusion || f.state}) ${f.detailsUrl || f.targetUrl || ""}`);
  if (logs) parts.push("", "Failed log tail:", "```", logs, "```");
  return parts.join("\n");
}

function gather(pr) {
  const v = gh(["pr", "view", String(pr.number), "--json", "reviews,comments"]);
  const inline = gh(["api", `repos/{owner}/{repo}/pulls/${pr.number}/comments`]);
  const { failed } = needsRound(pr);
  let logs = "";
  for (const f of failed) {
    const id = (String(f.detailsUrl || f.targetUrl || "").match(/\/actions\/runs\/(\d+)/) || [])[1];
    if (!id) continue;
    const l = gh(["run", "view", id, "--log-failed"], { timeout: 120000 });
    if (l.ok && l.data) { logs = String(l.data).slice(-4000); break; }
  }
  return { reviews: v.data?.reviews || [], comments: v.data?.comments || [], inline: Array.isArray(inline.data) ? inline.data : [], failed, logs };
}

/** A3: every open bb/ PR that asked for changes or failed CI gets one lane on
 *  its own branch, at most `rounds` times. The same feedback twice is not a new
 *  round: the signature of what was said must move. */
export async function review({ apply = false, rounds = 0, cfg = load() } = {}) {
  const max = Math.max(1, Number(rounds) || Number(cfg.sentinel?.max_rounds) || 3);
  if (apply) { const p = permission(); if (!p.ok) return { state: "refused", why: `spend: ${p.missing.join(", ")} — not set`, prs: [] }; }
  const list = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,reviewDecision,statusCheckRollup,url"]);
  if (!list.ok) return { state: "error", why: list.why, prs: [] };
  const state = store.get(ROUNDS, {}) || {};
  const rows = [];
  for (const pr of (list.data || []).filter((p) => String(p.headRefName).startsWith("bb/"))) {
    const need = needsRound(pr);
    if (!need.changes && !need.failed.length) continue;
    const s = state[pr.number] || { rounds: 0, sig: "" };
    if (s.rounds >= max) { rows.push({ pr: pr.number, state: "needs-human", why: `${s.rounds} rounds, the cap is ${max}` }); continue; }
    const fb = gather(pr);
    const sig = sha1(JSON.stringify([fb.reviews.map((r) => r.id || r.submittedAt), fb.comments.map((c) => c.id || c.createdAt), fb.inline.map((c) => c.id), fb.failed.map((f) => `${f.name || f.context}:${f.completedAt || ""}`)]));
    if (sig === s.sig) { rows.push({ pr: pr.number, state: "waiting", why: "no new feedback since the last round" }); continue; }
    if (!writable(pr.headRefName, cfg)) { rows.push({ pr: pr.number, state: "refused", why: "not a bb/ branch" }); continue; }
    const round = s.rounds + 1;
    const wt = path.join(VAR, "worktrees", `review-pr${pr.number}`);
    const lane = { id: `pr${pr.number}-r${round}`, run_id: `review-${new Date().toISOString().slice(0, 10)}`, branch: pr.headRefName, worktree: wt,
      units: [{ id: `review-${pr.number}-${round}`, title: `PR #${pr.number} round ${round}`, brief: feedbackBrief(pr, fb), acceptance: String(cfg.sentinel?.gate || "npm run lint && npm test") }] };
    if (!apply) { rows.push({ pr: pr.number, state: "would-run", round, lane: lane.id }); continue; }
    const add = addWorktree(wt, pr.headRefName, { existing: true });
    if (!add.ok) { rows.push({ pr: pr.number, state: "error", why: add.why }); continue; }
    const r = await execute({ run_id: lane.run_id, lanes: [lane], waves: [[lane.id]] }, { apply: true, pr: false });
    const res = r.results[0] || { rc: r.rc, why: r.why };
    let row = { pr: pr.number, round, lane: lane.id, rc: res.rc, state: "failed", why: res.why || r.why || "" };
    const v = res.session_id ? veto(res.session_id) : "";
    if (v) row = { ...row, state: "vetoed", why: v };
    else if (res.rc === 0) {
      const guard = ironguard.check({ cwd: wt, cfg });
      if (!guard.ok) row = { ...row, state: "blocked", why: ironguard.summary(guard) };
      else {
        git(["add", "-A"], wt);
        git(["commit", "-q", "-m", `fix(review): PR #${pr.number} round ${round}`], wt);
        const p = git(["push", "origin", `HEAD:${pr.headRefName}`], wt);
        if (p.rc === 0) gh(["pr", "comment", String(pr.number), "--body", `bundlebox round ${round} of ${max}: addressed the review and CI feedback on this branch.\n\n${ironguard.summary(guard)}`]);
        row = { ...row, state: p.rc === 0 ? "pushed" : "unpushed", why: p.rc === 0 ? "" : (p.err || p.out).trim().slice(0, 200) };
      }
    }
    removeWorktree(wt);
    state[pr.number] = { rounds: round, sig, last: row.state, at: new Date().toISOString() };
    store.put(ROUNDS, state);
    if (round >= max && row.state !== "pushed") gh(["pr", "comment", String(pr.number), "--body", `bundlebox stopped after ${round} round(s); this PR needs a person.`]);
    rows.push(row);
  }
  return { state: apply ? "ran" : "dry-run", max, prs: rows };
}

export const commands = {
  sprint: {
    help: "run what the free path could not close as agent lanes, and send PR feedback back to them (spends with --apply)",
    usage: "bb sprint [--apply] [--top N] [--json] | review [--apply] [--rounds N] [--json]",
    run: async ({ _, flags }) => {
      const sub = _[0] || "run";
      const apply = Boolean(flags.apply);
      const r = sub === "review" ? await review({ apply, rounds: flags.rounds }) : sub === "run" ? await handoff({ apply, top: flags.top }) : null;
      if (!r) { warn(`unknown: bb sprint ${sub}`); return 2; }
      if (flags.json) { emit(r); return r.state === "refused" || r.state === "error" ? 2 : 0; }
      out(`  ${r.state}${r.why ? `: ${r.why}` : ""}`);
      const rows = r.shipped || r.prs || [];
      if (rows.length) out(table(rows.map((x) => [x.lane || `#${x.pr}`, x.state, String(x.why || "").slice(0, 90)]), { header: ["lane/pr", "state", "why"] }));
      return r.state === "refused" || r.state === "error" ? 2 : 0;
    },
  },
};
