// git.js — the git and gh calls Sentinel, sprint and ironguard share. Every one
// goes through exec.js, so a missing binary or a refusal comes back as a row.
import fs from "node:fs";
import path from "node:path";
import { git, run } from "../core/exec.js";
import { call as kernelCall } from "../core/kernel.js";
import { load } from "../core/config.js";
import { ROOT } from "../core/paths.js";

/** The branch fixes start from and PRs target: `sentinel.base`, else what
 *  origin calls HEAD, else `main`. Never a protected-branch WRITE target: this
 *  is only ever the base of a new branch. */
export function baseBranch(cwd = ROOT, cfg = load()) {
  if (cfg.sentinel?.base) return String(cfg.sentinel.base);
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const s = r.rc === 0 ? r.out.trim() : "";
  return s ? s.replace(/^origin\//, "") : "main";
}

/** The ref a new branch is cut from: origin's copy when there is one, so a
 *  local main that is behind or dirty does not leak into the fix. */
export function baseRef(cwd = ROOT, cfg = load()) {
  const b = baseBranch(cwd, cfg);
  return git(["rev-parse", "--verify", "--quiet", `origin/${b}`], cwd).rc === 0 ? `origin/${b}` : b;
}

/** A branch Sentinel may write to: its own prefix, never a protected name. */
export function writable(branch, cfg = load()) {
  const protectedNames = new Set(cfg.git?.protected || ["main", "master"]);
  return String(branch).startsWith("bb/") && !protectedNames.has(String(branch));
}

export const branchExists = (branch, cwd = ROOT) => git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd).rc === 0;

/** A worktree for `branch`: cut fresh from `from`, or checked out from origin
 *  when the branch already lives there (a review round works on the PR's own
 *  branch). node_modules is linked from the main checkout so the gate runs. */
export function addWorktree(wt, branch, { from = "", existing = false, cwd = ROOT } = {}) {
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (fs.existsSync(wt)) removeWorktree(wt, { cwd });
  let r, via = "js";
  if (existing) {
    git(["fetch", "--quiet", "origin", branch], cwd);
    r = git(["worktree", "add", "-B", branch, wt, `origin/${branch}`], cwd);
  } else {
    // The kernel's `worktree` op adds and seeds (the gitignored files a gate
    // needs, `kernel.seed`) in one process. It falls back to HEAD when the start
    // point is missing; here that is a failure, since HEAD is whatever the main
    // checkout happens to be on.
    const start = from || baseRef(cwd);
    const k = kernelCall("worktree", { path: wt, branch, base: start, apply: true, repo: cwd, seed: load().kernel?.seed || [] });
    if (k && k.ok && !(k.notes || []).some((n) => String(n).includes("unavailable"))) { r = { rc: 0 }; via = "kernel"; }
    else {
      if (k && k.ok) { removeWorktree(wt, { cwd }); git(["branch", "-D", branch], cwd); return { ok: false, why: `start point ${start} unavailable` }; }
      r = git(["worktree", "add", "-b", branch, wt, start], cwd);
    }
  }
  if (r.rc !== 0) return { ok: false, why: (r.err || r.out).trim().slice(0, 300) };
  const nm = path.join(cwd, "node_modules");
  if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, "node_modules"))) {
    try { fs.symlinkSync(nm, path.join(wt, "node_modules"), "dir"); } catch { /* the gate reports what is missing */ }
  }
  return { ok: true, via };
}

export function removeWorktree(wt, { cwd = ROOT } = {}) {
  const r = git(["worktree", "remove", "--force", wt], cwd);
  if (r.rc !== 0) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* already gone */ } git(["worktree", "prune"], cwd); }
}

/** Push `branch` from `wt` and open a PR, draft unless told otherwise. */
export function openPr(wt, branch, { title, body, base, draft = true, cfg = load() } = {}) {
  if (!cfg.git?.allow_push) return { ok: false, why: "git.allow_push = false" };
  if (!writable(branch, cfg)) return { ok: false, why: `refusing to push \`${branch}\`: not a bb/ branch, or protected` };
  const p = git(["push", "-u", "origin", branch], wt);
  if (p.rc !== 0) return { ok: false, why: (p.err || p.out).trim().slice(0, 300) };
  const r = run(["gh", "pr", "create", "--base", base || baseBranch(wt, cfg), "--head", branch, "--title", title, "--body", body, ...(draft ? ["--draft"] : [])], { cwd: wt, timeout: 120000 });
  if (r.rc !== 0) return { ok: false, pushed: true, why: r.missing ? "gh not installed" : (r.err || r.out).trim().slice(0, 300) };
  const url = r.out.trim().split("\n").pop();
  return { ok: true, url, number: Number((url.match(/\/pull\/(\d+)/) || [])[1]) || null };
}

/** `gh` with JSON out. `{ ok, data, why }`, never a throw. */
export function gh(args, { cwd = ROOT, timeout = 60000 } = {}) {
  const r = run(["gh", ...args], { cwd, timeout });
  if (r.rc !== 0) return { ok: false, data: null, why: r.missing ? "gh not installed" : (r.err || r.out).trim().slice(0, 300) };
  try { return { ok: true, data: r.out.trim() ? JSON.parse(r.out) : null }; } catch { return { ok: true, data: r.out.trim() }; }
}
