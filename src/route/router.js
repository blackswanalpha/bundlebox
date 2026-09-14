// router.js — units become lanes. A lane is one session, one checkout, one budget.
//
// Three constraints, and they fight each other:
//
//   budget      a lane must land between the floor and the ceiling. Under the
//               floor it paid full priming cost for a fraction of a session;
//               over the ceiling it compacts and loses the evidence the
//               compiler assembled.
//
//   conflict    two units that touch the same file must not run in parallel.
//               They can share a lane (sequential is fine); they must not share
//               a clock.
//
//   checkout    a shared tree often holds another session's work, and two
//               agents editing one tree corrupt each other's diffs. So a lane
//               gets its own worktree unless it is the only lane in that repo
//               and the tree is clean.
//
// Packing is first-fit-decreasing over est_tokens with a conflict check, which
// is the right algorithm here for an unglamorous reason: the unit sizes are
// wildly uneven (one 5900-line file next to six 40-line tables), and FFD's
// worst case only bites when they are even.
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { load } from "../core/config.js";
import { ROOT, abs } from "../core/paths.js";
import { git, gitOk } from "../core/exec.js";
import { human, stamp, shortId } from "../core/util.js";
import { overheadOf } from "../compile/context.js";

// One fixed namespace so a (run_id, lane_id) pair names the same session on
// every machine; the runner resumes a lane by this id after a crash.
export const NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // RFC 4122 URL namespace

/** RFC 4122 v5: sha1(namespace bytes + name), version and variant bits set. */
export function uuid5(namespace, name) {
  const ns = Buffer.from(String(namespace).replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(String(name), "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const newRunId = () => `run-${stamp()}-${shortId(4)}`;

/** Concurrent sessions this box can hold. One per core, and one per 1.5 GB
 *  after 6 GB is left for the OS and the editor: a box that swaps mid-lane
 *  loses every lane, not one. */
export function slotsTotal() {
  const cpus = os.cpus()?.length || 1;
  const memGB = os.totalmem() / 2 ** 30;
  return Math.max(1, Math.min(cpus, Math.floor(((memGB - 6) * 2) / 3)));
}

const filesOf = (u) => new Set(u.scope || []);
const conflicts = (a, b) => { const A = filesOf(a); return (b.scope || []).some((p) => A.has(p)); };

/** Heaviest model among a lane's units: a lane runs at the tier its hardest
 *  unit needs, or that unit fails and the cheap ones were not worth the lane. */
function laneModel(units, cfg) {
  const ms = units.map((u) => u.model).filter(Boolean);
  return ms.find((m) => /opus/i.test(m)) || ms[0] || cfg.lanes?.model || "";
}

export function plan(units, { runId = "", maxParallel = 0, agent = "" } = {}) {
  const cfg = load();
  const b = cfg.budget;
  const run_id = runId || newRunId();
  const maxPar = Number(maxParallel) || Number(cfg.lanes?.max_parallel) || 1;
  const agentName = agent || cfg.lanes?.agent || "auto";

  // Actuator units never become sessions. This is the cheapest possible
  // outcome and it is checked first so nothing downstream sizes a window for
  // work that a hundred lines of script will do.
  const local = [], remaining = [];
  for (const u of units || []) (u.actuator || u.status === "local" ? local : remaining).push(u);

  const ceiling = Number(b.max_tokens) || 0;
  const floor = Number(b.min_tokens) || 0;
  // The same overhead the compiler budgeted with. Merging two lanes saves
  // exactly one session's priming, so using a different number here than the
  // compiler used makes "is this merge worth it" disagree with the sizes
  // being merged.
  const overhead = overheadOf(null, cfg);

  const byRepo = new Map();
  for (const u of [...remaining].sort((x, y) => y.est_tokens - x.est_tokens)) {
    const repo = u.repo || ".";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(u);
  }

  let lanes = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const bins = [];
    for (const u of byRepo.get(repo)) {
      const fits = bins.filter((ln) => ln.est_tokens + u.est_tokens - overhead <= ceiling);
      // A lane this unit CONFLICTS with is the preferred home, not a lane to
      // avoid: sharing a file is only a problem across a clock, and inside one
      // lane there is one clock. Putting them together removes the conflict
      // from the schedule entirely.
      const target = fits.find((ln) => ln.units.some((x) => conflicts(u, x))) || fits[0] || null;
      if (!target) { bins.push({ units: [u], est_tokens: u.est_tokens, repo }); continue; }
      target.units.push(u);
      target.est_tokens += u.est_tokens - overhead;
    }
    lanes.push(...bins);
  }
  lanes = mergeUnderfilled(lanes, floor, ceiling, overhead);

  const out = lanes.map((ln, i) => {
    const id = `L${String(i + 1).padStart(2, "0")}`;
    return {
      id, run_id, repo: ln.repo,
      session_id: uuid5(NAMESPACE, `${run_id}/${id}`),
      unit_ids: ln.units.map((u) => u.id),
      units: ln.units,
      files: [...new Set(ln.units.flatMap((u) => u.scope || []))].sort(),
      est_tokens: Math.floor(ln.est_tokens),
      cwd: null, worktree: null, branch: `bb/${run_id}-${id.toLowerCase()}`,
      wave: 0, agent: agentName, model: laneModel(ln.units, cfg),
      // A lane whose one unit is most of the window will spill into a second
      // context; two slots keeps the wave from over-committing the box.
      slots: ln.units.some((u) => u.est_tokens > ceiling * 0.6) ? 2 : 1,
      status: "planned",
    };
  });
  assignCheckouts(out);
  const waves = schedule(out, maxPar, slotsTotal());
  return { run_id, lanes: out, local, waves, agent: agentName, max_parallel: maxPar,
    budget: { floor, ceiling, overhead, slots_total: slotsTotal() } };
}

/** Two 90k lanes in one repo are one 180k lane and one priming cost instead of
 *  two. Smallest pairs first, never past the ceiling. */
export function mergeUnderfilled(lanes, floor, ceiling, overhead) {
  const byRepo = new Map();
  for (const ln of lanes) { if (!byRepo.has(ln.repo)) byRepo.set(ln.repo, []); byRepo.get(ln.repo).push(ln); }
  const merged = [];
  for (const [repo, group] of byRepo) {
    const pool = [...group].sort((x, y) => x.est_tokens - y.est_tokens);
    while (pool.length >= 2 && pool[0].est_tokens < floor) {
      const a = pool.shift(), c = pool.shift();
      const joined = a.est_tokens + c.est_tokens - overhead;
      if (joined > ceiling) { merged.push(a); pool.unshift(c); continue; }
      pool.push({ units: [...a.units, ...c.units], est_tokens: joined, repo });
      pool.sort((x, y) => x.est_tokens - y.est_tokens);
    }
    merged.push(...pool);
  }
  return merged;
}

function gitState(dir) {
  if (!gitOk(dir)) return { exists: false, dirty: null };
  const r = git(["status", "--porcelain"], dir);
  return { exists: true, dirty: r.rc === 0 ? r.out.split("\n").filter((l) => l.trim()).length : null };
}

/** One lane per repo may use the shared checkout, and only if it is clean.
 *
 *  Everything else gets a worktree. The router only PLANS the path; creating
 *  it is the runner's job, because a plan that has already mutated the repo is
 *  a plan you cannot look at before agreeing to it. A shared-checkout lane
 *  edits the branch that is already checked out, so it gets no branch of its
 *  own and a warning saying so. */
export function assignCheckouts(lanes) {
  const usedShared = new Set();
  const states = new Map();
  for (const ln of lanes) {
    const repoAbs = ln.repo === "." ? ROOT : abs(ln.repo);
    if (!states.has(ln.repo)) states.set(ln.repo, gitState(repoAbs));
    const g = states.get(ln.repo);
    if (!g.exists) {
      // No git: nothing to isolate with. Every lane shares the tree and the
      // scheduler keeps them out of one wave (same cwd), so they run in turn.
      ln.cwd = repoAbs; ln.worktree = null; ln.branch = null;
      ln.warning = `${ln.repo} is not a git repository: no worktree, no branch, lanes here run one at a time`;
      continue;
    }
    const clean = g.dirty === 0;
    if (clean && !usedShared.has(ln.repo)) {
      usedShared.add(ln.repo);
      ln.cwd = repoAbs; ln.worktree = null; ln.branch = null;
      ln.warning = `uses the shared checkout of ${ln.repo}; edits land on the current branch`;
      continue;
    }
    const leaf = ln.branch.split("/").pop();
    ln.worktree = path.join(`${repoAbs}.worktrees`, leaf);
    ln.cwd = ln.worktree;
    ln.needs_worktree = true;
    if (!clean) ln.dirty_reason = g.dirty == null ? `git status failed in ${ln.repo}` : `${g.dirty} uncommitted files in ${ln.repo}`;
  }
}

/** Waves. Slots are a budget; parallelism is a cap; a file and a checkout are
 *  exclusive. Greedy in lane order, which is size order, so the biggest lane
 *  starts first and the tail of the run is the short lanes. */
export function schedule(lanes, maxParallel, slots) {
  const waves = [];
  let pending = [...lanes];
  let w = 0;
  while (pending.length) {
    w++;
    const wave = [], rest = [];
    let usedSlots = 0;
    const usedFiles = new Set(), usedCwd = new Set();
    for (const ln of pending) {
      const files = ln.files || [];
      const blocked = wave.length >= maxParallel
        || usedSlots + ln.slots > Math.max(slots, 1)
        || files.some((p) => usedFiles.has(p))
        || usedCwd.has(ln.cwd);
      if (blocked) { rest.push(ln); continue; }
      wave.push(ln); usedSlots += ln.slots; files.forEach((p) => usedFiles.add(p)); usedCwd.add(ln.cwd);
    }
    if (!wave.length) wave.push(rest.shift());  // nothing schedulable: force one through
    for (const ln of wave) ln.wave = w;
    waves.push(wave.map((ln) => ln.id));
    pending = rest;
  }
  return waves;
}

/** Lanes without their embedded units: enough to rehydrate from the units store. */
export const persistable = (ln) => { const { units, ...rest } = ln; return rest; };

export function report(p) {
  const lines = [`  run ${p.run_id}   floor ${human(p.budget.floor)}  ceiling ${human(p.budget.ceiling)}  overhead ${human(p.budget.overhead)}  slots ${p.budget.slots_total}  agent ${p.agent}`];
  if (p.local.length) {
    lines.push(`  ${p.local.length} unit(s) close LOCALLY — no session, no tokens:`);
    for (const u of p.local) lines.push(`      ${String(u.actuator || "local").padEnd(20)} ${u.title}`);
  }
  if (!p.lanes.length) { lines.push("  no lanes"); return lines.join("\n"); }
  lines.push(`  ${"lane".padEnd(5)} ${"ctx".padStart(7)} ${"model".padEnd(8)} ${"slots".padStart(5)} ${"wave".padStart(4)}  checkout`);
  for (const ln of p.lanes) {
    const ck = ln.worktree ? `worktree ${path.basename(ln.worktree)}` : `shared ${ln.repo}`;
    lines.push(`  ${ln.id.padEnd(5)} ${human(ln.est_tokens).padStart(7)} ${(ln.model || "-").padEnd(8)} ${String(ln.slots).padStart(5)} ${String(ln.wave).padStart(4)}  ${ck}`);
    for (const u of ln.units) lines.push(`      · ${u.title}`);
    if (ln.warning) lines.push(`      ! ${ln.warning}`);
  }
  lines.push(`  waves: ${p.waves.map((w) => w.join(",")).join(" | ")}   (ESTIMATE: ctx is projected, not measured)`);
  const over = p.lanes.filter((ln) => ln.est_tokens > p.budget.ceiling).length;
  const under = p.lanes.filter((ln) => ln.est_tokens < p.budget.floor).length;
  if (over) lines.push(`  ! ${over} lane(s) over the ceiling — they will compact`);
  if (under) lines.push(`  · ${under} lane(s) under the floor — unavoidable, nothing left to merge them with`);
  return lines.join("\n");
}
