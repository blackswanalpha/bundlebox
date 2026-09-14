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
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as ledger from "../tokens/ledger.js";
import * as prices from "../tokens/prices.js";
import { VAR, rel } from "../core/paths.js";
import { readJson, writeJson, load as loadCfg } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { now, human, usd, pad, table, median } from "../core/util.js";

export const BLOCK_HOURS = 5;
export const LOOKBACK_HOURS = 192;         // 8 days, the window P90 is taken over
export const BURN_MINUTES = 60;            // velocity is measured over the last hour
export const NEAR = 0.80;                  // the share of a limit that counts as near
export const PLANS = { pro: 19000, max5: 88000, max20: 220000 };
export const STATE = () => path.join(VAR, "monitor.json");
export const TITLES = () => path.join(VAR, "session-titles.json");

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

/** Tokens per minute over the last hour, across every block it touches. */
export function burn(us, at = Date.now()) {
  const from = at - BURN_MINUTES * 60000;
  const window = us.filter((r) => ms(r.ts || r.at) >= from);
  if (window.length < 2) return { per_minute: null, turns: window.length, minutes: BURN_MINUTES, confidence: window.length ? "thin" : "unknown" };
  const first = ms(window[0].ts || window[0].at);
  const span = Math.max((at - first) / 60000, 1);
  const tokens = window.reduce((a, r) => a + billed(r), 0);
  return { per_minute: Math.round(tokens / span), tokens, turns: window.length, minutes: Math.round(span), confidence: "measured" };
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
  const minutesToLimit = b.per_minute && left != null ? Math.floor(left / Math.max(b.per_minute, 1)) : null;
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

// ── session titles ──────────────────────────────────────────────────────────

const TEXTY = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ") : v?.text || "");

/** A session's title is its first human sentence. Derived, cached, and never
 *  invented: a session whose transcript holds no user text is titled "(no
 *  prompt recorded)" rather than given a generated name. */
export function titles({ refresh = false } = {}) {
  const cache = readJson(TITLES(), {}) || {};
  if (!refresh && Object.keys(cache).length) return cache;
  for (const { file } of ledger.transcripts()) {
    const id = path.basename(file).replace(/\.\w+$/, "");
    if (cache[id] && !refresh) continue;
    let text = "";
    try {
      const raw = fs.readFileSync(file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const role = o.role || o.message?.role || o.type;
        if (role !== "user") continue;
        const t = TEXTY(o.message?.content ?? o.content ?? o.text ?? "").trim();
        if (!t || t.startsWith("<") || /^Caveat:/.test(t)) continue;
        text = t.replace(/\s+/g, " ").slice(0, 96);
        break;
      }
    } catch { /* an unreadable transcript is an untitled session, not a crash */ }
    cache[id] = text || "(no prompt recorded)";
  }
  writeJson(TITLES(), cache);
  return cache;
}

/** One row per session: what it was called, what it used, what it saved. */
export function sessions({ limit = 20 } = {}) {
  const t = titles();
  const by = new Map();
  for (const r of rows()) {
    const s = by.get(r.session_id) || { session: r.session_id, title: t[r.session_id] || "", agent: r.agent || "", models: new Set(),
      turns: 0, tokens: 0, cache_read: 0, usd: 0, unpriced: 0, first: null, last: null, run_ids: new Set() };
    s.turns += 1; s.tokens += billed(r); s.cache_read += num(r.cache_read);
    if (r.model) s.models.add(r.model);
    if (r.run_id) s.run_ids.add(r.run_id);
    const at = r.ts || r.at;
    if (!s.first || at < s.first) s.first = at;
    if (!s.last || at > s.last) s.last = at;
    const c = prices.cost(r.model, { inp: num(r.input), out: num(r.output), cache_write: num(r.cache_write), cache_read: num(r.cache_read) });
    if (c) s.usd += c.total; else s.unpriced += 1;
    by.set(r.session_id, s);
  }
  const eps = store.rows("episodes");
  return [...by.values()].map((s) => {
    const mine = eps.filter((e) => e.at && s.first && s.last && e.at >= s.first && e.at <= s.last);
    return { ...s, models: [...s.models].sort(), run_ids: [...s.run_ids], usd: Math.round(s.usd * 1e4) / 1e4,
      turns_saved: mine.reduce((a, e) => a + num(e.turns_saved), 0), local_runs: mine.length };
  }).sort((a, b) => String(b.last).localeCompare(String(a.last))).slice(0, limit);
}

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
