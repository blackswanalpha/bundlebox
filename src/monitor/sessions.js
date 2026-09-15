// monitor/sessions.js — one row per session: what it was called, what it used,
// and what the local path had already done for it.
//
// A session's title is its first human sentence. Derived, cached, and never
// invented: a session whose transcript holds no user text is titled "(no prompt
// recorded)" rather than given a generated name.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as ledger from "../tokens/ledger.js";
import * as prices from "../tokens/prices.js";
import { VAR } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { rows } from "./window.js";

export const TITLES = () => path.join(VAR, "session-titles.json");
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const billed = (r) => num(r.input) + num(r.output) + num(r.cache_write) + num(r.cache_read);

// ── session titles ──────────────────────────────────────────────────────────

const TEXTY = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ") : v?.text || "");

/** A session's title is its first human sentence. Derived, cached, and never
 *  invented: a session whose transcript holds no user text is titled "(no
 *  prompt recorded)" rather than given a generated name.
 *
 *  The cache is filled PER MISSING ID, not all-or-nothing. It used to return
 *  early the moment the file had any entry at all, which meant every session
 *  opened after the first write was permanently untitled — the dashboard showed
 *  "(untitled)" for the four most recent sessions and the fix looked like a
 *  parsing problem when it was a caching one. A cache that can only ever be
 *  filled once is not a cache.
 *
 *  The in-process memo on top of it matters for the other caller: the command
 *  centre recomputes state on every push, and re-reading every transcript to
 *  re-derive titles that have not changed is the kind of cost that only shows
 *  up once somebody leaves the page open. */
const SKIP_LINE = /^(<|Caveat:|\[Request interrupted)/;
// Commands that clear, compact or configure. They are the first thing typed in
// a session often enough that titling on them makes half the table read
// "/clear", which names the harness rather than the work.
const META_CMD = /^\/(clear|compact|resume|continue|cost|config|status|model|login|logout|help|exit|quit|doctor|init|memory|export|hooks|terminal-setup|vim|theme)\b/i;
let _memo = null;

/** The first thing a person actually typed, out of one transcript. Harness
 *  scaffolding — reminders, command wrappers, caveats — is not a prompt, and a
 *  session titled with a system reminder is worse than one titled honestly. */
export function titleOf(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { return ""; }           // an unreadable transcript is an untitled session, not a crash
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const role = o.role || o.message?.role || o.type;
    if (role !== "user") continue;
    let t = TEXTY(o.message?.content ?? o.content ?? o.text ?? "").trim();
    if (!t) continue;
    // A slash command arrives wrapped in its own tags with the typed text
    // inside; that text IS the prompt, so it is unwrapped rather than skipped.
    const cmd = /<command-(?:name|message|args)>([^<]*)<\/command-\1?>/.exec(t)
      || /<command-name>([^<]*)<\/command-name>/.exec(t);
    if (cmd && cmd[1].trim()) t = cmd[1].trim();
    else if (SKIP_LINE.test(t)) continue;
    if (META_CMD.test(t)) continue;
    // A pasted block often opens with scaffolding and the sentence follows it.
    const cleaned = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    return cleaned.slice(0, 96);
  }
  return "";
}

export function titles({ refresh = false, write = true } = {}) {
  if (_memo && !refresh) return _memo;
  const cache = readJson(TITLES(), {}) || {};
  let added = 0;
  for (const { file } of ledger.transcripts()) {
    const id = path.basename(file).replace(/\.\w+$/, "");
    if (cache[id] && !refresh) continue;
    cache[id] = titleOf(file) || "(no prompt recorded)";
    added += 1;
  }
  // `write:false` exists for the one caller that must not touch the disk: the
  // command centre serves this over HTTP and is declared read-only. A read
  // route that writes a cache is still a write route, and the next person to
  // reason about what the dashboard can do would be reasoning from a false
  // premise.
  if (write && added) writeJson(TITLES(), cache);
  _memo = cache;
  return cache;
}
/** Drop the in-process memo. The server holds one process for hours, and a
 *  session that starts while it is up must become titled without a restart. */
export function resetTitles() { _memo = null; }

/** One row per session: what it was called, what it used, what it saved. */
export function sessions({ limit = 20, write = true } = {}) {
  const t = titles({ write });
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
