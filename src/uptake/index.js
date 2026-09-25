// uptake/index.js — `bb uptake`: of everything this box installed in front of
// the agents, what did the sessions actually reach for?
//
// `bb wire` writes an instructions block, an MCP entry and a set of hooks into
// every agent on the box, and `bb wire status` then reports that they are
// installed. Installed is not the same claim as used. The block sits in every
// session's window and is billed on every turn whether the agent obeys it or
// not, so a block nothing reaches for is not neutral: it is the most expensive
// kind of dead code this factory can write.
//
// The method is borrowed from skill evaluation, where the same gap exists
// between "the skill is on disk" and "the agent chose it": install it where the
// agent looks, then read the transcript for evidence that it was reached for.
// Three rules come with it and all three are kept here.
//
//   1. A surface that cannot be OBSERVED reports unknown, never zero. The
//      instructions block and the SessionStart context arrive in the system
//      prompt, which is not a turn, so no transcript can tell you whether they
//      were read. Printing 0% for those would be a measurement of nothing.
//   2. A denominator is an OPPORTUNITY, not a session count. `bb pinpoint`
//      exists to be called before a session starts opening files, so the
//      sessions that never opened a file are not sessions that ignored it.
//   3. A miss is reported with its evidence. "pinpoint fired in 1 of 9" is a
//      number; "session abc read 23 files and never called it" is a finding.
//
// Zero tokens: every input is a transcript that already exists on disk.
import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT, VAR, rel } from "../core/paths.js";
import { load } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { human, pad, table } from "../core/util.js";
import * as ledger from "../tokens/ledger.js";
import { text as estimateText } from "../tokens/estimate.js";
import { instructions } from "../wire/agents.js";

/** Distinct files a session opens before `bb pinpoint` would have paid for
 *  itself. Five is the point at which the packed brief is smaller than the
 *  reads; below it a session that just opened what it was told to open is not
 *  a session that ignored anything. It is a parameter and the report prints it. */
export const READ_FLOOR = 5;

const SNAPGEN = () => path.join(OUT, "snapgen");
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };  // absence is the answer

/** Commands that open a file, and commands that search for one. A session that
 *  runs `sed -n 1,80p src/x.js` has opened a file exactly as much as one that
 *  called Read, and counting only the tool would report a shell-first session
 *  as a session that never opened anything. */
const OPENERS = new Set(["cat", "head", "tail", "sed", "bat", "less", "more", "nl"]);
const SEARCHERS = new Set(["grep", "rg", "ag", "ack", "find", "fd", "tree"]);

/** A heredoc body is text being WRITTEN, not commands being run. Left in, every
 *  document this box writes about itself reads as a session running `bb`. */
const stripHeredocs = (cmd) => cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^\1\s*$/gm, " ");

/** One shell command -> the segments a shell would actually execute. */
export function segments(cmd) {
  return stripHeredocs(String(cmd))
    .split(/\n|;|\|\||&&|(?<!\|)\|(?!\|)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first word of a segment, with `sudo`, `time` and an env prefix skipped. */
function head(seg) {
  const words = seg.split(/\s+/).filter((w) => !/^\w+=/.test(w));
  let i = 0;
  while (i < words.length && ["sudo", "time", "env", "npx", "exec"].includes(words[i])) i++;
  return { cmd: (words[i] || "").replace(/^.*\//, ""), args: words.slice(i + 1) };
}

/** Is this segment an invocation of bb, and of which verb? `node bin/bb.js x`
 *  counts: it is how this repo runs itself before it is installed. */
function bbVerb(seg) {
  const w = seg.split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  if (w[0] === "bb" || w[0] === "bundlebox") return /^[a-z][a-z-]*$/.test(w[1] || "") ? w[1] : "";
  if (w[0] === "node" && /bb\.js$/.test(w[1] || "")) return /^[a-z][a-z-]*$/.test(w[2] || "") ? w[2] : "";
  return "";
}

/** Every string in a tool input, however deeply the agent nested it. */
function strings(v, depth = 0) {
  if (depth > 4) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap((x) => strings(x, depth + 1));
  if (v && typeof v === "object") return Object.values(v).flatMap((x) => strings(x, depth + 1));
  return [];
}

const TABLE_PATH = /(^|[^\w])(\.bundlebox[/\\]out[/\\]snapgen|out[/\\]snapgen)/;

/** What one session did, in the only terms these surfaces are about.
 *
 *  Reads and searches are counted through BOTH the tools and the shell, because
 *  which of the two a session uses is a harness setting, not a fact about
 *  whether it opened a file. */
export function observe(turns) {
  const o = { shell: 0, searches: 0, opens: 0, bbVerbs: [], mcp: [], snapgen: 0 };
  const paths = new Set();
  for (const t of turns) {
    for (const u of t.toolUses || []) {
      const name = String(u.name || "");
      if (name.startsWith("mcp__") && /bundlebox/.test(name)) o.mcp.push(name.replace(/^mcp__[^_]*__/, ""));
      else if (/^bb_[a-z_]+$/.test(name)) o.mcp.push(name);

      if (name === "Grep" || name === "Glob" || name === "Search") o.searches += 1;
      else if (name === "Read" || name === "NotebookRead") {
        const p = String(u.input?.file_path || u.input?.path || "");
        o.opens += 1;
        if (p) paths.add(p);
        if (TABLE_PATH.test(p)) o.snapgen += 1;
      } else if (name === "Bash" || name === "BashOutput") {
        o.shell += 1;
        for (const seg of segments(u.input?.command || "")) {
          const verb = bbVerb(seg);
          if (verb) { o.bbVerbs.push(verb); continue; }
          const { cmd, args } = head(seg);
          if (SEARCHERS.has(cmd)) o.searches += 1;
          else if (OPENERS.has(cmd)) {
            o.opens += 1;
            const file = args.filter((a) => !a.startsWith("-") && /[./]/.test(a)).pop();
            if (file) paths.add(file);
          }
          if (TABLE_PATH.test(seg)) o.snapgen += 1;
        }
      }
      if (name !== "Bash" && name !== "BashOutput" && strings(u.input).some((s) => TABLE_PATH.test(s))) o.snapgen += 1;
    }
  }
  return { ...o, files: paths.size };
}

/** Session ids the UserPromptSubmit hook located a task for.
 *
 *  The brief record is the evidence, and it is the only evidence there can be:
 *  a hook leaves no turn in a transcript, so a locator that runs itself would
 *  otherwise be invisible to the verb whose whole job is saying whether the
 *  surface was reached for. Automating a surface must not make it unmeasurable. */
export function briefedSessions() {
  const out = new Set();
  const dir = path.join(ROOT, ".bundlebox", "var", "brief");
  try {
    for (const n of fs.readdirSync(dir)) if (n.endsWith(".json")) out.add(n.replace(/\.json$/, ""));
  } catch { /* no records yet */ }
  return out;
}

/** The surfaces `bb wire` installs, each with what would count as firing and
 *  what would count as the chance to fire.
 *
 *  `observable: false` is the important row type. It is not a surface that
 *  scored zero; it is a surface no transcript can answer for, and it is printed
 *  with the reason so the gap is visible rather than absent. */
export function surfaces(cfg = load()) {
  const block = instructions({ mobile: false });
  const briefed = briefedSessions();
  return [
    { id: "mcp", what: "the bb_* MCP tools", observable: true,
      installed: () => exists(path.join(ROOT, ".mcp.json")) && /bundlebox/.test(fs.readFileSync(path.join(ROOT, ".mcp.json"), "utf8")),
      chance: () => true,
      fired: (o) => o.mcp.length > 0,
      detail: (o) => (o.mcp.length ? [...new Set(o.mcp)].join(" ") : "") },
    { id: "cli", what: "`bb <verb>` from a shell", observable: true,
      installed: () => true,
      chance: (o) => o.shell > 0,
      fired: (o) => o.bbVerbs.length > 0,
      detail: (o) => (o.bbVerbs.length ? [...new Set(o.bbVerbs)].slice(0, 6).join(" ") : `${o.shell} shell call(s), none of them bb`) },
    // A session counts as located when the HOOK did it, not only when the
    // session thought to. That third case is the one this file could not see
    // and the one that now matters most: `wire.auto_pinpoint` runs the locator
    // from UserPromptSubmit, and a hook leaves no turn in a transcript, so
    // automating the surface would otherwise have made it invisible to the verb
    // that measures whether it was reached for. The record it writes per
    // session is the evidence.
    { id: "pinpoint", what: "locate the task before opening files", observable: true,
      installed: () => true,
      chance: (o) => (o.files || o.opens) >= READ_FLOOR,
      fired: (o) => o.bbVerbs.includes("pinpoint") || o.mcp.includes("bb_pinpoint") || briefed.has(o.session_id),
      detail: (o) => `opened ${o.opens} file(s), ${o.files} distinct` },
    { id: "tables", what: "read out/snapgen instead of grepping", observable: true,
      installed: () => exists(path.join(SNAPGEN(), "INDEX.md")),
      chance: (o) => o.searches > 0,
      fired: (o) => o.snapgen > 0,
      detail: (o) => `${o.searches} search(es)` },
    { id: "auto", what: "the locator run FOR the session by UserPromptSubmit", observable: true,
      installed: () => Boolean(cfg.wire?.auto_pinpoint),
      chance: () => true,
      fired: (o) => briefed.has(o.session_id),
      detail: (o) => (briefed.has(o.session_id) ? "a brief was recorded for this session" : "no brief recorded; the prompt was not task-shaped, or the hook was not installed yet") },
    { id: "block", what: `the instructions block (${human(estimateText(block, "prose"))} tokens, every window)`, observable: false,
      installed: () => true,
      why: "it arrives in the system prompt, and a system prompt is not a turn" },
    { id: "context", what: "the SessionStart snapgen index", observable: false,
      installed: () => Boolean(cfg.wire?.inject_context),
      why: "additionalContext is injected, not tool-called; nothing in the transcript records it" },
    { id: "guard", what: "the PreToolUse read guard", observable: false,
      installed: () => Boolean(cfg.wire?.guard_reads),
      why: "permissionDecisionReason reaches the model outside the turn record" },
  ];
}

/** Fold every transcript this workspace owns into a per-surface scoreboard. */
export function report({ cfg = load(), since = "" } = {}) {
  const entries = ledger.transcripts();
  const unseen = entries.unknown || [];
  const defs = surfaces(cfg);
  const rows = defs.map((s) => ({ id: s.id, what: s.what, observable: s.observable, why: s.why || "",
    installed: (() => { try { return Boolean(s.installed()); } catch { return false; } })(),  // a probe that throws has not been installed
    chances: 0, fired: 0, misses: [] }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sessions = [];

  for (const e of entries) {
    const tr = ledger.read(e);
    if (!tr || !tr.turns?.length) continue;
    const last = tr.turns[tr.turns.length - 1]?.ts || "";
    if (since && last && last < since) continue;
    const o = { ...observe(tr.turns), session_id: tr.sessionId };
    const hit = {};
    for (const s of defs) {
      if (!s.observable) continue;
      const row = byId.get(s.id);
      if (!row.installed || !s.chance(o)) { hit[s.id] = null; continue; }
      row.chances += 1;
      const did = s.fired(o);
      hit[s.id] = did;
      if (did) row.fired += 1;
      else row.misses.push({ session: tr.sessionId, agent: e.adapter, detail: s.detail(o) });
    }
    sessions.push({ session: tr.sessionId, agent: e.adapter, last, ...o, hit });
  }
  return { rows, sessions: sessions.sort((a, b) => (a.last < b.last ? 1 : -1)), unseen, read_floor: READ_FLOOR };
}

// ── commands ────────────────────────────────────────────────────────────────

/** prompt4.md W1's gate: the prompt hook's fires and the edits they led to,
 *  per the join `hooks.taskRows` builds, with `n` beside every number. Under
 *  the sample floor the rate is `unknown`, not a percentage of seven. */
export const TASK_FLOOR = 12;
export function taskHeadLines() {
  let h = null;
  try { h = JSON.parse(fs.readFileSync(path.join(VAR, "task-head.json"), "utf8")); } catch { /* never fitted */ }
  if (!h) return ["", "  prompt hook: no fit recorded — the regex decides; a session-end writes `task-head.json` (n, fires, edits)."];
  const n = Number(h.fires ?? h.n) || 0, edited = Number(h.edited) || 0;
  const rate = n >= TASK_FLOOR ? `${Math.round((100 * edited) / n)}%` : "unknown";
  const head = h.useful ? `fitted head decides, threshold ${h.threshold}, errs ${h.errs}, holdout accuracy ${h.accuracy} vs base ${h.base_accuracy}`
    : `regex decides (${h.why || "no fit"})`;
  return ["", `  prompt hook: fired ${n}, led to an edit ${edited}, rate ${rate} (n=${n}, floor ${TASK_FLOOR}); ${head}.`,
    ...(h.unseen ? [`  ${h.unseen} transcript(s) could not be read — those sessions are unlabelled, not negatives.`] : [])];
}

const rate = (r) => (r.chances ? `${Math.round((100 * r.fired) / r.chances)}%` : "—");

function render(r, flags) {
  if (!r.sessions.length) {
    warn("  no transcript for this workspace carries a turn to read.");
    if (r.unseen.length) warn(`  could not look at: ${r.unseen.join(", ")} — unknown, not zero.`);
    return 2;
  }
  out(`  uptake over ${r.sessions.length} session(s) — did what \`bb wire\` installed get reached for?\n`);
  const observable = r.rows.filter((x) => x.observable);
  out(table(observable.map((x) => [x.id, x.installed ? "yes" : "no", x.chances ? `${x.fired}/${x.chances}` : "—", rate(x), x.what]),
    { header: ["surface", "installed", "fired/chances", "rate", "what it is"] }).split("\n").map((l) => "  " + l).join("\n"));
  taskHeadLines().forEach((l) => out(l));
  out(`\n  A chance is the moment the surface was for: pinpoint counts sessions that opened >= ${r.read_floor} distinct files,`);
  out("  tables counts sessions that ran a search, cli counts sessions that ran any shell command. A file opened with");
  out("  `sed -n` counts exactly as much as one opened with Read: which tool a session uses is a harness setting.");

  const blind = r.rows.filter((x) => !x.observable);
  if (blind.length) {
    out("\n  not observable from a transcript — installed, and no run of this verb can say whether it fired\n");
    for (const x of blind) out(`    ${pad(x.id, 10)} ${x.installed ? "installed" : "off"}   ${x.what}\n               ${x.why}`);
  }

  const dead = observable.filter((x) => x.installed && x.chances >= 3 && x.fired === 0);
  if (dead.length) {
    out("\n  installed and never once reached for, where the chance existed:");
    for (const x of dead) out(`    ${pad(x.id, 10)} 0 of ${x.chances}. Either the instruction does not say it plainly enough, or the surface is not worth its window.`);
  }

  const misses = observable.flatMap((x) => x.misses.map((m) => ({ surface: x.id, ...m })));
  if (misses.length && !flags.quiet) {
    out(`\n  every miss, with what the session did instead (${misses.length})\n`);
    out(table(misses.slice(0, 40).map((m) => [m.surface, m.session.slice(0, 12), m.agent, m.detail]),
      { header: ["surface", "session", "agent", "instead"] }).split("\n").map((l) => "    " + l).join("\n"));
    if (misses.length > 40) out(`    ... ${misses.length - 40} more`);
  }
  if (r.unseen.length) out(`\n  could not look at: ${r.unseen.join(", ")} — unknown, not zero.`);
  return 0;
}

async function cmd({ _, flags }) {
  const sub = _[0] || "";
  const r = report({ since: String(flags.since || "") });
  if (sub === "sessions") {
    if (flags.json) { emit({ sessions: r.sessions }); return 0; }
    out(table(r.sessions.slice(0, 40).map((s) => [s.session.slice(0, 12), s.agent, String(s.opens), String(s.files), String(s.searches), String(s.shell),
      [...new Set(s.bbVerbs)].slice(0, 4).join(" ") || "—", [...new Set(s.mcp)].slice(0, 3).join(" ") || "—"]),
      { header: ["session", "agent", "opens", "files", "searches", "shell", "bb verbs", "mcp tools"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }
  if (flags.json) { emit({ ...r, rows: r.rows.map((x) => ({ ...x, rate: x.chances ? x.fired / x.chances : null })) }); return 0; }
  return render(r, flags);
}

export const commands = {
  uptake: {
    help: "of everything bb wired in front of the agents, what did the sessions actually reach for (0 tokens)",
    usage: "bb uptake [--since <iso>] [--quiet] [--json] | bb uptake sessions",
    long: [
      "  bb uptake            per surface: installed, how often the chance came, how often it fired, every miss",
      "  bb uptake sessions   the raw observation per session: reads, searches, shell, which bb verbs, which MCP tools",
      "",
      "`bb wire status` says the block, the MCP entry and the hooks are installed. Installed is not used. The",
      "block is billed in every window of every session whether the agent obeys it or not, so a surface that",
      "never fires is the most expensive kind of dead code this factory can write.",
      "",
      "A denominator here is an opportunity, not a session: pinpoint is only counted against sessions that",
      "opened files, tables only against sessions that searched. A surface that arrives in the system prompt",
      "is reported as not observable and never as 0% — a transcript cannot answer for it, and a number that",
      "means `nothing was checked` is the one thing this box does not print.",
    ].join("\n"),
    run: cmd,
  },
};
