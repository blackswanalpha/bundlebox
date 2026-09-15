// git/commit.js — staging, the conventional-commit message the factory can
// derive without reading a diff, and the push.
//
// The message is built from what the control layer already knows — the
// detector, the findings closed, the scope and the acceptance command — so no
// session is paid to summarise a change it just made.
import fs from "node:fs";
import path from "node:path";
import { which } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT, rel } from "../core/paths.js";
import { out } from "../core/log.js";
import { gitx, repoDir, branch, dirtyFiles, secretSweep } from "./repo.js";
import { clean } from "../slop/index.js";

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
  return clean(`${type}(${area}): ${subject}\n\n${body.join("\n")}`) + "\n";
}

/** The name the OS itself gives a path, for comparing two spellings of one
 *  directory.
 *
 *  `fs.realpathSync` resolves symlinks, which is enough on macOS, where a temp
 *  dir is `/var/...` and git reports `/private/var/...`. It does NOT resolve a
 *  Windows 8.3 short name: `os.tmpdir()` hands back `C:\Users\RUNNER~1\...`
 *  and stays short, while `git rev-parse --show-toplevel` always reports the
 *  long form. The two then compare as different directories, every scope path
 *  lands "outside" the repository, and nothing is ever staged.
 *  `realpathSync.native` asks the OS for the final name, which settles both the
 *  short name and the drive-letter case git and Node disagree about. */
export function canon(p) {
  for (const f of [fs.realpathSync.native, fs.realpathSync]) {
    try { return f(p); } catch { /* not on disk, or no native call on this build */ }
  }
  return p;
}

/** Unit scope paths as paths relative to the repository top level, and which
 *  base they were read against.
 *
 *  Scope is workspace-relative, which only means something while the repository
 *  is inside the workspace. `--cwd` on a checkout somewhere else leaves no
 *  workspace path to be relative TO, so there the scope is read against the
 *  repository — the only reading it can have.
 *
 *  Pure, and takes its `path` implementation, so the Windows arithmetic can be
 *  tested on a machine that is not Windows. */
export function scopeToRepo(want, { root, repo, p = path } = {}) {
  const under = (parent, child) => {
    const r = p.relative(parent, child);
    return r === "" || (!r.startsWith("..") && !p.isAbsolute(r));
  };
  const workspace = under(root, repo);
  const from = workspace ? root : repo;
  const out = [];
  for (const s of want || []) {
    const r = p.relative(repo, p.isAbsolute(s) ? s : p.join(from, s)).replace(/\\/g, "/");
    if (r && !r.startsWith("..")) out.push(r);
  }
  return { local: [...new Set(out)], base: workspace ? "workspace" : "repo" };
}

/** Stage ONLY the dirty files inside the unit scope and commit them. */
export function commit({ cwd = ROOT, scope = [], findings = [], detector = "", acceptance = [], apply = false } = {}) {
  const want = [...new Set((scope || []).map(String).filter(Boolean))];
  if (!want.length) return { ok: false, changed: false, why: "no unit scope: refusing to stage without an explicit path list (never `git add -A`)" };
  const d = repoDir(cwd);
  const changed = dirtyFiles(d);
  if (!changed.length) return { ok: true, changed: false, repo: rel(d), why: "clean tree" };
  const dReal = canon(d), rootReal = canon(ROOT);
  const { local, base } = scopeToRepo(want.map((s) => (path.isAbsolute(s) ? canon(s) : s)), { root: rootReal, repo: dReal });
  if (!local.length) {
    const prefix = path.relative(rootReal, dReal).replace(/\\/g, "/");
    // Two different failures, and they need different sentences. Under the
    // workspace, the scope was almost certainly written relative to the repo:
    // name the prefix that would have worked. Outside it, the scope simply is
    // not in this checkout and there is no prefix to suggest.
    const why = base === "workspace" && prefix && !prefix.startsWith("..")
      ? `every scope path is outside ${prefix}: scope is workspace-relative, so name ${want.map((x) => `${prefix}/${x}`).slice(0, 3).join(", ")}`
      : `no scope path is inside ${rel(d)}: ${want.slice(0, 3).join(", ")}`;
    return { ok: false, changed: false, repo: rel(d), why };
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
