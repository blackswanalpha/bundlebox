// repeats.js — a failed tool call the session has already seen fail.
//
// Measured in interference-search (Badtheorylabs): 45% of failed attempts
// repeated one the model had already ruled out, and restating past failures in
// the prompt made repeats MORE frequent. So this never lists history. It speaks
// only when the call about to be retried is the same call that failed the same
// way before, and then it says that one fact.
//
// A signature is (tool, input, error), each normalised so that a timestamp, a
// pid or a temp path in the error does not make two identical failures look
// different. Same call with a different error is progress, and stays silent.
import { sha1 } from "../core/util.js";
import * as store from "../core/store.js";

const DOC = "repeat-failures";
export const KEEP_SESSIONS = 20;
export const MAX_PER_SESSION = 200;
const ERROR_CHARS = 600;

/** Digits, hex runs and temp paths are what differ between two runs of one failure. */
export function normaliseError(s) {
  return String(s || "")
    .slice(0, ERROR_CHARS)
    .replace(/\/tmp\/[^\s'":]+/g, "/tmp/…")
    .replace(/\b[0-9a-f]{7,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseInput(tool, input = {}) {
  if (tool === "Bash") return String(input.command || "").replace(/\s+/g, " ").trim();
  const keys = Object.keys(input || {}).filter((k) => k !== "description").sort();
  return JSON.stringify(keys.map((k) => [k, input[k]]));
}

export function signature(payload) {
  const tool = String(payload?.tool_name || "");
  const call = sha1(`${tool}|${normaliseInput(tool, payload?.tool_input)}`).slice(0, 12);
  const error = sha1(normaliseError(payload?.error)).slice(0, 12);
  return { tool, call, error, key: `${call}:${error}` };
}

/** Record one failure and return how many times this exact (call, error) has
 *  now failed in this session, with when it first did. */
export function record(payload) {
  if (!payload || payload.is_interrupt || payload.error == null) return null;
  const session = String(payload.session_id || "");
  const sig = signature(payload);
  let out = null;
  store.update(DOC, (doc) => {
    const d = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
    const s = d[session] || { at: new Date().toISOString(), seen: {} };
    const prev = s.seen[sig.key];
    s.seen[sig.key] = { n: (prev?.n || 0) + 1, first: prev?.first || new Date().toISOString(), tool: sig.tool };
    const keys = Object.keys(s.seen);
    if (keys.length > MAX_PER_SESSION) for (const k of keys.slice(0, keys.length - MAX_PER_SESSION)) delete s.seen[k];
    s.at = new Date().toISOString();
    d[session] = s;
    const sessions = Object.keys(d).sort((a, b) => String(d[b].at).localeCompare(String(d[a].at)));
    for (const k of sessions.slice(KEEP_SESSIONS)) delete d[k];
    out = { ...sig, ...s.seen[sig.key] };
    return d;
  }, {});
  return out;
}

/** The one line the agent reads, or null on a first failure. */
export function notice(r) {
  if (!r || r.n < 2) return null;
  const what = r.tool === "Bash" ? "This exact command" : `This exact ${r.tool} call`;
  return `bundlebox: ${what} has now failed ${r.n} times this session with the same error (first at ${r.first.slice(11, 19)}Z). ` +
    "Rerunning it unchanged will fail again. Change the input or the approach.";
}
