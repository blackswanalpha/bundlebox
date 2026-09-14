// git/index.js — the path after the lane, run locally, for zero model tokens.
//
// The factory already knows which findings a lane closed, which files it may
// have touched and what command proves it, so staging, a conventional-commit
// message, a draft PR body, the review round-trip and the merge are git and
// `gh` driven from here. Paying a session to read a diff the control layer
// produced is the failure this module exists to avoid.
//
// The rules are code, not memory:
//   - every git command carries an explicit repo dir that IS a git checkout
//   - staging is an explicit path list from the unit scope; never `git add -A`,
//     because a commit is where a lane's widening stops being visible
//   - a secret sweep runs BEFORE the commit: a key that reached a remote is
//     public whatever the next commit says
//   - hooks are the gate and are never bypassed; `guardArgs` refuses the bypass
//     flags by substring so `--force-with-lease=x` cannot slip past an exact match
//   - a `gh` call that could not be made returns null (unknown), never [] (looked,
//     found nothing); a merge gate that reads null refuses and says why
import fs from "node:fs";
import path from "node:path";
import { run, which, gitOk } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT, abs, rel } from "../core/paths.js";
import * as store from "../core/store.js";
import { out, warn, emit } from "../core/log.js";
import { now } from "../core/util.js";

// ── guards ───────────────────────────────────────────────────────────────────

// Substring, on purpose: `--force-with-lease=main` and `--force-if-includes`
// both contain `--force`, and `-c core.hooksPath=/dev/null` arrives as one or
// two argv entries. The short `-f` is matched as a flag cluster (`-f`, `-fu`)
// rather than as a substring so `--format` and file names stay legal.
export const REFUSED_SUBSTRINGS = ["--no-verify", "--force", "--force-with-lease", "--force-if-includes", "core.hooksPath"];
const SHORT_FORCE = /^-[a-zA-Z]*f[a-zA-Z]*$/;

/** Throws on any argument that would bypass a hook or rewrite a remote. */
export function guardArgs(args) {
  const joined = (args || []).map(String);
  const bad = joined.filter((a) => REFUSED_SUBSTRINGS.some((s) => a.includes(s)) || SHORT_FORCE.test(a));
  if (bad.length) throw new Error(`refused git flags ${JSON.stringify(bad)}: hooks are the gate, fix the failure instead`);
  return joined;
}

/** The top level of the checkout that contains `cwd`. Throws outside a repo:
 *  a git command that lands in a plain directory either does nothing or does
 *  something to the wrong tree. */
export function repoDir(cwd = ROOT) {
  const d = path.resolve(cwd || ROOT);
  if (!fs.existsSync(d)) throw new Error(`not a directory: ${d}`);
  if (!gitOk(d)) throw new Error(`not a git repository: ${rel(d)}`);
  const r = run(["git", "rev-parse", "--show-toplevel"], { cwd: d, timeout: 30000 });
  return r.rc === 0 && r.out.trim() ? r.out.trim() : d;
}

/** Every git call in this module goes through here, so the guard is not a caller's choice. */
export function gitx(args, cwd, { timeout = 120000 } = {}) {
  return run(["git", ...guardArgs(args)], { cwd, timeout });
}

// Basename rules. `.env.example` is the one documented exception: it is the
// template a secret file is copied from, and has no values in it.
const SECRET_NAME = [
  (b) => b.startsWith(".env") && b !== ".env.example",
  (b) => /^client_secret.*\.json$/.test(b),
  (b) => /\.(pem|p12|keystore|jks|key)$/.test(b),
  (b) => b.startsWith("id_rsa"),
  (b) => b === ".npmrc",
  (b) => /^serviceAccount.*\.json$/i.test(b),
  (b) => b === "credentials.json",
];
/** Paths that must never be staged, sorted. */
export function secretSweep(paths) {
  return [...new Set((paths || []).map(String))].filter((p) => { const b = path.posix.basename(p.replace(/\\/g, "/")); return SECRET_NAME.some((f) => f(b)); }).sort();
}

// ── status ───────────────────────────────────────────────────────────────────

/** `git status --porcelain -z` parsed. -z is used because it never quotes: a
 *  path with a space or a quote arrives as bytes, not as an escaped string.
 *  A rename is `R  new\0old\0` (git reverses the pair under -z), so `path` is
 *  where the file is now and `from` is where it was. Paths are relative to the
 *  repo top level, which is what `git add` from that dir expects. */
export function dirtyFiles(cwd) {
  const d = repoDir(cwd);
  const r = gitx(["status", "--porcelain", "-z", "--untracked-files=all"], d);
  if (r.rc !== 0) throw new Error(`git status failed in ${rel(d)}: ${r.err.trim().slice(-200)}`);
  return parsePorcelainZ(r.out);
}
export function parsePorcelainZ(text) {
  const parts = String(text || "").split("\0");
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    const row = { status: xy.trim() || "?", path: p };
    if (/[RC]/.test(xy)) { row.from = parts[i + 1] || ""; i++; }
    rows.push(row);
  }
  return rows;
}

export function branch(cwd) {
  const r = gitx(["branch", "--show-current"], repoDir(cwd));
  return r.rc === 0 ? r.out.trim() : "";
}
/** The remote's default branch when the clone recorded it, else `main`. */
export function defaultBranch(cwd) {
  const r = gitx(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoDir(cwd));
  const ref = r.rc === 0 ? r.out.trim() : "";
  return ref ? ref.split("/").pop() : "main";
}

// ── commit ───────────────────────────────────────────────────────────────────

const TYPE_FOR = {
  "doc-links": "docs", "doc-drift": "docs",
  "dead-exports": "refactor", "god-file": "refactor", "duplicate-blocks": "refactor", "orphan-files": "refactor",
  "secret-scan": "fix", "merge-markers": "fix", "debug-leftovers": "fix", "pr-review": "fix",
  "dead-deps": "chore", "lockfile-drift": "chore", "todo-census": "chore",
};
const typeFor = (detector) => TYPE_FOR[detector] || "fix";
/** The one top-level directory every scope path shares, else `workspace`. */
export function scopeName(scope) {
  const tops = new Set((scope || []).map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean).map((p) => (p.includes("/") ? p.split("/")[0] : ".")));
  if (tops.size === 1) { const [t] = tops; if (t !== ".") return t; }
  return "workspace";
}

/** Conventional Commits. Scope is the feature area, never the repo name; the
 *  body carries the finding ids and the acceptance so the reviewer reads WHY. */
export function message({ detector = "", findings = [], scope = [], acceptance = [], files = [] } = {}) {
  const dets = [...new Set([detector, ...findings.map((f) => f && f.detector)].filter(Boolean))];
  const one = dets.length === 1 ? dets[0] : "";
  const n = findings.length;
  const area = scopeName(scope);
  // No findings means the scope was given by hand, and bundlebox does not know
  // WHY these files changed. Saying "closes 0 findings" is a claim about
  // nothing; naming the files and admitting the gap is the honest subject.
  if (!n) {
    const body0 = ["No findings were named, so this commit was scoped by hand and bundlebox",
      "cannot say what it closes. Staged:"];
    for (const f of files.slice(0, 20)) body0.push(`- ${f}`);
    if (files.length > 20) body0.push(`- ... and ${files.length - 20} more`);
    const acc0 = [...new Set((Array.isArray(acceptance) ? acceptance : [acceptance]).filter(Boolean))];
    if (acc0.length) body0.push("", "Verified by:", ...acc0.map((a) => `  ${a}`));
    return `chore(${area}): ${files.length} file${files.length === 1 ? "" : "s"} in ${area}\n\n${body0.join("\n")}\n`;
  }
  const type = one ? typeFor(one) : "fix";
  const subject = one ? `close ${n} ${one} finding${n === 1 ? "" : "s"} in ${area}` : `close ${n} static-analysis findings in ${area}`;
  const body = [`Closes ${n} finding${n === 1 ? "" : "s"} from bundlebox detectors:`];
  for (const f of findings) body.push(`- ${f.id || "?"} ${f.title || f.detector || ""}`.trimEnd());
  const acc = [...new Set((Array.isArray(acceptance) ? acceptance : [acceptance]).filter(Boolean))];
  if (acc.length) body.push("", "Verified by:", ...acc.map((a) => `  ${a}`));
  return `${type}(${area}): ${subject}\n\n${body.join("\n")}\n`;
}

/** Stage ONLY the dirty files inside the unit scope and commit them. */
export function commit({ cwd = ROOT, scope = [], findings = [], detector = "", acceptance = [], apply = false } = {}) {
  const want = [...new Set((scope || []).map(String).filter(Boolean))];
  if (!want.length) return { ok: false, changed: false, why: "no unit scope: refusing to stage without an explicit path list (never `git add -A`)" };
  const d = repoDir(cwd);
  const changed = dirtyFiles(d);
  if (!changed.length) return { ok: true, changed: false, repo: rel(d), why: "clean tree" };
  // Scope paths are workspace-relative; git speaks repo-relative. Both sides
  // are compared as real paths: on macOS a temp dir is /var/... and git
  // reports /private/var/..., and a relative() across that reads as outside.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const dReal = real(d), rootReal = real(ROOT);
  const local = want.map((p) => path.relative(dReal, path.isAbsolute(p) ? real(p) : path.join(rootReal, p)).replace(/\\/g, "/")).filter((p) => p && !p.startsWith(".."));
  // Every scope path landed outside this checkout. Almost always the scope was
  // written relative to the repo when it is read relative to the WORKSPACE, and
  // "none inside the unit scope" does not say that.
  if (!local.length) {
    return { ok: false, changed: false, repo: rel(d),
      why: `every scope path is outside ${rel(d)}: scope is workspace-relative, so name ${want.map((p) => `${rel(d)}/${p}`).slice(0, 3).join(", ")}` };
  }
  const inScope = (p) => local.some((s) => p === s || p.startsWith(s.replace(/\/$/, "") + "/"));
  const staged = changed.filter((r) => inScope(r.path)).map((r) => r.path);
  const outside = changed.filter((r) => !inScope(r.path)).map((r) => r.path);
  const leaked = secretSweep(staged);
  if (leaked.length) return { ok: false, changed: false, repo: rel(d), why: `secret-shaped paths refused before commit: ${leaked.join(", ")}`, leaked };
  if (!staged.length) return { ok: false, changed: false, repo: rel(d), why: `${changed.length} dirty file(s), none inside the unit scope`, outside_scope: outside };
  const text = message({ detector, findings, scope: want, acceptance, files: staged });
  if (!apply) return { ok: true, changed: true, dry_run: true, repo: rel(d), staged, outside_scope: outside, message: text };
  const a = gitx(["add", "--", ...staged], d);
  if (a.rc !== 0) return { ok: false, changed: false, repo: rel(d), why: (a.err || a.out).trim().slice(-300) };
  const c = gitx(["commit", "-m", text], d, { timeout: 900000 });
  if (c.rc !== 0) return { ok: false, changed: false, repo: rel(d), why: (c.err || c.out).trim().slice(-500) };
  const sha = gitx(["rev-parse", "--short", "HEAD"], d).out.trim();
  return { ok: true, changed: true, repo: rel(d), sha, staged, outside_scope: outside, message: text };
}

// ── push ─────────────────────────────────────────────────────────────────────

export function push({ cwd = ROOT, branch: br = "", apply = false } = {}) {
  const d = repoDir(cwd);
  const g = load().git || {};
  br = br || branch(d);
  if (!br) return { ok: false, repo: rel(d), why: "detached HEAD" };
  if ((g.protected || []).includes(br)) return { ok: false, repo: rel(d), branch: br, why: `refusing to push protected branch ${br} (cfg.git.protected)` };
  if (g.allow_push === false) return { ok: false, repo: rel(d), branch: br, why: "cfg.git.allow_push is false" };
  const cmd = ["push", "-u", "origin", br];
  if (!apply) return { ok: true, dry_run: true, repo: rel(d), branch: br, cmd: `git ${cmd.join(" ")}` };
  const r = gitx(cmd, d, { timeout: 1800000 });
  return { ok: r.rc === 0, repo: rel(d), branch: br, why: r.rc === 0 ? "" : (r.err || r.out).trim().slice(-800) };
}

// ── gh ───────────────────────────────────────────────────────────────────────

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

/** The PR body a reviewer can act on, filled from what the lane closed. */
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
  return `## Summary
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
`;
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

// ── the verb ─────────────────────────────────────────────────────────────────

function laneInputs(laneId) {
  const lanes = store.get("lanes", []);
  const lane = lanes.find((l) => l.id === laneId);
  if (!lane) throw new Error(`no lane ${laneId} in var/lanes.json`);
  const units = store.get("units", []).filter((u) => (lane.unit_ids || []).includes(u.id));
  const ids = new Set(units.flatMap((u) => u.finding_ids || []));
  const findings = store.get("findings", []).filter((f) => ids.has(f.id));
  const scope = [...new Set([...(lane.files || []), ...units.flatMap((u) => u.scope || [])])];
  const dets = {};
  for (const f of findings) dets[f.detector] = (dets[f.detector] || 0) + 1;
  const detector = Object.entries(dets).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return { lane, units, findings, scope, detector, acceptance: units.map((u) => u.acceptance).filter(Boolean), cwd: lane.worktree || lane.cwd || ROOT };
}

const line = (key, r) => {
  const mark = r.ok ? "ok " : "!! ";
  const dry = r.dry_run ? "(dry run)" : "";
  const detail = r.why || (r.refused ? r.refused.join("; ") : "") || r.url || r.cmd || r.sha || (r.message || "").split("\n")[0] || "";
  return `  ${mark}${key.padEnd(7)}${dry.padEnd(10)} ${detail}`;
};

/** Where `bb git` acts when nobody said: the workspace root when it is a repo,
 *  otherwise its one subrepo. A workspace of projects carries git per project,
 *  and refusing at the top is the wrong answer to a shape `bb init` already
 *  detects and records in `workspace.subrepos`. */
export function defaultRepo() {
  if (gitOk(ROOT)) return ROOT;
  const subs = (load().workspace?.subrepos || []).filter((d) => gitOk(path.join(ROOT, d)));
  if (subs.length === 1) return path.join(ROOT, subs[0]);
  if (subs.length > 1) throw new Error(`${subs.length} repositories here (${subs.join(", ")}) and no --cwd: name the one to act on`);
  return ROOT;
}

export const commands = {
  git: {
    help: "commit, push, draft PR, ready, merge and review, with the workspace rules as code",
    usage: "bb git commit [--lane L01 | --scope a,b] [--apply] | push [--apply] | pr [--lane L01] [--apply] | ready <n> [--apply] | merge <n> [--override-gate] [--apply] | review <n> [--write] | status   [--cwd <dir>]",
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      const apply = !!flags.apply;
      // Resolved against the workspace, not the process: `--cwd demo` means the
      // project, wherever the shell happens to be.
      const cwd = flags.cwd ? path.resolve(ROOT, String(flags.cwd)) : defaultRepo();
      const show = (key, r) => { if (flags.json) emit(r); else { out(line(key, r)); if (r.outside_scope?.length) out(`      ${r.outside_scope.length} dirty file(s) OUTSIDE the unit scope, left uncommitted: ${r.outside_scope.slice(0, 4).join(", ")}`); if (r.message && r.dry_run) out(r.message.split("\n").map((l) => "      " + l).join("\n")); } return r.ok ? 0 : 1; };
      try {
        if (sub === "commit") {
          let inputs;
          if (flags.lane) inputs = laneInputs(String(flags.lane));
          else if (flags.scope) inputs = { scope: String(flags.scope).split(",").map((s) => s.trim()).filter(Boolean), findings: [], detector: String(flags.detector || ""), acceptance: [], cwd };
          else return show("commit", { ok: false, why: "no scope: pass --lane <id> or --scope a,b. Staging without an explicit path list is refused (never `git add -A`)" });
          return show("commit", commit({ ...inputs, cwd: flags.cwd ? cwd : inputs.cwd, apply }));
        }
        if (sub === "push") return show("push", push({ cwd, branch: flags.branch ? String(flags.branch) : "", apply }));
        if (sub === "pr") {
          let lane = {}, findings = [], acceptance = null, at = cwd;
          if (flags.lane) { const i = laneInputs(String(flags.lane)); lane = i.lane; findings = i.findings; acceptance = i.acceptance; at = flags.cwd ? cwd : i.cwd; }
          const base = flags.base ? String(flags.base) : defaultBranch(at);
          const title = flags.title ? String(flags.title) : (findings.length ? message({ detector: "", findings, scope: lane.files || [] }).split("\n")[0] : `bb: ${branch(at)}`);
          return show("pr", prCreate({ cwd: at, base, title, body: prBody(lane, findings, { base, acceptance }), draft: flags.draft === false ? false : null, apply }));
        }
        if (sub === "ready") return show("ready", prReady(_[1], { cwd, apply }));
        if (sub === "merge") return show("merge", merge(_[1], { cwd, overrideGate: !!flags.overrideGate, apply }));
        if (sub === "review") {
          const r = review(_[1], { cwd, write: !!flags.write });
          if (flags.json) { emit(r); return r.ok ? 0 : 1; }
          if (!r.ok) { out(line("review", r)); return 1; }
          out(`  PR #${r.pr} ${r.state}${r.decision ? ` (${r.decision})` : ""}  ${r.url || ""}`);
          out(`  ${r.counts.threads} thread(s)${r.threads_known ? "" : " (threads: unknown, gh api failed)"}, ${r.counts.checks} failing check(s)${r.checks_known ? "" : " (checks: unknown)"}${r.written ? `; ${r.written} findings in store` : ""}`);
          for (const f of r.findings) out(`    ${f.severity.padEnd(7)} ${f.title}`);
          if (!flags.write && r.findings.length) out("  --write to merge these into var/findings.json as detector pr-review");
          return 0;
        }
        if (sub === "status") {
          const d = repoDir(cwd);
          const br = branch(d), dirty = dirtyFiles(d), av = ghAvailable();
          const st = av.ok && br ? prStatus("", { cwd: d }) : null;
          const row = { repo: rel(d), branch: br, default_branch: defaultBranch(d), dirty: dirty.length, secrets_dirty: secretSweep(dirty.map((x) => x.path)), gh: av, pr: st, at: now() };
          if (flags.json) { emit(row); return 0; }
          out(`  repo       ${row.repo}   branch ${br || "(detached)"}   base ${row.default_branch}`);
          out(`  dirty      ${dirty.length}${row.secrets_dirty.length ? `   SECRET-SHAPED: ${row.secrets_dirty.join(", ")}` : ""}`);
          out(`  github     ${av.ok ? `ok as ${av.account}` : av.why}   merge ${load().git?.allow_merge ? "ENABLED" : "off (humans merge)"}`);
          if (st) { out(`  pr         #${st.number} ${st.state}${st.isDraft ? " DRAFT" : ""}  ${st.url}`); out(`             checks ${st.checks_total} total, ${st.checks_failing.length} failing, ${st.checks_pending.length} pending; ${st.approvals} approval(s); mergeable ${st.mergeable}`); }
          else out(`  pr         ${av.ok ? "none for this branch" : "unknown (gh unavailable)"}`);
          return 0;
        }
        warn(`unknown: bb git ${sub}`); return 2;
      } catch (e) {
        if (flags.json) emit({ ok: false, why: e.message }); else warn(e.message);
        return 1;
      }
    },
  },
};
