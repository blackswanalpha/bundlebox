// outcomes.js — A4 and A5's input: what happened to every auto-fix PR.
//
// Each PR is read once when it closes: merged or rejected. A merged one is
// then watched for a revert on the base branch, found by the `This reverts
// commit <sha>` line git writes. Each outcome is one episode row, so the
// episode table and buckmaster learn which fix types merge and which do not,
// and one autonomy step per fix type the PR carried.
import { git } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT } from "../core/paths.js";
import * as store from "../core/store.js";
import * as autonomy from "./autonomy.js";
import { PREFIX, TYPES_MARK } from "./autofix.js";
import { baseRef, gh } from "./git.js";

export const DOC = "sentinel-prs";

export const typesOf = (body) => String((String(body || "").match(new RegExp(`<!--\\s*${TYPES_MARK}:\\s*([^>]*?)\\s*-->`)) || [])[1] || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** The SHAs the base branch says were reverted, from its commit messages. */
export function reverted(log) {
  return new Set([...String(log).matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]));
}

/** Fold a PR listing into outcomes. Pure over (prs, seen, revertedShas). */
export function fold(prs, seen, revertedShas) {
  const events = [];
  for (const pr of prs) {
    if (!String(pr.headRefName).startsWith(PREFIX)) continue;
    const types = typesOf(pr.body);
    if (!types.length) continue;
    const prev = seen[pr.number];
    const sha = pr.mergeCommit?.oid || "";
    if (!prev && pr.state === "MERGED") events.push({ pr: pr.number, types, outcome: "merged", sha });
    else if (!prev && pr.state === "CLOSED") events.push({ pr: pr.number, types, outcome: "rejected", sha: "" });
    const was = prev?.outcome || (pr.state === "MERGED" ? "merged" : "");
    if (was === "merged" && !prev?.reverted && sha && [...revertedShas].some((s) => sha.startsWith(s) || s.startsWith(sha))) {
      events.push({ pr: pr.number, types, outcome: "reverted", sha });
    }
  }
  return events;
}

/** Read GitHub and the base branch, fold, and (with `apply`) record. */
export function sync({ apply = false, cfg = load(), root = ROOT } = {}) {
  const list = gh(["pr", "list", "--state", "all", "--limit", "200", "--json", "number,headRefName,state,body,mergeCommit,url"], { cwd: root });
  if (!list.ok) return { ok: false, why: list.why, events: [] };
  git(["fetch", "--quiet", "origin"], root);
  const log = git(["log", "--format=%B", "-n", "2000", baseRef(root, cfg)], root);
  const seen = store.get(DOC, {}) || {};
  const events = fold(list.data || [], seen, reverted(log.out));
  if (!apply) return { ok: true, events, applied: false };
  for (const e of events) {
    autonomy.observe(e.types, e.outcome, { cfg });
    seen[e.pr] = e.outcome === "reverted" ? { ...seen[e.pr], reverted: true } : { outcome: e.outcome, types: e.types, sha: e.sha };
    store.append("episodes", { kind: "sentinel", verb: "auto-fix", features: { types: e.types.join(","), outcome: e.outcome }, rc: e.outcome === "merged" ? 0 : 1,
      run_id: `pr-${e.pr}`, useful: e.outcome === "merged" ? 1 : 0, detail: `PR #${e.pr} ${e.outcome}` });
  }
  if (events.length) store.put(DOC, seen);
  return { ok: true, events, applied: true };
}
