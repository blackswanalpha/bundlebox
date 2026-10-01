// episodes.js — the one row every subsystem writes when it does anything.
//
// `buckmaster signals` reads transcripts: what a SESSION did, seen from outside.
// This is the other half: what the FACTORY did, recorded by the thing that did
// it. A pipeline stage, a script run and a bridge call land here in one shape,
// which is the only reason one model can train across them.
//
// `features` holds what was true BEFORE the row ran. A feature that knows the
// outcome trains a model that scores 1.0 and steers nothing. `useful` is the
// label and is deliberately not `rc == 0`: a stage that exits 0 and produces
// nothing anybody read was not useful; one that exits 1 because it found a
// real problem was. `turns_saved` is counted from work done, never guessed.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import { VAR } from "../core/paths.js";
import { now, median, sum, human, shortId, pad, sha1 } from "../core/util.js";

/** Fallback only, labelled ESTIMATE wherever it is printed. The measured figure
 *  is the median of (output + cache_write) over this workspace's own turns. */
export const TOKENS_PER_TURN = 2600;

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const int = (x) => Math.trunc(num(x));
const list = (xs) => (Array.isArray(xs) ? xs.map(String) : []);
const scalar = (v) => v === null || ["number", "string", "boolean"].includes(typeof v);

/** Agent turns this work would have cost, counted conservatively: one call per
 *  file, per command, per search, and a page per 40 rows returned. */
export function turns({ files_read = 0, commands = 0, searches = 0, rows = 0 } = {}) {
  const n = (x) => Math.max(0, int(x));
  return n(files_read) + n(commands) + n(searches) + Math.floor(n(rows) / 40);
}

/** The CONVENTIONS shape, with every field present and typed. Only scalars
 *  survive in `features`: a nested object there is a post-hoc payload sneaking
 *  into the pre-run facts. `produced` stays null when nothing counted it. */
export function normalise(row = {}) {
  const kind = row.kind || "stage";
  const verb = String(row.verb || row.stage || "");
  const feats = {};
  for (const [k, v] of Object.entries(row.features || {})) if (scalar(v) || v === undefined) feats[k] = v === undefined ? null : v;
  return {
    id: row.id || `${kind}:${(row.stage || verb || "?").replace(/\s+/g, "-")}:${row.run_id || shortId()}:${shortId(4)}`,
    kind, verb, stage: row.stage || "", gear: row.gear || "", prev: row.prev || "",
    features: feats,
    rc: int(row.rc), seconds: Math.round(num(row.seconds) * 1000) / 1000,
    produced: row.produced == null ? null : int(row.produced),
    changed: [0, 1].includes(row.changed) ? row.changed : null,
    reads: list(row.reads), produces: list(row.produces),
    turns_saved: int(row.turns_saved), tokens: int(row.tokens),
    run_id: row.run_id || "", useful: [0, 1].includes(row.useful) ? row.useful : -1,
    state: row.state || "ran",
    detail: row.detail && typeof row.detail === "object" ? row.detail : {},
    ts: row.ts || now(),
  };
}

export function write(row) {
  const r = normalise(row);
  store.append("episodes", r);
  return r;
}

export const rows = (o) => store.rows("episodes", o);

// ── what a verb displaced ───────────────────────────────────────────────────
//
// What each verb reads and makes, and what a session would have spent to get
// the same answer. Counted off the store AFTER the verb ran; a verb with no
// entry yields `produced: null` and zero turns, never a guess.
//
// This table lives here rather than in the pipeline because the pipeline is no
// longer its only caller. A verb typed by hand displaces exactly the same work
// as the same verb inside a gear, and two tables would eventually disagree
// about how much.
//
// `digest` is what makes a hand-typed verb countable at all. Running `bb scan`
// five times does not save five times over: the second run returns the answer
// the first one already gave. The digest is taken over what the verb PRODUCED,
// so a repeat is recognised as a repeat and claims nothing. An entry with no
// digest claims nothing either — a repeat cannot be told from fresh work, and
// doctrine 2 says degrade to zero rather than to a plausible number.
const openFindings = () => store.get("findings", []).filter((f) => f && f.status === "open");
const dig = (xs) => (Array.isArray(xs) && xs.length ? sha1(xs.map(String).sort().join("\n")).slice(0, 12) : xs && xs.length === 0 ? "empty" : null);

export const YIELD = {
  scan: () => {
    const o = openFindings();
    const ran = (store.get("scan", {}) || {}).ran || [];
    return { produced: o.length, produces: ["findings"], reads: [],
      turns: turns({ files_read: Math.min(60, o.length * 2), searches: ran.length, rows: o.length }),
      digest: dig(o.map((f) => f.id)) };
  },
  findings: () => {
    // A read of an answer `scan` already produced. It shares scan's digest on
    // purpose: after a scan, listing the findings displaces nothing more.
    const o = openFindings();
    return { produced: o.length, produces: ["findings"], reads: ["findings"],
      turns: turns({ files_read: Math.min(60, o.length * 2), rows: o.length }), digest: dig(o.map((f) => f.id)) };
  },
  compile: () => {
    const u = store.get("units", []), o = openFindings();
    return { produced: u.length, produces: ["units"], reads: ["findings"],
      turns: turns({ files_read: Math.min(20, o.length), rows: o.length }), digest: dig(u.map((x) => x.id)) };
  },
  route: () => {
    const l = store.get("lanes", []), u = store.get("units", []);
    return { produced: l.length, produces: ["lanes"], reads: ["units"],
      turns: turns({ commands: 3, rows: u.length }), digest: dig(l.map((x) => `${x.id}:${x.run_id || ""}`)) };
  },
  context: () => ({ produced: null, produces: ["context"], reads: [], turns: turns({ commands: 1 }), digest: null }),
  "oversight scan": () => { const o = store.get("oversight", {}) || {}; return { produced: null, produces: ["oversight"], reads: ["findings"], turns: turns({ files_read: 6, commands: 2 }), digest: dig(Object.keys(o)) }; },
  "oversight guidelines": () => ({ produced: null, produces: ["guidelines"], reads: ["oversight"], turns: 0, digest: null }),
  "snapgen build": () => ({ produced: null, produces: ["snapgen"], reads: [], turns: 0, digest: null }),
  "designlabs check": (detail) => ({ produced: detail?.rules ?? null, produces: ["designlabs"], reads: ["designlabs"],
    turns: turns({ files_read: Math.min(30, detail?.screens ?? 0), commands: 2, rows: detail?.rules ?? 0 }), digest: detail?.digest ?? null }),
  "designlabs tables": () => ({ produced: null, produces: ["designlabs-tables"], reads: ["designlabs"], turns: 0, digest: null }),
  "buckmaster signals": () => { const s = store.get("signals", {}) || {}; const n = (s.sessions || []).length; return { produced: n, produces: ["signals"], reads: ["transcripts"], turns: turns({ files_read: Math.min(30, n), commands: 2 }), digest: dig((s.sessions || []).map((x) => x.session_id || x.id || "")) }; },
  "buckmaster rules": () => { const r = store.get("rules", {}) || {}; return { produced: (r.recommendations || []).length, produces: ["rules"], reads: ["signals"], turns: turns({ commands: 1 }), digest: dig((r.recommendations || []).map((x) => x.id || x.rule || "")) }; },
  "buckmaster recommend": () => { const r = store.get("rules", {}) || {}; return { produced: (r.recommendations || []).length, produces: ["recommendations"], reads: ["rules", "signals"], turns: turns({ commands: 1 }), digest: dig((r.recommendations || []).map((x) => x.id || x.rule || "")) }; },
  "buckmaster memory": () => { const m = store.get("memory", []); return { produced: Array.isArray(m) ? m.length : null, produces: ["memory"], reads: ["signals", "episodes", "scripts"], turns: turns({ files_read: 4 }), digest: dig(Array.isArray(m) ? m.map((x) => x.id || x.key || "") : null) }; },
  "buckmaster episodes": () => ({ produced: store.rows("episodes").length, produces: ["episode-report"], reads: ["episodes"], turns: turns({ commands: 1 }), digest: null }),
  "tokens ledger": () => { const n = store.rows("usage").length; return { produced: n, produces: ["usage"], reads: ["transcripts"], turns: turns({ files_read: Math.min(20, n ? 1 + Math.floor(n / 50) : 0) }), digest: n ? `usage:${n}` : "empty" }; },
  "session list": () => ({ produced: null, produces: ["sessions"], reads: ["usage"], turns: 0, digest: null }),
  "scripts scan": () => { const s = store.get("scripts", []); return { produced: s.length, produces: ["scripts"], reads: [], turns: turns({ files_read: s.length, searches: 2 }), digest: dig(s.map((x) => x.path || x.id || "")) }; },
  doctor: () => ({ produced: null, produces: ["doctor"], reads: [], turns: turns({ commands: 3 }), digest: null }),
  "git status": () => ({ produced: null, produces: ["git"], reads: [], turns: turns({ commands: 1 }), digest: null }),
  run: () => ({ produced: null, produces: ["runs"], reads: ["lanes"], turns: 0, digest: null }),
};

// A verb whose answer does not land in the store leaves its own count here for
// the CLI hook to pick up. Taken on read, so it can never leak into the next
// verb of the same process.
let _published = null;
export const publish = (d) => { _published = d && typeof d === "object" ? d : null; };
export const takeDetail = () => { const d = _published; _published = null; return d; };

/** The yield of one verb key, never throwing. `detail` is whatever the caller
 *  counted itself, for verbs whose answer does not land in the store. */
export function yieldOf(key, detail = null) {
  const fn = YIELD[key] || YIELD[String(key).split(" ")[0]];
  if (!fn) return { produced: null, produces: [key], reads: [], turns: 0, digest: null };
  try { return { digest: null, ...fn(detail) }; } catch { return { produced: null, produces: [key], reads: [], turns: 0, digest: null }; } // never throws: a broken counter must not fail the verb it counts
}

/** Has this exact answer been given already? A repeat displaces nothing.
 *
 *  Matched on the digest alone, not on (verb, digest): the digest identifies
 *  the ANSWER, and whichever verb produced it first is the one that displaced
 *  the work. `bb findings` straight after `bb scan` is the case this is for —
 *  it prints the set `scan` just computed and adds nothing to the bill. */
export function seen(digest, limit = 400) {
  if (!digest) return false;
  for (const e of store.rows("episodes", { limit })) {
    if (e.detail && e.detail.digest === digest) return true;
  }
  return false;
}

/** Record one hand-typed verb. Every invocation is a row, because the log is
 *  what `learn` trains on; only a FRESH answer carries turns, because only a
 *  fresh answer displaced any. */
export function record({ verb, rc = 0, seconds = 0, run_id = "", features = {}, detail = null } = {}) {
  const y = yieldOf(verb, detail);
  const repeat = seen(y.digest);
  const why = y.digest == null
    ? "no digest for this verb: a repeat cannot be told from fresh work, so nothing is claimed"
    : repeat ? "this answer was already given: the turns were displaced then, not now" : "";
  return write({
    kind: "verb", verb, rc, seconds, run_id,
    features: { ...features, produced: y.produced },
    produced: y.produced, reads: y.reads, produces: y.produces,
    turns_saved: repeat || y.digest == null ? 0 : y.turns,
    state: "ran", detail: { digest: y.digest, turns_if_fresh: y.turns, why },
  });
}


/** Rewrite `useful` on the rows named in `labels` ({id: -1|0|1}). The log is
 *  append-only for everything else; a label is the one field that is decided
 *  after the row was written, and a second row per label would make every
 *  reader fold. Atomic rename, so a crash mid-write loses nothing. */
export function relabel(labels) {
  const ids = Object.keys(labels || {});
  if (!ids.length) return 0;
  const file = path.join(VAR, "episodes.jsonl");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let n = 0;
  const outLines = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    let o;
    try { o = JSON.parse(line); } catch { return line; }
    if (o && o.id in labels && o.useful !== labels[o.id]) { o.useful = labels[o.id]; n += 1; return JSON.stringify(o); }
    return line;
  });
  if (!n) return 0;
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, outLines.join("\n"));
  fs.renameSync(tmp, file);
  return n;
}

/** Labels for the episodes of ONE run, in run order.
 *
 *    1   a LATER stage read an artefact this one CHANGED
 *    0   it ran and the gear completed, but nothing later read it, or what it
 *        wrote was identical to what was already there
 *   -1   otherwise: unknown, and an unknown label is a row the model does not get
 *
 *  Order-aware on purpose: a read that happened BEFORE the produce is not
 *  evidence of anything. A stage never self-certifies: its own reads, and the
 *  reads of stages that did not run, count for nothing.
 *
 *  `changed` is what closes C32. "A later stage reads what this verb produces"
 *  is a fact about the GEAR, identical on every run, so a label built from it
 *  alone is a function of the verb — and the verb is also a model feature, so
 *  the model could score well by memorising the chain and steer nothing. What
 *  a stage actually changed differs run to run: a `scan` that finds nothing new
 *  is labelled 0 while the same verb on a dirty tree is labelled 1. Where
 *  nothing counted the output (`changed === null`) the old contract-only rule
 *  stands, because the alternative is discarding the row. */
export function autolabel(runEpisodes, { completed = true, apply = true } = {}) {
  const eps = Array.isArray(runEpisodes) ? runEpisodes : [];
  const labels = {};
  eps.forEach((e, i) => {
    if (!e || (e.state || "ran") !== "ran") return;
    const made = new Set(e.produces || []);
    let read = false;
    for (let j = i + 1; j < eps.length && !read; j++) {
      const later = eps[j];
      if (!later || later.id === e.id || (later.state || "ran") !== "ran") continue;
      read = (later.reads || []).some((r) => made.has(r));
    }
    const contributed = e.changed == null ? true : e.changed === 1;
    labels[e.id] = read && contributed ? 1 : completed ? 0 : -1;
  });
  if (apply) relabel(labels);
  return labels;
}

/** Marginal cost of one turn: MEASURED off store.usage when rows exist, else the
 *  ESTIMATE constant. The kind travels with the number so no report adds them. */
export function tokensPerTurn() {
  const xs = [];
  for (const r of store.rows("usage")) {
    if (/synthetic/i.test(String(r.model || ""))) continue;
    const x = num(r.output) + num(r.cache_write);
    if (x > 0) xs.push(x);
  }
  if (xs.length) return { value: Math.round(median(xs)), kind: "MEASURED", n: xs.length };
  return { value: TOKENS_PER_TURN, kind: "ESTIMATE", n: 0 };
}

/** Per verb: runs, median seconds, turns displaced, effective tok/s (what a
 *  session would have paid for the same answer, over the wall clock this took). */
export function report({ limit = 4000 } = {}) {
  const all = store.rows("episodes", { limit });
  const tpt = tokensPerTurn();
  const by = {};
  for (const r of all) {
    const v = r.verb || r.stage || r.kind || "?";
    const b = by[v] ||= { verb: v, runs: 0, secs: [], turns: 0, tokens: 0, useful: 0, labelled: 0 };
    b.runs += 1; b.secs.push(num(r.seconds)); b.turns += num(r.turns_saved); b.tokens += num(r.tokens);
    if (r.useful === 0 || r.useful === 1) { b.labelled += 1; b.useful += r.useful; }
  }
  const byVerb = Object.values(by).map((b) => {
    const secs = sum(b.secs);
    return { verb: b.verb, runs: b.runs, median_seconds: Math.round(median(b.secs) * 100) / 100, seconds: Math.round(secs * 10) / 10,
      turns: b.turns, tokens: b.tokens, tok_per_s: Math.round((b.turns * tpt.value) / Math.max(0.001, secs)),
      useful_rate: b.labelled ? Math.round((b.useful / b.labelled) * 100) / 100 : null, labelled: b.labelled };
  }).sort((a, b) => b.turns - a.turns);
  const turnsSaved = sum(all.map((r) => r.turns_saved));
  const secs = sum(all.map((r) => r.seconds));
  return { episodes: all.length, turns_saved: turnsSaved, tokens_avoided: turnsSaved * tpt.value, tokens_per_turn: tpt,
    tokens_spent: sum(all.map((r) => r.tokens)), seconds: Math.round(secs * 10) / 10,
    tok_per_s: Math.round((turnsSaved * tpt.value) / Math.max(0.001, secs)), by_verb: byVerb };
}

export function reportText(s) {
  const t = s.tokens_per_turn;
  const lines = [`  EPISODES — ${s.episodes} recorded, ${s.turns_saved} agent turns displaced`, ""];
  lines.push(`    tokens avoided       ${human(s.tokens_avoided)} ${t.kind}   (${human(t.value)}/turn ${t.kind}${t.n ? `, median of ${t.n} turns` : ""})`);
  lines.push(`    tokens spent         ${human(s.tokens_spent)} MEASURED`);
  lines.push(`    wall clock           ${s.seconds}s`);
  lines.push(`    effective rate       ${human(s.tok_per_s)} tok/s ${t.kind}`);
  lines.push("", `    ${pad("verb", 24)} ${pad("runs", 5, true)} ${pad("med s", 7, true)} ${pad("turns", 6, true)} ${pad("tok/s", 8, true)}  useful`);
  for (const b of s.by_verb.slice(0, 20)) {
    const rate = b.useful_rate == null ? "—" : `${Math.round(b.useful_rate * 100)}%`;
    lines.push(`    ${pad(b.verb, 24)} ${pad(b.runs, 5, true)} ${pad(b.median_seconds, 7, true)} ${pad(b.turns, 6, true)} ${pad(human(b.tok_per_s), 8, true)}  ${rate}`);
  }
  return lines.join("\n");
}
