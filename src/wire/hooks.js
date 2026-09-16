// hooks.js — `bb hook <event>`: the handlers an agent's hook system calls.
//
// Contract: read the payload on stdin (any shape, possibly empty), print at
// most one JSON object on stdout, ALWAYS exit 0 within the budget. A reporting
// hook that can fail a session is a reporting hook that will eventually fail
// a session. Failures are appended to .bundlebox/var/hooks.log so a hook that
// stopped working is visible somewhere, unlike the original's `2>/dev/null`.
import fs from "node:fs";
import path from "node:path";
import { VAR, OUT, ROOT, ensureDirs } from "../core/paths.js";
import { load } from "../core/config.js";
import * as store from "../core/store.js";
import { text as estimateText, file as estimateFile } from "../tokens/estimate.js";
import { now, human } from "../core/util.js";
import * as brief from "./brief.js";

// A cap is what a band may cost, not what it should. `pre-read` and
// `pre-search` are the two that carry an ANSWER rather than a pointer, so they
// are the two allowed to be expensive: what they replace is the whole file or
// the whole search.
const CAPS = { "session-start": 600, prompt: 1000, "pre-read": 900, "pre-search": 500, "post-tool": 300, "restate-rules": 700 };

// ── the janitor's three touch points ────────────────────────────────────────
//
// All three read an artefact `bb janitor compile` already wrote. None of them
// runs the compiler: `session-start` has 30 seconds and `prompt` runs on every
// turn, and a handler that recompiles a heap on either is a handler somebody
// turns off within a week.
//
// The stale guard matters more here than anywhere else in this file. The whole
// claim of the resolve pass is that a fact whose anchor no longer resolves must
// not be quoted with confidence; a hook that quotes a week-old diagnostics file
// as though it described the tree right now would be making exactly that
// mistake about the janitor's own output.
const jdir = () => path.join(OUT, "janitor");
function janitorArtefact(name, maxAgeHours) {
  const f = path.join(jdir(), name);
  try {
    const st = fs.statSync(f);
    if ((Date.now() - st.mtimeMs) / 3600000 > maxAgeHours) return null;
    return fs.readFileSync(f, "utf8");
  } catch { return null; }
}
const COMPACTED = () => path.join(VAR, "janitor-compacted.json");

function readStdin() {
  try { const s = fs.readFileSync(0, "utf8"); return s.trim() ? JSON.parse(s) : {}; } catch { return {}; }
}
function log(event, msg) {
  try { ensureDirs(); fs.appendFileSync(path.join(VAR, "hooks.log"), `${now()} ${event} ${msg}\n`); } catch { /* the log is a courtesy */ }
}
function capTokens(s, cap) {
  if (estimateText(s, "prose") <= cap) return s;
  const lines = s.split("\n");
  while (lines.length > 1 && estimateText(lines.join("\n"), "prose") > cap) lines.pop();
  return lines.join("\n") + "\n…";
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function sessionStart() {
  const cfg = load();
  if (!cfg.wire.inject_context) return;
  const parts = [];
  // First, because `capTokens` truncates from the END and this is the only part
  // that corrects something already in the window. The reference tables are a
  // pointer the agent can re-read at any time; a line saying which of the
  // memory it was just handed no longer resolves cannot be recovered later.
  const rot = memoryRotNotice(cfg);
  if (rot) parts.push(rot);
  const index = path.join(OUT, "snapgen", "INDEX.md");
  if (fs.existsSync(index)) parts.push("bundlebox reference tables (read instead of searching):\n" + fs.readFileSync(index, "utf8").trim());
  else parts.push("bundlebox: no snapgen tables yet — `bb snapgen build` writes layout, symbols, routes, docs, commands, hot.");
  const open = store.openFindings();
  if (open.length) {
    const by = {};
    for (const f of open) by[f.detector] = (by[f.detector] || 0) + 1;
    parts.push(`open findings: ${open.length} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")}) — \`bb findings\`, \`bb explain <id>\``);
  }
  parts.push("For a task: `bb pinpoint \"<task>\"` writes a located, budgeted brief; `bb context <files>` says whether a scope fits.");
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: capTokens(parts.join("\n\n"), CAPS["session-start"]) } });
}

/** The harness loads CLAUDE.md and the memory files itself, before any hook
 *  runs, and nothing here can stop it. What this CAN do is say which lines in
 *  what it just loaded no longer resolve — a correction, delivered in the same
 *  window as the thing it corrects. That is the cheapest hallucination lever
 *  this box has: the claim is already in the context, stated with the
 *  confidence it earned the day it was true. */
export function rotNotice(diagnostics = [], { max = 4 } = {}) {
  const bad = diagnostics.filter((x) => x.code === "dead-anchor" || x.code === "drifted-anchor");
  const errors = diagnostics.filter((x) => x.severity === "error");
  if (!bad.length && !errors.length) return "";
  const lines = [];
  if (bad.length) {
    lines.push(`memory to distrust: ${bad.length} claim${bad.length === 1 ? "" : "s"} in the loaded memory point at things that no longer exist. Do not quote them without checking:`);
    for (const x of bad.slice(0, max)) lines.push(`  ${x.source}${x.line ? `:${x.line}` : ""} — ${String(x.message).split(" — ")[0]}`);
    if (bad.length > max) lines.push(`  ...${bad.length - max} more — \`bb janitor\``);
  }
  if (errors.length) lines.push(`${errors.length} janitor error${errors.length === 1 ? "" : "s"} (conflicting rules, or a rule about a file that is gone) — \`bb janitor --verbose\``);
  return lines.join("\n");
}

function memoryRotNotice(cfg) {
  if (!cfg.janitor?.notify) return "";
  const raw = janitorArtefact("diagnostics.json", Number(cfg.janitor.max_age_hours) || 168);
  if (!raw) return "";
  let d; try { d = JSON.parse(raw); } catch { return ""; }
  return rotNotice(d.diagnostics || []);
}

/** RULES.md -> the text that goes back into the window, or "" when there is
 *  nothing to restate. Only the bullets: the heading and the count are for a
 *  human reading the file, and the window pays by the token. */
export function restateBand(rulesMarkdown) {
  const body = String(rulesMarkdown || "").split("\n").filter((l) => l.startsWith("- ")).join("\n");
  if (!body.trim()) return "";
  return `bundlebox: the conversation was just compacted. These constraints were in force before it and are restated in full, because a summarised rule is advice:\n${body}`;
}

/** The Compaction Cliff, answered on the one event that is observably able to
 *  put text in the window.
 *
 *  Measured over 396,934 artefacts (arXiv 2608.22752): a safety rule survives
 *  53% of one compaction round and 10% of five, because a summariser cannot
 *  tell a constraint from an anecdote and only the constraint needs its exact
 *  wording. So the round after a compaction, the rules go back in FULL — not
 *  summarised, not paraphrased, straight out of RULES.md.
 *
 *  It fires once per compaction, not once per prompt: the marker records which
 *  compaction has already been answered. Returns true when it emitted, so the
 *  caller does not also spend the prompt budget on a pinpoint nudge. */
function restateRules(payload, cfg) {
  if (!cfg.janitor?.restate_rules) return false;
  let mark; try { mark = JSON.parse(fs.readFileSync(COMPACTED(), "utf8")); } catch { return false; }
  if (!mark || !mark.at) return false;
  const session = String(payload.session_id || "");
  if (session && mark.session_id && mark.session_id !== session) return false;
  if (mark.restated_at && Date.parse(mark.restated_at) >= Date.parse(mark.at)) return false;
  const band = restateBand(janitorArtefact("RULES.md", Number(cfg.janitor.max_age_hours) || 168));
  if (!band) return false;
  try { fs.writeFileSync(COMPACTED(), JSON.stringify({ ...mark, restated_at: now() })); } catch { /* at worst it restates twice */ }
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: capTokens(band, CAPS["restate-rules"]) } });
  return true;
}

const TASK_SHAPED = /\b(fix|add|implement|refactor|change|update|write|remove|migrate|debug|investigate|make|build|wire|optimi[sz]e|ensure|analyse|analyze|audit|port|rename)\b/i;
/** A prompt worth locating. A question, an acknowledgement or a one-word reply
 *  is not, and running the locator on one spends a turn's budget on nothing. */
export const isTask = (p) => String(p).length >= 40 && TASK_SHAPED.test(String(p));

/** The turn this whole box was waiting for.
 *
 *  `bb uptake` on this workspace: pinpoint fired in 3 of the 13 sessions that
 *  opened five or more distinct files, and those 13 opened between 30 and 598
 *  files each. A suggestion in additionalContext is a suggestion — it was
 *  measured, and it loses to the model's own habit about three times in four.
 *
 *  So the hook runs it instead of recommending it. Measured 0.47s on this tree
 *  against a 15s budget, because every input pinpoint reads is a stored
 *  artefact (the symbol tables, the anchors, the oversight scan, the findings)
 *  and it computes none of them.
 *
 *  What enters the window is the MAP, about 300 tokens. The quoted regions stay
 *  on disk until a read asks for one, and `pre-read` serves it then: paying for
 *  every located region on every task prompt would spend the saving on regions
 *  the session never opens. */
async function autoPinpoint(payload, p) {
  const sessionId = String(payload.session_id || "");
  // A brief already standing for this prompt is not rebuilt. The same prompt
  // comes back after a denial, and re-locating it would bill the turn twice.
  const held = brief.current({ maxAgeMin: 45, sessionId });
  if (held && held.problem === p.slice(0, 400)) {
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: capTokens(brief.band(held), CAPS.prompt) } });
    return true;
  }
  const t0 = Date.now();
  const pp = await import("../pinpoint/index.js");
  const b = await pp.build(p, { kind: "fix" });
  const rec = brief.record(b, { sessionId, briefPath: b.path });
  brief.activate(rec);
  brief.prune();
  log("prompt", `pinpoint ${b.scope.length} files, ${b.anchors.length} regions, ${b.verdict} in ${Date.now() - t0}ms`);
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: capTokens(brief.band(rec), CAPS.prompt) } });
  return true;
}

async function prompt(payload) {
  const cfg = load();
  if (restateRules(payload, cfg)) return;
  if (!cfg.wire.inject_context) return;
  const p = String(payload.prompt || payload.user_prompt || "").trim();
  if (!isTask(p)) return;
  if (cfg.wire.auto_pinpoint) {
    try { if (await autoPinpoint(payload, p)) return; }
    catch (e) {
      // A failed locate must not cost the turn its context: fall through to the
      // line this hook has always emitted.
      log("prompt", `auto-pinpoint ${String(e && e.message || e).slice(0, 160)}`);
    }
  }
  const ctx = `bundlebox: before searching, run \`bb pinpoint "${p.slice(0, 120).replace(/"/g, "'")}"\` — it locates the symbols, quotes the regions and budgets the scope for 0 tokens (or call the bb_pinpoint MCP tool).`;
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: capTokens(ctx, CAPS.prompt) } });
}

const capacityOf = (cfg) => Number(cfg.budget.max_tokens) - Number(cfg.budget.reserve_output);
const decide = (event, d, cap) => emit({ hookSpecificOutput: { hookEventName: event, permissionDecision: d.permissionDecision,
  permissionDecisionReason: capTokens(d.permissionDecisionReason, cap) } });

/** Serve the region, then price the file.
 *
 *  The first branch is the new one and it is a DENIAL: pinpoint already located
 *  and quoted this region, so a read of it buys the window nothing it is not
 *  already about to be handed. The reason carries the quote, which is why its
 *  cap is the largest in this file — what it replaces is the whole file.
 *
 *  A file in SCOPE is never fully blocked. Claude Code requires one successful
 *  read of a file before it will edit it, so blocking the scope blocks the
 *  change; the denial says to read the RANGE, and that read is allowed. */
async function preRead(payload) {
  const cfg = load();
  if (!cfg.wire.guard_reads) return;
  const fp = payload?.tool_input?.file_path || payload?.tool_input?.path;
  if (!fp) return;
  if (cfg.wire.serve_from_brief) {
    const rec = brief.current({ maxAgeMin: Number(cfg.wire.brief_max_age_min) || 45, sessionId: String(payload.session_id || "") });
    const v = brief.readVerdict(rec, fp, {
      offset: Number(payload?.tool_input?.offset) || 0, limit: Number(payload?.tool_input?.limit) || 0,
      capacity: capacityOf(cfg), minShare: Number(cfg.wire.serve_min_share) || 0.02,
    });
    if (v) { decide("PreToolUse", v, CAPS["pre-read"]); return; }
  }
  if (payload?.tool_input?.limit) return;                  // a ranged read is already the advice
  const tokens = estimateFile(fp);
  const capacity = capacityOf(cfg);
  if (!tokens || tokens < capacity * 0.35) return;
  // Advisory, never a denial: the agent may need the whole file. But it should know the price.
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    permissionDecisionReason: capTokens(`bundlebox: ${path.basename(fp)} is ~${Math.round(tokens / 1000)}k tokens (${Math.round(100 * tokens / capacity)}% of the working window). Read a range with offset/limit; \`bb pinpoint\` or the bb_pinpoint tool quotes the region you need.`, CAPS["pre-read"]) } });
}

/** The other half of the input axis: a search whose answer is already indexed.
 *
 *  `bb uptake` measures this one too — the snapgen tables were read in 5 of the
 *  15 sessions that ran a search. A declaration search is the case where the
 *  answer is not merely cheaper to look up, it is already written down:
 *  `symbols-*.md` is a name/file/line index rebuilt by fingerprint. So the
 *  denial hands back the matching rows and the search never runs.
 *
 *  What is NOT denied matters as much. A string literal, a call site, a comment,
 *  a pattern no declaration index can answer: the tables have no rows for it,
 *  `tableHits` returns nothing and the search goes through untouched. */
async function preSearch(payload) {
  const cfg = load();
  if (!cfg.wire.guard_searches) return;
  const tool = String(payload.tool_name || "");
  const input = payload.tool_input || {};
  const rec = brief.current({ maxAgeMin: Number(cfg.wire.brief_max_age_min) || 45, sessionId: String(payload.session_id || "") });

  if (tool === "Grep") {
    const v = brief.searchVerdict(rec, input.pattern, { glob: input.glob || "", pathArg: input.path || "", cwd: String(payload.cwd || "") });
    if (v) decide("PreToolUse", v, CAPS["pre-search"]);
    return;
  }
  if (tool !== "Bash") return;
  // Half the reads and searches in the measured transcripts arrive through the
  // shell, not through Read and Grep. A guard that only watches the dedicated
  // tools is a guard that measures its own blind spot.
  const seg = brief.parseBash(input.command);
  if (!seg) return;
  if (seg.kind === "search") {
    const v = brief.searchVerdict(rec, seg.pattern, { pathArg: seg.pathArg || "", cwd: String(payload.cwd || "") });
    if (v) decide("PreToolUse", v, CAPS["pre-search"]);
    return;
  }
  if (!cfg.wire.serve_from_brief) return;
  const v = brief.readVerdict(rec, seg.file, { offset: seg.offset, limit: seg.limit, capacity: capacityOf(cfg), minShare: Number(cfg.wire.serve_min_share) || 0.02 });
  if (v) decide("PreToolUse", v, CAPS["pre-read"]);
}

/** The input axis, and the output axis.
 *
 *  Imported lazily: every other hook on this list runs once per session or once
 *  per prompt, and this one runs once per TOOL CALL, so the cost of loading a
 *  module it will not use is paid hundreds of times. */
async function postTool(payload) {
  const cfg = load();
  if (cfg.sieve?.enabled) {
    const { postTool: run } = await import("../sieve/index.js");
    run(payload);
  }
  if (cfg.slop?.guard_writes) await slopGuard(payload, cfg);
}

/** The prose the AGENT writes, measured by the same rules as the prose bb
 *  writes.
 *
 *  `bb slop` has always existed and every brief, commit message and PR body
 *  this factory emits goes through it. What it never saw was the other half of
 *  the session: the markdown the model writes into the tree, which is read by
 *  the NEXT session and billed again, every time, until somebody deletes it. A
 *  document is the only artefact here that charges rent.
 *
 *  Advisory, and deliberately so. A hedge is sometimes the honest word, and a
 *  hook that rewrites somebody's sentence without being asked is worse than the
 *  sentence. This reports the rule, the line and the token cost, and stops. */
async function slopGuard(payload, cfg) {
  const tool = String(payload.tool_name || "");
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return;
  const fp = String(payload?.tool_input?.file_path || payload?.tool_input?.path || "");
  if (!/\.(md|mdx|markdown|txt|rst)$/i.test(fp)) return;     // prose files only: code has its own detector
  const edits = payload?.tool_input?.edits;
  const written = [payload?.tool_input?.content, payload?.tool_input?.new_string,
    ...(Array.isArray(edits) ? edits.map((e) => e && e.new_string) : [])].filter((x) => typeof x === "string" && x.trim());
  if (!written.length) return;
  const { lint } = await import("../slop/index.js");
  const { text: estimate } = await import("../tokens/estimate.js");
  const r = lint(written.join("\n\n"));
  const max = Number(cfg.slop.max_hits) || 5;
  if (r.count < (Number(cfg.slop.floor) || 3)) return;        // one hedge is a word, not a habit
  const top = Object.entries(r.byRule).sort((a, b) => b[1] - a[1]).slice(0, max);
  const lines = r.hits.slice(0, max).map((h) => `  ${path.basename(fp)}:${h.line} ${h.rule} — "${h.text}"`);
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: capTokens(
    `bundlebox anti-slop: ${r.count} hit${r.count === 1 ? "" : "s"} in what you just wrote to ${path.basename(fp)} (~${human(estimate(written.join("\n"), "prose"))} tokens, re-read and billed by every session after this one).\n${lines.join("\n")}\n${top.map(([k, v]) => `${k} x${v}`).join(", ")} — \`bb slop ${fp}\` for all of them, \`bb slop fix ${fp} --apply\` strips what cannot lose a fact.`,
    CAPS["post-tool"]) } });
}

/** Nothing is emitted from here. Whether a PreCompact hook's stdout reaches the
 *  window after the summary is written is not something this box can observe,
 *  and a mitigation built on a guess is a mitigation that silently does
 *  nothing. So this only leaves a marker, and the next prompt — an event whose
 *  additionalContext IS observable in a transcript — does the work. */
async function preCompact(payload) {
  store.append("episodes", { kind: "hook", verb: "compaction", features: { trigger: payload.trigger || "auto" }, rc: 0, seconds: 0, produced: 0, turns_saved: 0, session_id: payload.session_id || "" });
  if (!load().janitor?.restate_rules) return;
  try {
    ensureDirs();
    fs.writeFileSync(COMPACTED(), JSON.stringify({ session_id: payload.session_id || "", at: now(), trigger: payload.trigger || "auto", restated_at: "" }));
  } catch (e) { log("pre-compact", `marker ${String(e && e.message || e).slice(0, 120)}`); }
}

/** The Stop hook: the fourth verification layer, and the only one that is not
 *  the work reviewing itself.
 *
 *  It executes nothing. What it can say is whether the ledger this work
 *  declared is still sitting there with gates unmet — the one question a
 *  session about to report "done" cannot answer about itself. Silent when there
 *  is no ledger, because a workspace that never declared a bar has not failed
 *  to meet one. */
async function stop(payload) {
  const cfg = load();
  if (!cfg.finish?.stop_hook) return;
  const { LEDGER, stopHook } = await import("../finish/index.js");
  if (!fs.existsSync(LEDGER())) return;
  const r = stopHook(JSON.stringify(payload || {}));
  const text = String(r.out || "").trim();
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  else if (r.err) log("stop", `checker ${String(r.err).slice(0, 160)}`);
}

async function sessionEnd(payload) {
  const cfg = load();
  if (cfg.wire.measure_sessions) {
    const { end } = await import("../tokens/session.js");
    const line = await end({ sessionId: payload.session_id || "", transcriptPath: payload.transcript_path || "" });
    if (line) process.stderr.write(String(line).trim() + "\n");   // stderr: shown to the person, never parsed by the harness
  }
  // Sleep-time compute, in the sense Letta uses it: the memory work happens
  // outside the session that pays for it. This is also the only moment the mark
  // pass has a complete transcript to trace reachability from — during the
  // session the file it needs is still being written.
  // The per-session brief record goes with the session that owned it. Age is
  // the only signal a hook has for the ones whose sessions never reached this
  // handler.
  try { brief.sweep(); } catch { /* a stale record expires on its own */ }
  if (!cfg.janitor?.refresh) return;
  try {
    const { build } = await import("../janitor/index.js");
    const { emit: writeOut } = await import("../janitor/emit.js");
    const b = await build({ budget: Number(cfg.janitor.budget) || undefined });
    writeOut({ ...b, apply: true });
    log("session-end", `janitor ${b.stats.parsed} objects, ${b.stats.errors}E ${b.stats.warnings}W`);
  } catch (e) {
    // A failed refresh costs the next session a fresher heap, never the session
    // that is ending. The stale guard on the read side handles the rest.
    log("session-end", `janitor ${String(e && e.message || e).slice(0, 160)}`);
  }
}

export async function handle(event) {
  const payload = readStdin();
  const t0 = Date.now();
  try {
    if (event === "session-start") await sessionStart(payload);
    else if (event === "prompt") await prompt(payload);
    else if (event === "pre-read") await preRead(payload);
    else if (event === "pre-search") await preSearch(payload);
    else if (event === "post-tool") await postTool(payload);
    else if (event === "pre-compact") await preCompact(payload);
    else if (event === "stop") await stop(payload);
    else if (event === "session-end") await sessionEnd(payload);
    else log(event || "(none)", "unknown event");
    log(event, `ok ${Date.now() - t0}ms`);
  } catch (e) {
    log(event, `error ${String(e && e.message || e).slice(0, 200)}`);
  }
  return 0;   // always
}
export const EVENTS = ["session-start", "prompt", "pre-read", "pre-search", "post-tool", "pre-compact", "stop", "session-end"];
