// monitor/report.js — the two reports `bb monitor` prints, and nothing else.
//
// Split out of index.js so the command file is a command file. Everything here
// is a pure function of a snapshot: no store read, no clock, so a report can be
// asserted against a fixed object in a test.
import { human, usd } from "../core/util.js";
import { NEAR, BLOCK_HOURS } from "./window.js";
import { CACHE_DISCOUNT } from "./savings.js";
import { masthead, headline, row, section, note, grid, meter, roleFor, dim, mute, paint } from "./render.js";

const count = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (p) => (p == null ? "—" : `${p}%`);
const hm = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const clock = (iso) => String(iso || "").slice(11, 16);
/** Seconds as a person says them: "9m 23s", "42s". */
/** A ratio reads as a ratio: always one decimal under 10, none above, so "3×"
 *  and "3.02×" never appear in the same report. */
const times = (x) => (x == null ? "—" : `${Number(x).toFixed(x >= 10 ? 0 : 1)}×`);
const secs = (s) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s * 10) / 10}s`);

/** The status view's values are spans and rates, not single figures, so its
 *  value column is wider than the savings view's. */
const STATUS_W = 18;
/** The width of an in-table proportion bar. */
const SHARE_W = 12;

const WHY = {
  hit: "the block is spent — nothing more will send until it resets",
  near: `past ${Math.round(NEAR * 100)}% of the block`,
  ok: "inside the block, with room left",
  indeterminate: "no limit could be established, so nothing is being compared",
};

// ── bb monitor ──────────────────────────────────────────────────────────────

/** The current block: how much of it is gone, how fast, and which clock ends
 *  it. `place` names the workspace, because every path this read hangs off it. */
export function statusText(s, { place = "", saved = null, here = {} } = {}) {
  const L = [masthead("monitor", place || here.label || "")];
  if (s.state === "indeterminate" && !s.block) {
    L.push(headline("Nothing to measure here yet", "mute"));
    L.push(note([
      here.initialised ? "This workspace has a .bundlebox, but no turn has been folded into it." : "There is no .bundlebox here — `bb init` sets one up.",
      "`bb tokens ledger` folds the transcripts the agents have already written.",
    ]));
    return L.join("\n");
  }

  const l = s.limit, role = roleFor(s.state);
  L.push(headline(`${pct(l.pct)} of this ${BLOCK_HOURS}-hour block used`, role));
  L.push(`  ${meter(l.pct, { role })}  ${mute(`${human(l.used)} of ${l.limit ? human(l.limit) : "an unknown limit"}`)}`);
  L.push("");

  if (s.block) L.push(row("block", `${clock(s.block.started)} → ${clock(s.block.ends)}`, `${hm(s.block.minutes_left)} left on the wall clock`, { width: STATUS_W }));
  L.push(row("spending", s.burn.per_minute == null ? mute("not enough turns to say") : `${human(s.burn.per_minute)} tokens/min`,
    s.burn.per_minute == null ? `${s.burn.turns} turn(s) in the last hour` : `over ${s.burn.minutes}m, ${s.burn.turns} turns${s.burn.confidence === "burst" ? ", a burst not a rate" : ""}`, { width: STATUS_W }));
  if (s.runs_out_in_minutes != null) {
    L.push(row("runs out", `in ${hm(s.runs_out_in_minutes)}`, s.exhausts_first === "clock" ? "the block expires before the budget does" : "the budget runs out before the block does", { width: STATUS_W }));
  }
  if (s.block) {
    L.push(row("cost", usd(s.block.usd), `${s.block.models.join(", ")}${s.block.unpriced_turns ? ` (+${s.block.unpriced_turns} turns on an unpriced model)` : ""}`, { width: STATUS_W }));
    L.push(row("cache", `${human(s.block.cache_read)} read`, `re-billed at a tenth of fresh input, ${human(s.block.cache_write)} written`, { width: STATUS_W }));
  }
  if (saved?.avoided?.known) L.push(row("saved", human(saved.avoided.tokens), `${count(saved.avoided.turns)} turns this box did instead — see \`bb monitor savings\``, { width: STATUS_W }));

  L.push("");
  L.push(`  ${paint(s.state.toUpperCase(), role, { bold: true })} ${dim("·")} ${dim(WHY[s.state] || "")}`);
  if (l.why) L.push(`  ${dim(`the limit is ${l.why}`)}`);
  return L.join("\n");
}

export const compact = (s) => s.state === "indeterminate"
  ? `bb ? ${s.why ? s.why.slice(0, 40) : "indeterminate"}`
  : `bb ${s.limit.pct ?? "?"}% ${human(s.limit.used)}/${s.limit.limit ? human(s.limit.limit) : "?"} ${s.burn.per_minute ? `${human(s.burn.per_minute)}/m` : "-"} ${hm(s.block?.minutes_left)} left`;

// ── bb monitor sessions / blocks ────────────────────────────────────────────

const TITLE_W = 46;
const MODELS_W = 30;

/** One row per session: what it was called, what it cost, what it displaced
 *  while it was open. The title is the first thing a person actually typed. */
export function sessionsText(rowsOut, { place = "" } = {}) {
  const L = [masthead("sessions", place)];
  if (!rowsOut.length) {
    L.push(headline("No session has been measured here yet", "mute"));
    L.push(note(["`bb tokens ledger` folds the transcripts the agents have already written."]));
    return L.join("\n");
  }
  L.push(headline(`${count(rowsOut.length)} session(s), newest first`, "ink"));
  L.push("");
  L.push(grid(rowsOut.map((s) => [
    dim(s.session.slice(0, 8)),
    (s.title || mute("(untitled)")).slice(0, TITLE_W),
    s.agent,
    count(s.turns),
    human(s.tokens),
    usd(s.usd),
    s.turns_saved ? paint(`${count(s.turns_saved)} turns`, "good") : dim("—"),
    dim(String(s.last || "").slice(0, 16).replace("T", " ")),
  ]), { header: ["id", "what it was asked", "agent", "turns", "tokens", "cost", "displaced", "last seen"] }));
  L.push(note([
    "Tokens and cost are MEASURED from each session's own transcript. \"displaced\" counts the",
    "agent turns local verbs did instead while that session was open — modelled, and never",
    "added to the cost.",
  ]));
  return L.join("\n");
}

/** The five-hour blocks this workspace has run, oldest first. */
export function blocksText(bs, { place = "" } = {}) {
  const L = [masthead("blocks", place)];
  if (!bs.length) {
    L.push(headline("No billing block has been recorded here yet", "mute"));
    L.push(note(["`bb tokens ledger` folds the transcripts the agents have already written."]));
    return L.join("\n");
  }
  const peak = Math.max(...bs.map((b) => b.tokens)) || 1;
  L.push(headline(`${count(bs.length)} billing block(s), oldest first`, "ink"));
  L.push("");
  L.push(grid(bs.map((b) => [
    dim(new Date(b.start).toISOString().slice(0, 16).replace("T", " ")),
    `${b.minutes}m`,
    count(b.turns),
    human(b.tokens),
    meter((100 * b.tokens) / peak, { width: SHARE_W, role: "cool" }),
    usd(b.usd),
    count(b.sessions.length),
    b.models.join(", ").slice(0, MODELS_W),
  ]), { header: ["started", "span", "turns", "tokens", "against the biggest", "cost", "sessions", "models"] }));
  L.push(note([`A block starts at its first turn and ends ${BLOCK_HOURS} hours later, or when ${BLOCK_HOURS} hours pass with`,
    "nothing in them — whichever comes first. Two blocks can sit end to end."]));
  return L.join("\n");
}

// ── bb monitor savings ──────────────────────────────────────────────────────

/** What the box did instead of the agent, and what that would have cost. */
export function savingsText(v) {
  const L = [masthead("savings", v.workspace.label)];

  if (!v.avoided.known) {
    L.push(headline(`Nothing recorded in ${v.workspace.name} yet`, "mute"));
    L.push(note([
      v.workspace.initialised ? "This workspace has a .bundlebox, but no verb has run in it yet." : "There is no .bundlebox here. `bb init` sets one up.",
      "Savings are counted as verbs run: `bb scan`, `bb pinpoint`, `bb snapgen build`.",
    ]));
    return L.join("\n");
  }

  const window = v.window_days ? ` in the last ${v.window_days} day(s)` : "";
  L.push(headline(`${human(v.avoided.tokens)} tokens not spent in ${v.workspace.name}${window}`, "good"));
  L.push(`  ${mute(`${count(v.avoided.turns)} agent turns displaced by ${count(v.runs)} local runs${v.leverage ? `, ${times(v.leverage)} the fresh tokens billed` : ""}`)}`);
  L.push("");

  const t = v.avoided.per_turn;
  L.push(row("avoided", human(v.avoided.tokens), `${count(v.avoided.turns)} turns × ${human(t.value)} tokens, ${t.kind === "MEASURED" ? `this workspace's median billed turn (${count(t.n)} turns)` : "an estimate — no billed turn to measure"}`));
  L.push(row("billed", v.spent.known ? human(v.spent.fresh) : mute("unknown"), v.spent.known ? `fresh input, output and cache writes over ${count(v.spent.turns)} turns` : "run `bb tokens ledger` to fold the transcripts"));
  if (v.leverage != null) L.push(row("leverage", times(v.leverage), "tokens avoided for every fresh token billed"));
  L.push(row("local time", secs(v.avoided.seconds), `wall clock those ${count(v.runs)} runs took, at no token cost`));
  if (v.spent.known) L.push(row("prompt cache", human(v.cache.tokens_not_rebilled), `${Math.round(CACHE_DISCOUNT * 100)}% of ${human(v.cache.read)} re-read tokens — the harness, not this box`));
  if (v.spent.usd) L.push(row("paid", usd(v.spent.usd), `what the ${count(v.spent.turns)} billed turns actually cost, across ${count(v.spent.sessions)} session(s)`));

  const top = v.by_verb.filter((b) => b.turns > 0).slice(0, 12);
  if (top.length) {
    L.push(section("where it came from"));
    L.push(grid(top.map((b) => [
      b.verb,
      count(b.runs),
      count(b.turns),
      human(b.tokens),
      `${meter(b.share, { width: SHARE_W, role: "cool" })} ${String(Math.round(b.share)).padStart(2)}%`,
      b.useful_rate == null ? dim("—") : `${b.useful_rate}%`,
    ]), { header: ["verb", "runs", "turns", "tokens", "share of savings", "useful"] }));
  }

  L.push(note([
    "Displaced turns are counted from work done — one per file read, command run or search",
    "answered — never guessed. They are valued at this workspace's own median billed turn,",
    "and are never subtracted from what you actually paid. \"useful\" is the share of labelled",
    "runs that produced something a session read.",
  ]));
  return L.join("\n");
}
