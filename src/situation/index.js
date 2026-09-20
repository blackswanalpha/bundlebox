// situation/index.js — `bb situation`: where this work stands, in one call.
//
// `bb echos` measured the habit this is aimed at. Over 26 recorded sessions on
// this box, 5,476 tool calls landed over 5,253 turns that made one: 1.04 calls
// per turn, worst session 452 over 452. Every turn is a full replay — the whole
// window is re-sent and re-read before the next fact arrives — so two
// independent questions asked in one turn cost one replay and asked apart cost
// two. At that ratio the cheapest available saving is not a faster verb, it is
// a verb that answers a whole SITUATION.
//
// Which situations, measured off the recorded command shapes rather than
// guessed. The consecutive pairs across those sessions:
//
//   git status → git diff     17, over 18 sessions that run each
//   git add → git commit      31, then → git log 18 more
//   git log → git branch      16
//
// Five reads, five round trips, one question: where does this work stand. This
// verb answers it once, out of artefacts already on disk plus one `git` call,
// and it costs 0 model tokens.
//
// `bb gates run` is the other half of the same argument and covers the other
// measured sequence (`npm run → npm test → npm run`, the most common three-
// command run of any kind here).
//
// Nothing below re-derives anything. The tree comes from git, the artefacts
// from `bb env`, the echos from the last `bb echos` run on disk and the work
// from the findings store, so a box with nothing reachable gets the same answer
// and a section whose input is missing SAYS so rather than printing nothing.
import { ROOT } from "../core/paths.js";
import { out, emit } from "../core/log.js";
import { human } from "../core/util.js";
import { git, gitOk } from "../core/exec.js";
import * as store from "../core/store.js";
import { branch, defaultBranch, dirtyFiles } from "../git/repo.js";
import { detectGates } from "../compile/compiler.js";
import * as env from "../env.js";
import * as echos from "../echos/index.js";

const lines = (s) => String(s || "").split("\n").filter(Boolean);

/** Branch, what is uncommitted, and what is committed but not pushed. One `git`
 *  invocation per fact and no parsing of porcelain that `repo.js` already
 *  parses. Returns `{ repo: false }` outside a work tree rather than throwing:
 *  a workspace that is not a git repo is a situation, not an error. */
export function tree(cwd = ROOT) {
  if (!gitOk(cwd)) return { repo: false };
  const br = branch(cwd);
  const base = defaultBranch(cwd);
  // `dirtyFiles` returns rows, not names; the status letter is worth keeping
  // because an untracked file and a modified one are different situations.
  let dirty = [];
  try { dirty = dirtyFiles(cwd); } catch { dirty = []; }   // a status that failed is not a clean tree
  // `--shortstat` over the working tree: the size of what is uncommitted, which
  // is the number `git diff` is usually being run to read.
  const stat = git(["diff", "--shortstat"], cwd).out.trim();
  const staged = git(["diff", "--cached", "--shortstat"], cwd).out.trim();
  // Ahead of the upstream, or of the base branch when there is no upstream: a
  // branch with commits nobody else can see is the thing `git log` was checking.
  const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  const against = up.rc === 0 ? up.out.trim() : (base && base !== br ? base : "");
  const ahead = against ? lines(git(["rev-list", "--count", `${against}..HEAD`], cwd).out.trim())[0] || "0" : null;
  const last = git(["log", "-1", "--format=%h %s"], cwd).out.trim();
  return { repo: true, branch: br, base, upstream: up.rc === 0 ? against : "", dirty: dirty.length,
    dirty_files: dirty.slice(0, 6).map((f) => `${f.status}:${f.path}`), diff: stat, staged, ahead: ahead === null ? null : Number(ahead), last };
}

/** The artefacts that are NOT ready, and the verb that would fix each. A row
 *  that is fine is a row nobody needs to read; the count carries it. */
export async function artefacts() {
  const r = await env.report();
  const rows = r.rows || r;
  const bad = rows.filter((x) => !x.present || x.ready === false);
  const stale = rows.filter((x) => x.present && x.ready !== false && Number(x.age_hours) > 24);
  return { total: rows.length, ready: rows.length - bad.length, bad, stale };
}

/** What the last `bb echos` run said about the work, hits first. Read from
 *  disk, never re-run: this verb is one call and re-deriving the stream here
 *  would make it the slowest one in the box. */
export function record() {
  const r = echos.latest();
  if (!r) return { ran: false };
  return { ran: true, at: r.at, engine: r.engine,
    hits: (r.echos || []).filter((e) => e.verdict === "hit"),
    unknown: (r.echos || []).filter((e) => e.verdict === "unknown").map((e) => e.id),
    locate: r.locate || null };
}

/** The work that is already located and budgeted, then what is merely open. A
 *  ready unit is a session's worth of work somebody already paid to pack. */
export function work() {
  const units = (store.get("units", []) || []).filter((u) => ["ready", "local"].includes(u.status));
  const open = store.openFindings();
  const bySeverity = {};
  for (const f of open) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return { units: units.length, local: units.filter((u) => u.status === "local").length,
    open: open.length, by_severity: bySeverity, top: units.slice(0, 5).map((u) => ({ id: u.id, title: u.title, est: u.est_tokens })) };
}

export async function situation({ cwd = ROOT } = {}) {
  return { at: new Date().toISOString(), tree: tree(cwd), gates: detectGates(cwd), artefacts: await artefacts(),
    record: record(), work: work() };
}

export function report(s) {
  const L = [];
  const t = s.tree;
  if (!t.repo) L.push("  tree        not a git work tree");
  else {
    L.push(`  branch      ${t.branch}${t.upstream ? ` → ${t.upstream}` : t.base && t.base !== t.branch ? `  base ${t.base}` : ""}${t.ahead ? `   ${t.ahead} commit(s) not pushed` : ""}`);
    L.push(`  uncommitted ${t.dirty} file(s)${t.diff ? `   ${t.diff}` : ""}${t.staged ? `   staged: ${t.staged}` : ""}`);
    if (t.dirty_files.length) L.push(`              ${t.dirty_files.join("  ")}${t.dirty > t.dirty_files.length ? `  +${t.dirty - t.dirty_files.length} more` : ""}`);
    if (t.last) L.push(`  last commit ${t.last}`);
  }
  const g = s.gates;
  L.push(`  gates       ${[g.quick, g.full].filter(Boolean).join("   ") || "none detected"}${g.quick || g.full ? "   (bb gates run)" : ""}`);

  const a = s.artefacts;
  L.push(`  artefacts   ${a.ready} of ${a.total} ready${a.stale.length ? `, ${a.stale.length} over a day old` : ""}`);
  for (const r of a.bad) L.push(`              missing  ${r.id.padEnd(12)} ${r.verb}`);
  for (const r of a.stale) L.push(`              ${String(r.age_hours).padStart(5)}h  ${r.id.padEnd(12)} ${r.verb}`);

  const w = s.work;
  L.push(`  work        ${w.units} unit(s) packed${w.local ? ` (${w.local} local)` : ""}, ${w.open} finding(s) open`);
  if (w.top.length) L.push(...w.top.map((u) => `              ${u.id}  ${human(u.est || 0).padStart(6)}  ${u.title}`));

  const r = s.record;
  if (!r.ran) L.push("  echos       never run here — `bb echos`. Not checked is not the same as nothing wrong.");
  else {
    L.push(`  echos       ${r.hits.length} hit(s)${r.unknown.length ? `, ${r.unknown.length} unknown (${r.unknown.join(", ")})` : ""}   ${String(r.at).slice(0, 16)}`);
    L.push(...r.hits.slice(0, 6).map((e) => `              ${e.id.padEnd(12)} ${String(e.detail).split(".")[0].slice(0, 96)}`));
    if (r.locate) L.push(`              locate       ${r.locate.verdict}, n=${r.locate.n} over ${r.locate.windows_scored} brief(s)`);
  }
  return L.join("\n");
}

export const commands = {
  situation: {
    help: "where this work stands: tree, gates, artefacts, packed work and what the echos saw (0 tokens)",
    usage: "bb situation [--json]",
    long: [
      "  Five questions a session asks separately, answered in one call.",
      "",
      "  Measured over the 26 sessions this workspace has recorded: `git status` and `git diff` are each",
      "  run by 18 of them and follow one another 17 times; `git log` follows `git commit` 22 times and",
      "  `git branch` follows `git log` 16 more. Pooled, those sessions made 5,476 tool calls over 5,253",
      "  turns that made one — 1.04 per turn. Every turn re-sends the whole window before the next fact",
      "  arrives, so five facts asked apart cost five replays and asked together cost one.",
      "",
      "  Nothing here is re-derived. The tree comes from git, the artefacts from `bb env`, the echos",
      "  from the last `bb echos` run on disk, the work from the findings store. A section whose input",
      "  is missing says so — `never run here` is not the same as nothing being wrong.",
    ].join("\n"),
    run: async ({ flags }) => {
      const s = await situation({});
      if (flags.json) { emit(s); return 0; }
      out(report(s));
      return 0;
    },
  },
};
