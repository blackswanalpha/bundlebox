// git/forge.js — everything that talks to GitHub: the `gh` probe, the PR body
// the factory can write from the lane, the checks gate, and the review
// round-trip.
//
// One rule runs through all of it: a `gh` call that could not be made returns
// null — UNKNOWN — and never an empty array, which would read as "looked, found
// nothing". A merge gate that cannot see the checks refuses and says so.
import path from "node:path";
import { run, which } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT, rel } from "../core/paths.js";
import * as store from "../core/store.js";
import { out } from "../core/log.js";
import { repoDir, branch, defaultBranch } from "./repo.js";
import { clean } from "../slop/index.js";

let _gh;
/** Can this box talk to GitHub. Memoised: `gh auth status` is a network call. */
export function ghAvailable({ fresh = false } = {}) {
  if (_gh && !fresh) return _gh;
  if (!which("gh")) return (_gh = { ok: false, why: "gh not installed" });
  const r = run(["gh", "auth", "status"], { timeout: 60000 });
  if (r.rc !== 0) return (_gh = { ok: false, why: (r.err || r.out).trim().split("\n")[0].slice(0, 200) || "gh not authenticated" });
  const m = /account (\S+)/.exec(r.out + r.err);
  return (_gh = { ok: true, account: m ? m[1] : "" });
}
/** Raw gh call; null when gh is missing or unauthenticated (unknown, not empty). */
export function gh(args, { cwd = ROOT, timeout = 180000 } = {}) {
  if (!ghAvailable().ok) return null;
  return run(["gh", ...args.map(String)], { cwd, timeout });
}
export function ghJson(args, opts) {
  const r = gh(args, opts);
  if (!r || r.rc !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

// ── pull requests ────────────────────────────────────────────────────────────

/** The PR body a reviewer can act on, filled from what the lane closed.
 *  Stripped by the prose ruleset like every other summary this factory writes. */
export function prBody(lane = {}, findings = [], { base = "main", acceptance = null } = {}) {
  const units = store.get("units", []).filter((u) => (lane.unit_ids || []).includes(u.id));
  const acc = [...new Set((acceptance || units.map((u) => u.acceptance)).filter(Boolean))];
  const byDet = {};
  for (const f of findings) byDet[f.detector || "?"] = (byDet[f.detector || "?"] || 0) + 1;
  const summary = [
    `- lane ${lane.id || "?"}${lane.agent ? ` (${lane.agent}${lane.model ? `, ${lane.model}` : ""})` : ""} closed ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    ...units.map((u) => `- ${u.title || u.id}`),
    ...Object.entries(byDet).map(([d, n]) => `- ${d}: ${n}`),
    ...(lane.files?.length ? [`- files in scope: ${lane.files.length}`] : []),
  ];
  const ids = findings.slice(0, 40).map((f) => `- \`${f.id}\` ${f.title || ""}`.trimEnd());
  const plan = acc.length ? acc.map((c) => `- [ ] \`${c}\``) : ["- [ ] (no automated acceptance recorded)"];
  return clean(`## Summary
${summary.join("\n")}

## Base
Branched off \`${base}\`.

## Findings closed
${ids.join("\n") || "n/a"}

## Test plan
${plan.join("\n")}

---
Opened by bundlebox. The evidence was gathered by the local detectors; run
\`bb explain <id>\` for the derivation behind any item above.
`) + "\n";
}

/** Open a DRAFT pull request with an explicit base: GitHub's default is the
 *  repo's default branch, which is not always the branch this work forked. */
export function prCreate({ cwd = ROOT, base = "", title = "", body = "", draft = null, apply = false } = {}) {
  const d = repoDir(cwd);
  const g = load().git || {};
  base = base || defaultBranch(d);
  draft = draft == null ? g.draft_pr !== false : !!draft;
  const br = branch(d);
  if (!br) return { ok: false, repo: rel(d), why: "detached HEAD" };
  if ((g.protected || []).includes(br)) return { ok: false, repo: rel(d), why: `refusing a PR from protected branch ${br}` };
  const existing = ghJson(["pr", "view", br, "--json", "number,url,state,isDraft"], { cwd: d });
  if (existing && existing.state === "OPEN") return { ok: true, existing: true, repo: rel(d), branch: br, ...existing };
  const args = ["pr", "create", "--base", base, "--title", title || `bb: ${br}`, "--body", body || ""];
  if (draft) args.push("--draft");
  if (!apply) return { ok: true, dry_run: true, repo: rel(d), branch: br, base, draft, title: title || `bb: ${br}`, body, cmd: `gh pr create --base ${base}${draft ? " --draft" : ""} --title ...` };
  const av = ghAvailable();
  if (!av.ok) return { ok: false, repo: rel(d), why: `gh unavailable: ${av.why}` };
  const r = gh(args, { cwd: d, timeout: 300000 });
  if (!r || r.rc !== 0) return { ok: false, repo: rel(d), why: r ? (r.err || r.out).trim().slice(-500) : "gh unavailable" };
  const view = ghJson(["pr", "view", br, "--json", "number,url,isDraft"], { cwd: d }) || {};
  const lastLine = r.out.trim().split("\n").pop() || "";
  return { ok: true, repo: rel(d), branch: br, url: view.url || lastLine || "", number: view.number ?? null, draft, base };
}

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["", "PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", "REQUESTED"]);
const checkState = (c) => String(c.conclusion || c.state || "").toUpperCase();
const checkName = (c) => c.name || c.context || c.workflowName || "?";

/** Everything a merge decision needs, in one call; null when gh could not be asked. */
export function prStatus(n, { cwd = ROOT } = {}) {
  const d = repoDir(cwd);
  const num = String(n || branch(d));
  if (!num) return null;
  const v = ghJson(["pr", "view", num, "--json", "number,url,title,state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,reviewDecision,reviews,statusCheckRollup"], { cwd: d });
  if (!v || !v.number) return null;
  const checks = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
  const failing = checks.filter((c) => FAILING.has(checkState(c))).map(checkName);
  const pending = checks.filter((c) => PENDING.has(checkState(c))).map(checkName);
  const approvals = (v.reviews || []).filter((r) => String(r.state || "").toUpperCase() === "APPROVED").length;
  return { ...v, repo: rel(d), checks_total: checks.length, checks_failing: failing, checks_pending: pending, approvals };
}

/** Promote a draft; only once every check is green, and a pending check is not green. */
export function prReady(n, { cwd = ROOT, apply = false } = {}) {
  const st = prStatus(n, { cwd });
  if (!st) return { ok: false, why: `unknown: gh could not report on PR ${n || "(current branch)"} (${ghAvailable().why || "no such PR"})` };
  if (st.checks_failing.length) return { ok: false, pr: st.number, why: `checks failing: ${st.checks_failing.slice(0, 4).join(", ")}` };
  if (st.checks_pending.length) return { ok: false, pr: st.number, why: `checks pending: ${st.checks_pending.slice(0, 4).join(", ")}` };
  if (!st.isDraft) return { ok: true, pr: st.number, why: "already ready" };
  if (!apply) return { ok: true, dry_run: true, pr: st.number, cmd: `gh pr ready ${st.number}` };
  const r = gh(["pr", "ready", String(st.number)], { cwd });
  return { ok: !!r && r.rc === 0, pr: st.number, why: r && r.rc === 0 ? "" : (r ? (r.err || r.out).trim().slice(-300) : "gh unavailable") };
}

/** Merge if and only if every gate agrees; each refusal names its gate. */
export function merge(n, { cwd = ROOT, overrideGate = false, apply = false } = {}) {
  const g = load().git || {};
  const st = prStatus(n, { cwd });
  if (!st) return { ok: false, refused: [`unknown: gh could not report on PR ${n || "(current branch)"} (${ghAvailable().why || "no such PR"})`] };
  const need = g.require_approvals ?? 1;
  const gates = [];
  if (!(g.allow_merge || overrideGate)) gates.push("cfg.git.allow_merge is false: merging is left to a person (--override-gate to say otherwise)");
  if (st.state !== "OPEN") gates.push(`state is ${st.state}, not OPEN`);
  if (st.isDraft) gates.push("still a draft: `bb git ready` first");
  if (String(st.mergeable || "").toUpperCase() === "CONFLICTING") gates.push("CONFLICTING with the base branch");
  if (st.checks_failing.length) gates.push(`checks failing: ${st.checks_failing.slice(0, 4).join(", ")}`);
  if (st.checks_pending.length) gates.push(`checks pending: ${st.checks_pending.slice(0, 4).join(", ")}`);
  if (st.approvals < need) gates.push(`${st.approvals} approval(s), ${need} required (cfg.git.require_approvals)`);
  if (gates.length) return { ok: false, pr: st.number, url: st.url, refused: gates };
  const args = ["pr", "merge", String(st.number), `--${g.merge_method || "squash"}`];
  if (g.delete_branch !== false) args.push("--delete-branch");
  if (!apply) return { ok: true, dry_run: true, pr: st.number, url: st.url, cmd: `gh ${args.join(" ")}` };
  const r = gh(args, { cwd, timeout: 600000 });
  return { ok: !!r && r.rc === 0, pr: st.number, url: st.url, why: r && r.rc === 0 ? "" : (r ? (r.err || r.out).trim().slice(-400) : "gh unavailable") };
}

// ── the review round-trip ────────────────────────────────────────────────────

/** Review threads and failing checks as FINDINGS, each already attached to its
 *  file, line and hunk, so the follow-up lane gets a packed brief instead of a
 *  session that reads the whole pull request to work out what was asked. */
export function review(n, { cwd = ROOT, write = false } = {}) {
  const st = prStatus(n, { cwd });
  if (!st) return { ok: false, findings: null, why: `unknown: gh could not report on PR ${n || "(current branch)"} (${ghAvailable().why || "no such PR"})` };
  const pr = st.number;
  const d = repoDir(cwd);
  // `--paginate` on a list endpoint concatenates one JSON array per page
  // (`[..][..]`); older gh has no `--slurp`, so the pages are joined here.
  const raw = gh(["api", `repos/{owner}/{repo}/pulls/${pr}/comments`, "--paginate"], { cwd: d });
  let threads = null;
  if (raw && raw.rc === 0) { try { threads = JSON.parse("[" + raw.out.trim().replace(/\]\s*\[/g, ",") + "]").flat(); } catch { threads = null; } }
  const checks = ghJson(["pr", "checks", String(pr), "--json", "name,state,bucket,link"], { cwd: d });
  const findings = [];
  const sev = load().git?.review_severity || "medium";
  for (const c of threads || []) {
    if (c.in_reply_to_id) continue;
    const body = String(c.body || "").trim();
    if (!body) continue;
    const p = c.path || "", line = c.line || c.original_line || 0;
    const replies = (threads || []).filter((r) => r.in_reply_to_id === c.id).map((r) => String(r.body || "").trim()).slice(0, 4);
    findings.push({
      detector: "pr-review", severity: sev, precision: "probe", kind: "fix", auto_fix: null,
      title: `PR #${pr} review on ${p}:${line}`, path: p, files: p ? [p] : [], key: `pr/${pr}/comment/${c.id}`,
      detail: body.slice(0, 1500),
      evidence: { pr, url: c.html_url || "", reviewer: c.user?.login || "", path: p, line, comment_id: c.id, hunk: String(c.diff_hunk || "").slice(-1200), replies },
      fix_hint: "Address the comment, then reply on the thread saying what changed. Do not resolve a thread you did not act on.",
      est_tokens: 4000 + Math.round(body.length / 3),
    });
  }
  for (const c of Array.isArray(checks) ? checks : []) {
    const state = String(c.bucket || c.state || "").toUpperCase();
    if (!(state === "FAIL" || FAILING.has(state))) continue;
    findings.push({
      detector: "pr-review", severity: "high", precision: "probe", kind: "verify", auto_fix: null,
      title: `PR #${pr} check failing: ${c.name}`, path: "", files: [], key: `pr/${pr}/check/${c.name}`,
      detail: `\`${c.name}\` is red on ${st.headRefName || ""}. ${c.link || ""}`.trim(),
      evidence: { pr, check: c.name, state, url: c.link || st.url || "" },
      fix_hint: "Reproduce with the repo's own gate before changing anything. A red check is not always this PR's fault.",
      est_tokens: 8000,
    });
  }
  let merged = null;
  if (write && findings.length) merged = store.mergeFindings(findings, { detectors: new Set(["pr-review"]) });
  return { ok: true, pr, url: st.url, state: st.state, decision: st.reviewDecision || null, findings, threads_known: threads !== null, checks_known: Array.isArray(checks),
    counts: { threads: findings.filter((f) => f.kind === "fix").length, checks: findings.filter((f) => f.kind === "verify").length }, written: merged ? merged.length : 0 };
}
