// lathe/record.js — record the shape of a command when it runs, not by reading
// a gigabyte of transcript afterwards.
//
// This file exists because of a measurement. The first version of `bb lathe
// learn` mined command order out of the transcripts, through
// `bb buckmaster sessions`, and it took FOUR MINUTES of wall clock for 4.8
// seconds of CPU: 1.4GB of JSONL on this box, of which the newest forty
// sessions are tens of megabytes, parsed in full to recover one string per tool
// call. The data was right and the place it was read from was wrong.
//
// So the shape is recorded at the moment it is free. The PostToolUse hook
// already fires on every tool call; appending forty bytes to an open file is
// the cheapest thing that hook can do, and it turns the learn pass from a
// gigabyte read into a two-hundred-kilobyte one.
//
// What is recorded is the SHAPE and never the command: `git commit` and not the
// message, `sed` and not the path. A habit is a shape — the argument is the one
// part that differs every time — and a log of shapes cannot leak a secret that
// was passed on a command line.
import fs from "node:fs";
import path from "node:path";
import { VAR, ensureDirs } from "../core/paths.js";
import { now } from "../core/util.js";

export const FILE = () => path.join(VAR, "shapes.jsonl");
/** Rows kept. Past this the oldest half goes: the model wants the habits this
 *  workspace has NOW, and a rotation that keeps everything is a file somebody
 *  eventually deletes by hand. */
export const MAX_ROWS = 20000;

/** One PostToolUse payload -> the shapes it ran. Returns how many were kept, so
 *  a caller can log nothing when the answer is zero. */
export function record(payload, { shapesOf }) {
  const tool = String(payload?.tool_name || "");
  if (tool !== "Bash") return 0;
  const shapes = shapesOf(payload?.tool_input?.command || "");
  if (!shapes.length) return 0;
  const row = { at: now(), s: String(payload.session_id || "").slice(0, 36), v: shapes };
  try {
    ensureDirs();
    fs.appendFileSync(FILE(), JSON.stringify(row) + "\n");
  } catch { return 0; }                                      // a lost row costs the model one occurrence
  return shapes.length;
}

/** The recorded rows, newest last. */
export function rows({ limit = MAX_ROWS } = {}) {
  let text;
  try { text = fs.readFileSync(FILE(), "utf8"); } catch { return []; }
  const lines = text.split("\n").filter(Boolean);
  const out = [];
  for (const l of lines.slice(-limit)) {
    try { const r = JSON.parse(l); if (Array.isArray(r.v) && r.v.length) out.push(r); } catch { /* a torn line is one row */ }
  }
  return out;
}

/** One run per session, in the order the commands happened. */
export function runs({ limit = MAX_ROWS } = {}) {
  const bySession = new Map();
  for (const r of rows({ limit })) {
    const key = r.s || "unknown";
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(...r.v.map(String));
  }
  return [...bySession.values()].filter((r) => r.length >= 2);
}

/** Drop the oldest half when the file is past its cap. Called from the same
 *  hook that appends, so nothing else has to remember to. */
export function rotate({ max = MAX_ROWS } = {}) {
  let text;
  try { text = fs.readFileSync(FILE(), "utf8"); } catch { return 0; }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= max) return 0;
  const keep = lines.slice(Math.floor(lines.length / 2));
  try { fs.writeFileSync(FILE(), keep.join("\n") + "\n"); return lines.length - keep.length; } catch { return 0; }
}

export function stat() {
  try {
    const st = fs.statSync(FILE());
    const r = rows({});
    return { rows: r.length, bytes: st.size, sessions: new Set(r.map((x) => x.s)).size, since: r.length ? r[0].at : "" };
  } catch { return { rows: 0, bytes: 0, sessions: 0, since: "" }; }
}
