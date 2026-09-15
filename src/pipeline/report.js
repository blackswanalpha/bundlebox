// pipeline/report.js — how a run reads on a terminal.
//
// Separate from the runner because a report is a rendering decision and a run
// is a spending decision: changing how a gear prints must not be able to change
// what it skips.
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import { human, pad } from "../core/util.js";
import * as episodes from "../buckmaster/episodes.js";
import { verbKey } from "./spec.js";

const MARK = { ran: " ", gated: "-", fresh: "=", "predicted-idle": "~", "would-run": "?", error: "!" };

export function report(r, { verbose = false, top = true } = {}) {
  if (r.error) return `  ${r.error}`;
  if (r.skipped_gear) return `  ${r.gear}: ${r.skipped_gear}`;
  const lines = [`  ${r.gear.toUpperCase()} — ${r.description || ""}   ${r.seconds}s   run ${r.run_id}`, ""];
  for (const s of r.stages) {
    const mark = MARK[s.state] || " ";
    if (s.state === "ran") {
      const produced = s.produced == null ? "" : `${s.produced} produced  `;
      lines.push(`   ${mark} ${pad(s.stage, 22)} ${pad(s.seconds.toFixed(2) + "s", 8, true)} ${pad(s.turns ? `${s.turns}t` : "", 5, true)}  ${s.rc ? `rc ${s.rc}  ` : ""}${produced}${s.gate_note || ""}`);
    } else lines.push(`   ${mark} ${pad(s.stage, 22)} ${pad("", 8)} ${pad("", 5)}  ${s.state}: ${s.why}${s.gate_note ? `  (${s.gate_note})` : ""}`);
    if (verbose && s.p_useful != null) lines.push(`       model p_useful ${s.p_useful}`);
  }
  for (const c of r.chained) { lines.push("", `   chained -> ${c.gear}`); lines.push(report(c, { verbose, top: false })); }
  if (top) lines.push("", bottomLine(r));
  return lines.join("\n");
}

function bottomLine(r) {
  const tpt = episodes.tokensPerTurn();
  const secs = Math.max(0.001, r.seconds);
  const tok = r.turns_saved * tpt.value;
  return `   ${r.verdict} · ${r.ran} ran, ${r.skipped} skipped${r.would_run ? `, ${r.would_run} would run` : ""}${r.failed ? `, ${r.failed} failed` : ""} · ${r.turns_saved} agent turns displaced in ${secs.toFixed(1)}s · ${human(tok)} tokens not spent (${tpt.kind}) · ${human(tok / secs)} tok/s · 0 spent`;
}

export function listText(gears, warnings = []) {
  const lines = ["  GEARS — declared pipelines over the verbs this factory has", ""];
  for (const g of Object.values(gears)) {
    const chain = g.chain.length ? ` -> ${g.chain.map((c) => c.gear).join(", ")}` : "";
    lines.push(`    ${pad(g.name, 10)} ${g.description}${chain}`);
    if (g.stages.length) lines.push(`    ${pad("", 10)} ${g.stages.map((s) => `${s.name}${s.when ? ` [${s.when}]` : ""}${s.optional ? "?" : ""}${s.skip_if_fresh ? "=" : ""}`).join(" → ")}`);
    if (g.on.length) lines.push(`    ${pad("", 10)} on: ${g.on.join(", ")}`);
    lines.push("");
  }
  lines.push("    [gate]  ? optional (the model may skip it)  = skip when inputs are fresh");
  for (const w of warnings) lines.push(`  ! ${w}`);
  return lines.join("\n");
}

export function runsText(rows) {
  if (!rows.length) return "  no gear runs yet. bb pipeline run <gear> --apply";
  const lines = [`  ${pad("at", 20)} ${pad("gear", 10)} ${pad("trigger", 8)} ${pad("ran", 4, true)} ${pad("skip", 4, true)} ${pad("fail", 4, true)} ${pad("turns", 6, true)} ${pad("secs", 7, true)}  verdict`];
  for (const r of rows) lines.push(`  ${pad(String(r.at || "").slice(0, 19), 20)} ${pad(r.gear, 10)} ${pad(r.trigger, 8)} ${pad(r.ran, 4, true)} ${pad(r.skipped, 4, true)} ${pad(r.failed, 4, true)} ${pad(r.turns_saved, 6, true)} ${pad(r.seconds, 7, true)}  ${r.verdict}${r.apply ? "" : " (dry)"}`);
  return lines.join("\n");
}

/** Where the measured edge lift disagrees with the declared order. The gears
 *  were declared by a person; the episodes measured what the orders were
 *  worth; this prints the difference. A thin edge is not a verdict, so every
 *  row carries its count. */
export function suggest(gears) {
  const eps = store.rows("episodes");
  const g = expert.call("graph", { episodes: eps });
  if (!g) return { error: `python3 required: ${expert.lastError}`, disagreements: [], labelled: 0 };
  const lift = g.lift || {};
  const n = {};
  for (const e of g.edges || []) n[`${e.from}>${e.to}`] = e.n;
  const disagreements = [];
  for (const gear of Object.values(gears)) {
    const keys = gear.stages.map(verbKey);
    for (let i = 1; i < keys.length; i++) {
      const to = keys[i], declared = keys[i - 1];
      const dl = lift[`${declared}>${to}`];
      if (dl == null) continue;
      let best = null;
      for (const c of keys) {
        if (c === to || c === declared) continue;
        const l = lift[`${c}>${to}`];
        if (l != null && l > dl && (!best || l > best.lift)) best = { from: c, lift: l, n: n[`${c}>${to}`] || 0 };
      }
      if (best) disagreements.push({ gear: gear.name, stage: to, declared: { from: declared, lift: dl, n: n[`${declared}>${to}`] || 0 }, measured: best });
    }
  }
  return { base_rate: g.base_rate, labelled: g.labelled, edges: (g.edges || []).length, disagreements };
}

export function suggestText(s) {
  if (s.error) return `  ${s.error}`;
  const lines = [`  SUGGEST — ${s.labelled} labelled episodes, ${s.edges} observed edges, base rate ${s.base_rate}`, ""];
  if (!s.labelled) { lines.push("    nothing labelled yet. Run gears with --apply; the graph fills as it goes."); return lines.join("\n"); }
  if (!s.disagreements.length) { lines.push("    the declared orders agree with the measured lifts."); return lines.join("\n"); }
  lines.push("  where the measured lift disagrees with the declared order:");
  for (const d of s.disagreements) lines.push(`    ${pad(d.gear, 10)} ${d.stage}: declared after ${d.declared.from} (lift ${d.declared.lift}, n=${d.declared.n}); measured better after ${d.measured.from} (lift ${d.measured.lift}, n=${d.measured.n})`);
  lines.push("", "  A thin edge is not a verdict. Check n before reordering.");
  return lines.join("\n");
}
