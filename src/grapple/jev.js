// jev.js — a second opinion on each contested shape before the human is asked.
//
// TypeSafe's Jev answers typed questions over a state blob: no text out, one
// calibrated probability per question, all questions in one pass. The queue
// asks it one yes/no per pattern item — "the rows of this shape are deliberate,
// not defects" — with the detector's claim and a code window round the rows as
// state. The answer becomes that item's uncertainty in `rank`: a shape Jev is
// sure about either way is cheap to leave unasked, a shape it puts near 0.5 is
// exactly the one a person has to settle. Jev never writes a label; the human's
// answer stays the only thing the harvest reads.
//
// Off unless TYPESAFE_API_KEY is set. BB_JEV=off turns it off with the key in
// place. Every failure — no key, no network, a bad reply, the clock — returns
// null and the queue ranks as it did before. The call is synchronous on
// purpose: `rank` and `emit` are synchronous, as the expert bridge is, and a
// child node process is how this tree already waits on an interpreter.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { abs } from "../core/paths.js";
import * as tokens from "../tokens/estimate.js";

export const URL = () => process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone";
export const MODEL = () => process.env.TYPESAFE_MODEL || "jev-latest";   // required by the API; `jev-<version>` pins one
export const WINDOW = 6;              // lines each side of a row
export const ROWS_PER_ITEM = 3;       // example windows per pattern
export const STATE_TOKENS = 24000;    // under Jev's 32k state ceiling with room for the questions
export const TIMEOUT_MS = 8000;       // per attempt
export const RETRIES = 2;             // after the first attempt, on a timeout, a 429 or a 5xx
export const BACKOFF_MS = 500;        // doubled per retry
export const MAX_WAIT_MS = 5000;      // the longest Retry-After honoured

export const available = () => Boolean(process.env.TYPESAFE_API_KEY) && String(process.env.BB_JEV || "").toLowerCase() !== "off";

const lineOf = (row) => { const m = /:(\d+)$/.exec(String(row.key || "")); return m ? Number(m[1]) : Number(row.line) || 0; };

/** The code round one row, numbered, or "" when the file is gone. */
export function window(row) {
  const p = String(row.path || "").split(":")[0];
  if (!p) return "";
  let lines;
  try { lines = fs.readFileSync(abs(p), "utf8").split("\n"); } catch { return ""; }
  const at = Math.max(lineOf(row), 1);
  const from = Math.max(at - WINDOW, 1), to = Math.min(at + WINDOW, lines.length);
  return lines.slice(from - 1, to).map((l, i) => `${from + i}${from + i === at ? ">" : " "} ${l}`).join("\n");
}

/** State and questions for the pattern items, inside the token ceiling. Items
 *  that did not fit are left out, not truncated: a question over half its
 *  evidence is a different question. */
export function build(items) {
  const state = [], questions = {}, keys = [];
  let spent = 0;
  for (const it of items) {
    if (it.shape !== "pattern" || !it.key) continue;
    const rows = (it.rows || []).slice(0, ROWS_PER_ITEM);
    const body = [`### ${it.key}`, `detector: ${it.detector}`, `claim: ${it.text}`,
      ...rows.map((r) => `--- ${r.path || r.key}\n${window(r)}`)].join("\n");
    const cost = tokens.text(body, "code");
    if (spent + cost > STATE_TOKENS) continue;
    spent += cost;
    state.push(body);
    keys.push(it.key);
    questions[it.key] = { type: "noul", instructions: `In section ${it.key}, the rows are deliberate: the code does what its author meant and the detector's claim is not a defect.` };
  }
  return { state: state.join("\n\n"), questions, keys, tokens: spent };
}

// The child does the one thing this process cannot do without an event loop
// turn: wait on fetch. It reads the request off stdin and prints the reply.
//
// It retries what is transient and nothing else: a timeout, a 429 and a 5xx.
// One request timed out at 8s and the same request answered in 2.1s a moment
// later, and without a retry that one slow reply dropped Jev for the whole
// assessment. A refused connection or a 4xx is not going to change in a
// second, so it returns at once. A Retry-After is honoured up to MAX_WAIT_MS.
const CHILD = `
let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => s += c);
process.stdin.on("end", async () => {
  const { url, key, body, timeout, retries, backoff, maxWait } = JSON.parse(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const done = (o) => process.stdout.write(JSON.stringify(o));
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      if ((r.status !== 429 && r.status < 500) || a >= retries) return done({ status: r.status, json: await r.json().catch(() => null), attempts: a + 1 });
      const after = Number(r.headers.get("retry-after"));
      await sleep(Math.min(after > 0 ? after * 1000 : backoff * 2 ** a, maxWait));
    } catch (e) {
      if (!e || e.name !== "TimeoutError" || a >= retries) return done({ status: 0, error: String(e && e.message || e), attempts: a + 1 });
      await sleep(backoff * 2 ** a);
    }
  }
});`;

/** POST one system-one request, retried per CHILD. `{ answers, ms, attempts }`
 *  or null. `retries: 0` is one attempt, for a caller with a hard deadline. */
export function call({ state, questions }, { timeout = TIMEOUT_MS, retries = RETRIES, backoff = BACKOFF_MS } = {}) {
  if (!available() || !Object.keys(questions).length) return null;
  const body = { model: MODEL(), state, questions };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["-e", CHILD], { input: JSON.stringify({ url: URL(), key: process.env.TYPESAFE_API_KEY, body, timeout, retries, backoff, maxWait: MAX_WAIT_MS }),
    encoding: "utf8", timeout: (timeout + MAX_WAIT_MS) * (retries + 1) + 2000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  let out;
  try { out = JSON.parse(r.stdout); } catch { return null; }
  if (out.status !== 200 || !out.json || typeof out.json.answers !== "object") return null;
  return { answers: out.json.answers, ms: Date.now() - t0, attempts: out.attempts || 1 };
}

/** A noul answer as one number in [0, 1], whatever field the reply used. */
export function probability(a) {
  if (a == null) return null;
  if (typeof a === "number") return a;
  for (const k of ["noul", "probability", "p", "value", "answer"]) if (typeof a[k] === "number") return a[k];   // the API answers `{ type: "noul", noul: 0.98 }`
  return null;
}

/** `{ by: { key: p }, ms }` for questions a caller composed itself, or null.
 *
 *  `opinions()` below is the pattern-item caller and packs code windows as its
 *  state. `bb intent` is the other one and packs prompts, which are not code
 *  and carry no rows, so it composes its own state and comes in here. Both go
 *  through `call`, so both get the same treatment on every failure: null, and
 *  the caller proceeds as it did without an opinion. */
export function probabilities(state, questions, opts = {}) {
  if (!available() || !questions || !Object.keys(questions).length) return null;
  const r = call({ state, questions }, opts);
  if (!r) return null;
  const by = {};
  for (const k of Object.keys(questions)) {
    const p = probability(r.answers[k]);
    if (p == null || Number.isNaN(p)) continue;
    by[k] = Math.round(Math.min(Math.max(p, 0), 1) * 1000) / 1000;
  }
  return { by, ms: r.ms, attempts: r.attempts };
}

/** `{ by: { key: { p, uncertainty } }, asked, answered, tokens, ms }` for the
 *  pattern items, or null when Jev did not answer. `p` is Jev's probability the
 *  shape is deliberate; `uncertainty` is 2·min(p, 1−p), the distance from a
 *  sure answer, which is what a question is worth. */
export function opinions(items) {
  if (!available()) return null;
  const b = build(items);
  if (!b.keys.length) return null;
  const r = call(b);
  if (!r) return null;
  const by = {};
  for (const k of b.keys) {
    const p = probability(r.answers[k]);
    if (p == null || Number.isNaN(p)) continue;
    const c = Math.min(Math.max(p, 0), 1);
    by[k] = { p: Math.round(c * 1000) / 1000, uncertainty: Math.round(2 * Math.min(c, 1 - c) * 1000) / 1000 };
  }
  return { by, asked: b.keys.length, answered: Object.keys(by).length, tokens: b.tokens, ms: r.ms };
}
