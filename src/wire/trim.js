// wire/trim.js — `bb wire trim`: remove the wiring nothing reaches for.
//
// `bb wire` installs an instructions block, an MCP server and a set of skills
// into every agent on this box. `bb uptake` then measures which of them a
// session actually used. Between those two verbs there was nothing: the block
// sat in every window of every session being billed on every turn, and the
// measurement saying nobody read it changed nothing at all.
//
// So this is the third verb, and it only ever removes what uptake MEASURED as
// dead. Three rules decide what that means, and all three exist because the
// alternative is a verb that deletes something a session needed.
//
//   1. A surface with no OPPORTUNITIES is not dead. `pinpoint` firing 0 times
//      in a workspace where no session ever opened five files is a surface
//      nobody had a reason to reach for. The denominator has to be real, which
//      is `chances >= MIN_CHANCES`.
//   2. A surface that cannot be OBSERVED is never trimmed. The block arrives in
//      the system prompt and the system prompt is not a turn; `bb uptake`
//      reports those as unknown and this verb leaves them alone. Trimming on an
//      unmeasurable row would be trimming on a guess.
//   3. A prohibition is never trimmed automatically. "Never edit anything under
//      .bundlebox/out/" has no firing to count — nothing observable happens
//      when a session obeys it — so it has no surface and no verdict.
//
// What it writes is `wire.trim` in .bundlebox/config.json, which is data a
// person can read and reverse in one edit. It does not rewrite the agent files
// itself: `bb wire --apply` does that, from the same config, so there is one
// place that writes into somebody's CLAUDE.md and it is the one that already
// did.
import { load, userConfig, save } from "../core/config.js";
import { text as estimateText } from "../tokens/estimate.js";
import { BULLETS, instructions, skills } from "./agents.js";

/** Opportunities a surface needs before "never fired" is a measurement rather
 *  than an absence. Three, the same floor `bb uptake` uses to call a surface
 *  dead in its own report; below it, one unusual week decides. */
export const MIN_CHANCES = 3;
/** Firing rate at or under which a line is not earning its window. Zero, not a
 *  percentage: a line reached for once in twenty sessions is still the line
 *  that made that session cheap, and this verb does not get to price that. */
export const DEAD_RATE = 0;

/** What each bullet costs, every prompt, in every session. */
export const costOf = (b) => estimateText(`- ${b.text}`, "prose");

/** The verdict per bullet, from an uptake report.
 *
 *  `keep`, `trim` and `unmeasured` are the only three, and the third is not a
 *  soft `keep` — it is the honest answer for a line whose surface no transcript
 *  can answer for, and it is printed rather than folded away. */
export function verdicts(report, { cfg = load() } = {}) {
  const bySurface = new Map((report.rows || []).map((r) => [r.id, r]));
  const trimmed = new Set((cfg.wire?.trim || []).map(String));
  return BULLETS.map((b) => {
    const tokens = costOf(b);
    const already = trimmed.has(b.id);
    if (!b.surface) {
      return { ...b, tokens, already, verdict: "unmeasured",
        why: "a prohibition: nothing observable happens when a session obeys it, so there is no firing to count" };
    }
    const row = bySurface.get(b.surface);
    if (!row) return { ...b, tokens, already, verdict: "unmeasured", why: `no uptake row for \`${b.surface}\`` };
    if (!row.observable) return { ...b, tokens, already, verdict: "unmeasured", surface_row: row, why: row.why || "not observable from a transcript" };
    if (!row.installed) return { ...b, tokens, already, verdict: "unmeasured", surface_row: row, why: "the surface is not installed, so nothing could have reached for it" };
    if (row.chances < MIN_CHANCES) {
      return { ...b, tokens, already, verdict: "unmeasured", surface_row: row,
        why: `only ${row.chances} chance(s) to fire; ${MIN_CHANCES} needed before never-fired is a measurement` };
    }
    const rate = row.chances ? row.fired / row.chances : 0;
    if (rate > DEAD_RATE) {
      return { ...b, tokens, already, verdict: "keep", surface_row: row, rate,
        why: `fired in ${row.fired} of ${row.chances}` };
    }
    return { ...b, tokens, already, verdict: "trim", surface_row: row, rate,
      why: `0 of ${row.chances} — installed, the chance came ${row.chances} times, and nothing reached for it` };
  });
}

/** The whole answer: what to trim, what it saves, and what the block becomes.
 *
 *  `per_prompt` is the number that matters and the reason this verb exists. The
 *  block is not paid once — it is in the system prompt of every turn of every
 *  session, so a dead line's cost is its tokens times every prompt anybody ever
 *  sends in this workspace. */
export function plan({ cfg = load(), report = null, mcpTools = [] } = {}) {
  const r = report || { rows: [], sessions: [] };
  const rows = verdicts(r, { cfg });
  const trim = rows.filter((x) => x.verdict === "trim").map((x) => x.id);
  const already = (cfg.wire?.trim || []).map(String);
  const next = [...new Set([...already, ...trim])];
  const before = instructions({ trim: already });
  const after = instructions({ trim: next });

  const toolRows = tools(r, { cfg, all: mcpTools });
  // EVERY tool dead is not a per-tool measurement: it says the server was never
  // reachable from these sessions at all, which is the `mcp` surface's own
  // finding and a different decision. Removing the whole set is unwiring the
  // server, and `bb unwire --agents <a>` is the verb for that.
  const allDead = mcpTools.length > 0 && toolRows.every((x) => x.verdict === "trim");
  for (const x of toolRows) {
    if (!allDead) continue;
    x.verdict = "unmeasured";
    x.why = "no session called any bb_* tool at all";
  }
  const trimTools = toolRows.filter((x) => x.verdict === "trim").map((x) => x.name);
  const alreadyTools = (cfg.wire?.trim_tools || []).map(String);
  const nextTools = [...new Set([...alreadyTools, ...trimTools])];

  const blockBefore = estimateText(before, "prose");
  const blockAfter = after ? estimateText(after, "prose") : 0;
  const toolTokens = toolRows.filter((x) => x.verdict === "trim").reduce((a, x) => a + x.tokens, 0);
  return {
    rows, trim, already, next,
    tools: toolRows, trim_tools: trimTools, already_tools: alreadyTools, next_tools: nextTools,
    tools_note: allDead
      ? "the server was never reached from these sessions, which is the `mcp` surface's own finding; `bb unwire` removes it, and this verb does not"
      : "",
    skills: skillRows(r),
    changed: next.length !== already.length || nextTools.length !== alreadyTools.length,
    tokens_before: blockBefore,
    tokens_after: blockAfter,
    // What the whole trim is worth in one window, block plus tool schemas.
    // Per PROMPT, which is the number that matters: both arrive in the system
    // prompt and are re-sent on every turn of every session in this workspace.
    per_prompt: (blockBefore - blockAfter) + toolTokens,
    block_after: after,
  };
}

// ── the other two surfaces ──────────────────────────────────────────────────
//
// The block is the expensive one, because it is in every window of every turn.
// The other two are not free either, and they are measured off the same
// transcripts:
//
//   MCP tools   every tool's name, description and input schema is in the
//               system prompt of a session that has the server wired. `bb
//               uptake` measures the whole `mcp` surface at 0 of 19 here; per
//               tool is finer, and the transcripts carry which one was called.
//   skills      a skill costs nothing until its trigger fires, which is why it
//               is the cheapest surface here and why this only ever REPORTS on
//               one. A skill nobody has loaded in fifty sessions may simply not
//               have come up yet, and deleting somebody's documentation on that
//               evidence is not a trade this verb gets to make.

/** Which bb_* MCP tools any session in this workspace has ever called.
 *
 *  The uptake observation already collects them per session — it is how the
 *  `mcp` row is decided — so this is a fold over data that was read once. */
export function toolsUsed(report) {
  const seen = new Set();
  for (const s of report.sessions || []) for (const m of s.mcp || []) seen.add(String(m));
  return seen;
}

/** Per MCP tool: called, or installed and never called. `sessions` is the
 *  denominator and it is printed, because "0 of 2 sessions" is not a
 *  measurement and this verb must not pretend it is. */
export function tools(report, { cfg = load(), all = [] } = {}) {
  const used = toolsUsed(report);
  const off = new Set((cfg.wire?.trim_tools || []).map(String));
  const n = (report.sessions || []).length;
  return all.map((t) => {
    const fired = used.has(t.name);
    const tokens = estimateText(`${t.name} ${t.description || ""} ${JSON.stringify(t.inputSchema || {})}`, "prose");
    if (fired) return { name: t.name, tokens, verdict: "keep", already: off.has(t.name), why: "a session called it" };
    if (n < MIN_CHANCES) return { name: t.name, tokens, verdict: "unmeasured", already: off.has(t.name), why: `${n} session(s) on disk; ${MIN_CHANCES} needed` };
    return { name: t.name, tokens, verdict: "trim", already: off.has(t.name), why: `0 of ${n} session(s) called it` };
  });
}

/** Per skill: how many sessions loaded it. REPORT only — see above. */
export function skillRows(report) {
  const n = (report.sessions || []).length;
  return skills().map((s) => ({
    name: s.name, files: s.files.length, verdict: "report",
    why: n < MIN_CHANCES
      ? `${n} session(s) on disk`
      : "a skill costs nothing until its trigger fires; this box does not delete somebody's documentation on a usage count",
  }));
}

/** Write `wire.trim` and `wire.trim_tools`. Read-merge into the user's config,
 *  like every other writer here: the file holds everything somebody set by hand
 *  and a whole object write is how one verb erases another's. */
export function apply(p) {
  const user = userConfig();
  const wire = { ...(user.wire || {}) };
  wire.trim = p.next;
  if (p.next_tools) wire.trim_tools = p.next_tools;
  save({ ...user, wire });
  return { wrote: p.next, wrote_tools: p.next_tools || [] };
}
