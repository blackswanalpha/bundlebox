// proofhouse.js — the checks whose subject is this box's own output.
//
// Every other view interrogates the system under test. This one interrogates
// the factory: the units it packed, the queue it built, the findings it left
// open. It exists because an unattended loop has nobody reading its artefacts,
// and the failure it is for looks exactly like health from outside. `bb
// mainboard gaps` reported "Agent: 62 unit(s) ready of 66" while fifty-nine of
// those were one fileless finding scoped to the whole repository — 6.9M
// projected tokens, every part verdict FITS. Nothing in the tree could say so.
//
// Four checks, and every one is arithmetic over an artefact already on disk:
// no scan, no probe, no model. What each reads is named in the evidence, so a
// row a reader disagrees with can be argued with rather than re-derived.
//
// A check that cannot look says so in `blind` instead of returning nothing.
// That is the whole point of putting this behind the view contract rather than
// beside it: a proofhouse reporting nothing wrong when it could not read the
// units is the same failure, one level up.
import { PLAN_ONLY } from "../actuators/_plan.js";

/** The bars, as data with the reason each one is where it is.
 *
 *  Absolute rather than relative to this tree's own history, and deliberately:
 *  the history is the thing under test. A bar fitted to what the factory has
 *  been producing would have called fifty-nine units of one finding normal,
 *  because by then it was. */
export const BARS = {
  /** A unit is supposed to be a located scope. Past this share of the tree it
   *  is a directory listing with a title on it, whatever its verdict says. */
  scope_share: 0.15,
  /** One detector owning the queue is not a busy factory, it is one finding
   *  wearing every hat. */
  concentration: 0.5,
  /** Under this many units a concentration share is arithmetic on noise: two
   *  units of one detector is 100% and means nothing. */
  min_units: 4,
  /** A finding a free actuator could have closed, still open this long, is a
   *  `bb fix --apply` nobody ran. Three days is two cron days plus a weekend
   *  edge, not a measurement. */
  stuck_days: 3,
  /** How many ids a row names before the list stops being evidence and starts
   *  being the queue printed twice. */
  name_at_most: 8,
};

const pct = (r) => `${Math.round(r * 100)}%`;
const days = (ms) => Math.round((ms / 86400000) * 10) / 10;

/** Every check, over artefacts the caller has already read.
 *
 *  Pure: the caller does the reading, so a test hands it rows rather than
 *  building a workspace, and the view stays the only thing that touches disk. */
export function check({ units = [], findings = [], universe = 0, now = Date.now() } = {}) {
  const out = [];
  const blind = [];
  const ready = units.filter((u) => u.status === "ready" || u.status === "local");
  const open = findings.filter((f) => f.status === "open");

  // ── 1. a unit scoped to the tree ──────────────────────────────────────────
  if (!universe) {
    blind.push("no code-file count: the symbol tables have not been built, so no unit's scope could be sized against the tree");
  } else {
    for (const u of ready) {
      const n = (u.scope || []).length;
      const share = n / universe;
      if (share < BARS.scope_share) continue;
      out.push({
        id: `PH-scope-${u.id}`, category: "FACTORY", severity: "high", kind: "investigate",
        title: `unit ${u.id} is scoped to ${pct(share)} of the tree — ${n} of ${universe} code files`,
        detail: `A unit names the files a session may edit. This one names ${n} of the ${universe} code files in the tree, which is not a located scope: it is what a finding with nothing to point at produces when something upstream hands it the whole workspace. The verdict says ${u.verdict} because ${u.projected} tokens fit a window, and fitting is not the same as being about something.`,
        evidence: { unit: u.id, detector: u.detector, scope_files: n, code_files: universe,
          share: Math.round(share * 1000) / 1000, verdict: u.verdict, projected: u.projected, title: u.title },
        fix_hint: "Find what gave this unit its scope. A finding with no `files` and a path that is a directory is the usual source; `bb explain` on any of its finding ids says which.",
      });
    }
  }

  // ── 2. one detector owning the queue ──────────────────────────────────────
  if (ready.length < BARS.min_units) {
    blind.push(`${ready.length} ready unit(s): under ${BARS.min_units} a concentration share is arithmetic on noise, so the queue was not checked for it`);
  } else {
    const by = new Map();
    for (const u of ready) by.set(u.detector, (by.get(u.detector) || 0) + 1);
    const [top, n] = [...by.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
    const share = n / ready.length;
    if (share > BARS.concentration) {
      out.push({
        id: `PH-concentration-${top}`, category: "FACTORY", severity: "medium", kind: "investigate",
        title: `${top} is ${pct(share)} of the ready queue — ${n} of ${ready.length} units`,
        detail: `A queue this concentrated is one finding split ${n} ways far more often than it is ${n} distinct pieces of work. Whatever a session opens next, it will open ${pct(share)} of the same thing.`,
        evidence: { detector: top, units: n, ready: ready.length, share: Math.round(share * 1000) / 1000,
          others: [...by.entries()].filter(([d]) => d !== top).map(([d, c]) => `${d}:${c}`).slice(0, BARS.name_at_most) },
        fix_hint: "Check whether those units carry the same finding ids. If they do, the split is upstream of the queue and the queue is reporting it faithfully.",
      });
    }
  }

  // ── 3. work that cannot be proved done ────────────────────────────────────
  const unproven = ready.filter((u) => u.unproven);
  if (unproven.length) {
    out.push({
      id: "PH-unproven-queue", category: "FACTORY", severity: "medium", kind: "investigate",
      title: `${unproven.length} of ${ready.length} ready unit(s) carry no acceptance command`,
      detail: "A unit with no acceptance has no way to come back green. Whatever a session does with it, the result is a claim, and the only thing that can contradict a claim is a command that runs.",
      evidence: { unproven: unproven.length, ready: ready.length,
        units: unproven.slice(0, BARS.name_at_most).map((u) => u.id), detectors: [...new Set(unproven.map((u) => u.detector))] },
      fix_hint: "Either the detector should carry an acceptance, or the directory these units touch has no declared gate — `bb gates --list` says which.",
    });
  }

  // ── 4. free closures nobody ran ───────────────────────────────────────────
  //
  // The one check that reads the clock. `first_seen` has been on every finding
  // since the store shipped and nothing has ever decided anything with it: an
  // hour old and four months old are the same row on every board in this tree.
  const dated = open.filter((f) => f.first_seen);
  if (!dated.length && open.length) {
    blind.push(`none of the ${open.length} open finding(s) carries a first_seen, so nothing could be aged`);
  } else {
    const stuck = dated.filter((f) => f.auto_fix && !PLAN_ONLY.has(f.auto_fix)
      && days(now - Date.parse(f.first_seen)) >= BARS.stuck_days);
    if (stuck.length) {
      const oldest = stuck.reduce((a, f) => (Date.parse(f.first_seen) < Date.parse(a.first_seen) ? f : a));
      out.push({
        id: "PH-stuck-actuated", category: "FACTORY", severity: "low", kind: "fix",
        title: `${stuck.length} finding(s) a free actuator could close have been open ${BARS.stuck_days}+ days`,
        detail: `Each of these names an actuator that edits, so closing them costs no model tokens and no lane. The oldest has been open ${days(now - Date.parse(oldest.first_seen))} days and has been re-seen ${oldest.seen_count || 1} time(s) without anything acting on it.`,
        evidence: { stuck: stuck.length, open: open.length, bar_days: BARS.stuck_days,
          oldest_days: days(now - Date.parse(oldest.first_seen)), oldest: oldest.id,
          actuators: [...new Set(stuck.map((f) => f.auto_fix))].slice(0, BARS.name_at_most) },
        fix_hint: "bb fix --apply closes these locally. A finding that survives it is one the actuator declined, and the reason is in the result.",
      });
    }
  }

  const ages = dated.map((f) => days(now - Date.parse(f.first_seen))).sort((a, b) => a - b);
  return {
    findings: out,
    blind,
    facts: {
      ready_units: ready.length, detectors: new Set(ready.map((u) => u.detector)).size,
      code_files: universe, open_findings: open.length,
      oldest_open_days: ages.length ? ages[ages.length - 1] : null,
      median_open_days: ages.length ? ages[Math.floor(ages.length / 2)] : null,
    },
  };
}
