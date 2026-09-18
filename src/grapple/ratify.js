// ratify.js — batched proposals. Ten yes/no rows in one decision moment
// rather than ten interruptions, and one recorded disposition per row.
//
// Routed to contact: rows about files the session already has open come
// first, because a question about code already in somebody's head costs
// almost no attention. What the session opened is what the brief's guards
// recorded under `seen.reads`; nothing here reads a transcript.
import { sha1, now } from "../core/util.js";
import * as core from "../core/store.js";
import * as gs from "./store.js";
import * as ask from "./ask.js";

export const PROPOSALS = "grapple-proposals";
export const BATCH = 10;

const proposalId = (keys) => sha1(keys.slice().sort().join("|")).slice(0, 10);

/** Build one proposal from the open queue. `open` is what the session has in
 *  front of it: those keys sort first, the rest keep their rank. */
export function propose({ open = [], batch = BATCH, questions = gs.questions() } = {}) {
  const opened = new Set((open || []).map(String));
  const rows = Object.values(questions).filter((q) => q.state === "open")
    .map((q) => ({ ...q, contact: (q.paths || []).some((p) => opened.has(p)) || (q.brief && opened.size > 0) ? 1 : 0 }))
    .sort((a, b) => b.contact - a.contact || (b.ev || 0) - (a.ev || 0) || (a.key < b.key ? -1 : 1))
    .slice(0, batch);
  if (!rows.length) return null;
  const id = proposalId(rows.map((r) => r.key));
  const p = { id, at: now(), rows: rows.map((r) => ({ key: r.key, shape: r.shape, text: r.text, reaches: r.reaches || 1, contact: r.contact })), state: "open" };
  core.put(PROPOSALS, p);
  gs.record("proposed", { proposal: id, keys: p.rows.map((r) => r.key), contact: p.rows.filter((r) => r.contact).length });
  return p;
}

/** The proposal on the table, or null. `decide` takes this one, so the rows
 *  somebody read are the rows their answer lands on. */
export function current() { const p = core.get(PROPOSALS, null); return p && p.id && Array.isArray(p.rows) ? p : null; }

/** Record the disposition of one proposal: which rows were confirmed, which
 *  rejected. Everything else in it stays open. Confirm means "yes, deliberate"
 *  for a pattern question and "yes, as stated" for an instance one. */
export function decide(p, { confirm = [], reject = [], reason = "", by = "operator" } = {}) {
  const yes = new Set(confirm.map(String)), no = new Set(reject.map(String));
  const out = { proposal: p.id, confirmed: [], rejected: [], untouched: [], labels: 0 };
  for (const r of p.rows) {
    const v = yes.has(r.key) ? "yes" : no.has(r.key) ? "no" : "";
    if (!v) { out.untouched.push(r.key); continue; }
    const a = ask.answer(r.key, { value: v, reason, by });
    if (a.error) { out.untouched.push(r.key); continue; }
    (v === "yes" ? out.confirmed : out.rejected).push(r.key);
    out.labels += a.reaches || 0;
  }
  gs.record("ratified", { proposal: p.id, confirmed: out.confirmed.length, rejected: out.rejected.length, untouched: out.untouched.length, labels: out.labels });
  core.put(PROPOSALS, { ...p, state: out.untouched.length ? "partial" : "decided", decided_at: now() });
  return out;
}

/** The proposal as a person reads it. */
export function render(p) {
  if (!p) return "  nothing to ratify: the queue is empty\n";
  const L = [`  proposal ${p.id} — ${p.rows.length} row(s), ${p.rows.filter((r) => r.contact).length} about files already open`, ""];
  for (const r of p.rows) L.push(`  [${r.contact ? "open" : "    "}] ${r.key}  ${r.shape.padEnd(8)} reaches ${String(r.reaches).padStart(3)}  ${String(r.text || "").slice(0, 110)}`);
  L.push("", `  bb grapple ratify ${p.id} --confirm <key,key> --reject <key,key> --reason "..."`);
  return L.join("\n") + "\n";
}
