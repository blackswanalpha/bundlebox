// mainboard/index.js — one board over every view, and one ledger under it.
//
//   bb mainboard          the board, read from the store. Free, no requests
//   bb mainboard run      run every view, then print the board
//   bb mainboard gaps     which stage of the pipeline does not hold, and the
//                         one command that closes it
//   bb mainboard check    the views and the taxonomy, with no server
//
// **There is deliberately no second findings file.** A finding in its own file
// is one `bb compile` cannot pack, `bb route` cannot budget and `bb fix` cannot
// close — which moves the work back into a session, the exact cost this tree
// exists to remove. Every view writes through `record()` into the same store
// the detectors write to, keyed so a re-run updates a row instead of filing a
// second one.
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import * as stages from "../pipeline/stages.js";
import { out, warn, emit, hr } from "../core/log.js";
import { now, pad, table, human } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import { VIEWS, view, CATEGORIES } from "./views.js";

const SEV = new Set(["critical", "high", "medium", "low", "info"]);
const TARGETS = new Set(["local", "mirror", "prod"]);

/** The one way a view files anything. Refuses what the board cannot mean:
 *  a finding with no evidence, an unknown category, an unknown severity, an
 *  unknown target, or an id that is not stable across runs. */
export function normalise(f, viewId) {
  const bad = [];
  if (!f || typeof f !== "object") return { bad: ["not an object"] };
  if (!f.id) bad.push("no id; a row that cannot be matched files a second copy on every run");
  if (!f.title) bad.push(`${f.id}: no title`);
  if (!f.evidence || typeof f.evidence !== "object" || !Object.keys(f.evidence).length)
    bad.push(`${f.id}: no evidence. A finding a reader cannot check is an opinion`);
  if (!CATEGORIES.includes(f.category)) bad.push(`${f.id}: category \`${f.category}\` is not in the taxonomy (${CATEGORIES.join(" ")})`);
  if (!SEV.has(f.severity)) bad.push(`${f.id}: severity \`${f.severity}\``);
  if (f.target && !TARGETS.has(f.target)) bad.push(`${f.id}: target \`${f.target}\` is not local|mirror|prod`);
  if (bad.length) return { bad };
  const detail = String(f.detail || "").slice(0, 1500);
  return { row: {
    detector: `mainboard:${viewId}`, severity: f.severity, precision: String(f.evidence?.static || "").length ? "heuristic" : "exact",
    title: f.title, path: f.case || f.id, files: f.files || [], key: f.id,
    detail, evidence: { ...f.evidence, view: viewId, category: f.category, target: f.target || "local", ...(f.refers ? { refers: f.refers } : {}) },
    fix_hint: f.fix_hint || (f.refers ? `The detail belongs to the \`${f.refers}\` view; that is where this is closed.` : ""),
    auto_fix: null, kind: f.kind || "investigate", est_tokens: estimateText(detail, "prose"),
  } };
}

export function record(viewId, findings) {
  const rows = [], bad = [];
  for (const f of findings || []) {
    const r = normalise(f, viewId);
    if (r.bad) bad.push(...r.bad); else rows.push(r.row);
  }
  store.mergeFindings(rows, { detectors: new Set([`mainboard:${viewId}`]) });
  return { recorded: rows.length, refused: bad };
}

export async function runViews({ only = "", base = "", corpusId = "", worldId = "", target = "local", budget = 0, runId = "" } = {}) {
  const want = only ? String(only).split(",").map((s) => s.trim()) : VIEWS.map((v) => v.id);
  const rows = [];
  for (const id of want) {
    const v = view(id);
    if (!v) { rows.push({ id, ran: false, skipped: "no such view" }); continue; }
    const t0 = Date.now();
    let r;
    try { r = await v.run({ base, corpusId, worldId, target, budget, runId }); }
    catch (e) { r = { ran: false, skipped: `the view itself failed: ${e.message}` }; }
    const seconds = (Date.now() - t0) / 1000;
    const rec = r.ran ? record(id, r.findings || []) : { recorded: 0, refused: [] };
    rows.push({ id, title: v.title, question: v.question, ...r, ...rec, seconds: Math.round(seconds * 10) / 10 });
    episodes.write({ kind: "stage", verb: "mainboard", stage: `mainboard:${id}`, run_id: runId,
      features: { view: id, ran: r.ran ? 1 : 0 }, rc: r.ran ? 0 : 1, seconds,
      produced: rec.recorded, produces: ["findings"], state: r.ran ? "ran" : "skipped",
      turns_saved: r.ran ? episodes.turns({ commands: 1, rows: rec.recorded * 4 }) : 0,
      detail: { skipped: r.skipped || null } });
  }
  return rows;
}

/** The board, read from the ledger. No requests, no views run. */
export function board() {
  const all = store.get("findings", []).filter((f) => String(f.detector || "").startsWith("mainboard:"));
  const open = all.filter((f) => f.status === "open");
  const byView = new Map();
  for (const v of VIEWS) byView.set(v.id, { id: v.id, title: v.title, question: v.question, open: [], resolved: 0 });
  for (const f of all) {
    const id = String(f.detector).slice("mainboard:".length);
    const b = byView.get(id) || { id, title: id, question: "", open: [], resolved: 0 };
    if (f.status === "open") b.open.push(f); else b.resolved += 1;
    byView.set(id, b);
  }
  return { views: [...byView.values()], open: open.length, total: all.length,
    by_category: open.reduce((a, f) => ({ ...a, [f.evidence?.category || "?"]: (a[f.evidence?.category || "?"] || 0) + 1 }), {}),
    by_severity: open.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {}) };
}

export function boardText(b, rows = null) {
  const L = [];
  for (const v of b.views) {
    const ran = rows?.find((r) => r.id === v.id);
    const mark = ran ? (ran.ran ? "" : `SKIP — ${ran.skipped}`) : "";
    L.push(`  ${pad(v.title, 13)} ${pad(v.open.length ? `${v.open.length} open` : "clear", 10)} ${pad(v.resolved ? `${v.resolved} closed` : "", 11)} ${mark || v.question}`);
    for (const f of v.open.slice(0, 5)) {
      L.push(`      ${pad(f.severity, 8)} ${pad(f.evidence?.category || "", 12)} ${f.title.slice(0, 84)}`);
      if (f.evidence?.refers) L.push(`               → ${f.evidence.refers} owns the detail`);
    }
    if (v.open.length > 5) L.push(`      … ${v.open.length - 5} more`);
  }
  L.push("", `  ${b.open} open of ${b.total} ever · ${Object.entries(b.by_severity).map(([k, n]) => `${n} ${k}`).join(" · ") || "nothing open"}`);
  if (Object.keys(b.by_category).length) L.push(`  ${Object.entries(b.by_category).sort((a, c) => c[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("  ")}`);
  return L.join("\n");
}

export function check() {
  const errors = [], warnings = [];
  const seen = new Set();
  for (const v of VIEWS) {
    if (seen.has(v.id)) errors.push(`duplicate view id ${v.id}`);
    seen.add(v.id);
    if (!v.question) errors.push(`${v.id}: no question; a view that cannot say what it asks is a view nobody reads`);
    for (const c of v.writes || []) if (!CATEGORIES.includes(c)) errors.push(`${v.id}: declares category \`${c}\`, which is not in the taxonomy`);
    if (typeof v.run !== "function") errors.push(`${v.id}: no run()`);
  }
  const used = new Set(store.get("findings", []).filter((f) => String(f.detector).startsWith("mainboard:")).map((f) => f.evidence?.category));
  for (const c of CATEGORIES) if (!VIEWS.some((v) => (v.writes || []).includes(c))) warnings.push(`category \`${c}\` is in the taxonomy and no view writes it`);
  return { ok: !errors.length, errors, warnings, views: VIEWS.length, categories: CATEGORIES.length, categories_seen: [...used].filter(Boolean) };
}

async function cmd({ _, flags }) {
  const sub = _[0] || "board";

  if (sub === "views") {
    if (flags.json) { emit({ views: VIEWS.map((v) => ({ id: v.id, title: v.title, question: v.question, writes: v.writes })) }); return 0; }
    out(table(VIEWS.map((v) => [v.id, v.title, (v.writes || []).join(" "), v.question]), { header: ["view", "title", "writes", "question"] })
      .split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "check") {
    const r = check();
    if (flags.json) { emit(r); return r.ok ? 0 : 1; }
    out(`  ${r.views} views, ${r.categories} categories — ${r.ok ? "ok" : "REFUSED"}`);
    for (const e of r.errors) out(`    !! ${e}`);
    for (const w of r.warnings) out(`    ·  ${w}`);
    return r.ok ? 0 : 1;
  }

  if (sub === "gaps") {
    const g = stages.gaps();
    if (flags.json) { emit(g); return g.gaps.length ? 1 : 0; }
    for (const s of g.stages) {
      const mark = s.state === "ok" ? "ok  " : s.state === "gap" ? "GAP " : "?   ";
      out(`  ${mark}${pad(s.title, 12)} ${s.why}`);
    }
    out("");
    out(`  ${g.ok} of ${g.of} stages hold.`);
    if (g.next) out(`  The first that does not is ${g.next.title.toLowerCase()}. Closed by:\n\n      ${g.next.fix}\n`);
    else out("  Nothing is waiting.");
    if (g.unknown.length) out(`  ${g.unknown.length} stage(s) could not be evaluated: ${g.unknown.map((s) => s.id).join(", ")}`);
    return g.gaps.length ? 1 : 0;
  }

  if (sub === "run") {
    const rows = await runViews({ only: String(flags.only || ""), base: String(flags.base || ""),
      corpusId: String(flags.persona || ""), worldId: String(flags.world || ""),
      target: String(flags.target || "local"), budget: Number(flags.budget) || 0, runId: String(flags.run || "") });
    const b = board();
    if (flags.json) { emit({ views: rows, board: b }); return 0; }
    out(boardText(b, rows));
    hr();
    for (const r of rows) out(`  ${pad(r.id, 13)} ${r.ran ? `ran in ${r.seconds}s, ${r.recorded} recorded` : `SKIP — ${r.skipped}`}${r.refused?.length ? `\n      refused ${r.refused.length}: ${r.refused[0]}` : ""}`);
    return 0;
  }

  if (sub === "board") {
    const b = board();
    if (flags.json) { emit(b); return 0; }
    if (!b.total) { out("  nothing on the board. `bb mainboard run --base <url>` probes every view."); return 0; }
    out(boardText(b));
    return 0;
  }
  warn(`unknown mainboard sub-verb: ${sub}. board | run | gaps | views | check`);
  return 2;
}

export const commands = {
  mainboard: {
    help: "one board over every view, one ledger under it; and which pipeline stage does not hold",
    usage: "bb mainboard [board|run|gaps|views|check] [--base url] [--only view,view] [--persona id] [--target local|prod] [--json]",
    long: [
      "  bb mainboard              the board, read from the store. No requests",
      "  bb mainboard run --base http://127.0.0.1:4400",
      "  bb mainboard gaps         the pipeline stage that does not hold, and the command that closes it",
      "",
      "Views: runbook · cookbook · scoreyard · clockwork · redline · cyberrender.",
      "A view that did not run says SKIP and why. Green because nothing was checked is not green.",
    ].join("\n"),
    run: cmd,
  },
};
