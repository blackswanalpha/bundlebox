// lathe/index.js — `bb lathe`: the automation engine.
//
// The model is called LATHE-1. It is not a language model and there is no
// inference call anywhere in this file: it is four count-based models over
// artefacts this workspace already produced, and every one of them runs locally
// for nothing.
//
//   SEQUENCE     closed contiguous patterns over what sessions actually ran, from
//                `bundlebox_expert.sequences` (PrefixSpan restricted to
//                contiguous extension, BIDE closedness). A pattern is kept only
//                when no longer pattern has the same support, which is what
//                keeps the emitted set small: `scan -> compile` at 40 is not a
//                habit when `scan -> compile -> route` is also at 40.
//   OUTCOME      the expert's logistic model over episode features
//                (`bb buckmaster model --train`), read here rather than
//                retrained: whether a step was USEFUL is what decides if its
//                habit is worth a script.
//   MEMORY       the janitor's compiled heap and the expert's decayed claims.
//                A claim whose anchor no longer resolves does not get to shape
//                an automation, which is the same rule the hooks follow.
//   COMPLETION   prefix entropy over the tree's own declarations, from the arc
//                index. A prefix with one continuation is worth completing; one
//                with forty is a menu.
//
// What it emits is the answer to "what did this workspace do by hand, more than
// twice, that it could have run": tagged scripts, snippets, boilerplate and a
// completion table. None of it needs an agent, which is the point — every one of
// these is a turn an agent would otherwise be paid to take.
import fs from "node:fs";
import path from "node:path";
import { OUT, VAR, rel, abs } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { out, emit, warn } from "../core/log.js";
import { now, shellSegments } from "../core/util.js";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import * as emitters from "./emit.js";
import * as record from "./record.js";

export const NAME = "LATHE-1";
export const DIR = () => path.join(OUT, "lathe");
export const MODEL = () => path.join(VAR, "lathe-model.json");

/** How often a habit must have happened before it is called one. Three, because
 *  two is a coincidence of two sessions and the whole claim of this file is
 *  that it proposes only what already happened. */
export const MIN_SUPPORT = 3;

// ── what the model learns from ──────────────────────────────────────────────

/** Verb runs, one per session or pipeline run. An episode carries `run_id` and
 *  `session_id`; either groups a sequence, and the order is the order they were
 *  appended, which is the order they happened. */
export function verbRuns(episodes) {
  const byRun = new Map();
  for (const e of episodes) {
    const key = String(e.run_id || e.session_id || "");
    const verb = String(e.verb || e.stage || "");
    if (!key || !verb) continue;
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(verb);
  }
  return [...byRun.values()].filter((r) => r.length >= 2);
}

/** Commands that are punctuation, not work.
 *
 *  This list is the difference between a useful model and a useless one, and it
 *  was measured rather than guessed. The first run of the shell miner reported
 *  `cd ; cd ; cd ; cd ; cd ; cd ; cd` at 136 occurrences with a lift of 2.46 —
 *  because an agent prefixes almost every shell call with `cd <root> &&`, so
 *  taking the first binary of each command shaped every command in the corpus
 *  as `cd`. `set` came second, from `set -euo pipefail` inside scripts. Neither
 *  is a habit; both are how a shell is entered. */
export const NOISE = /^(cd|set|export|echo|source|\.|true|false|pwd|clear|exit|umask|unset)$/;
/** Shell GRAMMAR, which is not a command at all.
 *
 *  Also measured. Splitting `for i in 1 2 3; do curl ...; break; done` on its
 *  separators and taking the first word of each piece produced the shapes
 *  `for i`, `do curl`, `break` and `done`, and the miner dutifully reported
 *  `(node ; for i ; do curl ; break ; done ; curl` as a habit with a lift of
 *  68. Those words are how a shell is written, not work a script displaces. */
export const KEYWORD = /^(for|while|until|do|done|if|then|elif|else|fi|case|esac|in|break|continue|return|function|select|coproc|time|exec|eval|trap|local|declare|readonly|shift|wait)$/;

/** The shapes of one shell command: one per segment that does work.
 *
 *  Shaped, because the argument is never the habit — `npm test`, `git commit -m
 *  "..."` and `sed -n 40,60p src/a.js` are three shapes, and counting them with
 *  their arguments intact finds no pattern in a hundred sessions. Segmented,
 *  because `cd x && npm test` is one call and one unit of work, and the work is
 *  the second half. */
export function commandShapes(cmd) {
  const out = [];
  for (const seg of shellSegments(cmd)) {
    const parts = seg.split(/\s+/);
    // A leading `(`, `{` or `!` is grouping; the command is what follows it.
    const head = String(parts[0] || "").replace(/^[("'{!]+/, "").replace(/["']$/, "");
    const bin = path.basename(head);
    if (!bin || bin.startsWith("-") || NOISE.test(bin) || KEYWORD.test(bin)) continue;
    // A sub-verb is part of the shape: `git commit` and `git push` are not one habit.
    const second = String(parts[1] || "").replace(/^["']|["']$/g, "");
    const sub = /^[a-z][\w:-]*$/.test(second) && !second.includes("/") && !second.includes(".") ? ` ${second}` : "";
    out.push(bin + sub);
  }
  return out;
}

/** The first shape of a command, or "". Kept because a caller that wants one
 *  name for one command should not have to know about segments. */
export const commandShape = (cmd) => commandShapes(cmd)[0] || "";

/** One run per session: the shapes of the commands it ran, in order.
 *
 *  Order is the whole point, which is why this reads the transcripts rather
 *  than the stored signals. `signals.sessions` already carries
 *  `top_repeat_cmds` — how often each command ran — and a count cannot tell
 *  `lint then test` from `test then lint`, so it cannot say what to automate. */
export function shellRuns(sessions) {
  const runs = [];
  for (const s of sessions || []) {
    const items = [];
    for (const t of s.turns || []) {
      for (const u of t.toolUses || []) items.push(...commandShapes(u?.input?.command || u?.input?.cmd || ""));
    }
    if (items.length >= 2) runs.push(items);
  }
  return runs;
}

/** The leading lines of every file in a group, for the boilerplate miner. A
 *  prologue is a contiguous run of identical lines across files, so the lines
 *  themselves are the sequence items. */
export function prologues(files, { lines = 14 } = {}) {
  const runs = [];
  for (const f of files) {
    const text = readText(abs(f));
    if (!text) continue;
    const head = text.split("\n").slice(0, lines).map((l) => l.trimEnd()).filter((l) => l !== "");
    if (head.length >= 2) runs.push(head);
  }
  return runs;
}

// ── the model ───────────────────────────────────────────────────────────────

/** The N newest transcripts, under a per-file size cap, as command runs.
 *
 *  The cap is the whole point. One transcript on this box is 11MB and the
 *  newest forty are tens of megabytes; reading them to recover one string per
 *  tool call is what the recorded shapes exist to avoid. This is a first-run
 *  backfill, bounded on both axes, and never the default. */
export async function backfill(limit, maxMb) {
  let bm, ledger, fs2;
  try {
    bm = await import("../buckmaster/index.js");
    ledger = await import("../tokens/ledger.js");
    fs2 = fs;
  } catch { return []; }
  const cap = maxMb * 1024 * 1024;
  const entries = ledger.transcripts()
    .map((t) => { let size = 0, m = 0; try { const st = fs2.statSync(t.file); size = st.size; m = st.mtimeMs; } catch { /* gone */ } return { ...t, size, m }; })
    .filter((t) => t.size > 0 && t.size <= cap)
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);
  const runs = [];
  for (const t of entries) {
    const turns = ledger.turns(t.file, t.adapter);
    if (!turns) continue;
    const items = [];
    for (const turn of turns) for (const u of turn.toolUses || []) items.push(...commandShapes(u?.input?.command || u?.input?.cmd || ""));
    if (items.length >= 2) runs.push(items);
  }
  void bm;
  return runs;
}

export async function learn({ maxEpisodes = 4000, transcripts = 0, maxTranscriptMb = 4 } = {}) {
  if (!expert.available()) return { error: `python3 required for the sequence model: ${expert.lastError || "not found"}` };
  const episodes = store.rows("episodes", { limit: maxEpisodes });
  const signals = store.get("signals", {}) || {};
  const memory = store.get("memory", []);
  const graph = store.get("graph", {}) || {};
  let outcome = null;
  try { outcome = JSON.parse(fs.readFileSync(path.join(VAR, "model.json"), "utf8")); } catch { /* not trained yet */ }

  const verbs = expert.call("sequences", { sequences: verbRuns(episodes), min_support: MIN_SUPPORT });
  // The recorded shapes, not the transcripts. `record.js` says why: the same
  // order read from the transcripts cost four minutes of wall clock for 4.8
  // seconds of CPU, and this file is two hundred kilobytes.
  //
  // A workspace that has never run a session with the hook installed has
  // nothing here, and `--transcripts N` backfills it from the N newest
  // transcripts under a size cap. Opt-in, because the default pass must stay
  // cheap enough to run at session end.
  let runs = record.runs({});
  let from = "recorded shapes";
  if (transcripts > 0) {
    const back = await backfill(transcripts, maxTranscriptMb);
    if (back.length) { runs = runs.concat(back); from = `recorded shapes + ${back.length} transcript(s)`; }
  }
  const shell = expert.call("sequences", { sequences: runs, min_support: MIN_SUPPORT });

  // Completion comes from the compiled index when it is there, and from nothing
  // when it is not: inventing a name list would make the table a guess.
  let names = [];
  try { const arc = await import("../arc/read.js"); names = arc.names() || []; } catch { /* no index */ }
  const completion = names.length ? expert.call("completions", { names, min_count: 1 }) : { prefixes: [] };

  const model = {
    name: NAME,
    version: 1,
    learned_at: now(),
    inputs: {
      episodes: episodes.length,
      sessions: new Set(record.rows({}).map((r) => r.s)).size || (signals.sessions || []).length,
      shape_rows: record.stat().rows,
      corpus: from,
      memory_claims: Array.isArray(memory) ? memory.length : 0,
      declarations: names.length,
      outcome_model: outcome ? { auc: outcome.auc ?? null, trained_at: outcome.trained_at || "" } : null,
      verb_edges: (graph.edges || []).length,
    },
    // A pattern whose items are all the same shape is a repetition, not a
    // habit: `npm test ; npm test ; npm test` says a test was re-run, and a
    // script for it would automate impatience.
    sequence: { verbs: varied(verbs?.patterns), shell: varied(shell?.patterns) },
    // Two caps, not one slice. The rows sort by entropy, so a flat slice fills
    // with zero-entropy certain prefixes and the narrow section comes out empty
    // however many of them there are.
    completion: { prefixes: [
      ...(completion?.prefixes || []).filter((p) => p.certain).slice(0, 300),
      ...(completion?.prefixes || []).filter((p) => !p.certain && p.entropy <= 1.6).slice(0, 100),
    ] },
  };
  fs.mkdirSync(path.dirname(MODEL()), { recursive: true });
  fs.writeFileSync(MODEL(), JSON.stringify(model, null, 2) + "\n");
  return model;
}

const varied = (rows) => (rows || []).filter((p) => new Set(p.items || []).size > 1);

export function model() {
  try { return JSON.parse(fs.readFileSync(MODEL(), "utf8")); } catch { return null; }
}

// ── the verb ────────────────────────────────────────────────────────────────

export const commands = {
  lathe: {
    help: `the automation engine: what this workspace did by hand more than twice, as scripts, snippets, boilerplate and completions (${NAME}, no tokens)`,
    usage: [
      "bb lathe                  what the model holds and what it emitted",
      "     bb lathe learn [--transcripts N]   re-learn from the recorded shapes, episodes, memory and the index",
      "     bb lathe build [--apply]  emit the automations (dry run without --apply)",
    ].join("\n"),
    long: [
      `  ${NAME} is not a language model and nothing here calls one. It is four count-based models`,
      "  over artefacts this workspace already produced: closed contiguous sequences over the verbs",
      "  and commands sessions actually ran, the expert's logistic outcome model, the janitor's",
      "  decayed memory, and prefix entropy over the compiled declaration index.",
      "",
      "  Every row it emits names the support behind it. A habit with three occurrences is proposed",
      "  as a script; nothing is proposed from one.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      if (sub === "learn") {
        const m = await learn({ transcripts: Number(flags.transcripts) || 0, maxTranscriptMb: Number(flags.maxTranscriptMb) || 4 });
        if (m.error) { warn(m.error); return 2; }
        if (flags.json) { emit(m); return 0; }
        out(`  ${m.name} — learned ${now()}`);
        out(`  from    ${m.inputs.episodes} episodes, ${m.inputs.shape_rows} recorded command rows over ${m.inputs.sessions} session(s), ${m.inputs.memory_claims} memory claims, ${m.inputs.declarations} declarations`);
        out(`  found   ${m.sequence.verbs.length} verb habit(s), ${m.sequence.shell.length} shell habit(s), ${m.completion.prefixes.length} completable prefix(es)`);
        out(`  wrote   ${rel(MODEL())}`);
        return 0;
      }
      if (sub === "build") {
        const m = model();
        if (!m) { warn("no model; run `bb lathe learn`"); return 2; }
        const r = await emitters.all(m, { apply: !!flags.apply, minSupport: Number(flags.minSupport) || MIN_SUPPORT });
        if (flags.json) { emit(r); return 0; }
        out(`  ${m.name} — ${r.rows.length} artefact(s)${r.apply ? "" : "  (dry run: --apply writes them)"}`);
        for (const row of r.rows) out(`    ${row.state.padEnd(9)} ${rel(row.path).padEnd(46)} ${row.what}`);
        if (r.apply) out(`\n  wrote ${rel(DIR())}`);
        else out("\n  --apply writes them under .bundlebox/out/lathe/");
        return 0;
      }
      if (sub === "status") {
        const m = model();
        if (flags.json) { emit({ model: m, emitted: emitters.onDisk() }); return 0; }
        if (!m) { out(`  ${NAME} — not learned yet. \`bb lathe learn\` reads episodes, signals, memory and the index (no tokens).`); return 0; }
        out(`  ${m.name} v${m.version} — learned ${m.learned_at}`);
        out(`  inputs   ${m.inputs.episodes} episodes, ${m.inputs.sessions} sessions, ${m.inputs.declarations} declarations${m.inputs.outcome_model ? `, outcome AUC ${m.inputs.outcome_model.auc}` : ", no outcome model (`bb buckmaster model --train`)"}`);
        out(`  habits   ${m.sequence.verbs.length} verb, ${m.sequence.shell.length} shell`);
        for (const p of m.sequence.verbs.slice(0, 6)) out(`    ${String(p.support).padStart(4)}x  ${p.items.join(" → ")}${p.lift ? `   lift ${p.lift}` : ""}`);
        for (const p of m.sequence.shell.slice(0, 6)) out(`    ${String(p.support).padStart(4)}x  ${p.items.join(" ; ")}${p.lift ? `   lift ${p.lift}` : ""}`);
        const disk = emitters.onDisk();
        out(`  emitted  ${disk.length ? disk.map((d) => rel(d)).join(", ") : "nothing yet — `bb lathe build --apply`"}`);
        return 0;
      }
      warn(`unknown sub-verb: ${sub}\n${commands.lathe.usage}`);
      return 2;
    },
  },
};
