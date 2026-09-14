// context.js — will this unit fit in one session, and if not, where does it cut?
//
// A work unit's context is four things stacked:
//
//     overhead   system prompt + tool schemas + the CLAUDE.md chain + memory index
//     brief      the compiled instructions and the pre-computed evidence
//     payload    every file in scope, read once
//     churn      the same files re-read after edits, tool results, test output
//
// `churn` is the term everyone forgets. A session that opens 60k of code does
// not hold 60k: it holds the file, the edited file, the analyzer output about
// the file, and the diff. Measured on real transcripts the multiplier sits near
// 2.4, which is the config default.
//
// The verdict is one of:
//
//     FITS     projected peak <= max_tokens, comfortably
//     TIGHT    inside max_tokens but past the point where compaction starts
//     SPLIT    over the ceiling, and the scope divides cleanly
//     HEAVY    over the ceiling and a single file is the reason
//
// SPLIT comes with the actual split: first-fit-decreasing over the file costs,
// respecting directory locality so the halves are still coherent units of work.
import path from "node:path";
import { load } from "../core/config.js";
import { human } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import * as anc from "./anchors.js";

// Past this fraction of the window the harness starts summarising, and a
// session that compacts mid-unit loses the evidence the compiler paid to
// assemble. `budget.tight_at` overrides; this is the fallback when unset.
export const TIGHT_AT = 0.78;
// What opening a session costs when nothing has been measured. Budgeting from
// zero overhead is how a plan that "fits" arrives already full, so the floor is
// the smallest figure observed on a lean session rather than zero.
export const OVERHEAD_FLOOR = 25000;

export const tightAt = (cfg = load()) => Number(cfg.budget.tight_at) || TIGHT_AT;

/** What opening a session here costs, in preference order: the caller, the
 *  MEASURED lean profile if lanes spawn lean, the calibrated interactive
 *  figure, then the observed floor.
 *
 *  The lean figure is the one that matters: `bb tokens profile --probe` runs a
 *  one-turn session under the exact flags `bb run` uses, so the budget is sized
 *  against the session the factory actually opens rather than against the
 *  interactive sessions a person happened to run in this workspace. */
export function overheadOf(override = null, cfg = load()) {
  if (override != null && Number.isFinite(Number(override))) return Number(override);
  const b = cfg.budget;
  const lean = Number(b.overhead_lean) || 0;
  if (lean && (cfg.lanes?.lean_session ?? true)) return lean;
  return Number(b.overhead_tokens) || OVERHEAD_FLOOR;
}

/** Output reserve by unit kind.
 *
 *  A flat reserve on every lane is window held back for output a table edit
 *  will never produce. `fix` writes a patch and a sentence; `investigate`
 *  writes an argument. Reserving the same for both is what pushes mechanical
 *  lanes over a ceiling they were nowhere near. */
export function reserveFor(kind, cfg = load()) {
  const b = cfg.budget;
  const byKind = b.reserve_by_kind || {};
  return Number(kind && byKind[kind] != null ? byKind[kind] : b.reserve_output) || 0;
}

/** Payload tokens one session can hold for a unit of `kind`, after everything
 *  fixed (overhead, this kind's reserve, the compaction margin) and before churn. */
export function capacity(kind = "", { overhead = null, brief = 0, cfg = load() } = {}) {
  const b = cfg.budget;
  const usable = b.max_tokens * tightAt(cfg) - overheadOf(overhead, cfg) - reserveFor(kind, cfg) - brief;
  return Math.max(1, Math.floor(usable / (Number(b.churn_factor) || 1)));
}

export function evaluate(scope, { brief = "", churn = null, overhead = null, anchors = null, kind = "" } = {}) {
  const cfg = load();
  const b = cfg.budget;
  const churnF = churn == null ? Number(b.churn_factor) : Number(churn);
  const over = overheadOf(overhead, cfg);
  const reserve = reserveFor(kind, cfg);

  const est = anchors && anchors.length ? anc.payload(scope, anchors) : estimate.files(scope || []);
  const briefTokens = estimate.text(brief || "", "prose");
  const payload = est.total;
  const projected = Math.floor(over + briefTokens + payload * churnF + reserve);

  const ceiling = Number(b.max_tokens) || 0;
  const floor = Number(b.min_tokens) || 0;
  const ratio = ceiling ? projected / ceiling : 0;
  const nFiles = Object.keys(est.files).length;

  let verdict;
  if (projected <= ceiling * tightAt(cfg)) verdict = "FITS";
  else if (projected <= ceiling) verdict = "TIGHT";
  else if (nFiles > 1) verdict = "SPLIT";
  else verdict = "HEAVY";

  const out = {
    verdict, projected, ceiling, floor,
    ratio: Math.round(ratio * 1000) / 1000,
    parts: { overhead: over, brief: briefTokens, payload, churn: Math.floor(payload * (churnF - 1)), reserve_output: reserve },
    files: est.files,
    missing: est.missing || [],
    headroom: ceiling - projected,
    anchored: est.anchored || [],
    payload_whole: est.whole_total ?? payload,
    payload_saved: est.saved || 0,
    // Under the floor is also a finding: a lane that will use a tenth of the
    // window paid the full priming cost for a tenth of a session. The router
    // reads `underfilled` and merges such units.
    underfilled: projected < floor,
  };
  if (verdict === "SPLIT") {
    const cap = Math.max(1, Math.floor((ceiling * tightAt(cfg) - over - reserve - briefTokens) / churnF));
    out.split = split(est.files, cap);
  }
  return out;
}

/** First-fit-decreasing bin pack with directory locality.
 *
 *  Plain FFD produces bins that are balanced and incoherent: half of one
 *  directory and half of another in one session, which costs more in
 *  orientation than it saves in tokens. So files are grouped by their parent
 *  directory first and the GROUP is packed; a group too big for one bin is
 *  broken, and only then by size.
 *
 *  `files` is {rel: tokens}; `cap` is payload tokens per bin. Returns [[rel]]. */
export function split(files, cap) {
  cap = Math.max(1, Number(cap) || 1);
  const groups = new Map();
  for (const [p, cost] of Object.entries(files || {})) {
    const dir = path.posix.dirname(p.replace(/\\/g, "/"));
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push([p, Number(cost) || 0]);
  }
  const items = [];
  for (const members of groups.values()) {
    const total = members.reduce((s, [, c]) => s + c, 0);
    if (total <= cap) items.push([total, members.map(([p]) => p)]);
    else for (const [p, c] of members.sort((x, y) => y[1] - x[1])) items.push([c, [p]]);
  }
  items.sort((x, y) => y[0] - x[0]);

  const bins = [];
  for (const [cost, paths] of items) {
    const bin = bins.find((bn) => bn.used + cost <= cap);
    if (bin) { bin.used += cost; bin.held.push(...paths); }
    else bins.push({ used: cost, held: [...paths] });
  }
  return bins.map((bn) => bn.held.sort());
}

/** One screen, no scrolling. The verdict is the last line on purpose. */
export function report(ev) {
  const p = ev.parts;
  const r = (s) => String(s).padStart(8);
  const lines = [
    `  overhead        ${r(human(p.overhead))}`,
    `  brief           ${r(human(p.brief))}`,
    `  payload         ${r(human(p.payload))}   (${Object.keys(ev.files).length} files`
      + (ev.payload_saved ? `, ${ev.anchored.length} anchored, ${human(ev.payload_saved)} skipped)` : ")"),
    `  churn           ${r(human(p.churn))}   (x${load().budget.churn_factor})`,
    `  output reserve  ${r(human(p.reserve_output))}`,
    `  ${"-".repeat(30)}`,
    `  projected peak  ${r(human(ev.projected))}   of ${human(ev.ceiling)}  (${Math.round(ev.ratio * 100)}%)`,
  ];
  if (ev.missing?.length) lines.push(`  missing         ${ev.missing.length} paths in scope do not exist`);
  if (ev.underfilled) lines.push(`  UNDERFILLED     below the ${human(ev.floor)} floor — merge this unit`);
  if (ev.split) {
    lines.push(`  split           ${ev.split.length} sessions:`);
    ev.split.forEach((part, i) => {
      const cost = part.reduce((s, f) => s + (ev.files[f] || 0), 0);
      lines.push(`                  ${i + 1}. ${String(part.length).padStart(3)} files, ${human(cost)} payload`);
    });
  }
  lines.push(`  VERDICT         ${ev.verdict}`);
  return lines.join("\n");
}
