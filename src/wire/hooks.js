// hooks.js — `bb hook <event>`: the handlers an agent's hook system calls.
//
// Contract: read the payload on stdin (any shape, possibly empty), print at
// most one JSON object on stdout, ALWAYS exit 0 within the budget. A reporting
// hook that can fail a session is a reporting hook that will eventually fail
// a session. Failures are appended to .bundlebox/var/hooks.log so a hook that
// stopped working is visible somewhere, unlike the original's `2>/dev/null`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VAR, OUT, ROOT, PKG_ROOT, ensureDirs } from "../core/paths.js";
import { load } from "../core/config.js";
import * as store from "../core/store.js";
import { text as estimateText, file as estimateFile } from "../tokens/estimate.js";
import { now, human } from "../core/util.js";
import * as brief from "./brief.js";
import * as narrative from "./narrative.js";
import * as expert from "../core/expert.js";

// A cap is what a band may cost, not what it should. `pre-read` and
// `pre-search` are the two that carry an ANSWER rather than a pointer, so they
// are the two allowed to be expensive: what they replace is the whole file or
// the whole search.
export const CAPS = { "session-start": 600, prompt: 1000, "pre-read": 900, "pre-write": 900, "pre-search": 500, "post-tool": 300, "restate-rules": 700, narrative: 1200 };

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

/** Manifests that make a directory a project rather than a place someone
 *  happened to open a terminal. One level down as well, because a workspace of
 *  subrepos carries its manifests in the children and not at the top — the same
 *  case `detectRepo` already handles for `bb init`. */
const MANIFESTS = ["package.json", "go.mod", "pyproject.toml", "Cargo.toml", "pom.xml", "build.gradle",
  "build.gradle.kts", "Gemfile", "composer.json", "requirements.txt", "mix.exs", "pubspec.yaml", "CMakeLists.txt"];

/** Is this root worth writing a `.bundlebox` into?
 *
 *  The cost of being wrong is asymmetric and the directions are not symmetric
 *  either. Declining to init a real project costs one line of advice the session
 *  can act on. Initing a home directory, a mount point or `/tmp` scatters a
 *  state directory somewhere nobody asked for it and starts a background build
 *  over a tree that is not a codebase. So: refuse the obvious non-projects by
 *  name, then require positive evidence — a git worktree, or a manifest at the
 *  root or one level under it. */
function looksLikeProject(root) {
  const home = os.homedir();
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === home) return "";
  if (resolved === os.tmpdir() || resolved.startsWith(os.tmpdir() + path.sep)) return "";
  if (fs.existsSync(path.join(resolved, ".git"))) return "git worktree";
  for (const m of MANIFESTS) if (fs.existsSync(path.join(resolved, m))) return m;
  let kids = [];
  try { kids = fs.readdirSync(resolved, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).slice(0, 40); }
  catch { return ""; }
  for (const k of kids) for (const m of MANIFESTS) if (fs.existsSync(path.join(resolved, k.name, m))) return `${k.name}/${m}`;
  return "";
}

/** A session that opens where no environment exists gets one, before it does
 *  anything else.
 *
 *  Every other surface in this box assumes `.bundlebox` is there: the tables the
 *  session reads instead of searching, the brief the guards answer from, the
 *  findings the prompt hook cites. In a workspace that was never inited all of
 *  them are absent, none of them says so, and the session does what a session
 *  with no environment has always done — it searches the tree. Advising `bb
 *  init` in that window loses to the model's own habit about three times in
 *  four, which is the measurement this release was built on. So the hook runs
 *  it.
 *
 *  Two halves, split by what they cost. `bb init` is detection over the tree and
 *  finishes in well under the 30s SessionStart budget, so it runs inline and the
 *  session is told what it now has. Building the artefacts is minutes of
 *  scanning, indexing and rendering, which is not a hook's to spend — it is
 *  detached, and the returned line says it is still building rather than
 *  implying the environment is ready. */
async function autoInit(cfg) {
  if (cfg.wire.auto_init === false) return "";
  if (fs.existsSync(path.join(ROOT, ".bundlebox", "config.json"))) return "";
  const why = looksLikeProject(ROOT);
  if (!why) return "";
  const log_ = (m) => log("session-start", `auto-init ${m}`);
  const { setMode } = await import("../core/log.js");
  try {
    // The hook's stdout is a protocol, not a terminal: `bb init` prints a
    // report, and one line of it on this channel is a malformed hook response.
    setMode({ quiet: true, json: false });
    const init = await import("../init.js");
    await init.commands.init.run({ _: [], flags: {} });
  } catch (e) { log_(`failed: ${String(e && e.message || e).slice(0, 120)}`); return ""; }
  finally { setMode({ quiet: false, json: false }); }
  if (!fs.existsSync(path.join(ROOT, ".bundlebox", "config.json"))) { log_("wrote nothing"); return ""; }
  let building = false;
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [path.join(PKG_ROOT, "bin", "bb.js"), "env", "up", "--apply", "--quiet"],
      { cwd: ROOT, detached: true, stdio: "ignore" });
    child.unref();
    building = true;
  } catch (e) { log_(`env up did not start: ${String(e && e.message || e).slice(0, 120)}`); }
  log_(`inited (${why})${building ? ", env up running" : ""}`);
  return `bundlebox: no environment here, so one was just created — \`.bundlebox/config.json\` written (${why}).`
    + (building
      ? " The reference tables, findings, oversight and worklist are building in the background; they are not ready this second."
        + " Re-run `bb env`, or call `bb_pinpoint` for the task, before searching the tree."
      : " Run `bb env up --apply` to build the tables, findings and worklist — locally, no tokens.");
}

async function sessionStart(payload = {}) {
  const cfg = load();
  // Claude Code fires SessionStart with `source: "compact"` right after a
  // compaction, before the next prompt. That is the first observable moment
  // the window can be corrected, and the record goes back here rather than
  // one prompt later. The marker keeps the prompt from doing it twice.
  if (String(payload.source || "") === "compact") {
    if (restateAfterCompaction(payload, cfg, "SessionStart")) return;
    // No marker (a harness with no PreCompact hook): still the same moment,
    // and the record is still on disk, just not frozen.
    const bands = compactionBands(cfg, { sessionId: String(payload.session_id || "") });
    if (bands.length) { emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: bands.join("\n\n") } }); return; }
  }
  const created = await autoInit(cfg);
  if (!cfg.wire.inject_context) {
    // `auto_init` is not a context-injection feature and does not switch off
    // with one. A workspace that was just created has to say so, or the session
    // is handed an environment it has no reason to believe exists.
    if (created) emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: created } });
    return;
  }
  const parts = [];
  if (created) parts.push(created);
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
/** The two bands that go back after a compaction, each under its own cap.
 *
 *  The narrative first: it is the WORK — task, scope, what was edited, what
 *  ran, what gate is open — read off the record the guards wrote, never off
 *  the summary. The rules second, verbatim. Two caps, because truncating from
 *  the end of one joined band would cut the rules to keep the narrative or
 *  the other way round, and neither is the right thing to lose. */
export function compactionBands(cfg, { sessionId = "" } = {}) {
  const out = [];
  if (cfg.janitor?.narrative !== false) {
    const n = narrative.afterCompaction({ sessionId });
    if (n) out.push(capTokens(n, CAPS.narrative));
  }
  if (cfg.janitor?.restate_rules) {
    const r = restateBand(janitorArtefact("RULES.md", Number(cfg.janitor.max_age_hours) || 168));
    if (r) out.push(capTokens(r, CAPS["restate-rules"]));
  }
  return out;
}

/** Once per compaction: the marker says which compaction was answered, so a
 *  SessionStart(compact) that already restated leaves nothing for the prompt
 *  to do, and a harness with no SessionStart(compact) gets it at the prompt. */
function restateAfterCompaction(payload, cfg, hookEventName) {
  if (!cfg.janitor?.restate_rules && cfg.janitor?.narrative === false) return false;
  let mark; try { mark = JSON.parse(fs.readFileSync(COMPACTED(), "utf8")); } catch { return false; }
  if (!mark || !mark.at) return false;
  const session = String(payload.session_id || "");
  if (session && mark.session_id && mark.session_id !== session) return false;
  if (mark.restated_at && Date.parse(mark.restated_at) >= Date.parse(mark.at)) return false;
  const bands = compactionBands(cfg, { sessionId: session });
  if (!bands.length) return false;
  try { fs.writeFileSync(COMPACTED(), JSON.stringify({ ...mark, restated_at: now(), restated_on: hookEventName })); } catch { /* at worst it restates twice */ }
  emit({ hookSpecificOutput: { hookEventName, additionalContext: bands.join("\n\n") } });
  return true;
}
const restateRules = (payload, cfg) => restateAfterCompaction(payload, cfg, "UserPromptSubmit");

const TASK_SHAPED = /\b(fix|add|implement|refactor|change|update|write|remove|migrate|debug|investigate|make|build|wire|optimi[sz]e|ensure|analyse|analyze|audit|port|rename)\b/i;
/** A prompt worth locating. A question, an acknowledgement or a one-word reply
 *  is not, and running the locator on one spends a turn's budget on nothing.
 *
 *  prompt4.md F1: the regex above fired 3 times in one session and all 3 were
 *  questions about a design, each costing the window an edit scope and a gate
 *  it had no use for. So the regex is now ONE feature of a fitted head, not
 *  the decision. `task-head.json` is a coefficient table `model.py` fitted on
 *  this workspace's own join — the prompt the hook fired on, against whether
 *  that session went on to edit a file — held out by time, and it carries
 *  `useful` only when it beat the base rate on that holdout. Below the head's
 *  threshold the hook emits nothing. With no head, or a head that did not beat
 *  the base rate, or a head whose features this file no longer computes the
 *  same way, the regex decides exactly as before. */
export const TASK_HEAD = () => path.join(VAR, "task-head.json");
const TASK_VERBS = new Set(["fix", "add", "implement", "refactor", "change", "update", "write", "remove", "migrate", "debug",
  "investigate", "make", "build", "wire", "optimise", "optimize", "ensure", "analyse", "analyze", "audit", "port", "rename"]);
/** Mirrors `prompt_featurize` in `expert/bundlebox_expert/model.py` line for
 *  line. The table carries three probe prompts with their features so a drift
 *  between the two is detected at load, not guessed at. */
export function promptFeatures(prompt) {
  const s = String(prompt || "").trim();
  const words = s.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  const first = words.length ? words[0].toLowerCase() : "";
  return {
    "@bias": 1,
    "len~log": Math.round(Math.log1p(s.length) / 10 * 10000) / 10000,
    task_shaped: TASK_SHAPED.test(s) ? 1 : 0,
    imperative: TASK_VERBS.has(first) ? 1 : 0,
    question: s.includes("?") ? 1 : 0,
    path: /[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(js|py|rs|md|json|ts)\b/.test(s) ? 1 : 0,
    symbol: /`[^`]+`|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z]+_[a-z0-9_]+\b/.test(s) ? 1 : 0,
    bb_verb: /\bbb [a-z]+/.test(s) ? 1 : 0,
    pasted: s.includes("<pasted_content") ? 1 : 0,
  };
}
const same = (a, b) => Object.keys({ ...a, ...b }).every((k) => Math.abs(Number(a[k] || 0) - Number(b[k] || 0)) < 1e-6);
let _head;
/** The fitted head, with `drift` set when its probes disagree with
 *  `promptFeatures`. Cached per process; a hook is one process. */
export function taskHead() {
  if (_head !== undefined) return _head;
  try {
    const h = JSON.parse(fs.readFileSync(TASK_HEAD(), "utf8"));
    if (h && typeof h === "object") h.drift = (h.probes || []).some((pr) => !same(pr.features || {}, promptFeatures(pr.prompt)));
    _head = h && typeof h === "object" ? h : null;
  } catch { _head = null; }
  return _head;
}
export const resetTaskHead = () => { _head = undefined; };
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
/** P(this prompt is a task) under the head. */
export function taskScore(prompt, head = taskHead()) {
  const x = promptFeatures(prompt), w = (head && head.weights) || {};
  return sigmoid(Object.entries(x).reduce((a, [k, v]) => a + (Number(w[k]) || 0) * v, 0));
}
export const isTask = (p) => {
  const s = String(p);
  const h = taskHead();
  if (h && h.useful && !h.drift) return taskScore(s, h) >= Number(h.threshold ?? 0.2);
  return s.length >= 40 && TASK_SHAPED.test(s);
};

/** The join the head trains on (prompt4.md W1): every prompt the hook located,
 *  against whether the SAME session later wrote a file. Both sides are already
 *  on disk — the brief log carries the prompt, the transcripts carry the
 *  edits — and a session whose transcript this box cannot see is not a
 *  negative, it is unlabelled, so it is not a row. */
export async function taskRows() {
  const echos = await import("../echos/index.js");
  const t = echos.transcriptEvents({});
  const seen = new Set(), edits = new Map();
  for (const e of t.events) {
    if (!e.session) continue;
    seen.add(e.session);
    if (e.kind === "edit") { if (!edits.has(e.session)) edits.set(e.session, []); edits.get(e.session).push(e.at || 0); }
  }
  const rows = [];
  for (const r of brief.logged({})) {
    const sid = String(r.session_id || "");
    if (!sid || !r.problem || !seen.has(sid)) continue;
    const at = Date.parse(r.at || "") || 0;
    rows.push({ prompt: String(r.problem), at: r.at || "", session: sid,
      edited: (edits.get(sid) || []).some((x) => x >= at - 60000) ? 1 : 0 });
  }
  return { rows, unseen: t.unseen || [] };
}
/** Fit the head and write the table, useful or not: a table that says
 *  "n=7, base rate, need 12" is what `bb uptake` and `bb doctor` print, and
 *  the regex keeps deciding until the table says otherwise. */
export async function fitTaskHead({ write = true } = {}) {
  const { rows, unseen } = await taskRows();
  const m = expert.call("model-train-prompts", { rows });
  if (!m) return { useful: false, n: rows.length, why: expert.lastError || "python3 required", fires: rows.length, edited: rows.filter((r) => r.edited).length };
  m.fitted_at = now();
  m.unseen = unseen.length;
  m.sessions = new Set(rows.map((r) => r.session)).size;
  if (write) { try { fs.writeFileSync(TASK_HEAD(), JSON.stringify(m)); } catch { /* the next session-end writes it */ } }
  resetTaskHead();
  return m;
}

/** The symbol space (prompt4.md W3), rebuilt when any `symbols-*.md` is newer
 *  than the table. 1.6s measured on this tree for 2,945 rows; a sleep-time
 *  cost, never a prompt-time one. */
export async function buildSpace({ force = false } = {}) {
  const rank = await import("../pinpoint/rank.js");
  const dir = path.join(OUT, "snapgen");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^symbols-.*\.md$/.test(n)); } catch { return { built: false, why: "no symbol tables" }; }
  if (!names.length) return { built: false, why: "no symbol tables" };
  const newest = Math.max(...names.map((n) => { try { return fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } }));
  let have = 0; try { have = fs.statSync(rank.SPACE()).mtimeMs; } catch { /* none yet */ }
  if (!force && have >= newest) return { built: false, why: "current", tables: names.length };
  const tables = {}; for (const n of names) { try { tables[n] = fs.readFileSync(path.join(dir, n), "utf8"); } catch { /* one table */ } }
  const t0 = Date.now();
  const sp = expert.call("space-build", { tables });
  if (!sp) return { built: false, why: expert.lastError || "python3 required" };
  sp.built_at = now(); sp.tables = names;
  try { fs.writeFileSync(rank.SPACE(), JSON.stringify(sp)); } catch (e) { return { built: false, why: e.message }; }
  rank.resetSpace();
  return { built: true, rows: sp.n_rows, terms: sp.n_terms, k: sp.k, ms: Date.now() - t0, useful: sp.useful };
}

/** The finding head (prompt4.md W2): fit on the older 80% of the labelled
 *  findings, replayed against `PRECISION` on the newer 20%. Written with its
 *  sample size either way; `useful` only when it beat the constant. */
export const CONFIDENCE_HEAD = () => path.join(VAR, "confidence-head.json");
export function fitConfidenceHead({ write = true } = {}) {
  let findings = [];
  try { const j = JSON.parse(fs.readFileSync(path.join(VAR, "findings.json"), "utf8")); findings = Array.isArray(j) ? j : (j.findings || []); } catch { return { useful: false, why: "no findings" }; }
  const r = expert.call("confidence-fit", { findings });
  if (!r) return { useful: false, why: expert.lastError || "python3 required" };
  r.fitted_at = now();
  if (write) { try { fs.writeFileSync(CONFIDENCE_HEAD(), JSON.stringify(r)); } catch { /* next time */ } }
  return r;
}

/** Sleep-time fits, on the session-end budget with the lathe and the echos:
 *  the session that produced the rows does not pay for learning from them,
 *  and nothing here reaches a window. Each is a coefficient table, not a
 *  model dependency; each refuses to steer until it beats its base rate. */
export async function fits({ cfg = load() } = {}) {
  const out = {};
  if (cfg.wire?.fit_heads === false) return out;
  try { const h = await fitTaskHead(); out.task = h; log("session-end", `task head n=${h.n ?? 0} ${h.useful ? `fitted, threshold ${h.threshold}` : `base rate (${h.why})`}`); }
  catch (e) { log("session-end", `task head ${String(e && e.message || e).slice(0, 160)}`); }
  try { const sp = await buildSpace(); out.space = sp; if (sp.built) log("session-end", `symbol space ${sp.rows} rows, ${sp.terms} terms, k=${sp.k} in ${sp.ms}ms`); }
  catch (e) { log("session-end", `symbol space ${String(e && e.message || e).slice(0, 160)}`); }
  try { const c = fitConfidenceHead(); out.confidence = c; log("session-end", `confidence head n=${c.acted_on ?? 0} acted_on ${c.useful ? "beats PRECISION" : `(${c.why})`}`); }
  catch (e) { log("session-end", `confidence head ${String(e && e.message || e).slice(0, 160)}`); }
  // The intent table. Fitted here and nowhere else: this is the only budget in
  // the box that may call Jev, and sleep time is the only place a remote model
  // is allowed to cost anything.
  try {
    const { fit } = await import("../intent/index.js");
    const i = await fit();
    out.intent = i;
    log("session-end", `intent table n=${i.n ?? 0} ${i.useful ? `fitted, ${(i.useful_kinds || []).join("/")} decide` : `fallback (${i.why})`}`);
  } catch (e) { log("session-end", `intent table ${String(e && e.message || e).slice(0, 160)}`); }
  return out;
}

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
  const [pp, intent] = await Promise.all([import("../pinpoint/index.js"), import("../intent/index.js")]);
  // The kind is the budget: it picks this turn's output reserve, and the reserve
  // is what capacity() does NOT spend on scope. `classify` is arithmetic over a
  // stored table — no network, no model, no clock — so it costs the turn nothing
  // and returns `fix` unchanged when no table has been fitted yet.
  const it = intent.classify(p);
  const b = await pp.build(p, { kind: it.kind });
  const rec = brief.record(b, { sessionId, briefPath: b.path });
  brief.activate(rec);
  brief.prune();
  // Recorded so `bb tokens calibrate` can group measured output by kind. A
  // located prompt is not a unit, so it has no episode, so without this row the
  // reserve table is only ever checked against the lanes that ran.
  intent.record({ session_id: sessionId, kind: it.kind, p: it.p, via: it.via });
  log("prompt", `pinpoint ${b.scope.length} files, ${b.anchors.length} regions, ${b.verdict}, kind ${it.kind} (${it.via}) in ${Date.now() - t0}ms`);
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
    const v = brief.searchVerdict(rec, seg.pattern, { pathArg: seg.pathArg || "", cwd: String(payload.cwd || ""), stdin: Boolean(seg.stdin) });
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
  if (cfg.lathe?.record_shapes) await recordShape(payload, cfg);
  if (cfg.grapple?.enabled !== false) await grappleObserve(payload);
}

/** grapple's counters, fed for free: sixty bytes per tool call, no decision.
 *  Everything `bb grapple` scores as drift is read back from this row. */
async function grappleObserve(payload) {
  try { const d = await import("../grapple/detect.js"); d.observeTool(payload); }
  catch (e) { log("post-tool", `grapple ${String(e && e.message || e).slice(0, 120)}`); }
}

/** The one blocking check grapple adds, at the one moment the agent has
 *  committed nothing: a write outside the brief's scope list.
 *
 *  In `observe` phase this records the verdict it would have returned and
 *  emits NOTHING — no decision, no bytes — so the session behaves exactly as
 *  it did before grapple existed, and the recorded verdicts are the base rate
 *  the enforce phase is gated on. In `enforce` the verdict is emitted within
 *  the `pre-write` cap, bounded like every other band in this file. */
export async function preWrite(payload) {
  const cfg = load();
  // detect.js and store.js only: this runs once per write, and the rest of the
  // grapple graph (the expert bridge, the harvest, child_process) is the CLI's.
  const [detect, gstore] = await Promise.all([import("../grapple/detect.js"), import("../grapple/store.js")]);
  const s = gstore.settings(cfg);
  if (s.phase === "off") return null;
  const fp = payload?.tool_input?.file_path || payload?.tool_input?.path || payload?.tool_input?.notebook_path;
  if (!fp) return null;
  const rec = brief.current({ maxAgeMin: Number(cfg.wire.brief_max_age_min) || 45, sessionId: String(payload.session_id || "") });
  const v = detect.writeVerdict(rec, fp);
  if (!v) return null;
  gstore.record("write_verdict", { session_id: String(payload.session_id || ""), file: String(fp), decision: v.permissionDecision, phase: s.phase, emitted: s.phase === "enforce" });
  if (s.phase !== "enforce") return null;
  decide("PreToolUse", v, CAPS["pre-write"]);
  return v;
}

/** The automation engine's input, recorded when it is free.
 *
 *  `bb lathe` needs the ORDER of the commands a session ran. Mining that out of
 *  the transcripts took four minutes of wall clock for 4.8 seconds of CPU —
 *  1.4GB of JSONL parsed in full to recover one string per tool call. This hook
 *  is already running on every tool call, so appending forty bytes here is the
 *  cheapest place in the system to learn the same fact.
 *
 *  The SHAPE only: `git commit`, never the message. The argument is the part
 *  that differs every time, so it is never the habit, and a log of shapes
 *  cannot carry a secret somebody passed on a command line. */
async function recordShape(payload, cfg) {
  if (String(payload.tool_name || "") !== "Bash") return;
  const [rec, lathe] = await Promise.all([import("../lathe/record.js"), import("../lathe/index.js")]);
  const n = rec.record(payload, { shapesOf: lathe.commandShapes });
  if (n && Math.random() < 0.01) rec.rotate({ max: Number(cfg.lathe.max_rows) || rec.MAX_ROWS });
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
  const cfg = load();
  if (!cfg.janitor?.restate_rules && cfg.janitor?.narrative === false) return;
  // Freeze the record NOW, so what goes back after the summary is written
  // describes the same moment the summary does and not a later one.
  let frozen = "";
  if (cfg.janitor?.narrative !== false) {
    try { frozen = narrative.write({ sessionId: String(payload.session_id || "") }); }
    catch (e) { log("pre-compact", `narrative ${String(e && e.message || e).slice(0, 120)}`); }
  }
  try {
    ensureDirs();
    fs.writeFileSync(COMPACTED(), JSON.stringify({ session_id: payload.session_id || "", at: now(), trigger: payload.trigger || "auto", restated_at: "", narrative: frozen }));
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
    const r = await end({ sessionId: payload.session_id || "", transcriptPath: payload.transcript_path || "" });
    // `end` returns {line, wrote, measure}. Stringifying the object printed
    // "[object Object]" at the end of every session; the line is the one field
    // meant for a person to read.
    const line = r && typeof r === "object" ? r.line : r;
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
  // grapple's sleep-time pass, for the same reason as lathe's below: the
  // harvest and the tally read rows already on disk, and the session that
  // paid for the turns should not pay for learning from them. Nothing is
  // emitted from here; a session-end hook has no window to reach.
  if (cfg.grapple?.enabled !== false) {
    try { const g = await import("../grapple/index.js"); const s = g.observe({ session: String(payload.session_id || ""), cfg }); log("session-end", `grapple ${s.queue.open} open question(s), ${s.labels.n} label(s), drift ${s.drift.score}`); }
    catch (e) { log("session-end", `grapple ${String(e && e.message || e).slice(0, 160)}`); }
  }
  // Sleep-time compute, alongside the janitor's recompile and for the same
  // reason: the model wants what this session did, and the session that pays
  // for a turn should not pay for learning from it. 1.4s measured on this tree,
  // because it reads the recorded shapes and not the transcripts.
  if (cfg.lathe?.learn_on_end) {
    try {
      const lathe = await import("../lathe/index.js");
      const m = await lathe.learn();
      if (m.error) log("session-end", `lathe ${m.error}`);
      else {
        const em = await import("../lathe/emit.js");
        const r = await em.all(m, { apply: true });
        log("session-end", `lathe ${m.sequence.verbs.length} verb + ${m.sequence.shell.length} shell habit(s), ${r.rows.filter((x) => x.state === "wrote").length} artefact(s)`);
        // The actuator half. `reach` is free and always runs — it reads the
        // shapes the learn pass just read — so a script that displaced nothing
        // is visible without anybody asking. Writing into `scripts/` is a
        // stronger act and stays behind `lathe.apply_on_end`: a hook that adds
        // files to somebody's repository unasked is a hook they turn off.
        const act = await import("../lathe/apply.js");
        if (cfg.lathe.apply_on_end) {
          const s = await act.sweep(m, { apply: true, cfg });
          log("session-end", `lathe applied ${s.applied.rows.filter((x) => x.state === "wrote" || x.state === "updated").length}, tombstoned ${s.tombstoned.length}`);
        } else {
          const reach = act.reach({ cfg });
          if (reach.losing) log("session-end", `lathe ${reach.losing} applied script(s) have displaced nothing — \`bb lathe sweep --apply\``);
        }
      }
    } catch (e) { log("session-end", `lathe ${String(e && e.message || e).slice(0, 160)}`); }
  }
  // The echos, on the same sleep-time budget as the janitor and the lathe: the
  // session that produced the rows should not pay for reading them. Nothing is
  // emitted into the window — this session is over — so what it does is file
  // the findings, and the NEXT session opens with them in `bb findings`.
  if (cfg.echos?.enabled !== false && cfg.echos?.on_session_end) {
    try {
      const echos = await import("../echos/index.js");
      const r = await echos.run({ cfg });
      echos.write(r);
      const filed = echos.file(r);
      log("session-end", `echos ${r.hits} hit(s) over ${r.sessions} session(s), ${filed} filed (${r.engine})`);
    } catch (e) { log("session-end", `echos ${String(e && e.message || e).slice(0, 160)}`); }
  }
  // The three fitted heads of prompt4.md, on the same sleep-time budget.
  await fits({ cfg });
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

export async function handle(event) { return handleEvent(event, readStdin()); }

/** One event with its payload already in hand: what `handle` does after
 *  reading stdin, and what a test calls without a stdin to read. */
export async function handleEvent(event, payload = {}) {
  const t0 = Date.now();
  try {
    if (event === "session-start") await sessionStart(payload);
    else if (event === "prompt") await prompt(payload);
    else if (event === "pre-read") await preRead(payload);
    else if (event === "pre-write") await preWrite(payload);
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
export const EVENTS = ["session-start", "prompt", "pre-read", "pre-write", "pre-search", "post-tool", "pre-compact", "stop", "session-end"];
