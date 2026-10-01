// occurred.js — when the thing a row is about happened, as distinct from when
// this box noticed it.
//
// Every finding already carries `first_seen`, and it is not the same fact. A
// detector that shipped on Tuesday reports a defect written in March as first
// seen on Tuesday; a scan that ran twice reports a service that fell over an
// hour ago as first seen twice. Ordering a case by `first_seen` orders the
// SCANS, which is why a case could say what belonged together and not what came
// first.
//
// Two sources can prove an occurrence and the rest cannot, so the rest get
// nothing. That is the whole discipline here: an undated row says it is undated
// and a case says how many of its rows it could place. Copying `first_seen`
// into `occurred_at` would make every row datable and every timeline a fiction,
// and from outside the two are indistinguishable.
//
//   git:last-touch      a row about a file. The last commit to touch that path
//                       is when the code this is about last changed, which is an
//                       UPPER BOUND: the defect existed at or before then, never
//                       after. One `git log` pass over the whole history, parsed
//                       once — 140 commits on this tree.
//   session:first-event a row about a session. Echos name theirs, and the event
//                       log has the turns. The session's first recorded event is
//                       when the work this row is about started.
//
// Nothing is written to the store. The derivation is cheap and re-runnable, and
// a field stored on a row is a field that goes stale the next time somebody
// commits — which for THIS field would be silently, since nothing re-reads it.
import { execFileSync } from "node:child_process";
import { ROOT } from "../core/paths.js";
import * as echos from "../echos/index.js";

const NONE = { at: null, via: "none" };

/** path -> ISO date of the last commit that touched it.
 *
 *  `--no-merges` because a merge commit touches every path in the branch and
 *  would date half the tree to the merge. `-z` is not used: the format is one
 *  path per line and a path with a newline in it is not a thing this tree has. */
export function touches({ root = ROOT, exec = execFileSync } = {}) {
  const map = new Map();
  let text = "";
  try {
    text = exec("git", ["log", "--no-merges", "--format=%x00%cI", "--name-only"],
      { cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return map; }   // no git, no history, a repo git refuses: no dates, never a guess
  let at = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("\0")) { at = line.slice(1).trim(); continue; }
    const p = line.trim();
    // Newest first, so the first time a path appears is its last touch.
    // Normalised to UTC: `%cI` carries the committer's offset, and two dates
    // with different offsets do not sort as strings however they compare as
    // instants — which is the one operation everything downstream does.
    if (p && at && !map.has(p)) { const t = Date.parse(at); if (t) map.set(p, new Date(t).toISOString()); }
  }
  return map;
}

/** session -> ISO date of its first recorded event. The caller reads the log;
 *  this is arithmetic over the rows, so a test hands it four of them. */
export function spans({ events = [] } = {}) {
  const map = new Map();
  for (const e of events || []) {
    const s = String(e.session || "");
    const at = Number(e.at) || 0;
    if (!s || !at) continue;
    const held = map.get(s);
    if (!held || at < held) map.set(s, at);
  }
  return new Map([...map].map(([s, at]) => [s, new Date(at).toISOString()]));
}

/** Everything the two sources need, gathered once for a whole board.
 *
 *  Synchronous, so `cases()` stays synchronous: an async clock would make the
 *  one verb that must be instant await two file reads it could have done. */
export function index({ root = ROOT } = {}) {
  let ev = [];
  try { ev = (echos.events({ limit: 0 }) || {}).events || []; }
  catch { ev = []; }   // no event log is a blind spot the caller reports, not an empty answer
  return { touched: touches({ root }), sessions: spans({ events: ev }) };
}

/** When the thing this row is about happened, and how that was proved.
 *
 *  `files` before `session` because a row that names both is about the file: an
 *  echo names no file and a detector names no session, so the order only
 *  decides a case nothing in this tree currently produces. */
export function occurredAt(f, { touched = new Map(), sessions = new Map() } = {}) {
  const paths = [f?.path, ...(Array.isArray(f?.files) ? f.files : [])]
    .map((p) => String(p || "").replace(/\\/g, "/")).filter((p) => p && p !== "." && p.includes("."));
  // The EARLIEST last-touch across the row's files: a row about two files is
  // about both, and the older one is the earliest this could have started.
  const dates = paths.map((p) => touched.get(p)).filter(Boolean).sort();
  if (dates.length) return { at: dates[0], via: "git:last-touch", bound: "upper" };

  const s = String(f?.evidence?.session || "");
  if (s && sessions.has(s)) return { at: sessions.get(s), via: "session:first-event", bound: "exact" };

  return { ...NONE, why: paths.length ? "git has no commit touching this row's files" : s ? "no recorded events for this row's session" : "this row names neither a tracked file nor a session" };
}
