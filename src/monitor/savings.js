// monitor/savings.js — what this workspace did NOT have to spend.
//
// `bb monitor` answers "what is this costing". This is the other half of the
// same question and it was, until now, only reachable through
// `bb buckmaster episodes` — a verb named after the subsystem that records the
// rows rather than after the thing a person wants to know. Anybody asking "is
// this box earning its place in the repo" had no verb to type.
//
// The number is a DISPLACEMENT, not a discount. Every local run records the
// agent turns it did instead of: one call per file it read for you, per command
// it ran, per search it answered, and a page per 40 rows it returned. Those
// turns are counted from work done. What each one WOULD have cost is this
// workspace's own median billed turn, so the conversion is measured here and
// not borrowed from somebody else's repo.
//
// Two things this deliberately does not do. It never subtracts the saving from
// the bill: the bill is measured and the saving is modelled, and mixing them
// would make both unreadable. And it never reports zero for something it could
// not look at — an unfolded ledger is `unknown`, which reads differently.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, BB_DIR } from "../core/paths.js";
import * as store from "../core/store.js";
import * as prices from "../tokens/prices.js";
import { sum, now } from "../core/util.js";
import { tokensPerTurn } from "../buckmaster/episodes.js";
import { rows as usageRows } from "./window.js";

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const ms = (ts) => { const t = Date.parse(ts || ""); return Number.isFinite(t) ? t : 0; };
const billed = (r) => num(r.input) + num(r.output) + num(r.cache_write) + num(r.cache_read);

const HOURS = 3600 * 1000;
/** A cache read bills at a tenth of fresh input, so nine tenths of every cached
 *  token is a saving the transcript already proves. It belongs to the harness,
 *  not to this box, and is reported on its own line for that reason. */
export const CACHE_DISCOUNT = 0.9;

/** The workspace these numbers are about. `bb monitor` is per-project — every
 *  path it reads hangs off the nearest root — and saying which project out loud
 *  is the difference between "nothing recorded yet" and "you are in the wrong
 *  directory", which otherwise print the same. */
export function workspace(root = ROOT) {
  const home = os.homedir();
  const label = root.startsWith(home) ? `~${root.slice(home.length)}` : root;
  return { root, label, name: path.basename(root), initialised: fs.existsSync(BB_DIR) };
}

/** Local runs, newest-first-agnostic, optionally windowed to the last n days. */
export function runs({ limit = 4000, days = 0, at = Date.now() } = {}) {
  const all = store.rows("episodes", { limit });
  if (!days) return all;
  const from = at - days * 24 * HOURS;
  return all.filter((r) => ms(r.ts) >= from);
}

/** What the workspace actually paid over the same window, folded from the
 *  transcripts the agents already wrote. MEASURED, to the token. */
export function spend({ days = 0, at = Date.now(), fold = false } = {}) {
  const from = days ? at - days * 24 * HOURS : 0;
  const us = usageRows({ fold }).filter((r) => ms(r.ts || r.at) >= from);
  const sessions = new Set(), models = new Set();
  let tokens = 0, usd = 0, unpriced = 0, cacheRead = 0, cacheWrite = 0, fresh = 0;
  for (const r of us) {
    tokens += billed(r);
    cacheRead += num(r.cache_read);
    cacheWrite += num(r.cache_write);
    fresh += num(r.input) + num(r.output) + num(r.cache_write);
    if (r.session_id) sessions.add(r.session_id);
    if (r.model) models.add(r.model);
    const c = prices.cost(r.model, { inp: num(r.input), out: num(r.output), cache_write: num(r.cache_write), cache_read: num(r.cache_read) });
    if (c) usd += c.total; else unpriced += 1;
  }
  return { tokens, fresh, usd: Math.round(usd * 1e4) / 1e4, turns: us.length, unpriced_turns: unpriced,
    sessions: sessions.size, models: [...models].sort(), cache_read: cacheRead, cache_write: cacheWrite,
    known: us.length > 0 };
}

/** Per verb, ordered by what it displaced. `share` is of the total avoided, so
 *  the table answers "which verbs are worth keeping" without further sums. */
function byVerb(eps, perTurn) {
  const by = new Map();
  for (const r of eps) {
    const verb = r.verb || r.stage || r.kind || "?";
    const b = by.get(verb) || { verb, runs: 0, turns: 0, seconds: 0, useful: 0, labelled: 0 };
    b.runs += 1;
    b.turns += num(r.turns_saved);
    b.seconds += num(r.seconds);
    if (r.useful === 0 || r.useful === 1) { b.labelled += 1; b.useful += r.useful; }
    by.set(verb, b);
  }
  const total = sum([...by.values()].map((b) => b.turns)) || 1;
  return [...by.values()]
    .map((b) => ({ ...b, seconds: Math.round(b.seconds * 10) / 10, tokens: b.turns * perTurn,
      share: Math.round((1000 * b.turns) / total) / 10,
      useful_rate: b.labelled ? Math.round((100 * b.useful) / b.labelled) : null }))
    .sort((a, b) => b.turns - a.turns);
}

/** The whole answer, in one shape, with provenance on every figure. */
export function savings({ limit = 4000, days = 0, at = Date.now(), fold = false } = {}) {
  const ws = workspace();
  const eps = runs({ limit, days, at });
  const perTurn = tokensPerTurn();
  const turns = sum(eps.map((r) => num(r.turns_saved)));
  const seconds = Math.round(sum(eps.map((r) => num(r.seconds))) * 10) / 10;
  const paid = spend({ days, at, fold });
  const avoided = turns * perTurn.value;
  const cached = Math.round(paid.cache_read * CACHE_DISCOUNT);
  return {
    at: now(), workspace: ws, window_days: days || null,
    runs: eps.length,
    avoided: { tokens: avoided, turns, per_turn: perTurn, seconds,
      known: eps.length > 0,
      why: eps.length ? null : "no local run has been recorded in this workspace yet" },
    spent: paid,
    cache: { read: paid.cache_read, written: paid.cache_write, tokens_not_rebilled: cached },
    // Against FRESH tokens, not against every billed token. A cache read is
    // most of a modern turn's count and bills at a tenth, so dividing by the
    // full figure compares a displaced turn to a discounted one and reports a
    // leverage near zero for a box that is working.
    leverage: paid.fresh ? Math.round((avoided / paid.fresh) * 100) / 100 : null,
    provenance: {
      turns: "measured — counted from the work each local run did",
      per_turn: perTurn.kind === "MEASURED" ? `measured — median of ${perTurn.n} billed turns in this workspace` : "estimate — no billed turn to take a median from",
      avoided: "modelled — displaced turns valued at the median billed turn",
      spent: paid.known ? "measured — folded from the agents' own transcripts" : "unknown — nothing folded yet, run `bb tokens ledger`",
      leverage: "avoided tokens per fresh token billed; cache reads are excluded from the denominator",
    },
    by_verb: byVerb(eps, perTurn.value),
  };
}
