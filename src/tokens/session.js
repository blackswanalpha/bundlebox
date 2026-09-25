// session.js — what this session cost, and what the local path kept it from costing.
//
// Two numbers, and they are not the same KIND of number, so they are never
// added together or printed the same way.
//
//   USED    MEASURED, to the token, off the transcript the agent already wrote:
//           fresh input, cache writes, cache reads, output, priced at the
//           published rates. A model prices.js does not know is reported with
//           its tokens and no cost.
//   SAVED   three components, each labelled by how it is known:
//     cache       MEASURED. cache_read tokens billed at the discount; the same
//                 tokens at the full rate is the difference.
//     wire        MEASURED when headroom is up, from its own /stats; "n/a" when
//                 it is not. Never a zero that means "not looked".
//     automation  ESTIMATE, as a RANGE. Turns the local verbs displaced
//                 (episodes' `turns_saved`, counted not guessed) times what a
//                 turn costs in THIS session: `marginal` (output + cache write,
//                 what one more turn ADDS) for the low figure, `full` (the whole
//                 re-sent window) for the high one. The truth is between.
//
// Episodes are attributed to a session by the run it names, and otherwise by
// the window that PREPARED it, and the report says which. A bracket of [first
// turn, last turn] was the original rule and it excluded exactly the work this
// line exists to report: scan, compile and route run BEFORE a session opens,
// which is the whole point of them.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import { VAR, rel } from "../core/paths.js";
import { now, human, median } from "../core/util.js";
import { num } from "../adapters/index.js";
import * as ledger from "./ledger.js";
import * as prices from "./prices.js";
import * as headroom from "./headroom.js";

export const OUT_DIR = path.join(VAR, "sessions");

/** (sessionId, transcript entry|null). Falls back to the newest transcript here. */
export function resolve({ sessionId = "", transcriptPath = "" } = {}) {
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const entry = { adapter: "", file: transcriptPath };
    for (const t of ledger.transcripts()) if (t.file === transcriptPath) entry.adapter = t.adapter;
    if (!entry.adapter) {
      const tr = ledger.turns(transcriptPath) === null ? null : true;
      if (!tr) return { sessionId: sessionId || path.basename(transcriptPath).replace(/\.jsonl?$/, ""), entry: null };
      entry.adapter = "claude";
    }
    return { sessionId: sessionId || ledger.read(entry)?.sessionId || path.basename(transcriptPath).replace(/\.jsonl?$/, ""), entry };
  }
  const all = ledger.transcripts();
  if (sessionId) return { sessionId, entry: all.find((t) => path.basename(t.file).replace(/\.jsonl?$/, "") === sessionId) || null };
  const n = ledger.newest();
  return n ? { sessionId: ledger.read(n)?.sessionId || path.basename(n.file).replace(/\.jsonl?$/, ""), entry: n } : { sessionId: "", entry: null };
}

/** This session's own tokens per turn, two ways, both medians: a session's
 *  first turns are small and its last are large, and a mean over that is a
 *  number no individual turn ever was. */
function perTurn(rows) {
  const live = rows.filter((r) => num(r.input) + num(r.cache_read) + num(r.cache_write) > 0);
  if (!live.length) return { full: 0, marginal: 0 };
  return { full: Math.round(median(live.map((r) => num(r.input) + num(r.cache_read) + num(r.cache_write) + num(r.output)))),
    marginal: Math.round(median(live.map((r) => num(r.output) + num(r.cache_write)))) };
}

/** Price avoided tokens at the session's own input/cache mix, not a flat rate:
 *  a displaced turn would have been mostly cache reads. */
function avoidedUsd(tokens, rows, { marginal }) {
  if (!tokens || !rows.length) return 0;
  const keys = marginal ? ["cache_write", "output"] : ["input", "cache_write", "cache_read", "output"];
  const tot = keys.reduce((a, k) => a + rows.reduce((b, r) => b + num(r[k]), 0), 0);
  if (!tot) return 0;
  const model = rows.reduce((best, r) => (num(r.cache_read) + num(r.input) > num(best.cache_read) + num(best.input) ? r : best), rows[0]).model;
  const share = (k) => (keys.includes(k) ? rows.reduce((b, r) => b + num(r[k]), 0) / tot : 0);
  const c = prices.cost(model, { inp: Math.round(tokens * share("input")), out: Math.round(tokens * share("output")),
    cache_write: Math.round(tokens * share("cache_write")), cache_read: Math.round(tokens * share("cache_read")) });
  return c ? c.total : 0;
}

// Free work older than this was not preparing this session. A bound is needed
// because the first session in a workspace has no previous one to start from,
// and without it a month of pipeline rows would all land on it.
export const PREP_HOURS = 24;

/** The episodes this session may claim.
 *
 *  Two rules, in order, and each episode satisfies at most one, so nothing is
 *  counted twice across sessions:
 *
 *    1. It names a run this session's turns also name. Exact: the lane rows
 *       carry `run_id`, and so does every episode that run wrote.
 *    2. It is not another run's lane, and falls in the PREPARATION window — after
 *       the previous session on this workspace ended, and before this one's
 *       last turn. That is where `scan`, `compile` and `route` live. */
export function attribute({ first, last, rows, sessionId }) {
  const runIds = new Set(rows.map((r) => r.run_id).filter(Boolean));
  const floor = new Date(Date.parse(first) - PREP_HOURS * 3600 * 1000).toISOString();
  let prevEnd = floor;
  for (const r of ledger.usage()) {
    if (!r || r.session_id === sessionId) continue;
    const ts = r.ts || r.at || "";
    if (ts && ts < first && ts > prevEnd) prevEnd = ts;
  }
  return store.rows("episodes").filter((e) => {
    const ts = e.ts || e.at || "";
    if (!ts) return false;
    if (e.run_id && runIds.has(e.run_id)) return true;
    // A lane belongs to its own run and to no other session. Everything else
    // that carries a run_id — a pipeline stage names the pipeline's run, not a
    // lane's — is free work, and free work is claimed by the session it
    // prepared.
    if (e.lane_id || e.kind === "lane") return false;
    return ts > prevEnd && ts <= last;
  });
}

export async function measure({ sessionId = "", transcriptPath = "" } = {}) {
  const r = resolve({ sessionId, transcriptPath });
  if (r.entry) ledger.fold();
  const rows = ledger.usage({ sessionId: r.sessionId });
  const used = { input: 0, output: 0, cache_write: 0, cache_read: 0, turns: 0 };
  const usd = { input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0 };
  let cacheSavedUsd = 0, first = null, last = null;
  const unpriced = new Set(), models = new Set();
  for (const row of rows) {
    used.input += num(row.input); used.output += num(row.output); used.cache_write += num(row.cache_write); used.cache_read += num(row.cache_read); used.turns += 1;
    const ts = row.ts || row.at || null;
    if (ts) { if (!first || ts < first) first = ts; if (!last || ts > last) last = ts; }
    if (row.model) models.add(row.model);
    const c = prices.cost(row.model, { inp: num(row.input), out: num(row.output), cache_write: num(row.cache_write), cache_read: num(row.cache_read) });
    if (!c) { if (row.model) unpriced.add(row.model); continue; }
    for (const k of ["input", "output", "cache_write", "cache_read", "total"]) usd[k] += c[k];
    cacheSavedUsd += c.cache_saved;
  }
  used.billed = used.input + used.cache_write + used.cache_read + used.output;
  used.peak_window = ledger.sessionPeak(r.sessionId);

  const pt = perTurn(rows);
  // Null timestamps mean no bracket, so no episode can be attributed: zero
  // turns saved, stated as such, rather than every episode ever.
  const eps = first && last ? attribute({ first, last, rows, sessionId: r.sessionId }) : [];
  const turnsSaved = eps.reduce((a, e) => a + num(e.turns_saved), 0);
  const localSeconds = eps.reduce((a, e) => a + num(e.seconds), 0);
  const byVerb = new Map();
  for (const e of eps) {
    const v = e.verb || e.kind || "?";
    const b = byVerb.get(v) || { verb: v, n: 0, turns: 0, seconds: 0 };
    b.n += 1; b.turns += num(e.turns_saved); b.seconds += num(e.seconds);
    byVerb.set(v, b);
  }

  let wire = null;
  if (headroom.cfg().enabled) {
    const w = await headroom.wire();
    if (w.ok) wire = { tokens: w.net_saved || w.saved, gross: w.saved, source: "headroom /stats" };
  }
  const low = turnsSaved * pt.marginal, high = turnsSaved * pt.full;
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return {
    session: r.sessionId, transcript: r.entry ? rel(r.entry.file) : "", agent: rows[0]?.agent || r.entry?.adapter || "",
    started: first, ended: last, models: [...models].sort(), unpriced_models: [...unpriced].sort(),
    used, usd: Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, r4(v)])),
    saved: { cache_tokens: used.cache_read, cache_usd: r4(cacheSavedUsd), wire_tokens: wire ? wire.tokens : null, wire_source: wire?.source || null,
      automation_turns: turnsSaved, automation_tokens: low, automation_tokens_high: high,
      automation_usd: r4(avoidedUsd(low, rows, { marginal: true })), automation_usd_high: r4(avoidedUsd(high, rows, { marginal: false })) },
    basis: { per_turn_tokens: pt.marginal, per_turn_full: pt.full, episodes: eps.length, local_seconds: Math.round(localSeconds * 10) / 10,
      attribution: `by run when the episode names one, else by the window that prepared this session (since the previous session here, capped at ${PREP_HOURS}h)`,
      prices: `${prices.SOURCE}, as of ${prices.AS_OF}` },
    by_verb: [...byVerb.values()].sort((a, b) => b.turns - a.turns).slice(0, 12),
    measured_at: now(),
  };
}

const usd2 = (x) => `$${(Number(x) || 0).toFixed(2)}`, usd4 = (x) => `$${(Number(x) || 0).toFixed(4)}`;

/** The one line that goes back into the session. */
export function line(m) {
  const u = m.used, s = m.saved;
  const savedTok = s.cache_tokens + s.automation_tokens + (s.wire_tokens || 0);
  const cost = m.unpriced_models.length ? "cost n/a" : usd2(m.usd.total);
  return `tokens used ${human(u.billed)} (${cost}) MEASURED · saved ${human(savedTok)}+ (${usd2(s.cache_usd + s.automation_usd)}+) MEASURED+ESTIMATE · ${u.turns} turns, peak window ${human(u.peak_window)}`;
}

export function report(m) {
  const u = m.used, s = m.saved, b = m.basis;
  const L = [];
  const row = (label, tok, cost, how) => L.push(`    ${label.padEnd(20)}${human(tok).padStart(10)}   ${(cost ?? "").padEnd(10)} ${how}`);
  L.push(`  SESSION ${m.session}   ${m.started || "?"} → ${m.ended || "?"}${m.agent ? `   (${m.agent})` : ""}`, "");
  L.push("  USED");
  row("turns", u.turns, "", "MEASURED");
  row("fresh input", u.input, usd4(m.usd.input), "MEASURED");
  row("cache writes", u.cache_write, usd4(m.usd.cache_write), "MEASURED");
  row("cache reads", u.cache_read, usd4(m.usd.cache_read), "MEASURED");
  row("output", u.output, usd4(m.usd.output), "MEASURED");
  row("billed", u.billed, usd4(m.usd.total), "MEASURED");
  row("peak window", u.peak_window, "", "MEASURED");
  if (m.unpriced_models.length) L.push(`    ! not priced: ${m.unpriced_models.join(", ")} — tokens counted, cost omitted`);
  L.push("", "  SAVED");
  row("cache reads", s.cache_tokens, usd4(s.cache_usd), "MEASURED — billed at the cache-read discount");
  if (s.wire_tokens === null) L.push(`    ${"wire (headroom)".padEnd(20)}${"n/a".padStart(10)}              MEASURED only when the proxy is up; it is not`);
  else row("wire (headroom)", s.wire_tokens, "", `MEASURED — ${s.wire_source}, net of cache busts`);
  row("automation", s.automation_tokens, usd4(s.automation_usd), `ESTIMATE, low — ${s.automation_turns} turns x ${human(b.per_turn_tokens)} marginal`);
  row("  upper bound", s.automation_tokens_high, usd4(s.automation_usd_high), `ESTIMATE, high — x ${human(b.per_turn_full)} full window`);
  L.push("", "    The automation line is a counterfactual and is given as a RANGE. The low figure charges each",
    "    displaced turn only what an extra turn ADDS (output + tool result written to cache); the high",
    "    figure charges the whole re-sent window, which over-counts because a session carrying those",
    "    turns would have compacted. Both inputs are measured; the product is an estimate.");
  if (m.by_verb.length) {
    L.push("", `    ${"verb".padEnd(20)} ${"runs".padStart(5)} ${"turns".padStart(6)} ${"sec".padStart(7)}`);
    for (const v of m.by_verb) L.push(`    ${v.verb.padEnd(20)} ${String(v.n).padStart(5)} ${String(v.turns).padStart(6)} ${v.seconds.toFixed(1).padStart(7)}`);
  }
  L.push("", `  basis: ${b.prices}`, `         ${b.episodes} episodes, attributed ${b.attribution}`);
  return L.join("\n");
}

export function markdown(m) {
  const u = m.used, s = m.saved, b = m.basis;
  const wire = s.wire_tokens === null ? "n/a" : s.wire_tokens.toLocaleString();
  const R = [`# Session ${m.session}`, "", `\`${m.started || "?"}\` → \`${m.ended || "?"}\` · ${u.turns} turns · ${m.models.join(", ") || "unknown model"}${m.agent ? ` · ${m.agent}` : ""}`, "",
    "| | tokens | USD | how it is known |", "|---|---:|---:|---|",
    `| **used** | ${u.billed.toLocaleString()} | ${usd4(m.usd.total)} | MEASURED from the transcript |`,
    `| fresh input | ${u.input.toLocaleString()} | ${usd4(m.usd.input)} | MEASURED |`,
    `| cache writes | ${u.cache_write.toLocaleString()} | ${usd4(m.usd.cache_write)} | MEASURED |`,
    `| cache reads | ${u.cache_read.toLocaleString()} | ${usd4(m.usd.cache_read)} | MEASURED |`,
    `| output | ${u.output.toLocaleString()} | ${usd4(m.usd.output)} | MEASURED |`,
    `| · cache discount | ${s.cache_tokens.toLocaleString()} | ${usd4(s.cache_usd)} | MEASURED |`,
    `| · wire (headroom) | ${wire} | — | ${s.wire_tokens === null ? "not measured — proxy not up" : "MEASURED — proxy /stats"} |`,
    `| · automation (low) | ${s.automation_tokens.toLocaleString()} | ${usd4(s.automation_usd)} | ESTIMATE — ${s.automation_turns} turns × ${b.per_turn_tokens.toLocaleString()} marginal |`,
    `| · automation (high) | ${s.automation_tokens_high.toLocaleString()} | ${usd4(s.automation_usd_high)} | ESTIMATE — × ${b.per_turn_full.toLocaleString()} full window |`,
    "", `Peak window: **${u.peak_window.toLocaleString()}** tokens (MEASURED).`, ""];
  if (m.unpriced_models.length) R.push(`- **Not priced**: ${m.unpriced_models.join(", ")} — tokens counted, cost omitted rather than guessed.`);
  R.push(`- Episodes are attributed ${b.attribution}.`, `- Prices: ${b.prices}.`);
  if (m.by_verb.length) { R.push("", "| verb | runs | turns | seconds |", "|---|---:|---:|---:|"); for (const v of m.by_verb) R.push(`| \`${v.verb}\` | ${v.n} | ${v.turns} | ${v.seconds.toFixed(1)} |`); }
  R.push("", `_Measured ${m.measured_at} by \`bb session\`. Transcript: \`${m.transcript || "n/a"}\`._`);
  return R.join("\n") + "\n";
}

const HEAD = "# sessions — what each one used and saved\n\n";
const INDEX = () => path.join(OUT_DIR, "index.md");

/** The index, rewritten with this id's row replaced or dropped. Every verb that
 *  changes `index.md` comes through here: the file is generated, so the format
 *  belongs to one function and not to whoever is holding a text editor. */
function index(tag, row) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const idx = INDEX();
  let prior = HEAD;
  try { prior = fs.readFileSync(idx, "utf8"); } catch { /* first session */ }
  const kept = prior.split("\n").filter((l) => !l.includes(tag)).join("\n").replace(/\n+$/, "");
  fs.writeFileSync(idx, kept + "\n" + (row ? row + "\n" : ""));
  return idx;
}

/** var/sessions/<id>.md plus one line in index.md, replacing that id's line if present. */
export function write(m) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stem = (m.session || "session").slice(0, 36);
  const md = path.join(OUT_DIR, `${stem}.md`);
  fs.writeFileSync(md, markdown(m));
  const tag = `\`${m.session.slice(0, 12)}\``;
  const cost = m.unpriced_models.length ? "cost n/a" : usd2(m.usd.total);
  const row = `- ${tag} ${(m.ended || "").slice(0, 16)} — used ${m.used.billed.toLocaleString()} (${cost}) MEASURED, saved ${(m.saved.cache_tokens + m.saved.automation_tokens).toLocaleString()} MEASURED+ESTIMATE ([md](${stem}.md))`;
  return [rel(md), rel(index(tag, row))];
}

/** One record dropped: the markdown and its row, both through `index` above.
 *  `id` is what the index prints or the full id the file is named for; a prefix
 *  works when exactly one record answers to it. */
export function remove(id) {
  const want = String(id || "").trim();
  if (!want) return { ok: false, why: "no id given", removed: [] };
  const hits = list().filter((r) => r.session === want || want.startsWith(r.session) || r.session.startsWith(want));
  if (!hits.length) return { ok: false, why: `no session record for ${want} in ${rel(INDEX())}`, removed: [] };
  if (hits.length > 1) return { ok: false, why: `${want} matches ${hits.length} records: ${hits.map((h) => h.session).join(", ")}`, removed: [] };
  const hit = hits[0];
  const stem = (hit.line.match(/\(([^()]+)\.md\)/) || [])[1] || hit.session;
  const md = path.join(OUT_DIR, `${stem}.md`);
  const removed = [];
  try { fs.unlinkSync(md); removed.push(rel(md)); } catch { /* the row outlived the file */ }
  removed.push(rel(index(`\`${hit.session}\``, null)));
  return { ok: true, session: hit.session, removed };
}

export function list() {
  let text;
  try { text = fs.readFileSync(path.join(OUT_DIR, "index.md"), "utf8"); } catch { return []; }  // no sessions written yet
  return text.split("\n").filter((l) => l.startsWith("- `")).map((l) => ({ session: (l.match(/`([^`]+)`/) || [])[1] || "", line: l.slice(2) }));
}

/** SessionEnd: measure, write, and return the one line for the hook to print.
 *
 *  A record is written for a session that HAPPENED, and the evidence that one
 *  happened is a transcript or a usage row — not the id, which the caller
 *  supplies and can get wrong. `bb session end --session zzz-does-not-exist`
 *  used to write a 974-byte record of zero and exit 0, so a hook passing an id
 *  the harness shaped differently filed a zero row instead of failing loudly,
 *  and the ledger grew a junk line nothing could remove. An opened-and-closed
 *  window with no turns is real and still records: it has a transcript. */
export async function end({ sessionId = "", transcriptPath = "" } = {}) {
  const m = await measure({ sessionId, transcriptPath });
  if (!m.transcript && !m.used.turns) {
    const dirs = [...new Set(ledger.transcripts().map((t) => path.dirname(t.file)))];
    const looked = transcriptPath || dirs.join(", ") || "no transcript directory this workspace can see";
    return { ok: false, wrote: [], measure: m,
      line: `session end: no transcript and no usage rows for ${sessionId || m.session || "(no id)"} — looked in ${looked}. Nothing written.` };
  }
  const wrote = write(m);
  return { ok: true, line: line(m), wrote, measure: m };
}

/** Every transcript for this workspace that has no record yet, measured and
 *  written, newest first.
 *
 *  Bounded on both axes for the reason `lathe.backfill` is: transcripts here
 *  run to tens of megabytes, and a verb that reads all of them is a verb that
 *  is never run twice. `--since` is the gap you are recovering; `--transcripts`
 *  is the ceiling on how much of it you pay for at once. */
export async function backfill({ since = "", transcripts = 50, write: doWrite = true } = {}) {
  const have = new Set(list().map((r) => r.session).filter(Boolean));
  const floor = since ? Date.parse(since) : 0;
  if (since && !Number.isFinite(floor)) return { error: `--since ${since} is not a date`, rows: [] };
  const limit = Math.max(1, Number(transcripts) || 50);
  const entries = ledger.transcripts()
    .map((t) => { let m = 0, size = 0; try { const st = fs.statSync(t.file); m = st.mtimeMs; size = st.size; } catch { /* gone between listing and stat */ } return { ...t, m, size }; })
    .filter((t) => t.size > 0 && (!floor || t.m >= floor))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);
  const rows = [];
  for (const t of entries) {
    const id = resolve({ transcriptPath: t.file }).sessionId;
    if (!id) { rows.push({ transcript: rel(t.file), state: "unreadable" }); continue; }
    if (have.has(id.slice(0, 12))) { rows.push({ session: id, transcript: rel(t.file), state: "have" }); continue; }
    const m = await measure({ transcriptPath: t.file });
    if (!m.used.turns && !m.transcript) { rows.push({ session: id, transcript: rel(t.file), state: "empty" }); continue; }
    if (doWrite) write(m);
    have.add(id.slice(0, 12));
    rows.push({ session: id, transcript: rel(t.file), state: doWrite ? "wrote" : "would write",
      turns: m.used.turns, used: m.used.billed, saved: m.saved.cache_tokens + m.saved.automation_tokens, line: line(m) });
  }
  return { rows, scanned: entries.length, written: rows.filter((r) => r.state === "wrote").length };
}
