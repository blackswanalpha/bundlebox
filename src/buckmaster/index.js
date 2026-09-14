// buckmaster/index.js — `bb buckmaster` (was `bb learn`): the expert-system half, reached through
// src/core/expert.js. Signals off the transcripts, rules over the signals, the
// process graph and model over the episodes, and the memory derived from all
// of it. Every sub-verb that needs python says so and returns 2; the zero-token
// path (scan → compile → route) never depends on this module.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import { load } from "../core/config.js";
import { OUT, VAR, ROOT, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { out, emit, warn } from "../core/log.js";
import { now, pad } from "../core/util.js";
import * as ledger from "../tokens/ledger.js";
import * as episodes from "./episodes.js";
import * as outcomes from "./outcomes.js";

export { episodes, outcomes };

export const modelPath = () => path.join(VAR, "model.json");
export const recommendationsPath = () => path.join(OUT, "buckmaster", "recommendations.md");

const INTERRUPT = /\[Request interrupted by user/i;
const ERRORISH = /^(?:\s*(?:error|Error|ERROR|Exit code [1-9]|Command failed|\[Request interrupted))/;

/** The slice of a turn the signals module reads. Paths and commands only: a
 *  whole tool input can be a 40k file write, and it crosses a pipe. */
function slim(t) {
  return {
    msgId: t.msgId, ts: t.ts, input: t.input, output: t.output, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead,
    toolUses: (t.toolUses || []).map((u) => {
      const i = u.input || {};
      const keep = {};
      for (const k of ["file_path", "path", "target_file", "command", "cmd"]) if (i[k] != null) keep[k] = String(i[k]).slice(0, 400);
      return { name: u.name, input: keep };
    }),
    toolResults: (t.toolResults || []).map((r) => ({ chars: r.chars, error: !!r.error || ERRORISH.test(String(r.text || "").slice(0, 120)), key: r.key || "" })),
  };
}

/** Sessions for the expert: newest transcripts first, parsed by the adapter
 *  that wrote them. A transcript no adapter recognises is skipped, not zeroed. */
export function sessions({ limit = 40 } = {}) {
  const entries = ledger.transcripts();
  const dated = entries.map((t) => { let m = 0; try { m = fs.statSync(t.file).mtimeMs; } catch { /* gone */ } return { ...t, m }; }).sort((a, b) => b.m - a.m).slice(0, limit);
  const rows = [];
  for (const t of dated) {
    const turns = ledger.turns(t.file, t.adapter);
    if (!turns) continue;
    const interrupts = turns.reduce((n, u) => n + (u.toolResults || []).filter((r) => INTERRUPT.test(String(r.text || ""))).length, 0);
    rows.push({ session_id: path.basename(t.file).replace(/\.jsonl?$/, ""), adapter: t.adapter, turns: turns.map(slim), interrupts });
  }
  return { sessions: rows, unknown: entries.unknown || [] };
}

const needPython = () => { if (expert.available()) return false; expert.call("version"); warn(`python3 required: ${expert.lastError}`); return true; };

export function runSignals({ limit } = {}) {
  const s = sessions({ limit });
  const r = expert.call("signals", { sessions: s.sessions });
  if (!r) return null;
  const doc = { at: now(), sessions: r.sessions, aggregate: r.aggregate, unknown_adapters: s.unknown };
  store.put("signals", doc);
  return doc;
}

export function runRules({ cfg = load() } = {}) {
  const sig = store.get("signals", null);
  if (!sig || !sig.aggregate) return { error: "no signals stored: bb buckmaster signals first" };
  const r = expert.call("rules", { signals: sig.aggregate, thresholds: cfg.buckmaster?.thresholds || cfg.learn?.thresholds || {} });
  if (!r) return null;
  const doc = { at: now(), measured_at: sig.at, sessions: sig.aggregate.sessions, ...r };
  store.put("rules", doc);
  return doc;
}

export function recommendationsMd(r) {
  const lines = ["# buckmaster — recommendations", "", `Measured ${r.measured_at || r.at} over ${r.sessions ?? "?"} sessions. Verdict: **${r.verdict}**.`, "",
    "Paste the lines you agree with into your agent's instructions file; nothing here writes there for you.", ""];
  if (!r.recommendations.length) lines.push("Nothing crossed a threshold. Sessions are lean.", "");
  for (const rec of r.recommendations) {
    lines.push(`## ${rec.id} — ${rec.title}`, "", `${rec.why}.`, "", `Actuator: \`${rec.actuator}\`${rec.cost ? ` (${rec.cost})` : ""}`, "", "Evidence:", "", "```json", JSON.stringify(rec.evidence, null, 2), "```", "");
  }
  lines.push("## Derivation", "");
  for (const f of r.fired || []) lines.push(f.error ? `- ${f.rule}: ERROR ${f.error}` : `- ${f.rule}: ${f.why} → set ${(f.set || []).join(", ")}`);
  lines.push("", "Thresholds: `" + JSON.stringify(r.thresholds) + "`", "");
  return lines.join("\n");
}

function signalsText(doc) {
  const a = doc.aggregate;
  const f = (v) => (v == null ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));
  const lines = [`  SIGNALS — ${a.sessions} sessions   ${doc.at}`, ""];
  for (const [k, label] of [["reread_ratio", "re-read ratio"], ["repeat_cmd_ratio", "repeat-command ratio"], ["fat_chars_share", "fat-result byte share"],
    ["singleton_turn_ratio", "singleton tool turns"], ["retry_ratio", "retry-after-error"], ["ctx_slope_median", "window slope / turn"], ["ctx_peak_median", "window peak (median)"],
    ["cache_read_ratio", "cache-read ratio"], ["long_session_share", "long-session share"], ["compactions_per_session", "compactions / session"], ["searches_per_session", "searches / session"], ["interrupts_per_session", "interrupts / session"]]) {
    lines.push(`    ${pad(label, 26)} ${pad(f(a[k]), 10, true)}`);
  }
  if (doc.unknown_adapters?.length) lines.push("", `  could not look: ${doc.unknown_adapters.join(", ")}`);
  return lines.join("\n");
}

function rulesText(r) {
  const lines = [`  RULES — verdict ${r.verdict}, ${r.recommendations.length} recommendations`, ""];
  if (!r.recommendations.length) lines.push("  nothing crossed a threshold. Sessions are lean.");
  for (const rec of r.recommendations) lines.push(`  ! ${pad(rec.id, 16)} ${rec.title}`, `      -> ${rec.actuator}   ${rec.cost || ""}`);
  lines.push("", "  derivation:");
  for (const f of r.fired || []) lines.push(f.error ? `    ${f.rule}: ERROR ${f.error}` : `    ${f.rule}: ${f.why}`);
  return lines.join("\n");
}

function modelText(m, { weights = false } = {}) {
  if (!m) return "  no model trained: bb buckmaster model --train";
  if (!m.n || m.n < 12) return `  not trained: ${m.why}`;
  const lines = [`  MODEL — ${m.n} labelled episodes (${m.train} train, ${m.holdout} holdout by time)`];
  lines.push(`    accuracy ${m.accuracy} vs base ${m.base_accuracy}${m.verb_accuracy != null ? `, verb-only ${m.verb_accuracy}` : ""}${m.auc != null ? `, auc ${m.auc}` : ""}`);
  lines.push(`    ${m.useful ? "beats the base rate AND a verb-only guess: it steers optional stages" : `(base rate) ${m.why}`}`);
  if (m.collinear?.length) lines.push(`  ! collinear features (one column wearing several names): ${m.collinear.map((g) => g.join(" = ")).join("; ")}`);
  if (weights) for (const [k, v] of Object.entries(m.weights || {}).slice(0, 40)) lines.push(`    ${pad(k, 28)} ${pad(v, 8, true)}`);
  return lines.join("\n");
}

async function buckmasterCmd({ _, flags }) {
  const sub = _[0] || "episodes";
  const cfg = load();

  if (sub === "episodes") {
    const s = episodes.report({ limit: Number(flags.limit) || 4000 });
    if (flags.json) { emit(s); return 0; }
    out(episodes.reportText(s));
    return 0;
  }
  if (sub === "outcomes") {
    const scored = outcomes.score({ runId: flags.run || "", all: !!flags.all, cfg });
    const rows = outcomes.outcomes();
    if (flags.json) { emit({ scored: scored.length, outcomes: rows, by_detector: outcomes.byDetector(rows) }); return 0; }
    out(outcomes.reportText(rows));
    out(`  ${scored.length} re-scored`);
    return 0;
  }
  if (sub === "backlog") {
    const rows = outcomes.backlog();
    if (flags.json) { emit({ backlog: rows }); return 0; }
    out(outcomes.backlogText(rows));
    return 0;
  }

  if (needPython()) return 2;

  if (sub === "signals") {
    const doc = runSignals({ limit: Number(flags.limit) || 40 });
    if (!doc) { warn(`python3 required: ${expert.lastError}`); return 2; }
    if (flags.json) { emit(doc); return 0; }
    out(signalsText(doc));
    return 0;
  }
  if (sub === "rules" || sub === "recommend") {
    const r = runRules({ cfg });
    if (r === null) { warn(`python3 required: ${expert.lastError}`); return 2; }
    if (r.error) { warn(r.error); return 1; }
    let wrote = "";
    if (sub === "recommend") { fs.mkdirSync(path.dirname(recommendationsPath()), { recursive: true }); fs.writeFileSync(recommendationsPath(), recommendationsMd(r)); wrote = rel(recommendationsPath()); }
    if (flags.json) { emit({ ...r, wrote }); return 0; }
    out(rulesText(r));
    if (wrote) out(`  wrote ${wrote}`);
    return 0;
  }
  if (sub === "graph") {
    const g = expert.call("graph", { episodes: store.rows("episodes") });
    if (!g) { warn(`python3 required: ${expert.lastError}`); return 2; }
    store.put("graph", { at: now(), ...g });
    if (flags.json) { emit(g); return 0; }
    out(`  GRAPH — ${g.verbs.length} verbs, ${g.edges.length} edges, ${g.labelled} labelled, base rate ${g.base_rate}`);
    for (const e of g.edges.slice(0, 20)) out(`    ${pad(e.from, 22)} -> ${pad(e.to, 22)} n=${e.n}${g.lift[`${e.from}>${e.to}`] != null ? `  lift ${g.lift[`${e.from}>${e.to}`]}` : ""}`);
    return 0;
  }
  if (sub === "model") {
    let m = readJson(modelPath(), null);
    if (flags.train) {
      m = expert.call("model-train", { episodes: store.rows("episodes") });
      if (!m) { warn(`python3 required: ${expert.lastError}`); return 2; }
      m.trained_at = now();
      writeJson(modelPath(), m);
    }
    if (flags.json) { emit(m || { useful: false, why: "no model" }); return 0; }
    out(modelText(m, { weights: !!flags.weights }));
    return 0;
  }
  if (sub === "memory") {
    const sig = store.get("signals", {}) || {};
    const old = store.get("memory", []);
    // A fired rule is procedural memory: it is the tier that changes how the
    // next session works rather than describing the last one, so the rules the
    // expert already derived are carried in instead of being re-derived here.
    const rules = store.get("rules", {}) || {};
    const r = expert.call("memory-derive", { signals: sig.aggregate || {}, episodes: store.rows("episodes", { limit: 4000 }),
      scripts: store.get("scripts", []), root: ROOT, old: Array.isArray(old) ? old : [],
      recommendations: rules.recommendations || [], tombstones: store.get("memory_tombstones", []) });
    if (!r) { warn(`python3 required: ${expert.lastError}`); return 2; }
    store.put("memory", r.claims);
    store.put("memory_tombstones", r.tombstones || []);
    if (flags.json) { emit(r); return 0; }
    const t = r.by_tier || {};
    out(`  MEMORY — ${r.claims.length} claims kept (${Array.isArray(old) ? old.length : 0} before): ${t.episodic || 0} episodic, ${t.semantic || 0} semantic, ${t.procedural || 0} procedural`);
    for (const tier of ["procedural", "semantic", "episodic"]) {
      const rows = r.claims.filter((c) => (c.tier || "episodic") === tier);
      if (!rows.length) continue;
      out(`    ${tier}`);
      for (const c of rows.slice(0, 8)) out(`      ${pad(c.confidence.toFixed(2), 5)} ${c.claim}`);
      if (rows.length > 8) out(`      ${rows.length - 8} more`);
    }
    const dropped = (r.tombstones || []).filter((x) => x.invalidated_at && x.invalidated_at === (r.claims[0]?.last_seen || ""));
    if (dropped.length) out(`    ${dropped.length} claim(s) left this round: ${[...new Set(dropped.map((d) => d.reason))].join(", ")}`);
    return 0;
  }
  if (sub === "recall") {
    const about = String(flags.about || _.slice(1).join(" ") || "");
    if (!about) { warn('what about? bb buckmaster recall --about "<text>"'); return 2; }
    const claims = store.get("memory", []);
    const tiers = flags.tier ? String(flags.tier).split(",").map((x) => x.trim()) : null;
    const r = expert.call("memory-recall", { claims, about, budget_tokens: Number(flags.budget) || 1100, tiers });
    if (!r) { warn(`python3 required: ${expert.lastError}`); return 2; }
    // Retrieval is the only thing that raises salience: a claim that keeps being
    // handed to a session has earned the half-life it is getting.
    if (r.claims.length) {
      const bumped = expert.call("memory-reinforce", { claims, keys: r.claims.map((c) => c.key), useful: !!flags.useful });
      if (bumped) store.put("memory", bumped.claims);
    }
    if (flags.json) { emit(r); return 0; }
    out(`  RECALL — ${r.claims.length} of ${r.considered} claims, ${r.tokens} tokens${r.suppressed ? `, ${r.suppressed} folded into a consolidated claim` : ""}`);
    for (const c of r.claims) out(`    ${pad(c.score.toFixed(2), 5)} ${pad(c.tier || "episodic", 11)} ${pad(c.hedge, 9)} ${c.claim}`);
    return 0;
  }
  warn(`unknown buckmaster sub-verb: ${sub}. episodes | signals | rules | recommend | graph | model | memory | recall | outcomes | backlog`);
  return 2;
}

export const commands = {
  buckmaster: {
    help: "signals, rules, graph, model and memory over transcripts and episodes (python3)",
    usage: "bb buckmaster episodes | signals [--limit N] | rules | recommend | graph | model [--train] [--weights] | memory | recall --about \"<text>\" [--tier procedural,semantic,episodic] [--useful] | outcomes [--all] | backlog [--json]",
    run: buckmasterCmd,
  },
};
