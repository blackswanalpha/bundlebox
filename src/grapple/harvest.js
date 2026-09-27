// harvest.js — labels nobody was asked for.
//
// Two sources, both free. Closures: a contested row that resolved with a
// `closed_by` git or the witness could prove is a label today, at zero
// questions. Survival: a contested row that is still open is NOT a negative
// because it was seen 185 times — at 48 scans a day that is four days, and
// four days is not evidence. It is a negative only when somebody was in the
// file, changed it, and left the finding: survival CONDITIONED on the path
// being edited in the window. That is what git can prove, and the row with no
// commit on its path in the window gets no label at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, PKG_ROOT } from "../core/paths.js";
import { now } from "../core/util.js";
import * as core from "../core/store.js";
import * as gs from "./store.js";

export const MIN_LABELS = 10;             // below this the harvest reports `unknown`, never a rate
export const BACKFILL = "grapple-backfill";   // .bundlebox/var/grapple-backfill.json
export const PRIORS = "grapple-priors";       // .bundlebox/var/grapple-priors.json
export const SHIPPED = () => path.join(PKG_ROOT, "expert", "bundlebox_expert", "priors.json");

/** One `git log --name-only` since the earliest date asked about, then every
 *  `(since, file)` question is answered from memory. One call for a board of
 *  two hundred rows rather than two hundred calls, which is the difference
 *  between a session-end pass and a session-end stall. Returns a counter with
 *  the same shape the tests inject; -1 means git could not answer. */
export function gitCounter(minSince) {
  let commits = null;
  const load = () => {
    if (commits) return commits;
    try {
      const args = ["log", "--format=%x00%cI", "--name-only", "--since", String(minSince || "1970-01-01")];
      const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      commits = [];
      for (const block of out.split("\0")) {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        if (!lines.length) continue;
        commits.push({ at: Date.parse(lines[0]) || 0, files: new Set(lines.slice(1)) });
      }
    } catch { commits = -1; }           // no git, no history: unknown, never a guess
    return commits;
  };
  return (since, file) => {
    const c = load();
    if (c === -1) return -1;
    const t = Date.parse(since) || 0;
    let n = 0;
    for (const k of c) if (k.at >= t && k.files.has(file)) n += 1;
    return n;
  };
}
const earliest = (rows) => rows.map((f) => f.first_seen).filter(Boolean).sort()[0] || "";

/** Closures the box can already explain. `unknown` is skipped: a label the
 *  data has not made is worse than a missing one. */
export function closures(rows) {
  const out = [];
  for (const f of rows) {
    if (f.status === "open" || f.precision !== "heuristic") continue;
    const by = f.closed_by || "unknown";
    if (by === "unknown") continue;
    out.push({ id: f.id || core.findingId(f), detector: f.detector, path: f.path || f.key, label: by === "acted_on" ? "defect" : by === "unchanged" ? "not-a-defect" : "vanished", source: `closure:${by}`, confidence: by === "acted_on" ? 0.8 : 0.6 });
  }
  return out;
}

/** Edit-conditioned survival. `count(since, file)` is git by default and is
 *  injected by the tests; -1 means git could not answer and the row is left. */
export function survival(rows, { count = gitCounter(earliest(rows)), at = now() } = {}) {
  const out = [];
  let unanswerable = 0;
  for (const f of rows) {
    if (f.status !== "open" || f.precision !== "heuristic" || !f.first_seen) continue;
    const p = f.path || (Array.isArray(f.files) ? f.files[0] : "");
    if (!p) continue;
    const n = count(f.first_seen, p);
    if (n < 0) { unanswerable += 1; continue; }
    if (n === 0) continue;                                    // nobody was in the file: no evidence either way
    out.push({ id: f.id || core.findingId(f), detector: f.detector, path: p, label: "not-a-defect", source: "survived-edit", commits: n, seen_count: f.seen_count || 0, since: f.first_seen, at, confidence: Math.min(0.9, 0.5 + 0.1 * n) });
  }
  return { labels: out, unanswerable };
}

/** One label per finding. A row can be reached by an answer, a closure, the
 *  backfill and survival at once; counting it four times is four labels from
 *  one fact, and the floor exists to refuse exactly that. The most direct
 *  source wins: a person's answer, then a proven closure, then history, then
 *  survival. */
export function dedupe(labels) {
  const rank = (l) => (String(l.source).startsWith("answer:") ? 0 : String(l.source).startsWith("closure:") ? 1 : String(l.source).startsWith("backfill:") ? 2 : 3);
  const best = new Map();
  for (const l of labels) {
    const id = l.id || `${l.detector}|${l.path}`;
    const cur = best.get(id);
    if (!cur || rank(l) < rank(cur)) best.set(id, l);
  }
  return [...best.values()];
}

/** Run both, write the corpus, report the count with its `n`. */
export function run({ rows = core.get("findings", []), count = gitCounter(earliest(rows)), minLabels = MIN_LABELS, backfilled = stored(), answered = answeredLabels() } = {}) {
  const c = closures(rows);
  const s = survival(rows, { count });
  const raw = c.length + s.labels.length + backfilled.length + answered.length;
  const labels = dedupe([...c, ...s.labels, ...backfilled, ...answered]);
  const contested = rows.filter((f) => f.precision === "heuristic");
  const byLabel = {};
  for (const l of labels) byLabel[l.label] = (byLabel[l.label] || 0) + 1;
  const n = labels.length;
  const report = {
    at: now(), n, raw, deduplicated: raw - n, contested: contested.length, closures: c.length, survived_edit: s.labels.length, backfilled: backfilled.length, answered: answered.length, git_unanswerable: s.unanswerable, by_label: byLabel,
    // A rate below the floor is `unknown`: ten labels cannot fit a policy and
    // a number printed anyway would be quoted as one.
    defect_rate: n >= minLabels ? Math.round(((byLabel.defect || 0) / n) * 1000) / 1000 : "unknown",
    floor: minLabels,
  };
  gs.writeJsonOut("harvest.json", { ...report, labels });
  gs.writeText("harvest.md", [
    "# grapple — harvested labels", "",
    `n = ${n} label(s) over ${contested.length} contested row(s), one per row (${raw - n} duplicate(s) folded): ${c.length} from closures, ${s.labels.length} from edit-conditioned survival (${s.unanswerable} row(s) git could not answer), ${backfilled.length} from the git backfill, ${answered.length} from answered questions.`,
    `defect rate: ${report.defect_rate}${report.defect_rate === "unknown" ? ` (floor ${minLabels})` : ""}`, "",
    "| label | n |", "|---|---|", ...Object.entries(byLabel).map(([k, v]) => `| ${k} | ${v} |`), "",
  ].join("\n"));
  gs.record("harvested", { n, closures: c.length, survived_edit: s.labels.length, backfilled: backfilled.length, answered: answered.length });
  return { ...report, labels };
}

// ── C1: the backfill from git, before grapple ever ran ──────────────────────
//
// Run the detectors at an old commit and ask git what happened to each
// contested row since. The thirty-minute closure windows #45 rejected were
// blind because work sits uncommitted for hours; over months the blind spot
// mostly closes, and a repository with history yields labels on turn one.
//
// The same refusal as `survival`: a row that is gone today with no commit on
// its path is the detector's inputs moving, not a fix, and gets no label.

/** The labels answers produced (`ask.answer` writes them), or none. Read off
 *  the document rather than imported, because ask.js imports this file. */
export function answeredLabels() {
  const d = core.get("grapple-labels", null);
  return d && Array.isArray(d.labels) ? d.labels.filter((l) => l.detector !== "brief") : [];
}

/** The backfill labels on disk, or none. */
export function stored() {
  const d = core.get(BACKFILL, null);
  return d && Array.isArray(d.labels) ? d.labels : [];
}

/** The contested rows the detectors report at `rev`: a detached worktree, one
 *  child `bb scan --json` over it, then the worktree is removed. Returns null
 *  when git or the scan cannot answer. */
export function scanAt(rev, { log = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-backfill-"));
  try {
    const a = spawnSync("git", ["worktree", "add", "--detach", dir, rev], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    if (a.status !== 0) { log(`worktree: ${String(a.stderr || "").trim().slice(0, 160)}`); return null; }
    // stdout goes to a file, not a pipe: the CLI exits before a pipe drains a
    // payload past the 64k pipe buffer, and the JSON arrives cut mid-string.
    const outFile = path.join(dir, ".bundlebox-scan.json");
    const fd = fs.openSync(outFile, "w");
    let r;
    try { r = spawnSync(process.execPath, [path.join(PKG_ROOT, "bin", "bb.js"), "scan", "--json"], { cwd: dir, env: { ...process.env, BB_ROOT: dir }, encoding: "utf8", timeout: 900000, stdio: ["ignore", fd, "pipe"] }); }
    finally { fs.closeSync(fd); }
    if (r.status !== 0) { log(`scan: ${String(r.stderr || "").trim().slice(-160)}`); return null; }
    let d;
    try { d = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { log("scan: not JSON"); return null; }
    const rows = Array.isArray(d) ? d : (d && Array.isArray(d.findings) ? d.findings : []);
    return rows.filter((f) => f.precision === "heuristic").map((f) => ({ detector: f.detector, path: f.path || (Array.isArray(f.files) ? f.files[0] : ""), key: f.key || f.title, title: f.title, severity: f.severity }));
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the worktree remove took it */ }
  }
}

const revDate = (rev) => {
  try { return execFileSync("git", ["log", "-1", "--format=%cI", rev], { cwd: ROOT, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }  // unknown rev or no git: undated
};

/** Label each historical contested row by what git did to it since.
 *
 *    defect         gone from today's board, and a commit touched its path
 *    not-a-defect   still on today's board, and a commit touched its path
 *    (no label)     no commit touched its path: git cannot see the reason
 *    vanished       the path is gone from the tree
 *
 *  `then` and `today` are contested rows; `count(since, file)` is git by
 *  default and injected by the tests. */
export function labelBackfill(then, today, { count = gitCounter(since), since = "", rev = "", exists = (p) => fs.existsSync(path.join(ROOT, p)) } = {}) {
  const open = new Set(today.map((f) => `${f.detector}|${f.key || f.title}`));
  const out = [];
  let unanswerable = 0, unchanged = 0;
  for (const h of then) {
    if (!h.path) continue;
    const id = core.findingId(h);
    if (!exists(h.path)) { out.push({ id, detector: h.detector, path: h.path, label: "vanished", source: `backfill:${rev}`, confidence: 0.5 }); continue; }
    const n = count(since, h.path);
    if (n < 0) { unanswerable += 1; continue; }
    if (n === 0) { unchanged += 1; continue; }
    const still = open.has(`${h.detector}|${h.key || h.title}`);
    out.push({ id, detector: h.detector, path: h.path, label: still ? "not-a-defect" : "defect", source: `backfill:${rev}`, commits: n, confidence: Math.min(0.9, 0.5 + 0.1 * n) });
  }
  return { labels: out, unanswerable, unchanged };
}

/** The verb: scan at `rev`, label against today's board, store. */
export function backfill({ rev, scan = scanAt, count = null, today = core.get("findings", []).filter((f) => f.status === "open" && f.precision === "heuristic"), log = () => {} } = {}) {
  const since = revDate(rev);
  const then = scan(rev, { log });
  if (!then) return { rev, error: "could not scan at that revision", n: 0 };
  const r = labelBackfill(then, today, { count: count || gitCounter(since), since, rev });
  const doc = { rev, since, at: now(), then: then.length, labels: r.labels, unanswerable: r.unanswerable, unchanged: r.unchanged };
  core.put(BACKFILL, doc);
  gs.record("backfilled", { rev, then: then.length, n: r.labels.length });
  return { ...doc, n: r.labels.length };
}

// ── C2: a fitted prior per contested detector ───────────────────────────────
//
// The counts `for_rule` blends toward the method's base at
// `settled / (settled + SHRINKAGE)`: `held` is what the labels called a
// defect, `broken` what they called not one. A fresh workspace reads the
// shipped file; a workspace with a harvest fits its own and that one wins.
// `vanished` counts for neither: a deleted file says nothing about the rule.

export function fitPriors(labels) {
  const by = {};
  for (const l of labels) {
    if (l.label !== "defect" && l.label !== "not-a-defect") continue;
    const d = by[l.detector] || (by[l.detector] = { held: 0, broken: 0 });
    if (l.label === "defect") d.held += 1; else d.broken += 1;
  }
  for (const d of Object.values(by)) { d.n = d.held + d.broken; d.hold_rate = d.n ? Math.round((d.held / d.n) * 1000) / 1000 : null; }
  return by;
}

/** The priors `rank` reads: this workspace's fit when it has one, otherwise
 *  the file shipped in the package. `via` says which. */
export function priors() {
  const local = core.get(PRIORS, null);
  if (local && local.by && Object.keys(local.by).length) return { by: local.by, via: "local", at: local.at, from: local.from };
  try { const s = JSON.parse(fs.readFileSync(SHIPPED(), "utf8")); if (s && s.by) return { by: s.by, via: "shipped", at: s.at, from: s.from }; } catch { /* none shipped */ }
  return { by: {}, via: "none" };
}

/** Fit from the current harvest and store. `ship` also writes the package
 *  file, which is how a cold workspace gets a measured number. Not reachable
 *  from the CLI: `bb grapple` is a RECORDS verb and writes under .bundlebox/
 *  only; shipping is a maintainer copying `out/grapple/priors.json` in. */
export function fit({ labels = null, ship = false, from = ROOT } = {}) {
  const L = labels || run().labels;
  const by = fitPriors(L);
  const doc = { at: now(), from: path.basename(from), n: L.length, by };
  core.put(PRIORS, doc);
  gs.writeJsonOut("priors.json", doc);
  if (ship) fs.writeFileSync(SHIPPED(), JSON.stringify(doc, null, 2) + "\n");
  return { ...doc, shipped: ship };
}
