// runner.js — execute a gear, and write down what it was worth.
//
// The loop is small and every line is a decision about not spending:
//   1. build the context once (git state, open findings, minutes since the
//      last run). Every gate reads it; none re-measure it. A fact whose source
//      failed is null, never 0: a null gate RUNS the stage (spec.js).
//   2. gate. A false gate is a skip and the skip is an episode too.
//   3. fresh. The declared inputs fingerprint the same as last run -> skip.
//      This is what makes a gear cheap enough to run on a tick.
//   4. optional stages ask the model, and only a model that beat its base rate
//      gets a vote (`source: "model"`). Below SKIP_BELOW the stage is skipped.
//   5. run in-process through the cli table, timed, output silenced.
//   6. write the episode: the training row, written whether it ran or not.
//   7. re-read the store facts so the next gate sees what this stage wrote.
//
// Nothing here spends. A stage that cannot run is an `error` row; the gear
// keeps going and its verdict says `partial`.
import path from "node:path";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import { git } from "../core/exec.js";
import { readJson } from "../core/config.js";
import { VAR } from "../core/paths.js";
import { setMode, isJson, warn } from "../core/log.js";
import { now, stamp, shortId, slug, human, pad, sum } from "../core/util.js";
import { fingerprint, inputsOf, readMeta, writeMeta } from "../kit/cache.js";
import * as episodes from "../learn/episodes.js";
import { evaluate, verbKey, load as loadGears } from "./spec.js";

/** Below this predicted usefulness an OPTIONAL stage is skipped. 0.35, not 0.5:
 *  a free stage that runs uselessly costs seconds; a needed stage skipped
 *  costs a wrong answer. The asymmetry belongs in the threshold. */
export const SKIP_BELOW = 0.35;

const round2 = (x) => Math.round(x * 100) / 100;

/** What is true before the gear runs. Each field is null when its source could
 *  not be read (doctrine 2): a store that does not parse is not "0 findings". */
export function context(gearName) {
  const ctx = { gear: gearName, at: now(), open_findings: null, open_high: null, dirty: null, since_min: null, units_ready: null };
  Object.assign(ctx, storeFacts());
  const st = git(["status", "--porcelain"]);
  if (st.rc === 0) ctx.dirty = st.out.split("\n").filter((l) => l.trim()).length;
  const last = store.rows("gear_runs").filter((r) => r.gear === gearName).pop();
  if (last) {
    const t = Date.parse(last.at || last.ts || "");
    if (Number.isFinite(t)) ctx.since_min = Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  return ctx;
}

function storeFacts() {
  const f = store.get("findings", null);
  const u = store.get("units", null);
  const open = Array.isArray(f) ? f.filter((x) => x && x.status === "open") : null;
  return {
    open_findings: open ? open.length : null,
    open_high: open ? open.filter((x) => x.severity === "high" || x.severity === "critical").length : null,
    units_ready: Array.isArray(u) ? u.filter((x) => x && x.status === "ready").length : null,
  };
}

/** Pre-run facts only. `inputs` is the declared input count, not what ran. */
function features(st, ctx, inputCount) {
  return { inputs: inputCount, open_findings: ctx.open_findings, dirty: ctx.dirty, since_min: ctx.since_min, optional: st.optional ? 1 : 0 };
}

// What each verb reads and makes, and what a session would have spent to get
// the same answer. Counted off the store after the stage ran; a verb with no
// entry yields `produced: null` (nothing counted it) and zero turns, never a
// guess. Artefact names are the graph's vocabulary for autolabel.
const open = () => store.get("findings", []).filter((f) => f && f.status === "open");
const YIELD = {
  scan: () => { const o = open(); const ran = (store.get("scan", {}) || {}).ran || []; return { produced: o.length, produces: ["findings"], reads: [], turns: episodes.turns({ files_read: Math.min(60, o.length * 2), searches: ran.length, rows: o.length }) }; },
  compile: () => { const u = store.get("units", []); const o = open(); return { produced: u.length, produces: ["units"], reads: ["findings"], turns: episodes.turns({ files_read: Math.min(20, o.length), rows: o.length }) }; },
  route: () => { const l = store.get("lanes", []); const u = store.get("units", []); return { produced: l.length, produces: ["lanes"], reads: ["units"], turns: episodes.turns({ commands: 3, rows: u.length }) }; },
  "oversight scan": () => ({ produced: null, produces: ["oversight"], reads: ["findings"], turns: 0 }),
  "oversight guidelines": () => ({ produced: null, produces: ["guidelines"], reads: ["oversight"], turns: 0 }),
  "snapgen build": () => ({ produced: null, produces: ["snapgen"], reads: [], turns: 0 }),
  "learn signals": () => { const s = store.get("signals", {}) || {}; const n = (s.sessions || []).length; return { produced: n, produces: ["signals"], reads: ["transcripts"], turns: episodes.turns({ files_read: Math.min(30, n), commands: 2 }) }; },
  "learn rules": () => { const r = store.get("rules", {}) || {}; return { produced: (r.recommendations || []).length, produces: ["rules"], reads: ["signals"], turns: episodes.turns({ commands: 1 }) }; },
  "learn recommend": () => { const r = store.get("rules", {}) || {}; return { produced: (r.recommendations || []).length, produces: ["recommendations"], reads: ["rules", "signals"], turns: episodes.turns({ commands: 1 }) }; },
  "learn memory": () => { const m = store.get("memory", []); return { produced: Array.isArray(m) ? m.length : null, produces: ["memory"], reads: ["signals", "episodes", "scripts"], turns: episodes.turns({ files_read: 4 }) }; },
  "learn episodes": () => ({ produced: store.rows("episodes").length, produces: ["episode-report"], reads: ["episodes"], turns: episodes.turns({ commands: 1 }) }),
  "tokens ledger": () => { const n = store.rows("usage").length; return { produced: n, produces: ["usage"], reads: ["transcripts"], turns: episodes.turns({ files_read: Math.min(20, n ? 1 + Math.floor(n / 50) : 0) }) }; },
  "session list": () => ({ produced: null, produces: ["sessions"], reads: ["usage"], turns: 0 }),
  "scripts scan": () => { const s = store.get("scripts", []); return { produced: s.length, produces: ["scripts"], reads: [], turns: episodes.turns({ files_read: s.length, searches: 2 }) }; },
  doctor: () => ({ produced: null, produces: ["doctor"], reads: [], turns: episodes.turns({ commands: 3 }) }),
  "git status": () => ({ produced: null, produces: ["git"], reads: [], turns: episodes.turns({ commands: 1 }) }),
  run: () => ({ produced: null, produces: ["runs"], reads: ["lanes"], turns: 0 }),
};
function yieldOf(st) {
  const fn = YIELD[verbKey(st)] || YIELD[st.verb];
  if (!fn) return { produced: null, produces: [verbKey(st)], reads: [], turns: 0 };
  try { return fn(); } catch { return { produced: null, produces: [verbKey(st)], reads: [], turns: 0 }; }
}

/** Run one gear and whatever it chains into. Never throws; returns the run record. */
export async function runGear(name, opts = {}) {
  const { apply = false, verbose = false, quiet = false, trigger = "hand", table = null, gears = null, runId = "", _seen = null, _depth = 0 } = opts;
  const loaded = gears || (await loadGears()).gears;
  const g = loaded[name];
  if (!g) return { gear: name, rc: 2, error: `no such gear: ${name}. bb pipeline list`, stages: [], chained: [], ran: 0, skipped: 0, failed: 0, turns_saved: 0, seconds: 0 };
  const seen = _seen || new Set();
  // A chain is a graph and somebody will write a loop into it.
  if (seen.has(name)) return { gear: name, rc: 0, skipped_gear: "already ran in this invocation", stages: [], chained: [], ran: 0, skipped: 0, failed: 0, turns_saved: 0, seconds: 0 };
  seen.add(name);
  const run_id = runId || `${stamp()}-${shortId(4)}`;
  let cmdTable = table;
  if (!cmdTable) {
    // Imported here, not at the top: cli.js imports this module's group.
    try { cmdTable = (await (await import("../cli.js")).loadCommands()).table; } catch (e) { cmdTable = {}; warn(`cli table unavailable: ${e.message}`); }
  }
  const ctx = context(g.name);
  const model = readJson(path.join(VAR, "model.json"), null);
  const lift = (store.get("graph", null) || {}).lift || null;
  const wasJson = isJson();
  const t0 = Date.now();
  const rows = [], eps = [];
  let prev = "";

  for (const st of g.stages) {
    const key = verbKey(st);
    const row = { stage: st.name, verb: key, state: "", why: "", rc: 0, seconds: 0, produced: null, turns: 0, p_useful: null };
    let inputCount = null, fp = null, fpKey = null;

    const gate = evaluate(st.when, ctx);
    if (gate.value === false) { row.state = "gated"; row.why = `when: ${st.when}`; }
    else if (st.when && gate.value === null) row.gate_note = gate.error ? `gate unparseable (${gate.error}); ran anyway` : `gate unknown (${gate.unknown.join(", ")} not measurable); ran anyway`;

    if (!row.state && st.skip_if_fresh) {
      if (typeof st.inputs !== "function") warn(`${g.name}/${st.name}: skip_if_fresh without inputs(); it can never be fresh`);
      else {
        let inputs = null;
        try { inputs = st.inputs(); } catch (e) { warn(`${g.name}/${st.name}: inputs() failed (${e.message}); treated as changed`); }
        if (Array.isArray(inputs)) {
          inputCount = inputs.length;
          fp = fingerprint(inputs);
          fpKey = `pipeline-${slug(g.name)}-${slug(st.name)}`;
          const meta = readMeta(fpKey);
          if (inputsOf(fp) > 0 && meta.fingerprint === fp) { row.state = "fresh"; row.why = `${inputsOf(fp)} inputs unchanged since ${meta.at || "last run"}`; }
        }
      }
    }
    const feats = features(st, ctx, inputCount);

    // Only a model that beat its base rate votes; the base-rate fallback is not a prediction.
    if (!row.state && st.optional && model && model.useful) {
      const pred = expert.call("model-predict", { model, lift, episode: { verb: key, prev, features: feats } });
      if (pred && pred.source === "model" && typeof pred.p === "number") {
        row.p_useful = pred.p;
        if (pred.p < SKIP_BELOW) { row.state = "predicted-idle"; row.why = `model: p_useful ${pred.p} < ${SKIP_BELOW}`; }
      }
    }
    if (!row.state && !apply) { row.state = "would-run"; row.why = "dry run; --apply runs it"; }

    if (!row.state) {
      const cmd = cmdTable[st.verb];
      const t1 = Date.now();
      if (!cmd) { row.state = "error"; row.rc = 2; row.why = `no verb \`${st.verb}\` on this install`; }
      else {
        // Silence the verb's own output unless --verbose: a gear prints one line per stage.
        setMode({ quiet: !verbose, json: false });
        try {
          const rc = await cmd.run({ _: [...st.args], flags: { ...st.flags, quiet: true }, rest: [] });
          row.rc = typeof rc === "number" ? rc : 0;
          row.state = "ran";
        } catch (e) { row.state = "error"; row.rc = 2; row.why = String((e && e.message) || e).split("\n")[0]; }
        finally { setMode({ quiet, json: wasJson }); }
      }
      row.seconds = round2((Date.now() - t1) / 1000);
      if (row.state === "ran") {
        const y = yieldOf(st);
        row.produced = y.produced; row.turns = y.turns; row.reads = y.reads; row.produces = y.produces;
        // rc 2 is "could not run": its inputs were not consumed, so nothing is fresh.
        if (fpKey && row.rc !== 2) writeMeta(fpKey, { fingerprint: fp, at: now(), gear: g.name, stage: st.name, inputs: inputCount });
        Object.assign(ctx, storeFacts());
      }
    }

    eps.push(episodes.write({ kind: "stage", verb: key, stage: st.name, gear: g.name, prev, features: feats, rc: row.rc, seconds: row.seconds,
      produced: row.produced, reads: row.reads || [], produces: row.produces || [], turns_saved: row.turns, run_id, useful: -1, state: row.state,
      detail: { why: row.why, p_useful: row.p_useful, gate_note: row.gate_note || "" } }));
    rows.push(row);
    prev = key;
  }

  const ran = rows.filter((r) => r.state === "ran");
  const failed = rows.filter((r) => r.state === "error" || (r.state === "ran" && r.rc === 2));
  const skipped = rows.filter((r) => ["gated", "fresh", "predicted-idle"].includes(r.state));
  // Labels are decided once the whole run is visible: what a stage produced is
  // only worth something if a LATER stage read it.
  episodes.autolabel(eps, { completed: true });
  const result = {
    gear: g.name, description: g.description, run_id, trigger, stages: rows, seconds: round2((Date.now() - t0) / 1000),
    ran: ran.length, skipped: skipped.length, failed: failed.length, would_run: rows.filter((r) => r.state === "would-run").length,
    turns_saved: sum(ran.map((r) => r.turns)), tokens: 0, context: ctx, chained: [],
    verdict: failed.length ? "partial" : apply ? "clean" : "dry",
    rc: failed.length ? 2 : 0,
  };
  const gearRow = () => ({ id: `${g.name}:${run_id}`, gear: g.name, run_id, trigger, apply, stages: g.stages.length, ran: result.ran, skipped: result.skipped,
    failed: result.failed, seconds: result.seconds, tokens: 0, turns_saved: result.turns_saved, verdict: result.verdict, chained: result.chained.map((c) => c.gear) });
  store.append("gear_runs", gearRow());

  if (_depth < 3) {
    for (const c of g.chain) {
      const gate = evaluate(c.when, ctx);
      if (gate.value === false) { result.chained.push({ gear: c.gear, skipped_gear: `when: ${c.when}`, stages: [], chained: [], ran: 0, skipped: 0, failed: 0, turns_saved: 0, seconds: 0 }); continue; }
      const child = await runGear(c.gear, { ...opts, trigger: "chain", table: cmdTable, gears: loaded, runId: run_id, _seen: seen, _depth: _depth + 1 });
      result.chained.push(child);
      result.turns_saved += child.turns_saved || 0;
      result.seconds = round2(result.seconds + (child.seconds || 0));
      if (child.rc === 2) { result.rc = 2; result.verdict = "partial"; }
    }
    if (result.chained.length) store.append("gear_runs", { ...gearRow(), chained_update: true });
  }
  return result;
}

// ── reports ──────────────────────────────────────────────────────────────────

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
