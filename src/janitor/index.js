// janitor/index.js — the driver, and the verbs.
//
// `bb janitor` is a compiler. Source: the four stores an agent's memory is
// smeared across. Target: one placed, budgeted, provenance-checked window
// image. Seven passes, in one order, each reading and writing the same IR:
//
//   parse      four stores  → typed objects                 (parse.js)
//   resolve    every anchor → live | drifted | dead          (resolve.js)
//   mark       transcripts  → reachability, promotion        (mark.js)
//   sweep      contradiction, quarantine, age-out            (sweep.js)
//   compact    type-aware merge; rules never rewritten       (compact.js)
//   place      rank, deal around the dead zone, pin rules    (place.js)
//   emit       WINDOW.md, HEAP.md, heap.jsonl, diagnostics   (emit.js)
//
// It is a compiler and not a cleanup script for one reason that shows up in
// every verb below: a cleanup script answers "is this tidy", and a compiler
// answers "does this build", which is a question with a failing answer. A rule
// whose file no longer exists is an ERROR. Two live rules that contradict each
// other is an ERROR, and neither is silently dropped. Everything else is a
// warning or a note, the counts drive the exit code, and a hook can act on it.
//
// Nothing here spends a token. Every input — markdown, transcripts, the var
// store, the symbol tables — is already on this disk.
//
// Exit codes: 0 clean · 10 warnings · 11 errors · 30 the compiler itself failed
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, abs, rel } from "../core/paths.js";
import { out, warn, emit as emitJson } from "../core/log.js";
import { human, table, pad } from "../core/util.js";
import { parse, AGENT_HOME } from "./parse.js";
import { resolve, resetCache, resetSymbols } from "./resolve.js";
import { mark, rootsFrom } from "./mark.js";
import { sweep } from "./sweep.js";
import { compact } from "./compact.js";
import { place, DEFAULT_BUDGET } from "./place.js";
import * as out_ from "./emit.js";
import * as warehouse from "./warehouse.js";
import { KINDS, HALF_LIFE, normalize, value } from "./heap.js";

export * as heap from "./heap.js";
export { parse } from "./parse.js";
export { resolve } from "./resolve.js";
export { mark } from "./mark.js";
export { sweep } from "./sweep.js";
export { compact, pinned } from "./compact.js";
export { place } from "./place.js";
export * as warehouse from "./warehouse.js";

export const CODES = { ok: 0, warn: 10, error: 11, failed: 30 };

/** Every pass, in order, with the numbers each one produced. This is the whole
 *  system; the verbs below are views of it. */
export async function build({
  stores = ["memory", "wiring", "transcripts", "var"],
  budget = DEFAULT_BUDGET, ageFactor = 3, near = 0.82, days = 120,
  root = ROOT, home = AGENT_HOME, rootFiles = null, at = Date.now(), allProjects = false,
} = {}) {
  resetCache(); resetSymbols();
  const passes = [];
  const diags = [];

  const p = await parse({ stores, root, home, days, allProjects });
  for (const e of p.errors) diags.push({ severity: "warning", code: "store-unreadable", message: `${e.store}: ${e.error}`, source: e.store, line: 0 });
  passes.push({ name: "parse", what: "four stores → typed objects", n: p.objects.length,
    detail: `${new Set(p.objects.map((o) => o.source)).size} sources, ${KINDS.map((k) => `${p.objects.filter((o) => o.kind === k).length} ${k}`).join(", ")}` });

  // A tombstone is remembered across runs, or every compile re-learns what the
  // last one retracted from the same unchanged file.
  const tombs = out_.knownTombstones();
  let resurrected = 0;
  for (const o of p.objects) {
    const t = tombs.get(o.id);
    if (t) { o.retracted_at = t.retracted_at; o.meta = { ...o.meta, retracted_why: t.why, from_tombstone: true }; resurrected++; }
  }
  if (resurrected) passes.push({ name: "recall", what: "retractions remembered from previous runs", n: resurrected, detail: "not re-learned" });

  const r = resolve(p.objects, { root });
  diags.push(...r.diags);
  passes.push({ name: "resolve", what: "anchors checked against the tree", n: p.objects.length,
    detail: `${r.counts.live} live, ${r.counts.drifted} drifted, ${r.counts.dead} dead, ${r.counts.uncheckable} uncheckable claims` });

  const roots = rootFiles ? rootsFrom(rootFiles) : p.roots;
  const m = mark(p.objects, roots, { at });
  diags.push(...m.diags);
  passes.push({ name: "mark", what: "reachability traced from what sessions touched", n: m.stats.reached,
    detail: `${m.stats.reached} reached of ${m.stats.total} from ${m.stats.roots} roots, ${m.stats.promoted} promoted` });

  const s = sweep(p.objects, { ageFactor, at });
  diags.push(...s.diags);
  passes.push({ name: "sweep", what: "contradiction, quarantine, age-out", n: s.stats.retracted + s.stats.quarantined,
    detail: `${s.stats.conflicts} conflicts, ${s.stats.quarantined} quarantined, ${s.stats.aged} aged out, ${human(s.stats.tokens_reclaimed)} tokens reclaimed` });

  const liveSet = s.objects.filter((o) => !o.retracted_at && !(o.meta && o.meta.quarantined));
  const c = compact(liveSet, { near });
  diags.push(...c.diags);
  passes.push({ name: "compact", what: "type-aware merge; rule and fact text never rewritten", n: c.stats.in - c.stats.out,
    detail: `${c.stats.exact} exact, ${c.stats.fused} fused, ${c.stats.folded} folded, ${c.stats.flagged} flagged unfused, ${human(c.stats.tokens_saved)} tokens saved` });

  const pl = place(c.objects, { budget, inDegree: m.inDegree, at });
  for (const o of pl.overflow) {
    diags.push({ severity: "error", code: "budget-overflow", id: o.id, source: o.source, line: o.line,
      message: `rules alone do not fit the ${budget}-token budget; this one was cut as the lowest-valued`,
      fix: "raise --budget, or delete rules until the ones left fit" });
  }
  passes.push({ name: "place", what: "ranked and dealt around the middle of the window", n: pl.stats.placed,
    detail: `${human(pl.stats.tokens)} of ${human(budget)} tokens, ${pl.stats.rules_pinned} rules pinned${pl.stats.lift ? `, ${pl.stats.lift}x edge lift` : ""}${pl.stats.dropped ? `, ${pl.stats.dropped} dropped` : ""}` });

  // The full heap for the record: survivors as compacted, plus everything the
  // sweep took out. A heap file that only holds the survivors cannot answer
  // why anything is missing.
  const kept = new Set(c.objects.map((o) => o.id));
  const objects = [...c.objects, ...s.objects.filter((o) => !kept.has(o.id))];

  return {
    objects, placed: pl.placed, diags, passes,
    roots,
    stats: {
      ...pl.stats,
      parsed: p.objects.length,
      tokens_reclaimed: s.stats.tokens_reclaimed + c.stats.tokens_saved,
      errors: diags.filter((d) => d.severity === "error").length,
      warnings: diags.filter((d) => d.severity === "warning").length,
      notes: diags.filter((d) => d.severity === "note").length,
      resolve: r.counts, mark: m.stats, sweep: s.stats, compact: c.stats,
    },
  };
}

const code = (b) => (b.stats.errors ? CODES.error : b.stats.warnings ? CODES.warn : CODES.ok);

// ── reporting ───────────────────────────────────────────────────────────────

function report(b, { verbose = false } = {}) {
  out("");
  out(table(b.passes.map((p) => [p.name, p.what, String(p.n), p.detail || ""]),
    { header: ["pass", "what it does", "n", "result"] }).split("\n").map((l) => "  " + l).join("\n"));
  out("");
  const st = b.stats;
  out(`  ${st.errors} errors · ${st.warnings} warnings · ${st.notes} notes`);
  out(`  window  ${human(st.tokens)} of ${human(st.budget)} tokens, ${st.placed} objects${st.lift ? `, ${st.lift}x more value at the edges than the middle` : ""}`);
  out(`  heap    ${st.parsed} parsed → ${b.objects.filter((o) => !o.retracted_at).length} live, ${human(st.tokens_reclaimed)} tokens reclaimed`);

  const hard = b.diags.filter((d) => d.severity !== "note");
  if (hard.length) {
    out("");
    for (const d of hard.slice(0, verbose ? 200 : 12)) {
      const mark_ = d.severity === "error" ? "E" : "W";
      out(`  ${mark_} ${d.code.padEnd(17)} ${String(d.source).slice(-46)}${d.line ? `:${d.line}` : ""}`);
      out(`    ${d.message}`);
      if (d.fix && verbose) out(`    fix: ${d.fix}`);
    }
    if (!verbose && hard.length > 12) out(`\n  ...${hard.length - 12} more. \`bb janitor --verbose\`, or read ${rel(path.join(out_.DIR(), "HEAP.md"))}`);
  }
  out("");
}

// ── prune: the only verb that touches a file a human wrote ──────────────────

/** Remove retracted single-line bullets from the markdown they came from.
 *
 *  Deliberately narrow. Only a bullet that is ONE line and whose text still
 *  matches the object exactly is removed, because the block parser records
 *  where a block starts and not where it ends, and a pass that guesses the end
 *  of a wrapped rule is a pass that eats half a sentence. Everything else is
 *  reported for a human. A file is backed up beside itself before it changes.
 */
export function prune(objects, { apply = false } = {}) {
  const want = new Map();
  for (const o of objects) {
    if (!o.retracted_at || (o.meta && o.meta.from_tombstone)) continue;
    if (!o.source || !/\.md$/i.test(o.source)) continue;
    if (!want.has(o.source)) want.set(o.source, []);
    want.get(o.source).push(o);
  }
  const plan = [];
  for (const [source, objs] of want) {
    // os.homedir(), not process.env.HOME: the latter is unset on Windows.
    const file = source.startsWith("~") ? path.join(os.homedir(), source.slice(1)) : abs(source);
    let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const targets = new Map(objs.map((o) => [normalize(o.text), o]));
    const cut = [];
    for (let i = 0; i < lines.length; i++) {
      const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
      if (!bullet) continue;
      const o = targets.get(normalize(bullet[1]));
      if (!o) continue;
      // Only when the bullet does not continue onto the next line.
      if (lines[i + 1] && /^\s+\S/.test(lines[i + 1]) && !/^\s*(?:[-*+]|\d+\.)\s/.test(lines[i + 1])) continue;
      cut.push({ line: i, text: lines[i], id: o.id, why: (o.meta && o.meta.retracted_why) || "" });
    }
    const unremovable = objs.filter((o) => !cut.some((c) => c.id === o.id));
    if (!cut.length && !unremovable.length) continue;
    plan.push({ source, file, cut, unremovable, before: lines.length, after: lines.length - cut.length });
    if (apply && cut.length) {
      const drop = new Set(cut.map((c) => c.line));
      try {
        fs.writeFileSync(`${file}.bak`, text);
        fs.writeFileSync(file, lines.filter((_, i) => !drop.has(i)).join("\n"));
      } catch (e) { plan[plan.length - 1].error = String(e && e.message || e); }
    }
  }
  return plan;
}

// ── verbs ───────────────────────────────────────────────────────────────────

const stores = (flags) => (flags.stores ? String(flags.stores).split(",").map((s) => s.trim()).filter(Boolean)
  : ["memory", "wiring", "transcripts", "var"]);
const opts = (flags) => ({
  stores: stores(flags),
  budget: Number(flags.budget) || DEFAULT_BUDGET,
  ageFactor: Number(flags.ageFactor) || 3,
  near: Number(flags.near) || 0.82,
  days: Number(flags.days) || 120,
  allProjects: !!flags.allProjects,
});

async function cmd({ _, flags }) {
  const sub = _[0] || "status";

  if (sub === "warehouse") {
    const s = warehouse.survey();
    const r = warehouse.build({ materialise: !!flags.materialise, query: String(flags.query || "") });
    if (flags.json) { emitJson({ survey: s, result: r, queries: Object.fromEntries(Object.entries(warehouse.QUERIES).map(([k, v]) => [k, v.what])) }); return r.ok ? 0 : CODES.warn; }
    out("");
    out(table(s.present.map((c) => [c.table, c.grain, c.key, String(c.rows || "—"), human(c.bytes)]),
      { header: ["view", "one row is", "key", "rows", "bytes"] }).split("\n").map((l) => "  " + l).join("\n"));
    if (s.unclassified.length) {
      out(`\n  unclassified — on disk, no declared grain, therefore not queryable:`);
      for (const u of s.unclassified) out(`    ${pad(u.file, 28)} ${human(u.bytes)}  last written ${u.mtime.slice(0, 16)}`);
    }
    out(`\n  schema  ${rel(r.sql)}`);
    if (!r.ok) { out(`  ${r.why}`); return CODES.warn; }
    out(`  db      ${rel(r.db)}`);
    if (r.rows) out("\n" + r.rows.split("\n").map((l) => "  " + l).join("\n"));
    out(`\n  queries: ${Object.keys(warehouse.QUERIES).join(", ")}  —  \`bb janitor warehouse --query rot\``);
    out("");
    return 0;
  }

  let b;
  try { b = await build(opts(flags)); }
  catch (e) { warn(`janitor failed: ${String(e && e.stack || e).split("\n").slice(0, 3).join(" ")}`); return CODES.failed; }

  if (sub === "heap") {
    const kind = String(flags.kind || "");
    const store = String(flags.store || "");
    let rows = b.objects.filter((o) => (!kind || o.kind === kind) && (!store || (o.meta && o.meta.store) === store));
    if (!flags.all) rows = rows.filter((o) => !o.retracted_at);
    rows.sort((a, z) => value(z) - value(a));
    if (flags.json) { emitJson({ objects: rows.slice(0, Number(flags.limit) || 500) }); return code(b); }
    out("");
    out(table(rows.slice(0, Number(flags.limit) || 40).map((o) => [
      o.id, o.kind, o.gen, o.resolution, o.reached ? "reached" : "—",
      String(o.tokens || 0), `${String(o.source).slice(-34)}${o.line ? `:${o.line}` : ""}`, o.text.slice(0, 54),
    ]), { header: ["id", "kind", "gen", "anchor", "reach", "tok", "source", "text"] }).split("\n").map((l) => "  " + l).join("\n"));
    out(`\n  ${rows.length} objects. \`bb janitor explain <id>\` for one.\n`);
    return code(b);
  }

  if (sub === "explain") {
    const id = String(_[1] || "");
    const o = b.objects.find((x) => x.id === id || x.id.startsWith(id));
    if (!o) { warn(`no object ${id}. \`bb janitor heap\``); return CODES.failed; }
    const ds = b.diags.filter((d) => d.id === o.id);
    if (flags.json) { emitJson({ object: o, diagnostics: ds }); return 0; }
    out("");
    out(`  ${o.id}  ${o.kind}  generation ${o.gen}`);
    out(`  ${o.text}`);
    out("");
    out(`  from        ${o.source}${o.line ? `:${o.line}` : ""}  (${(o.meta && o.meta.store) || "?"})`);
    out(`  anchor      ${o.anchor ? `${o.anchor.file || o.anchor.symbol || o.anchor.url} → ${o.resolution}${(o.meta && o.meta.resolution_why) ? ` (${o.meta.resolution_why})` : ""}` : "none — nothing can check this claim"}`);
    out(`  learned     ${o.learned_at}${o.valid_from !== o.learned_at ? `, valid from ${o.valid_from}` : ""}`);
    out(`  half-life   ${Number.isFinite(HALF_LIFE[o.kind]) ? `${HALF_LIFE[o.kind]} days` : "never ages out"}`);
    out(`  reached     ${o.reached ? `${o.reached.at || "yes"} by ${o.reached.by}` : "no — nothing in the window has touched it"}`);
    out(`  retracted   ${o.retracted_at ? `${o.retracted_at} — ${(o.meta && o.meta.retracted_why) || ""}` : "no"}`);
    if (o.meta && o.meta.quarantined) out(`  quarantined ${o.meta.quarantined}`);
    if (o.meta && o.meta.also_at) out(`  also at     ${o.meta.also_at.join(", ")}`);
    if (o.refs && o.refs.length) out(`  links to    ${o.refs.join(", ")}`);
    out(`  value       ${value(o).toFixed(3)}`);
    if (ds.length) { out(""); for (const d of ds) out(`  ${d.severity === "error" ? "E" : d.severity === "warning" ? "W" : "N"} ${d.code}: ${d.message}`); }
    out("");
    return 0;
  }

  if (sub === "prune") {
    const plan = prune(b.objects, { apply: !!flags.apply });
    if (flags.json) { emitJson({ plan, applied: !!flags.apply }); return code(b); }
    out("");
    if (!plan.length) { out("  nothing to prune: no retracted object maps to a removable line.\n"); return code(b); }
    for (const f of plan) {
      out(`  ${f.source}  ${f.before} → ${f.after} lines`);
      for (const c of f.cut.slice(0, 8)) out(`    - ${c.text.trim().slice(0, 88)}`);
      if (f.cut.length > 8) out(`    ...${f.cut.length - 8} more`);
      if (f.unremovable.length) out(`    ${f.unremovable.length} retracted but wrapped across lines — left alone, remove by hand`);
      if (f.error) out(`    ! ${f.error}`);
    }
    const cuts = plan.reduce((a, f) => a + f.cut.length, 0);
    out(flags.apply ? `\n  ${cuts} lines removed from ${plan.length} files. Originals are beside them as .bak\n`
      : `\n  DRY RUN — ${cuts} lines from ${plan.length} files. \`bb janitor prune --apply\` to write, originals kept as .bak\n`);
    return code(b);
  }

  // status | compile
  const applying = sub === "compile" || !!flags.apply;
  const e = out_.emit({ objects: b.objects, placed: b.placed, diags: b.diags, passes: b.passes, stats: b.stats, apply: applying });

  if (flags.json) { emitJson({ ...b.stats, diagnostics: b.diags, emitted: e }); return code(b); }
  report(b, { verbose: !!flags.verbose });
  if (sub === "compile") {
    out(`  wrote ${rel(e.dir)}/ — WINDOW.md (${human(e.window_tokens)} tokens), HEAP.md, heap.jsonl, diagnostics.json`);
    if (e.tombstoned) out(`  ${e.tombstoned} retractions recorded; they will not be re-learned`);
    out("");
  } else {
    out(`  read-only. \`bb janitor compile\` to write the window, \`bb janitor prune\` to clean the sources.\n`);
  }
  return code(b);
}

export const commands = {
  janitor: {
    help: "compile the agent's memory: check every anchor, sweep what rotted, place what survives",
    usage: "bb janitor [status|compile|heap|explain <id>|prune|warehouse] [--budget N] [--age-factor N] [--stores a,b] [--verbose] [--json]",
    long: [
      "  bb janitor                     what is in the heap, what rotted, what a compile would reclaim",
      "  bb janitor compile             run every pass and write WINDOW.md, the placed image an agent loads",
      "  bb janitor heap --kind rule    the objects, ranked by what they are worth in a window",
      "  bb janitor explain <id>        one object: where it came from, whether its anchor still resolves,",
      "                                 what reached it, why it was retracted",
      "  bb janitor prune [--apply]     remove retracted lines from the markdown they came from (.bak kept)",
      "  bb janitor warehouse           a DuckDB schema over the var store, in place. --query rot|reclaim|",
      "                                 half_life|dead_weight|cost_of_rot|growth  --materialise for Parquet",
      "",
      "Seven passes: parse → resolve → mark → sweep → compact → place → emit.",
      "  resolve   every claim carrying a file:line or a symbol is checked against the tree as it is now.",
      "            A dead anchor is the shape most agent hallucination actually has: a true statement about",
      "            a tree that has moved, quoted with the confidence it earned when it was written.",
      "  mark      reachability traced from what the sessions actually opened, not from age. Survivors are",
      "            promoted a generation, which puts them further out of the sweep's reach.",
      "  sweep     contradicted claims are RETRACTED, never deleted — a deleted fact is re-learned from the",
      "            same bad source next week. Two conflicting rules are an error and neither is dropped.",
      "  compact   rule and fact text is never rewritten. Uniform summarisation loses 47% of safety rules in",
      "            one round and 90% in five (arXiv 2608.22752); only the rule needs its exact wording.",
      "  place     the window is not read uniformly, so position is allocated: highest value at the two ends,",
      "            lowest in the middle, rules in full at the head and recalled at the tail.",
      "",
      "Zero tokens: every input is already on this disk. Exit codes: 0 clean · 10 warnings · 11 errors · 30 failed.",
    ].join("\n"),
    run: cmd,
  },
};
