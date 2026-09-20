// bench/gate.js — the ablation benchmark, wired to a decision.
//
// `bb bench run` already measures the one thing that matters about this whole
// factory: for a given task, does the packed brief cost less than a bare search
// and read? And it already prints the tasks where the answer is NO, because a
// bench that only publishes its wins is a table-shaped advertisement.
//
// What it did not do is act. A task that loses packed stayed routable, got
// packed again on the next run, and lost again — the measurement existed and
// changed nothing. This file is the other half:
//
//   losers()      the tasks the last run measured as packed-costs-more
//   verdictFor()  is THIS unit one of them, by scope overlap and by title
//   delta()       what the bench says a brief is worth, for the spend guard
//
// Two rules keep the gate from being worse than no gate.
//
//   1. A gate that cannot see evidence does not block. No run, a run older
//      than `bench.max_age_hours`, or a task the suite never covered, all
//      return `unknown` and pack normally. Blocking on silence would make
//      every fresh checkout unroutable.
//   2. The margin is a parameter and the verdict prints it. `bench.min_win_pct`
//      exists because a 1% win does not pay for the locate, and a threshold
//      nobody can see is an assertion.
import { load } from "../core/config.js";
// A cycle, and a deliberate one: `index.js` owns where a run is stored and this
// file owns what a run MEANS, so duplicating the path here to break it would
// put the same constant in two places. Nothing below runs at module scope, so
// the bindings are live by the time any of it is called.
import { latest, history } from "./index.js";
import { similarity as oneSimilarity } from "../janitor/heap.js";

const pct = (r) => Number(r.saved_pct) || 0;

/** Every measured task from the newest run, plus the tasks the stored history
 *  has seen. History is the tie-breaker: one run is one measurement, and a task
 *  that has lost three times in a row is a different claim from one that lost
 *  once on a tree that was mid-refactor. */
export function tasks({ cfg = load(), at = Date.now() } = {}) {
  const r = latest();
  if (!r) return { ok: false, why: "no bench run stored — `bb bench run`", rows: [], at: null };
  const ageH = (at - (Date.parse(r.at || "") || at)) / 3600000;
  const maxAge = Number(cfg.bench?.max_age_hours) || 336;
  if (ageH > maxAge) {
    return { ok: false, why: `the last bench run is ${Math.round(ageH)}h old (max ${maxAge}h); it is not evidence about this tree`, rows: [], at: r.at, age_hours: Math.round(ageH) };
  }
  return { ok: true, rows: (r.tasks || []).filter((t) => !t.error), at: r.at, suite: r.suite,
    age_hours: Math.round(ageH), runs: history({ limit: 40 }).length };
}

/** The tasks where packing is not worth it: packed cost more, or won by less
 *  than the margin. Both are "route this bare", and they are reported apart
 *  because they mean different things to somebody reading the table. */
export function losers({ cfg = load(), at = Date.now() } = {}) {
  const t = tasks({ cfg, at });
  if (!t.ok) return { ...t, lost: [], thin: [] };
  const margin = Number(cfg.bench?.min_win_pct) || 0;
  return {
    ...t,
    lost: t.rows.filter((x) => pct(x) <= 0),
    thin: t.rows.filter((x) => pct(x) > 0 && pct(x) < margin),
    margin,
  };
}

/** How much two tasks are the same task. One scorer for the whole box now
 *  (`janitor/heap.js`, prompt4.md W4): files first, because a bench task and a
 *  unit that touch the same files are about the same code whatever they are
 *  called; the title is the fallback for a unit with no scope yet. */
export const similarity = (a, b) => oneSimilarity({ files: a.files || [], title: a.title || "" }, { files: b.files || [], title: b.title || "" });

/** Two tasks are the same task past this overlap. Deliberately high: opting a
 *  unit out of packing on a loose match costs the window the brief would have
 *  saved, and the failure is silent. */
export const SAME = 0.5;

/** Should this unit be packed?
 *
 *  `pack: true` with a reason is the normal answer, including every case where
 *  there is no evidence — see rule 1. `pack: false` means the bench measured a
 *  task like this one and packing lost. */
export function verdictFor(unit, { cfg = load(), at = Date.now(), l = null } = {}) {
  if (cfg.bench?.gate === false) return { pack: true, verdict: "off", why: "bench.gate is off" };
  const L = l || losers({ cfg, at });
  if (!L.ok) return { pack: true, verdict: "unknown", why: L.why };
  const me = { files: unit.scope || unit.files || [], title: unit.title || "" };
  let best = null;
  for (const t of [...L.lost, ...L.thin]) {
    const s = similarity(me, { files: [...(t.bare_files || []), ...(t.packed_files_list || [])], title: t.title || t.id });
    if (!best || s > best.s) best = { s, t };
  }
  // A bench task carries counts, not file lists, in the stored shape; when it
  // does the match above is by title alone and that is stated, never hidden.
  if (!best || best.s < SAME) return { pack: true, verdict: "not-measured", why: `no bench task matches this one above ${SAME}`, nearest: best ? Math.round(best.s * 100) / 100 : 0 };
  const lost = pct(best.t) <= 0;
  return {
    pack: false, verdict: lost ? "loses" : "thin",
    why: lost
      ? `bench task \`${best.t.id}\` cost ${Math.abs(pct(best.t))}% MORE packed than bare (${L.at.slice(0, 10)}); routing this bare`
      : `bench task \`${best.t.id}\` saved only ${pct(best.t)}%, under the ${L.margin}% margin; routing this bare`,
    match: Math.round(best.s * 100) / 100, task: best.t.id, saved_pct: pct(best.t),
  };
}

/** Does this brief carry a measured bench delta?
 *
 *  The spend guard's question. A brief nobody benched is a brief whose value is
 *  asserted, and the whole argument for opening a session on it is that the
 *  packing paid for itself. `known: false` is the honest answer when the suite
 *  has never covered this work, and the guard says so rather than refusing. */
export function delta(unit, { cfg = load(), at = Date.now() } = {}) {
  const t = tasks({ cfg, at });
  if (!t.ok) return { known: false, why: t.why, saved_pct: null };
  const me = { files: unit.scope || unit.files || [], title: unit.title || "" };
  let best = null;
  for (const row of t.rows) {
    const s = similarity(me, { files: row.bare_files || [], title: row.title || row.id });
    if (!best || s > best.s) best = { s, row };
  }
  if (!best || best.s < SAME) return { known: false, why: `no bench task matches this unit above ${SAME}; \`bb bench init\` derives a suite from the open findings`, saved_pct: null, nearest: best ? Math.round(best.s * 100) / 100 : 0 };
  return { known: true, saved_pct: pct(best.row), task: best.row.id, match: Math.round(best.s * 100) / 100,
    bare: best.row.bare, packed: best.row.packed, at: t.at };
}
