// janitor/mark.js — liveness. Which of this heap did anything actually reach?
//
// A collector that sweeps by age alone deletes the one rule nobody has needed
// for eight months and the day after, somebody needs it. Age is not evidence.
// Reachability is, and the evidence is already on disk: every transcript
// records which files the sessions opened and which paths they wrote.
//
// So the mark phase is a real trace, not a heuristic:
//
//   roots       the paths and memory files sessions touched in the window,
//               each with the last time it was touched.
//   direct      an object whose anchor, or whose own source file, is a root.
//   transitive  an object a reached object links to. `[[wiki-links]]` in the
//               memory format are already edges; this pass walks them, so a
//               memory that is only ever reached through another memory is
//               reached, and one that nothing links to and nothing cites is
//               genuinely unreachable rather than merely quiet.
//
// Generational, because survival is information. Letta's sleep-time agents and
// every generational collector before them work on the same observation: an
// object that has survived collections is far more likely to survive the next.
// An object reached in this trace is promoted a generation; promotion raises
// the bar the sweep has to clear before it can touch it, so the things a team
// actually relies on become progressively harder to lose while the churn at the
// young end stays cheap to throw away.
//
// Zero tokens. Transcripts are files; this pass reads them and nothing else.
import path from "node:path";
import { GENERATIONS, HALF_LIFE, ageDays, diag, terms } from "./heap.js";

const nextGen = (g) => GENERATIONS[Math.min(GENERATIONS.length - 1, GENERATIONS.indexOf(g) + 1)] || "young";

/** The names an object answers to when something links to it: its frontmatter
 *  name, its source basename, and the basename without extension. */
function namesOf(o) {
  const out = new Set();
  if (o.meta && o.meta.name) out.add(String(o.meta.name).toLowerCase());
  if (o.source) {
    const b = path.basename(o.source);
    out.add(b.toLowerCase());
    out.add(b.replace(/\.[^.]+$/, "").toLowerCase());
  }
  return out;
}

/** Build the link graph once: name → ids, and id → the ids it points at. */
export function graph(objects) {
  const byName = new Map();
  for (const o of objects) for (const n of namesOf(o)) {
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(o.id);
  }
  const edges = new Map();
  const inDegree = new Map();
  for (const o of objects) {
    const targets = new Set();
    for (const r of o.refs || []) for (const id of byName.get(String(r).toLowerCase()) || []) if (id !== o.id) targets.add(id);
    edges.set(o.id, [...targets]);
    for (const t of targets) inDegree.set(t, (inDegree.get(t) || 0) + 1);
  }
  return { byName, edges, inDegree };
}

/** Mark in place. Returns what was reached, how, and the diagnostics for what
 *  was not. */
export function mark(objects, roots = { files: new Set(), at: new Map() }, { at = Date.now(), transitive = true } = {}) {
  const g = graph(objects);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const rootFiles = roots.files instanceof Set ? roots.files : new Set(roots.files || []);
  const rootAt = roots.at instanceof Map ? roots.at : new Map(Object.entries(roots.at || {}));

  // Basenames as well as full paths: a transcript records the absolute path a
  // session opened, and a memory line writes the workspace-relative one.
  const rootBase = new Map();
  for (const f of rootFiles) {
    const b = path.basename(String(f));
    const when = rootAt.get(f) || rootAt.get(b) || "";
    if (!rootBase.has(b) || rootBase.get(b) < when) rootBase.set(b, when);
  }
  const touchedAt = (p) => {
    if (!p) return null;
    const s = String(p);
    return rootAt.get(s) || rootBase.get(path.basename(s)) || (rootFiles.has(s) || rootBase.has(path.basename(s)) ? "" : null);
  };

  // ── direct ────────────────────────────────────────────────────────────────
  const queue = [];
  for (const o of objects) {
    const viaAnchor = o.anchor && o.anchor.file ? touchedAt(o.anchor.file) : null;
    const viaSource = touchedAt(o.source);
    const when = viaAnchor != null ? viaAnchor : viaSource;
    if (when == null) continue;
    o.reached = { at: when || o.learned_at, by: viaAnchor != null ? "anchor" : "source", hops: 0 };
    queue.push(o.id);
  }

  // ── transitive ────────────────────────────────────────────────────────────
  if (transitive) {
    let hops = 0;
    while (queue.length && hops < 8) {
      const layer = queue.splice(0, queue.length);
      hops++;
      for (const id of layer) {
        const from = byId.get(id);
        for (const t of g.edges.get(id) || []) {
          const o = byId.get(t);
          if (!o || o.reached) continue;
          o.reached = { at: from.reached.at, by: `link from ${id}`, hops };
          queue.push(t);
        }
      }
    }
  }

  // ── promote ───────────────────────────────────────────────────────────────
  // Survival is the only promotion criterion. A rule that has been reached is
  // moved out of reach of the age-out rules entirely.
  let promoted = 0;
  for (const o of objects) {
    if (!o.reached) continue;
    const g2 = nextGen(o.gen);
    if (g2 !== o.gen) { o.gen = g2; promoted++; }
    o.meta = { ...o.meta, survived: (Number(o.meta && o.meta.survived) || 0) + 1 };
  }

  // ── diagnostics ───────────────────────────────────────────────────────────
  const diags = [];
  for (const o of objects) {
    if (o.reached) continue;
    const hl = HALF_LIFE[o.kind];
    if (!Number.isFinite(hl)) continue;                    // rules are never stale for being quiet
    const age = ageDays(o, at);
    if (age < hl) continue;
    diags.push(diag(age > hl * 3 ? "warning" : "note", "unreached",
      `${o.kind} is ${Math.round(age)} days old, past its ${hl}-day half-life, and nothing in the window has reached it`, o,
      { age_days: Math.round(age), half_life: hl, fix: "let the sweep retract it, or link it from something that is used" }));
  }

  const reached = objects.filter((o) => o.reached).length;
  return {
    diags,
    inDegree: g.inDegree,
    stats: { total: objects.length, reached, unreached: objects.length - reached, promoted, roots: rootFiles.size },
  };
}

/** Roots from something other than a transcript — a file list, a git diff — so
 *  the trace can be run against a proposed change rather than history. */
export const rootsFrom = (files = [], at = new Date().toISOString()) => ({
  files: new Set(files.map(String)),
  terms: new Set(),
  at: new Map(files.map((f) => [String(f), at])),
});
