// git/index.js — the verb, and the one name the rest of the factory imports.
//
// The path after the lane, run locally, for zero model tokens: staging and a
// derived commit message (commit.js), the guards and the working tree
// (repo.js), and the GitHub round-trip (forge.js). This file dispatches and
// re-exports; the rules live next to the thing they constrain.
import path from "node:path";
import { run, gitOk } from "../core/exec.js";
import { load } from "../core/config.js";
import { ROOT, rel } from "../core/paths.js";
import * as store from "../core/store.js";
import { out, warn, emit } from "../core/log.js";
import { now } from "../core/util.js";
import { guardArgs, repoDir, gitx, secretSweep, dirtyFiles, parsePorcelainZ, branch, defaultBranch } from "./repo.js";
import { scopeName, message, canon, scopeToRepo, commit, push } from "./commit.js";
import { ghAvailable, gh, ghJson, prBody, prCreate, prStatus, prReady, merge, review } from "./forge.js";

export { REFUSED_SUBSTRINGS, guardArgs, repoDir, gitx, secretSweep, dirtyFiles, parsePorcelainZ, branch, defaultBranch } from "./repo.js";
export { scopeName, message, canon, scopeToRepo, commit, push } from "./commit.js";
export { ghAvailable, gh, ghJson, prBody, prCreate, prStatus, prReady, merge, review } from "./forge.js";

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
