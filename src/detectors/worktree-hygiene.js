// worktree-hygiene — the state of the checkout itself. A dirty shared checkout
// is how two lanes destroy each other's work. A survey: a dirty tree is fixed
// by a person, not by a session opened inside the dirty tree. Reads only
// (`git status -sb`, never fetch): a detector that fetches is a detector that
// hangs on a VPN.
import fs from "node:fs";
import { finding, gitAvailable } from "./_shared.js";

export default {
  name: "worktree-hygiene", precision: "exact", severity: "low",
  description: "dirty tree, untracked files, branches without upstream, stale worktree records, behind/ahead",
  run(ctx) {
    if (!gitAvailable(ctx)) return [];
    const out = [];
    const st = ctx.git(["status", "-sb", "--porcelain=v1"]);
    if (st.rc !== 0) return [];
    const lines = st.out.split("\n").filter(Boolean);
    const head = lines.shift() || "";
    const branch = (/^## ([^. ]+)/.exec(head) || [])[1] || "";
    const behind = Number((/behind (\d+)/.exec(head) || [])[1] || 0);
    const ahead = Number((/ahead (\d+)/.exec(head) || [])[1] || 0);
    const hasUpstream = head.includes("...");
    // The tool's own state dir is never hygiene: reporting it would make every
    // first scan dirty the tree it just scanned.
    const untracked = lines.filter((l) => l.startsWith("??") && !l.slice(3).startsWith(".bundlebox"));
    const dirty = lines.filter((l) => !l.startsWith("??"));
    const protectedBranches = ctx.cfg.git?.protected || [];
    if (dirty.length || untracked.length) {
      out.push(finding({
        severity: dirty.length > 20 ? "medium" : dirty.length ? "low" : "info", kind: "investigate",
        path: ".", key: "dirty",
        title: `${branch || "HEAD"}: ${dirty.length} uncommitted, ${untracked.length} untracked file(s)`,
        detail: [...dirty, ...untracked].slice(0, 20).map((l) => `  ${l}`).join("\n"),
        evidence: { branch, dirty: dirty.length, untracked: untracked.length, files: dirty.slice(0, 50).map((l) => l.slice(3)), untracked_files: untracked.slice(0, 50).map((l) => l.slice(3)) },
        fix_hint: "The router refuses to put a lane in a dirty shared checkout. Commit, stash somewhere that is not this tree, or give the lane a worktree.",
      }));
    }
    if (behind) {
      out.push(finding({
        severity: "low", kind: "investigate", path: ".", key: "behind",
        title: `${branch}: ${behind} commit(s) behind upstream${ahead ? `, ${ahead} ahead` : ""}`,
        evidence: { branch, behind, ahead, clean: !dirty.length, protected: protectedBranches.includes(branch) },
        // Only the CLEAN, protected-branch case is mechanical: a fast-forward
        // git itself refuses if it is not one. A dirty tree is a person's call.
        auto_fix: !dirty.length && protectedBranches.includes(branch) ? "sync-trunk" : null,
        fix_hint: "`git pull --ff-only` on a clean tree. Findings computed here describe files upstream may have moved past.",
      }));
    }
    const refs = ctx.git(["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"]);
    const noUpstream = refs.rc === 0 ? refs.out.split("\n").filter(Boolean).map((l) => l.split("\t")).filter(([, u]) => !u).map(([b]) => b) : null;
    if (noUpstream && noUpstream.length && hasUpstream) {
      out.push(finding({
        severity: "info", kind: "investigate", path: ".", key: "no-upstream",
        title: `${noUpstream.length} local branch(es) with no upstream`,
        detail: noUpstream.slice(0, 20).map((b) => `  ${b}`).join("\n"),
        evidence: { branches: noUpstream.slice(0, 50), count: noUpstream.length },
        fix_hint: "A branch nobody pushed is work only this machine has.",
      }));
    }
    const wt = ctx.git(["worktree", "list", "--porcelain"]);
    if (wt.rc === 0) {
      const stale = [];
      let cur = null;
      for (const l of wt.out.split("\n")) {
        if (l.startsWith("worktree ")) cur = l.slice(9);
        else if (l.startsWith("prunable") && cur) stale.push(cur);
        else if (l === "" && cur) { if (!fs.existsSync(cur) && !stale.includes(cur)) stale.push(cur); cur = null; }
      }
      if (stale.length) {
        out.push(finding({
          severity: "low", kind: "fix", path: ".", key: "stale-worktrees",
          title: `${stale.length} worktree record(s) point at directories that are gone`,
          detail: stale.map((p) => `  ${p}`).join("\n"),
          evidence: { worktrees: stale, count: stale.length },
          auto_fix: "prune-worktrees",
          fix_hint: "`git worktree prune` drops the bookkeeping; it cannot touch a worktree that still exists.",
        }));
      }
    }
    return out;
  },
};
