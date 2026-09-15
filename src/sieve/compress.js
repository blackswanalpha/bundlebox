// sieve/compress.js — the input axis, and the pure half of it.
//
// Every other verb in this box shrinks what a session is ASKED to read: a brief
// instead of a tree, an anchor instead of a file. None of them touch what a
// session reads because it ran a command. A 4,000-line test log, a `git log`
// dump, a subagent report: the agent pays for that once when it arrives and
// again on every later turn of the session, because the whole window is re-sent.
// Shrinking it once is therefore paid back every turn that follows.
//
// Three tiers, applied in order, each strictly weaker than the one before:
//
//   scrub  lossless. ANSI escapes the model cannot see, trailing whitespace,
//          blank-line runs, and >= REPEAT_MIN identical consecutive lines
//          collapsed to one line plus a count. Nothing is lost.
//   dedup  this tool's output is byte-identical to its previous output IN THIS
//          SESSION, so the bytes are already in the window. A marker replaces
//          them. Across sessions it is not a duplicate: a fresh window has
//          never seen the first copy, which is why the session id is required
//          and a payload without one is left alone.
//   elide  lossy, and the only tier that is. Head + tail are kept, the middle
//          is dropped, and error-looking lines are carried out of the middle
//          first, because the one line that mattered in a 3,000-line build log
//          is the one line an agent will otherwise re-run the build to find.
//
// Two rules make the lossy tier safe to leave on:
//
//   1. The tool allowlist is an ALLOWLIST. Read, Edit and Write are absent by
//      construction: their output is what a later exact-match edit is written
//      against, so eliding a Read makes the model edit text it never saw. A
//      blocklist would silently admit the next tool of that shape.
//   2. An elided payload is written to disk first and the marker carries the
//      path. Without it the agent's only recovery is re-running the command,
//      which costs more than the elision saved and is wrong outright when the
//      command is not idempotent (a test run, a deploy, `git log` at a moment).
//
// Nothing here touches the disk or the config; `index.js` owns both. Keeping
// this file pure is what lets `bb sieve replay` measure the exact transform the
// hook applies, against transcripts that already exist, for nothing.
import { text as estimateText } from "../tokens/estimate.js";

/** Below this a hook round-trip costs more attention than it saves. Chars, not
 *  tokens: the estimator is a regex pass and this is the guard in front of it. */
export const SCRUB_MIN = 1024;
/** Identical consecutive lines before a run collapses. Three is a table. */
export const REPEAT_MIN = 4;
/** Emit a replacement only when it saves at least this many chars. A transform
 *  that wins 12 chars has spent a hook to change the bytes the model reads. */
export const MIN_WIN = 64;
/** Below this, two identical outputs are not worth a marker. */
export const DEDUP_MIN = 2048;
/** Error lines carried out of the elided middle, and the cap on each. */
const MAX_SALVAGED = 12;
const MAX_SALVAGE_LINE = 300;

/** Tools whose output may be elided. Read/Edit/Write are absent on purpose —
 *  see rule 1 above. Everything here answers a question; nothing here is the
 *  text a later edit is matched against. */
export const SAFE_TOOLS = ["Bash", "BashOutput", "Task", "TaskOutput", "Agent", "WebFetch", "WebSearch", "Grep", "Glob", "NotebookRead"];

/** What an error looks like in any of the log formats a gate produces. */
const SALVAGE_RE =
  /\b(error|err!|fail(ed|ure|ing|s)?|exception|traceback|panic|fatal|denied|refused|timed?[ _-]?out|assert(ion)?|segfault|undefined reference|cannot find|no such file|not found|warning)\b/i;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** The token cap one tool result is allowed to occupy, and the line budget
 *  around it.
 *
 *  The cap is a SHARE of the working window rather than a constant, because the
 *  same 8k-char log is 6% of a 130k window and 1.5% of a 500k one, and only one
 *  of those is worth eliding. Doctrine 9: thresholds are data, relative to the
 *  thing they bound. */
export function limitsFor(cfg) {
  const s = cfg?.sieve || {};
  const capacity = Math.max(1, Number(cfg?.budget?.max_tokens || 0) - Number(cfg?.budget?.reserve_output || 0));
  return {
    maxTokens: Math.max(200, Math.round(capacity * Number(s.max_share || 0.02))),
    headLines: Math.max(1, Number(s.head_lines || 60)),
    tailLines: Math.max(1, Number(s.tail_lines || 40)),
    tools: Array.isArray(s.tools) && s.tools.length ? s.tools : SAFE_TOOLS,
  };
}

/** Is this tool's output safe to touch? An MCP tool is read-only by shape (it
 *  answers, it does not hand back text an edit is matched against), so the
 *  prefix is admitted — but only when the caller has not named its own list. */
export function allowed(name, limits) {
  if (!name || typeof name !== "string") return false;
  if (limits.tools.includes(name)) return true;
  return limits.tools === SAFE_TOOLS && name.startsWith("mcp__");
}

/** Text out of whatever container an agent wrapped its tool result in. Returns
 *  null when there is nothing readable, which is not the same as "". */
export function extractText(response) {
  if (response == null) return null;
  if (typeof response === "string") return response || null;
  if (Array.isArray(response)) {
    const parts = response.map((b) => (b && typeof b.text === "string" ? b.text : extractText(b && b.content))).filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof response === "object") {
    const parts = [];
    for (const key of ["stdout", "stderr", "output", "content", "text", "result"]) {
      const v = response[key];
      if (typeof v === "string" && v) parts.push(v);
      else if (v && typeof v === "object") { const t = extractText(v); if (t) parts.push(t); }
    }
    if (parts.length) return parts.join("\n");
    try { return JSON.stringify(response); } catch { return null; }
  }
  return String(response);
}

// ── tier 1: scrub (lossless) ────────────────────────────────────────────────

export function scrub(input) {
  let t = input.replace(ANSI_RE, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  const lines = t.split("\n");
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n >= REPEAT_MIN && lines[i].trim()) out.push(lines[i], `... [bb sieve: line repeated ${n}x] ...`);
    else for (let k = 0; k < n; k++) out.push(lines[i]);
    i = j;
  }
  return out.join("\n");
}

// ── tier 2: dedup ───────────────────────────────────────────────────────────

/** What replaces an output the window already holds verbatim. The first lines
 *  stay so the agent can see WHICH output this was without opening anything. */
export function duplicateMarker(tool, body) {
  const lines = body.split("\n");
  const preview = lines.slice(0, 5).map((l) => (l.length > MAX_SALVAGE_LINE ? l.slice(0, MAX_SALVAGE_LINE) + "..." : l));
  return `[bb sieve: byte-identical to the previous ${tool} result in this session — ${body.length.toLocaleString("en-US")} chars / ${lines.length} lines, unchanged. It is already above in this window. First lines:]\n${preview.join("\n")}`;
}

// ── tier 3: elide (lossy) ───────────────────────────────────────────────────

/** Head + tail + salvaged errors, or null when that is not smaller.
 *  `spillPath` is the recovery path written by the caller; without one the
 *  marker says so rather than pointing at nothing. */
export function elide(input, limits, spillPath = "") {
  const lines = input.split("\n");
  const recover = spillPath
    ? ` Full output: ${spillPath} — grep it, do not re-run the command.`
    : " The middle is not recoverable: re-run only if the command is idempotent.";

  if (lines.length <= limits.headLines + limits.tailLines) {
    // Big in bytes, few lines: one enormous line, so the cut is by chars.
    // maxTokens is a token budget, and the only honest way back to chars here
    // is this text's own ratio, which is exact for this text.
    const tokens = estimateText(input, "code");
    if (tokens <= limits.maxTokens) return null;
    const keep = Math.floor((input.length * (limits.maxTokens / tokens)) / 2);
    const dropped = input.length - 2 * keep;
    if (dropped <= 0 || keep <= 0) return null;
    return `${input.slice(0, keep)}\n... [bb sieve: elided ${dropped.toLocaleString("en-US")} chars from the middle.${recover}] ...\n${input.slice(-keep)}`;
  }

  const head = lines.slice(0, limits.headLines);
  const tail = lines.slice(-limits.tailLines);
  const middle = lines.slice(limits.headLines, lines.length - limits.tailLines);

  const salvaged = [];
  for (const line of middle) {
    if (salvaged.length >= MAX_SALVAGED) break;
    if (SALVAGE_RE.test(line)) salvaged.push(line.length > MAX_SALVAGE_LINE ? line.slice(0, MAX_SALVAGE_LINE) + "..." : line);
  }

  const marker = `... [bb sieve: elided ${middle.length.toLocaleString("en-US")} lines, kept the first ${limits.headLines} and the last ${limits.tailLines}` +
    (salvaged.length ? `, and carried ${salvaged.length} error-like line(s) out of the cut` : "") + `.${recover}] ...`;

  const out = [...head, marker, ...salvaged, ...tail].join("\n");
  return out.length < input.length ? out : null;
}

// ── the pipeline ────────────────────────────────────────────────────────────

/** scrub, then elide if still over budget. Returns null when nothing worth
 *  emitting came out — which is the honest answer for most tool results.
 *
 *  `spill(text)` is called ONLY when the elide tier is about to run and only
 *  with the text that is about to be cut, so a caller with no disk (the replay)
 *  passes nothing and measures the same shape.
 *
 *  The return carries `tier` because a saving from `scrub` and a saving from
 *  `elide` are not the same claim: one lost nothing, the other lost the middle.
 *  A ledger that adds them without saying which is a ledger that cannot be
 *  audited later. */
export function transform(input, limits, { spill = null, tool = "" } = {}) {
  if (!input || input.length <= SCRUB_MIN) return null;
  let text = scrub(input);
  let tier = text.length < input.length ? "scrub" : "";
  if (estimateText(text, "code") > limits.maxTokens) {
    const cut = elide(text, limits, spill ? (spill(text, tool) || "") : "");
    if (cut != null) { text = cut; tier = "elide"; }
  }
  if (input.length - text.length < MIN_WIN) return null;
  return {
    text, tier: tier || "scrub",
    before: input.length, after: text.length,
    tokens_before: estimateText(input, "code"), tokens_after: estimateText(text, "code"),
  };
}

/** Put compressed text back into the shape the agent handed us.
 *
 *  Claude Code validates `updatedToolOutput` against the tool's own output
 *  schema before applying it, so handing a bare string back for a Bash result
 *  (an object) is rejected on every call: the hook looks like it works, the
 *  ledger fills up, and the model still reads the full output. A shape we
 *  cannot rebuild returns null and the hook emits nothing, which is always
 *  safer than emitting a shape the harness will refuse. */
export function rebuild(response, updated) {
  if (response == null || typeof response === "string") return updated;
  if (typeof response === "object" && !Array.isArray(response)) {
    for (const key of ["stdout", "output", "content", "text", "result"]) {
      if (typeof response[key] !== "string") continue;
      const out = { ...response, [key]: updated };
      // extractText already folded stderr in, so leaving the original would
      // re-add every byte the elision just removed.
      if (key === "stdout" && typeof response.stderr === "string") out.stderr = "";
      return out;
    }
  }
  return null;
}
