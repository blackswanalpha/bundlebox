// runner.js — execute a gear, and write down what it was worth.
//
// The loop is small and every line is a decision about not spending:
//   1. build the context once (facts.js): git state, open findings, minutes
//      since the last run. Every gate reads it; none re-measure it.
//   2. gate. A false gate is a skip and the skip is an episode too.
//   3. fresh. The declared inputs fingerprint the same as last run -> skip.
//      This is what makes a gear cheap enough to run on a tick.
//   4. optional stages ask the model, and only a model that beat its base rate
//      gets a vote (`source: "model"`). Below SKIP_BELOW the stage is skipped.
//   5. run in-process through the cli table, timed, output silenced.
//   6. write the episode: the training row, written whether it ran or not.
//   7. re-read the store facts so the next gate sees what this stage wrote.
//
// Steps 2 to 4 only ever DECIDE, and step 5 only ever RUNS. They are two
// functions for that reason: a decision that can also execute is a decision
// nobody can read in isolation, and this is the loop that must never spend by
// accident. Nothing here spends. A stage that cannot run is an `error` row;
// the gear keeps going and its verdict says `partial`.
import path from "node:path";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import { readJson, load as loadConfig } from "../core/config.js";
import { VAR } from "../core/paths.js";
import { setMode, isJson, warn } from "../core/log.js";
import { now, stamp, shortId, slug, sum } from "../core/util.js";
import { fingerprint, inputsOf, readMeta, writeMeta } from "../kit/cache.js";
import * as episodes from "../buckmaster/episodes.js";
import { evaluate, verbKey, spendKeys, load as loadGears } from "./spec.js";
import { context, storeFacts, features } from "./facts.js";

export { context } from "./facts.js";
export { report, listText, runsText, suggest, suggestText } from "./report.js";

/** Below this predicted usefulness an OPTIONAL stage is skipped. 0.35, not 0.5:
 *  a free stage that runs uselessly costs seconds; a needed stage skipped
 *  costs a wrong answer. The asymmetry belongs in the threshold. */
export const SKIP_BELOW = 0.35;

const round2 = (x) => Math.round(x * 100) / 100;

// The yield table moved to buckmaster/episodes.js: a verb typed by hand displaces
// the same work as the same verb inside a gear, and two tables would disagree.
// The pipeline does not dedupe by digest because its freshness gate already
// refuses to re-run a stage whose inputs have not drifted.
const yieldOf = (st) => episodes.yieldOf(verbKey(st));

/** Have this stage's declared inputs changed since it last ran?
 *  Returns the fingerprint and its store key so a stage that RUNS can record
 *  them; a stage that skips records nothing, because nothing consumed them. */
function freshness(g, st) {
  if (typeof st.inputs !== "function") {
    warn(`${g.name}/${st.name}: skip_if_fresh without inputs(); it can never be fresh`);
    return { fresh: null, fp: null, fpKey: null, inputCount: null };
  }
  let inputs = null;
  try { inputs = st.inputs(); } catch (e) { warn(`${g.name}/${st.name}: inputs() failed (${e.message}); treated as changed`); }
  if (!Array.isArray(inputs)) return { fresh: null, fp: null, fpKey: null, inputCount: null };
  const fp = fingerprint(inputs);
  const fpKey = `pipeline-${slug(g.name)}-${slug(st.name)}`;
  const meta = readMeta(fpKey);
  const fresh = inputsOf(fp) > 0 && meta.fingerprint === fp
    ? `${inputsOf(fp)} inputs unchanged since ${meta.at || "last run"}` : null;
  return { fresh, fp, fpKey, inputCount: inputs.length };
}

/** Everything that can stop a stage before it runs, in the order it is cheapest
 *  to ask. Decides only: it never calls a verb. */
function decide(g, st, row, { ctx, model, lift, apply, prev }) {
  let inputCount = null, fp = null, fpKey = null;

  const gate = evaluate(st.when, ctx);
  if (gate.value === false) { row.state = "gated"; row.why = `when: ${st.when}`; }
  else if (st.when && gate.value === null) {
    row.gate_note = gate.error ? `gate unparseable (${gate.error}); ran anyway`
      : `gate unknown (${gate.unknown.join(", ")} not measurable); ran anyway`;
  }

  if (!row.state && st.skip_if_fresh) {
    const f = freshness(g, st);
    ({ fp, fpKey, inputCount } = f);
    if (f.fresh) { row.state = "fresh"; row.why = f.fresh; }
  }
  const feats = features(st, ctx, inputCount);

  // The one stage kind that can cost money, and the only place in this loop
  // that can. Checked before the dry-run branch so `refused` beats `would-run`:
  // a stage nobody has given permission to is refused whether or not --apply
  // was typed, and a person reading a dry run has to see which key is missing.
  if (!row.state && st.spends) {
    // `fresh`: the ceilings are read at the moment of the decision, not from
    // whatever this process cached at start-up. A worker that has been up for
    // six hours deciding on a six-hour-old budget is the one case this check
    // exists for.
    const g = spendKeys(loadConfig({ fresh: true }));
    if (!g.ok) { row.state = "refused"; row.why = `spends: ${g.missing.join(", ")} — not set. \`bb config\``; }
  }

  // Only a model that beat its base rate votes; the base-rate fallback is not a prediction.
  if (!row.state && st.optional && model && model.useful) {
    const pred = expert.call("model-predict", { model, lift, episode: { verb: row.verb, prev, features: feats } });
    if (pred && pred.source === "model" && typeof pred.p === "number") {
      row.p_useful = pred.p;
      if (pred.p < SKIP_BELOW) { row.state = "predicted-idle"; row.why = `model: p_useful ${pred.p} < ${SKIP_BELOW}`; }
    }
  }
  if (!row.state && !apply) { row.state = "would-run"; row.why = "dry run; --apply runs it"; }
  return { feats, fp, fpKey, inputCount };
}

/** Run the stage's verb in-process and record what it produced. */
async function execute(st, row, { cmdTable, ctx, verbose, quiet, wasJson, fp, fpKey, inputCount, gearName }) {
  const cmd = cmdTable[st.verb];
  // What this stage's artefact held BEFORE it ran. Without it the label is a
  // function of the verb (C32): every `scan` claims to produce findings whether
  // or not this run found any, and the model memorises the verb.
  const before = yieldOf(st).produced;
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
  if (row.state !== "ran") return;

  const y = yieldOf(st);
  row.produced = y.produced; row.turns = y.turns; row.reads = y.reads; row.produces = y.produces;
  // null on either side means nothing counted it: unknown, not unchanged.
  row.changed = before == null || y.produced == null ? null : (y.produced === before ? 0 : 1);
  row.before = before;
  // rc 2 is "could not run": its inputs were not consumed, so nothing is fresh.
  if (fpKey && row.rc !== 2) writeMeta(fpKey, { fingerprint: fp, at: now(), gear: gearName, stage: st.name, inputs: inputCount });
  Object.assign(ctx, storeFacts());
}

/** The command table, resolved once per invocation. Imported here rather than
 *  at the top because cli.js imports this module's group. */
async function commandTable(table) {
  if (table) return table;
  try { return (await (await import("../cli.js")).loadCommands()).table; }
  catch (e) { warn(`cli table unavailable: ${e.message}`); return {}; }
}

const empty = (gear, extra) => ({ gear, stages: [], chained: [], ran: 0, skipped: 0, failed: 0, turns_saved: 0, seconds: 0, ...extra });

/** Run one gear and whatever it chains into. Never throws; returns the run record. */
export async function runGear(name, opts = {}) {
  const { apply = false, verbose = false, quiet = false, trigger = "hand", table = null, gears = null, runId = "", _seen = null, _depth = 0 } = opts;
  const loaded = gears || (await loadGears()).gears;
  const g = loaded[name];
  if (!g) return empty(name, { rc: 2, error: `no such gear: ${name}. bb pipeline list` });
  const seen = _seen || new Set();
  // A chain is a graph and somebody will write a loop into it.
  if (seen.has(name)) return empty(name, { rc: 0, skipped_gear: "already ran in this invocation" });
  seen.add(name);

  const run_id = runId || `${stamp()}-${shortId(4)}`;
  const cmdTable = await commandTable(table);
  const ctx = context(g.name);
  const model = readJson(path.join(VAR, "model.json"), null);
  const lift = (store.get("graph", null) || {}).lift || null;
  const wasJson = isJson();
  const t0 = Date.now();
  const rows = [], eps = [];
  let prev = "";

  for (const st of g.stages) {
    const key = verbKey(st);
    const row = { stage: st.name, verb: key, state: "", why: "", rc: 0, seconds: 0, produced: null, changed: null, turns: 0, p_useful: null };
    const d = decide(g, st, row, { ctx, model, lift, apply, prev });
    if (!row.state) await execute(st, row, { cmdTable, ctx, verbose, quiet, wasJson, gearName: g.name, ...d });

    eps.push(episodes.write({ kind: "stage", verb: key, stage: st.name, gear: g.name, prev, features: d.feats, rc: row.rc, seconds: row.seconds,
      produced: row.produced, changed: row.changed, reads: row.reads || [], produces: row.produces || [], turns_saved: row.turns, run_id, useful: -1, state: row.state,
      detail: { why: row.why, p_useful: row.p_useful, gate_note: row.gate_note || "", produced_before: row.before ?? null } }));
    rows.push(row);
    prev = key;
  }

  const ran = rows.filter((r) => r.state === "ran");
  const failed = rows.filter((r) => r.state === "error" || (r.state === "ran" && r.rc === 2));
  const skipped = rows.filter((r) => ["gated", "fresh", "predicted-idle", "refused"].includes(r.state));
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
      if (gate.value === false) { result.chained.push(empty(c.gear, { skipped_gear: `when: ${c.when}` })); continue; }
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
