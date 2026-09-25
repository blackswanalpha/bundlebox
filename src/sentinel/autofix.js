// autofix.js — A1: close the fixes that cannot go wrong, on a branch, behind
// the gate, as a draft PR. Never on the base branch and never in the main
// checkout: the work happens in a throwaway worktree under .bundlebox/var.
//
//   1. cut bb/auto-fix/<date> from the base, in its own worktree
//   2. in that worktree: scan the certain detectors, `bb fix --apply --certain`
//   3. nothing changed          -> drop the worktree and the branch
//   4. ironguard blocks          -> keep the branch, push nothing
//   5. the gate fails            -> keep the branch, push nothing
//   6. commit, push, draft PR; when every fix type has earned it (A5) and
//      ironguard found nothing to review, mark it ready and set auto-merge
import path from "node:path";
import { run, git, shellCmd } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT, VAR, PKG_ROOT } from "../core/paths.js";
import { CERTAIN } from "../actuators/index.js";
import * as ironguard from "../ironguard/index.js";
import * as autonomy from "./autonomy.js";
import { addWorktree, removeWorktree, openPr, baseBranch, baseRef, branchExists, writable, gh } from "./git.js";

export const PREFIX = "bb/auto-fix/";
export const TYPES_MARK = "bb-fix-types";
const BB = [process.execPath, path.join(PKG_ROOT, "bin", "bb.js")];

/** The day's branch, suffixed when an earlier run today already made one. */
export function branchFor(date, exists = (b) => branchExists(b)) {
  let b = `${PREFIX}${date}`;
  for (let n = 2; exists(b); n++) b = `${PREFIX}${date}-${n}`;
  return b;
}

/** The PR body: what closed, what proved it, and the marker `sync` reads the
 *  fix types back out of. */
export function body({ fixed, gate, guard, types }) {
  return [
    `Closed by bundlebox's certain actuators (${types.join(", ")}), with no model in the loop.`, "",
    ...fixed.map((r) => `- \`${r.id}\` ${r.name}: ${r.path || ""} ${r.why ? `— ${r.why}` : ""}`.trimEnd()), "",
    `Gate: \`${gate.command}\` exited ${gate.rc}.`,
    ironguard.summary(guard), "",
    `<!-- ${TYPES_MARK}: ${types.join(",")} -->`,
  ].join("\n");
}

const bb = (args, cwd, timeout = 600000) => run([...BB, ...args], { cwd, timeout, env: { BB_ROOT: cwd } });

/** One A1 pass. `candidates` are the free-tier findings from rank(); an empty
 *  list is a no-op that touches nothing. Dry unless `apply`. */
export function autoFix({ candidates = [], apply = false, cfg = load(), date = new Date().toISOString().slice(0, 10), root = ROOT } = {}) {
  const certain = candidates.filter((f) => CERTAIN.has(f.auto_fix));
  if (!certain.length) return { state: "nothing", why: "no open finding names a certain actuator" };
  const detectors = [...new Set(certain.map((f) => f.detector))];
  const branch = branchFor(date, (b) => branchExists(b, root));
  if (!writable(branch, cfg)) return { state: "refused", why: `\`${branch}\` is not a writable bb/ branch` };
  if (!apply) return { state: "would-fix", branch, count: certain.length, detectors, ids: certain.map((f) => f.id) };

  const wt = path.join(VAR, "worktrees", `auto-fix-${date}`);
  const add = addWorktree(wt, branch, { from: baseRef(root, cfg), cwd: root });
  if (!add.ok) return { state: "error", branch, why: `worktree: ${add.why}` };
  const done = (row, keep) => { removeWorktree(wt, { cwd: root }); if (!keep) git(["branch", "-D", branch], root); return { branch, ...row }; };

  // The worktree is its own workspace: its store starts empty, so the certain
  // detectors run there first and the actuators confirm against what is on
  // THAT tree, not against the main checkout's store.
  const sc = bb(["scan", "--only", detectors.join(",")], wt);
  if (sc.rc !== 0) return done({ state: "error", why: `scan in the worktree failed: ${(sc.err || sc.out).trim().slice(0, 200)}` }, false);
  const fx = bb(["fix", "--apply", "--certain", "--json"], wt);
  let results = [];
  try { results = JSON.parse(fx.out).results || []; } catch { return done({ state: "error", why: `fix output unreadable: ${(fx.err || fx.out).trim().slice(0, 200)}` }, false); }
  const fixed = results.filter((r) => r.changed && r.applied !== false);
  const status = git(["status", "--porcelain"], wt);
  if (!fixed.length || !status.out.trim()) {
    const seen = results.map((r) => `${r.name}: ${r.why || (r.ok ? "no change" : "failed")}`).join("; ");
    return done({ state: "no-change", why: `the certain actuators found nothing to change on the base branch${seen ? ` (${seen})` : ` (scan: ${sc.out.trim().split("\n").pop() || "no output"})`}` }, false);
  }
  const types = [...new Set(fixed.map((r) => r.name))].sort();

  const guard = ironguard.check({ cwd: wt, base: baseRef(root, cfg), cfg });
  if (!guard.ok) return done({ state: "blocked", types, guard, why: ironguard.summary(guard) }, true);

  const command = String(cfg.sentinel?.gate || "npm run lint && npm test");
  const g = run(shellCmd(command, { merge: true }), { cwd: wt, timeout: (Number(cfg.kernel?.gate_timeout) || 1800) * 1000 });
  const gate = { command, rc: g.rc, tail: String(g.out).slice(-2000) };
  if (g.rc !== 0) return done({ state: "gate-failed", types, gate, guard, why: `\`${command}\` exited ${g.rc}` }, true);

  git(["add", "-A"], wt);
  const title = `fix(auto): close ${fixed.length} certain finding(s): ${types.join(", ")}`;
  const c = git(["commit", "-q", "-m", title, "-m", fixed.map((r) => `${r.name}: ${r.path || r.id}`).join("\n")], wt);
  if (c.rc !== 0) return done({ state: "error", types, gate, guard, why: `commit: ${(c.err || c.out).trim().slice(0, 200)}` }, true);

  const auto = guard.auto_ok && autonomy.earned(types) && Boolean(cfg.git?.allow_merge);
  const pr = openPr(wt, branch, { title, body: body({ fixed, gate, guard, types }), base: baseBranch(root, cfg), draft: true, cfg });
  let merge = null;
  if (pr.ok && auto) {
    const ready = gh(["pr", "ready", String(pr.number || pr.url)], { cwd: wt });
    merge = ready.ok ? gh(["pr", "merge", String(pr.number || pr.url), "--auto", "--squash"], { cwd: wt }) : ready;
  }
  return done({ state: pr.ok ? (merge?.ok ? "auto-merge" : "pr") : "committed", types, fixed: fixed.map((r) => ({ id: r.id, name: r.name, path: r.path })), gate: { command, rc: g.rc }, guard, pr, merge,
    why: pr.ok ? pr.url : pr.why }, true);
}
