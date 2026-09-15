// monitor/window.js — the five-hour block, the limit it is measured against,
// and the rate it is being spent at.
//
// Claude Code bills in FIVE-HOUR ROLLING BLOCKS that start with the first
// message after a gap, not in calendar days, so a daily total answers the wrong
// question: what a person needs to know at 14:40 is how much of the block that
// started at 11:05 is left. Blocks can be back to back and the gap between them
// is what ends one.
//
// Every number carries where it came from:
//   measured    folded from a transcript, to the token
//   p90         this account's own 90th-percentile block over the last 8 days
//   plan        the published ceiling for a named plan
//   unknown     nothing to read; the verb says so rather than printing a zero
import * as store from "../core/store.js";
import * as ledger from "../tokens/ledger.js";
import * as prices from "../tokens/prices.js";
import { now, human } from "../core/util.js";

export const BLOCK_HOURS = 5;
export const LOOKBACK_HOURS = 192;         // 8 days, the window P90 is taken over
export const BURN_MINUTES = 60;            // velocity is measured over the last hour
export const NEAR = 0.80;                  // the share of a limit that counts as near
export const PLANS = { pro: 19000, max5: 88000, max20: 220000 };

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const ms = (ts) => { const t = Date.parse(ts || ""); return Number.isFinite(t) ? t : 0; };
const billed = (r) => num(r.input) + num(r.output) + num(r.cache_write) + num(r.cache_read);

/** Usage rows, deduplicated by (session_id, msg_id) with the last write winning
 *  and sorted by timestamp. The same contract the ledger folds under: reading a
 *  transcript twice must never double a number. */
export function rows({ fold = false } = {}) {
  if (fold) { try { ledger.fold(); } catch { /* a transcript we cannot read is not a reason to report nothing */ } }
  const by = new Map();
  for (const r of store.rows("usage")) if (r && r.session_id) by.set(`${r.session_id} ${r.msg_id}`, r);
  return [...by.values()].filter((r) => ms(r.ts || r.at)).sort((a, b) => ms(a.ts || a.at) - ms(b.ts || b.at));
}

/** Five-hour rolling blocks. A block starts at its first turn and ends five
 *  hours later OR when five hours pass with nothing in them, whichever comes
 *  first — a gap is what ends a block, and two blocks can sit end to end. */
export function blocks(us = rows()) {
  const span = BLOCK_HOURS * 3600 * 1000;
  const out = [];
  let cur = null;
  for (const r of us) {
    const t = ms(r.ts || r.at);
    if (!cur || t - cur.start >= span || t - cur.last >= span) {
      cur = { start: t, last: t, end: t + span, turns: 0, tokens: 0, input: 0, output: 0, cache_write: 0, cache_read: 0,
        usd: 0, unpriced: 0, models: new Set(), sessions: new Set(), agents: new Set() };
      out.push(cur);
    }
    cur.last = t;
    cur.turns += 1;
    cur.tokens += billed(r);
    for (const k of ["input", "output", "cache_write", "cache_read"]) cur[k] += num(r[k]);
    if (r.model) cur.models.add(r.model);
    if (r.session_id) cur.sessions.add(r.session_id);
    if (r.agent) cur.agents.add(r.agent);
    const c = prices.cost(r.model, { inp: num(r.input), out: num(r.output), cache_write: num(r.cache_write), cache_read: num(r.cache_read) });
    if (c) cur.usd += c.total; else cur.unpriced += 1;
  }
  return out.map((b) => ({ ...b, models: [...b.models].sort(), sessions: [...b.sessions], agents: [...b.agents],
    usd: Math.round(b.usd * 1e4) / 1e4, minutes: Math.round((b.last - b.start) / 60000) }));
}

/** The limit this account is measured against, and where the number came from.
 *  `custom` is the 90th percentile of this account's own completed blocks over
 *  the last 8 days — the monitor's own history, not a published figure, because
 *  a published figure is wrong for anybody on a different plan. */
export function limitOf(bs, { plan = "custom", limit = 0, at = Date.now() } = {}) {
  if (limit > 0) return { limit, source: "flag", confidence: "given" };
  if (plan !== "custom" && PLANS[plan]) return { limit: PLANS[plan], source: "plan", confidence: "published" };
  const recent = bs.filter((b) => at - b.start <= LOOKBACK_HOURS * 3600 * 1000 && b.end <= at).map((b) => b.tokens).sort((a, b) => a - b);
  if (recent.length < 3) return { limit: null, source: "unknown", confidence: "unknown",
    why: `${recent.length} completed block(s) in the last ${LOOKBACK_HOURS / 24} days; P90 needs at least 3. Pass --plan or --limit` };
  const idx = Math.max(0, Math.ceil(0.9 * recent.length) - 1);
  return { limit: recent[idx], source: "p90", confidence: "measured",
    why: `the 90th percentile of ${recent.length} completed block(s) over ${LOOKBACK_HOURS / 24} days, highest seen ${human(recent[recent.length - 1])}` };
}

/** Tokens per minute over the last hour.
 *
 *  The denominator is the OBSERVED span, floored at MIN_BURN_SPAN. Without that
 *  floor a burst is reported as a rate: two turns 40s apart carrying 50k tokens
 *  divide by a span near one minute and the page says 50k/min, which then feeds
 *  `runs_out_in_minutes` and tells a reader the window dies in two minutes. The
 *  floor is the honest reading — over a span this short the sample cannot
 *  support a rate, so the confidence says `burst` and the caller can refuse to
 *  extrapolate from it. */
export const MIN_BURN_SPAN = 10;          // minutes; below this a sample is a burst, not a rate
export function burn(us, at = Date.now()) {
  const from = at - BURN_MINUTES * 60000;
  const window = us.filter((r) => ms(r.ts || r.at) >= from);
  if (window.length < 2) return { per_minute: null, tokens: window.reduce((a, r) => a + billed(r), 0),
    turns: window.length, minutes: BURN_MINUTES, confidence: window.length ? "thin" : "unknown" };
  const first = ms(window[0].ts || window[0].at);
  const observed = (at - first) / 60000;
  const span = Math.max(observed, MIN_BURN_SPAN);
  const tokens = window.reduce((a, r) => a + billed(r), 0);
  return { per_minute: Math.round(tokens / span), tokens, turns: window.length,
    minutes: Math.round(span), observed_minutes: Math.round(observed),
    confidence: observed < MIN_BURN_SPAN ? "burst" : "measured" };
}

export function snapshot({ plan = "custom", limit = 0, fold = false, at = Date.now() } = {}) {
  const us = rows({ fold });
  if (!us.length) return { state: "indeterminate", why: "no usage rows. `bb tokens ledger` folds the transcripts", at: now(), blocks: 0 };
  const bs = blocks(us);
  const active = bs.find((b) => b.end > at && b.start <= at) || null;
  const lim = limitOf(bs, { plan, limit, at });
  const b = burn(us, at);
  const used = active ? active.tokens : 0;
  const pct = lim.limit ? Math.round((1000 * used) / lim.limit) / 10 : null;
  const left = lim.limit ? Math.max(lim.limit - used, 0) : null;
  const minutesLeft = active ? Math.max(Math.round((active.end - at) / 60000), 0) : null;
  // Two clocks run at once and the earlier one decides: the block expires on
  // the wall clock whatever the rate, and the budget runs out at this rate
  // whatever the clock. Reporting only one of them is how a window ends early.
  // A burst rate is not a rate. Extrapolating one produces a countdown that is
  // wrong by an order of magnitude in the direction that makes a person stop
  // working, so the countdown is withheld rather than guessed.
  const minutesToLimit = b.per_minute && left != null && b.confidence === "measured"
    ? Math.floor(left / Math.max(b.per_minute, 1)) : null;
  const stateOf = () => {
    if (!lim.limit) return "indeterminate";
    if (pct >= 100) return "hit";
    if (pct >= NEAR * 100) return "near";
    return "ok";
  };
  const state = stateOf();
  return {
    at: now(), state,
    block: active ? { started: new Date(active.start).toISOString(), ends: new Date(active.end).toISOString(),
      minutes_left: minutesLeft, turns: active.turns, tokens: active.tokens, usd: active.usd,
      unpriced_turns: active.unpriced, models: active.models, agents: active.agents, sessions: active.sessions.length,
      input: active.input, output: active.output, cache_write: active.cache_write, cache_read: active.cache_read } : null,
    limit: { ...lim, used, left, pct },
    burn: b,
    runs_out_in_minutes: minutesToLimit,
    exhausts_first: minutesToLimit == null || minutesLeft == null ? null : (minutesToLimit < minutesLeft ? "budget" : "clock"),
    blocks: bs.length,
    today: { tokens: us.filter((r) => (r.ts || r.at || "").slice(0, 10) === new Date(at).toISOString().slice(0, 10)).reduce((a, r) => a + billed(r), 0) },
    provenance: { tokens: "measured — folded from the agent's own transcript", limit: lim.source, burn: b.confidence },
  };
}

/** The on-call gate. Everything local is free; this is asked immediately before
 *  the one thing that is not, so a window that is nearly gone is not spent on a
 *  call that will be cut off half-written. */
export function guard({ plan = "custom", limit = 0, allowNear = false } = {}) {
  const s = snapshot({ plan, limit });
  if (s.state === "indeterminate") return { ok: true, state: s.state, why: s.why || "no limit could be established; not blocking on an unknown" };
  if (s.state === "hit") return { ok: false, state: s.state, why: `the current 5-hour block is at ${s.limit.pct}% of ${human(s.limit.limit)} (${s.limit.source}); it resets in ${s.block?.minutes_left ?? "?"} minutes` };
  if (s.state === "near" && !allowNear) return { ok: false, state: s.state, why: `the current block is at ${s.limit.pct}%, ${human(s.limit.left)} left and burning ${human(s.burn.per_minute)}/min — pass --allow-near to send anyway` };
  return { ok: true, state: s.state, why: `${s.limit.pct ?? "?"}% of the block used` };
}
