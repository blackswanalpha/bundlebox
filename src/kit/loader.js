// loader.js — the read side: which derived artefacts answer this, inside a budget.
//
// A session that needs orienting needs some of the tables and cannot afford all
// of them, so the loader catalogues what is on disk with its token cost, ranks
// it against a question, and packs WHOLE artefacts into a budget. Never a
// truncated one: half a route table reads as complete, which is worse than
// none. Discovery is by directory, so a subsystem that writes `<dir>/<name>.md`
// is visible here the day it lands.
import fs from "node:fs";
import path from "node:path";
import { OUT, rel } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { human, pad } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import * as cache from "./cache.js";

/** Where derived artefacts live under OUT, and which registry wrote their metadata. */
export const SOURCES = [
  { dir: "snapgen", kind: "table", meta: "snapgen" },
  { dir: "oversight/guidelines", kind: "guideline", meta: "oversight-guidelines" },
  { dir: "pinpoint", kind: "prompt", meta: null },
  { dir: "learn", kind: "process", meta: "learn" },
];
// `prompt` is excluded from ranking: pinpoint outputs are written FOR a session
// and always score highly against the question that produced them, which would
// crowd out the tables that answer it.
export const RANKABLE = ["table", "guideline", "process"];

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "that", "this", "with",
  "when", "not", "be", "as", "at", "by", "from", "md", "which", "what", "why", "how", "where", "who", "does", "do",
  "did", "are", "was", "were", "has", "have", "had", "can", "could", "should", "would", "will", "its", "into", "over",
  "per", "but", "if", "so", "all", "any", "each", "more", "than", "then", "there", "their", "they", "you", "your",
  "about", "after", "before", "only", "one", "two", "run", "get", "set"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function titleOf(text) {
  for (const line of text.split("\n").slice(0, 6)) if (line.startsWith("# ")) return line.slice(2).trim();
  return "";
}

/** Every derived artefact on disk with its token cost. No imports, no model. */
export function catalog(kinds = null) {
  const out = [];
  for (const src of SOURCES) {
    if (kinds && !kinds.includes(src.kind)) continue;
    const d = path.join(OUT, src.dir);
    let names;
    try { names = fs.readdirSync(d).filter((n) => n.endsWith(".md")).sort(); } catch { continue; }
    for (const n of names) {
      // INDEX lists the others; README is prose about a verb, not an artefact.
      if (n === "INDEX.md" || n === "README.md") continue;
      const p = path.join(d, n);
      const stem = n.slice(0, -3);
      const meta = src.meta ? cache.readMeta(`${src.meta}/${stem}`) : {};
      out.push({ name: stem, path: p, rel: rel(p), kind: src.kind, tokens: meta.tokens || estimate.file(p),
        doc: meta.description || titleOf(readText(p).slice(0, 4000)), group: meta.group || "", built: meta.built || "", score: 0, terms: [] });
    }
  }
  return out;
}

export function terms(question) {
  const out = [];
  const seen = new Set();
  for (const w of String(question || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
  }
  return out;
}

/** Score artefacts against a question: name hit +4, description +2, body hits
 *  by DENSITY and only under `deepUnder` tokens, then a cheapness bonus. Whole
 *  words only: substring matching scored `routes` as a hit for "out". */
export function rank(question, arts = null, { deepUnder = 8000 } = {}) {
  const ts = terms(question);
  const pats = Object.fromEntries(ts.map((t) => [t, new RegExp(`\\b${esc(t)}\\b`, "g")]));
  const list = arts || catalog(RANKABLE);
  for (const a of list) {
    const name = `${a.name} ${a.group}`.toLowerCase().replace(/-/g, " ");
    const doc = String(a.doc || "").toLowerCase();
    const hits = [];
    let score = 0;
    for (const t of ts) {
      pats[t].lastIndex = 0;
      if (pats[t].test(name)) { hits.push(t); score += 4; continue; }
      pats[t].lastIndex = 0;
      if (pats[t].test(doc)) { hits.push(t); score += 2; }
    }
    if (a.tokens && a.tokens <= deepUnder) {
      const body = readText(a.path).toLowerCase();
      const perK = Math.max(a.tokens / 1000, 1);
      for (const t of ts) {
        if (hits.includes(t)) continue;
        const n = (body.match(pats[t]) || []).length;
        if (!n) continue;
        hits.push(t);
        score += Math.min(1, n / perK) * 0.5;
      }
    }
    // A cheap artefact that hit is worth more per token than an expensive one.
    if (score && a.tokens) score += Math.min(2, 2000 / Math.max(a.tokens, 200));
    a.score = Math.round(score * 100) / 100;
    a.terms = hits;
  }
  return list.sort((x, y) => y.score - x.score || x.tokens - y.tokens);
}

/** Whole artefacts, best first, until the budget is spent. Never truncates one;
 *  what did not fit is named in the returned text. */
export function pack(question = "", budgetTokens = 20000, { names = null, kinds = null, minScore = 1 } = {}) {
  const arts = catalog(kinds || RANKABLE);
  const byName = new Map(arts.map((a) => [a.name, a]));
  const chosen = [], dropped = [];
  let spent = 0;
  for (const n of names || []) {
    const a = byName.get(n);
    if (!a) dropped.push({ name: n, why: "no such artefact" });
    else if (spent + a.tokens > budgetTokens) dropped.push({ name: n, tokens: a.tokens, why: "over budget" });
    else { chosen.push(a); spent += a.tokens; }
  }
  if (question) {
    for (const a of rank(question, arts.filter((x) => !chosen.includes(x)))) {
      if (a.score < minScore) break;
      if (spent + a.tokens > budgetTokens) { dropped.push({ name: a.name, tokens: a.tokens, why: "over budget" }); continue; }
      chosen.push(a); spent += a.tokens;
    }
  }
  const parts = chosen.map(({ path: _p, ...a }) => a);
  const p = { question, budget: budgetTokens, tokens: spent, parts, dropped };
  p.text = render({ ...p, _arts: chosen });
  return p;
}

export function render(p, { header = true } = {}) {
  const L = [];
  if (header) L.push(`<!-- bundlebox pack: ${p.parts.length} artefact(s), ~${p.tokens} tokens -->`);
  for (const a of p._arts || []) L.push(`\n<!-- ${a.rel} (${a.kind}, ~${a.tokens} tok) -->\n`, readText(a.path).trimEnd());
  if (p.dropped?.length) L.push(`\n<!-- not included: ${p.dropped.map((d) => `${d.name} (${d.why})`).join(", ")} -->`);
  return L.join("\n");
}

export function report(p) {
  const L = [`  question   ${p.question || "(explicit names)"}`, `  budget     ${human(p.tokens)} / ${human(p.budget)} tokens`, ""];
  for (const a of p.parts) L.push(`  ${pad(a.kind, 10)} ${pad(a.name, 24)} ${pad(a.tokens, 7, true)} tok   ${String(a.doc || "").slice(0, 52)}`);
  for (const d of p.dropped || []) L.push(`  ${pad("dropped", 10)} ${pad(d.name, 24)} ${pad(d.tokens ?? "-", 7, true)}       ${d.why}`);
  return L.join("\n");
}
