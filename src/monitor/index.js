// monitor/index.js — what this account is spending, right now, and how long the
// current window lasts at this rate.
//
// The data is the transcript every agent already writes, folded into
// `store.usage` by `bb tokens ledger`. No API call, no polling of a service, no
// estimate where a measurement exists.
//
// The window model matters more than the totals. Claude Code bills in FIVE-HOUR
// ROLLING BLOCKS that start with the first message after a gap, not in calendar
// days, so a daily total answers the wrong question: what a person needs to
// know at 14:40 is how much of the block that started at 11:05 is left. Blocks
// can be back to back and the gap between them is what ends one.
//
// Every number carries where it came from:
//   measured    folded from a transcript, to the token
//   p90         this account's own 90th-percentile block over the last 8 days
//   plan        the published ceiling for a named plan
//   unknown     nothing to read; the verb says so rather than printing a zero
//
// Exit codes make it usable from a hook or a cron line without parsing:
//   0 ok · 10 near the limit · 11 limit reached · 20 indeterminate · 30 error
import path from "node:path";
import { VAR } from "../core/paths.js";
import { writeJson, load as loadCfg } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { human, usd, pad, table } from "../core/util.js";
import { rows, blocks, limitOf, burn, snapshot, guard, BLOCK_HOURS, LOOKBACK_HOURS, BURN_MINUTES, NEAR, PLANS, MIN_BURN_SPAN } from "./window.js";
import { titles, titleOf, resetTitles, sessions, TITLES } from "./sessions.js";

export { rows, blocks, limitOf, burn, snapshot, guard, BLOCK_HOURS, LOOKBACK_HOURS, BURN_MINUTES, NEAR, PLANS, MIN_BURN_SPAN } from "./window.js";
export { titles, titleOf, resetTitles, sessions, TITLES } from "./sessions.js";

export const STATE = () => path.join(VAR, "monitor.json");

// ── reporting ───────────────────────────────────────────────────────────────

const bar = (pct, w = 28) => {
  if (pct == null) return "?".repeat(w);
  const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return "#".repeat(n) + "-".repeat(w - n);
};
const hm = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export function text(s) {
  if (s.state === "indeterminate" && !s.block) return `  ${s.why}`;
  const L = [];
  const l = s.limit;
  L.push(`  block  ${s.block ? `${s.block.started.slice(11, 16)} → ${s.block.ends.slice(11, 16)}  ${hm(s.block.minutes_left)} left` : "none active"}`);
  L.push(`  used   [${bar(l.pct)}] ${l.pct == null ? "—" : `${l.pct}%`}   ${human(l.used)} of ${l.limit ? human(l.limit) : "an unknown limit"} (${l.source})`);
  if (l.why) L.push(`         ${l.why}`);
  L.push(`  burn   ${s.burn.per_minute == null ? `unknown (${s.burn.turns} turns in the last hour)` : `${human(s.burn.per_minute)} tokens/min over ${s.burn.minutes}m, ${s.burn.turns} turns`}`);
  if (s.runs_out_in_minutes != null) L.push(`  runs out in ${hm(s.runs_out_in_minutes)} at this rate — the ${s.exhausts_first} runs out first`);
  if (s.block) L.push(`  cost   ${usd(s.block.usd)}${s.block.unpriced_turns ? ` (+${s.block.unpriced_turns} turns on a model with no price)` : ""}   ${s.block.models.join(", ")}`);
  if (s.block) L.push(`  cache  ${human(s.block.cache_read)} read, ${human(s.block.cache_write)} written — read bills at a tenth of input`);
  L.push(`  ${s.state.toUpperCase()}${s.state === "hit" ? "  — the block is spent; it resets on the clock above"
    : s.state === "near" ? `  — past ${NEAR * 100}% of the block`
    : s.state === "indeterminate" ? "  — no limit could be established, so nothing is being compared" : ""}`);
  return L.join("\n");
}

export const compact = (s) => s.state === "indeterminate"
  ? `bb ? ${s.why ? s.why.slice(0, 40) : "indeterminate"}`
  : `bb ${s.limit.pct ?? "?"}% ${human(s.limit.used)}/${s.limit.limit ? human(s.limit.limit) : "?"} ${s.burn.per_minute ? `${human(s.burn.per_minute)}/m` : "-"} ${hm(s.block?.minutes_left)} left`;

export const CODES = { ok: 0, near: 10, hit: 11, indeterminate: 20, error: 30 };

async function cmd({ _, flags }) {
  const sub = _[0] || "status";
  const opts = { plan: String(flags.plan || loadCfg().monitor?.plan || "custom"), limit: Number(flags.limit) || 0, fold: flags.fold !== false };

  if (sub === "sessions") {
    const rowsOut = sessions({ limit: Number(flags.limit) || 20 });
    if (flags.json) { emit({ sessions: rowsOut }); return 0; }
    if (!rowsOut.length) { out("  no sessions measured yet. `bb tokens ledger`"); return 0; }
    out(table(rowsOut.map((s) => [s.session.slice(0, 8), (s.title || "").slice(0, 46), s.agent, s.turns, human(s.tokens), usd(s.usd), s.turns_saved ? `${s.turns_saved} turns` : "", String(s.last || "").slice(0, 16)]),
      { header: ["session", "title", "agent", "turns", "tokens", "cost", "saved", "last"] }).split("\n").map((l) => "  " + l).join("\n"));
    out(`\n  tokens MEASURED from the transcripts. "saved" counts local turns the factory displaced while the session was open — an ESTIMATE, and never added to the cost.`);
    return 0;
  }

  if (sub === "blocks") {
    const bs = blocks().slice(-(Number(flags.limit) || 12));
    if (flags.json) { emit({ blocks: bs }); return 0; }
    if (!bs.length) { out("  no blocks. `bb tokens ledger`"); return 0; }
    out(table(bs.map((b) => [new Date(b.start).toISOString().slice(0, 16).replace("T", " "), `${b.minutes}m`, b.turns, human(b.tokens), usd(b.usd), b.sessions.length, b.models.join(",").slice(0, 28)]),
      { header: ["started", "span", "turns", "tokens", "cost", "sessions", "models"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "guard") {
    const g = guard({ ...opts, allowNear: !!flags.allowNear });
    if (flags.json) { emit(g); return g.ok ? 0 : CODES.near; }
    out(`  ${g.ok ? "ok" : "REFUSE"} — ${g.why}`);
    return g.ok ? 0 : CODES[g.state] ?? CODES.error;
  }

  const s = snapshot(opts);
  if (flags.writeState) writeJson(String(flags.writeState) === "true" ? STATE() : String(flags.writeState), s);
  if (flags.json) emit(s);
  else if (flags.compact) console.log(compact(s));
  else out(text(s));

  if (flags.watch) {
    const every = Math.max(Number(flags.interval) || 10, 2) * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, every));
      const next = snapshot(opts);
      if (flags.writeState) writeJson(String(flags.writeState) === "true" ? STATE() : String(flags.writeState), next);
      if (flags.compact) console.log(compact(next));
      else { out(""); out(text(next)); }
    }
  }
  return CODES[s.state] ?? CODES.error;
}

export const commands = {
  monitor: {
    help: "what this account is spending in the current 5-hour block, and how long it lasts at this rate",
    usage: "bb monitor [status|blocks|sessions|guard] [--plan pro|max5|max20|custom] [--limit n] [--compact] [--json] [--watch --interval 10] [--write-state]",
    long: [
      "  bb monitor                     the current block, the burn rate, and which clock runs out first",
      "  bb monitor --compact           one line, for a status bar",
      "  bb monitor guard               refuse-or-allow, asked before anything spends",
      "  bb monitor sessions            every session with its own title, what it used and what it displaced",
      "  bb monitor blocks              the 5-hour blocks this workspace has run",
      "",
      "Exit codes: 0 ok · 10 near · 11 limit reached · 20 indeterminate · 30 error.",
      "The limit defaults to this account's own P90 block over the last 8 days; --plan uses a published ceiling.",
    ].join("\n"),
    run: cmd,
  },
};
