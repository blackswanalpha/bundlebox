// echos/index.js — `bb echos`: the agents that watch the work, not the tree.
//
// `bb scan` runs eighteen detectors over what is on disk. None of them could
// answer the other question — whether the work being done to that disk is going
// anywhere — because none of them reads the record of what sessions did. This
// verb does, and every input it uses is already on disk as a by-product of
// running: the recorded command shapes, the folded transcripts, the brief
// records. An echo costs a read and never a model call.
//
// The five are in `arc/src/echos/`, in Rust, because this runs over every event
// a workspace has ever recorded — tens of thousands of rows here — at session
// end, where the budget is seconds. This file is the other half of that split
// and it is the same split `bb arc` already makes: the binary is the
// implementation, and there is a JavaScript fallback so a box with no compiled
// `arc` still gets the answer rather than a shrug.
//
//   spin         the same command, again, with nothing edited between
//   oscillate    a file returning to a value it already had
//   drift        turns passing and not one file changing
//   diminishing  the late half of a session costing more per change than the early
//   converge     the located scope has stopped moving — the STOP condition, and
//                the one this loop never had
//   stray        the work landed outside the located scope — the locator was
//                wrong, and until now nothing wrote that down
//   batching     one tool call per turn, which is one round trip per fact
//
// Wired rather than offered. `echos.on_session_end` runs them while the
// session's own rows are fresh, the `echos` pipeline stage reports them, and
// every hit becomes a finding so `bb findings` and `bb explain` work on them
// exactly as they do on a detector's.
import fs from "node:fs";
import path from "node:path";
import { OUT, VAR, rel } from "../core/paths.js";
import { load } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { now, sha1, table } from "../core/util.js";
import { run as exec } from "../core/exec.js";
import * as store from "../core/store.js";
import * as ledger from "../tokens/ledger.js";
import * as record from "../lathe/record.js";
import { BIN } from "../arc/index.js";
import * as wire from "../wire/brief.js";

export const DIR = () => path.join(OUT, "echos");
export const LATEST = () => path.join(DIR(), "latest.json");
export const IDS = ["spin", "oscillate", "drift", "diminishing", "converge", "stray", "batching"];

const ms = (ts) => { const t = Date.parse(ts || ""); return Number.isFinite(t) ? t : 0; };
const hash = (s) => sha1(String(s)).slice(0, 16);

// ── the event stream ────────────────────────────────────────────────────────

/** Command shapes, from the log the PostToolUse hook already appends to.
 *
 *  Free by construction: `lathe.record_shapes` writes these so the automation
 *  engine can learn command ORDER, and order is exactly what `spin` needs. Two
 *  readers, one write. */
export function shapeEvents({ limit = 20000 } = {}) {
  const rows = record.rows({ limit });
  const out = [];
  for (const r of rows) {
    const at = ms(r.at);
    for (const v of r.v || []) {
      // Only shapes that NAME the work. A recorded shape drops the arguments,
      // so ten `cat`s in a row are ten different files and four `grep`s are
      // four different searches — the first run of `spin` on this box reported
      // exactly those as spinning, which is a description of reading. The same
      // filter drops the rows written before `commandShapes` stopped shaping
      // heredoc bodies, which are not commands at all.
      const shape = String(v);
      if (!record.names(shape)) continue;
      out.push({ at, session: String(r.s || ""), kind: "shape", shape, polls: polls(shape) });
    }
  }
  return out;
}

/** Commands whose answer this box does not control, so repeating one is
 *  WAITING rather than spinning.
 *
 *  Every `spin` hit on this workspace's first run was one of these: `gh pr` in
 *  four sessions, `curl` in another, `git show` in a sixth. The rule asked "did
 *  a file change between these two runs" of commands that were never about a
 *  file — a PR's checks finish, a service comes up, and the local tree has
 *  nothing to do with either.
 *
 *  Two kinds, and they fail the same test for different reasons:
 *
 *    outside    `gh`, `curl`, a git subcommand that reaches a remote. The thing
 *               being asked about changes without anybody editing anything.
 *    dispatch   `git show <rev>`, `npm run <script>`, `make <target>`. A
 *               recorded shape drops the argument, and the argument is what
 *               selects the command — so two runs of one shape are two
 *               different commands, the same problem `record.names` solves for
 *               `cat` and `grep`.
 *
 *  It marks the event rather than dropping it. The command DID run, and `drift`
 *  counts it; only `spin`'s repeat rule ignores it. */
const OUTSIDE = /^(gh|curl|wget|http|https|ssh|scp|rsync|docker|docker-compose|podman|kubectl|helm|ping|nc|dig|host|nslookup|aws|gcloud|az|heroku|fly|vercel|netlify|npm view|npm ping|pip download)\b/;
const REMOTE_GIT = /^git (fetch|pull|push|clone|ls-remote|remote|submodule)$/;
const DISPATCH = /^(git (show|log|diff|blame|cat-file|rev-parse|rev-list)|npm run|yarn run|pnpm run|bun run|make|just|task|rake|gradle|mvn|cargo run|docker run)$/;
export function polls(shape) {
  const s = String(shape || "");
  return OUTSIDE.test(s) || REMOTE_GIT.test(s) || DISPATCH.test(s);
}

/** Commands that CHANGE something, so a session that only runs these has still
 *  done work.
 *
 *  `bb uptake` settled the same argument for the other direction and states it
 *  plainly: a file opened with `sed -n` counts exactly as much as one opened
 *  with Read, because which tool a session uses is a harness setting and not a
 *  fact about whether it opened a file. Nothing here said the equivalent about
 *  WRITING, and the first run of `drift` reported four sessions as having
 *  changed nothing — one of which had 217 Bash calls carrying 59 redirects,
 *  42 heredocs, 11 git writes and 4 `sed -i`. Counting only the Edit and Write
 *  tools measured the harness, not the work.
 *
 *  A redirect to `/dev/null` or a `2>&1` is not a write, which is why the
 *  target has to look like a path. */
const REDIRECT = /(?:^|[^>&0-9])>>?\s*(?!\s*&)(?!\/dev\/)[\w./~$-]+/;
const SHELL_WRITES = [
  /\bsed\s+(?:-[a-zA-Z]*\s+)*-i\b/,                       // in-place edit
  /(?:^|[|;&]\s*)tee\s+(?!-)[\w./~$-]/,                   // tee FILE
  /(?:^|[|;&]\s*)(?:mv|cp|rm|mkdir|touch|chmod|ln)\s+[\w./~$-]/,
  /\bgit\s+(?:checkout|apply|restore|revert|stash|rm|mv|add|commit|merge|rebase|reset)\b/,
  /\b(?:fs\.(?:writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync)|\.write_text\s*\(|\.unlink\s*\()/,
  /<<-?\s*['"]?\w+['"]?[\s\S]*?(?:>\s*[\w./~$-]+|write_text|writeFileSync)/,
];
/** Does this shell command write? One answer per command: a command that writes
 *  three files is still one act of writing, and `drift` counts acts. */
export function writesFiles(cmd) {
  const s = String(cmd || "");
  if (!s) return false;
  return REDIRECT.test(s) || SHELL_WRITES.some((re) => re.test(s));
}

/** Turns, reads and edits, from the transcripts the agents already wrote.
 *
 *  The edit hash is of the text WRITTEN, not of the file afterwards, and that
 *  is the honest thing to hash: nothing on disk records what a file contained
 *  between two edits, and the string an exact-match edit installed is the one
 *  value this box can compare against a later one. A file set back to a string
 *  it held earlier in the session is what `oscillate` is about, and this sees
 *  exactly that and nothing more. */
export function transcriptEvents({ limit = 0 } = {}) {
  const entries = ledger.transcripts();
  const list = limit > 0 ? entries.slice(-limit) : entries;
  const out = [];
  const unseen = entries.unknown || [];
  for (const e of list) {
    const tr = ledger.read(e);
    if (!tr || !tr.turns?.length) continue;
    const session = String(tr.sessionId || "");
    for (const t of tr.turns) {
      const at = ms(t.ts);
      const window = (Number(t.input) || 0) + (Number(t.cacheWrite) || 0) + (Number(t.cacheRead) || 0);
      // `tools` is the whole turn's call count, not the calls that produced an
      // event below: a Grep, a Glob or an MCP call is a round trip exactly as a
      // Read is, and counting only the ones this stream models would measure the
      // model of the work instead of the work.
      out.push({ at, session, kind: "turn", tokens: window || (Number(t.output) || 0), tools: (t.toolUses || []).length });
      for (const u of t.toolUses || []) {
        const name = String(u.name || "");
        const file = String(u.input?.file_path || u.input?.path || "");
        if (/^(Read|NotebookRead)$/.test(name)) { out.push({ at, session, kind: "read", file: rel(file) }); continue; }
        // A write through the shell is a write. No hash and no path: a redirect
        // or a `sed -i` does not hand this box the text it installed, so the
        // event carries the fact that something changed and nothing more.
        // `oscillate` requires a hash and so ignores these, which is the honest
        // outcome — it cannot say a `sed -i` returned a file to an earlier
        // value. `drift` and `diminishing` only need the count, and the count
        // is what they were missing.
        if (name === "Bash") {
          if (writesFiles(u.input?.command || u.input?.cmd || "")) out.push({ at, session, kind: "edit", file: "", hash: "" });
          continue;
        }
        if (!/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name) || !file) continue;
        const edits = Array.isArray(u.input?.edits) ? u.input.edits : null;
        const texts = edits ? edits.map((x) => x && x.new_string).filter((x) => typeof x === "string")
          : [u.input?.content, u.input?.new_string, u.input?.new_source].filter((x) => typeof x === "string");
        // Repo-relative, because a brief's scope is and `stray` compares the
        // two. A tool hands over an absolute path; the same file under two
        // spellings is two files to every rule that keys on one.
        for (const text of texts) out.push({ at, session, kind: "edit", file: rel(file), hash: hash(text) });
      }
    }
  }
  return { events: out, unseen };
}

/** The briefs this workspace has located, with the scope each one landed on.
 *
 *  `converge` is the only echo that reads across sessions, and this is why: a
 *  brief is written once per task prompt, so the sequence that matters belongs
 *  to the workspace and not to any one session.
 *
 *  Two sources, and the order matters. `wire/brief.js` keeps ONE active record
 *  per session for the guards to query, so a session that located four tasks
 *  left three of them nowhere — and a scope that had to be located again is the
 *  one worth scoring. The log holds every brief; the per-session records are
 *  read only for sessions the log never saw, which is every session from before
 *  it existed. Counting both for one session would count one brief twice. */
export function briefEvents() {
  const out = [];
  const seen = new Set();
  for (const rec of wire.logged({})) {
    const scope = (rec.scope || []).map(String).filter(Boolean);
    if (!scope.length) continue;
    const session = String(rec.session_id || "");
    seen.add(session);
    out.push({ at: ms(rec.at), session, kind: "brief", scope });
  }
  const dir = path.join(VAR, "brief");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return out; }  // no brief has been recorded here yet
  for (const n of names) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { continue; }   // a half-written record is one brief
    const scope = (rec.scope || []).map(String).filter(Boolean);
    const session = String(rec.session_id || n.replace(/[.]json$/, ""));
    if (!scope.length || seen.has(session)) continue;
    out.push({ at: ms(rec.at || rec.recorded), session, kind: "brief", scope });
  }
  return out;
}

/** Everything, in one stream. Sorted by time here rather than in the echo, so
 *  both implementations see the identical order and cannot disagree about which
 *  came first. */
export function events({ limit = 0 } = {}) {
  const t = transcriptEvents({ limit });
  const all = [...shapeEvents({}), ...t.events, ...briefEvents()];
  all.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { events: all, unseen: t.unseen };
}

// ── running them ────────────────────────────────────────────────────────────

export function thresholds(cfg = load()) {
  const e = cfg.echos || {};
  return {
    spin_repeats: Number(e.spin_repeats) || 4,
    oscillate_flips: Number(e.oscillate_flips) || 3,
    drift_turns: Number(e.drift_turns) || 12,
    diminishing_ratio: Number(e.diminishing_ratio) || 1.6,
    converge_similarity: Number(e.converge_similarity) || 0.95,
    converge_runs: Number(e.converge_runs) || 3,
    stray_share: e.stray_share == null ? 0.5 : Number(e.stray_share),
    stray_edits: Number(e.stray_edits) || 4,
    stray_briefs: Number(e.stray_briefs) || 2,
    batching_ratio: Number(e.batching_ratio) || 1.5,
    batching_calls: Number(e.batching_calls) || 20,
    batching_sessions: Number(e.batching_sessions) || 3,
  };
}

/** The Rust implementation. Returns null when there is no binary, so the caller
 *  can fall back and say which one answered. */
export function viaArc(payload) {
  const bin = BIN();
  if (!bin) return null;
  const r = exec([bin, "echos"], { input: JSON.stringify(payload), timeout: 60000 });
  if (r.rc !== 0) return null;
  try { return { ...JSON.parse(r.out), engine: "arc" }; } catch { return null; }  // a binary from another version: fall back
}

export async function run({ cfg = load(), limit = 0, only = [] } = {}) {
  const th = thresholds(cfg);
  const { events: evs, unseen } = events({ limit });
  const payload = { events: evs, thresholds: th, only };
  const got = viaArc(payload) || (await import("./fallback.js")).run(payload);
  return { at: now(), ...got, unseen, registry: got.registry || IDS };
}

// ── findings ────────────────────────────────────────────────────────────────

/** An echo hit, in the shape the findings store already holds.
 *
 *  Same store and the same `bb findings` / `bb explain` path as a detector's,
 *  because the alternative is a second list of problems in a second place, and
 *  the whole argument of this box is against exactly that. `path` is the
 *  session rather than a file: an echo is about the work, and pointing it at a
 *  file would send a fix to the wrong place. */
export function asFindings(r) {
  const out = [];
  for (const e of r.echos || []) {
    if (e.verdict !== "hit") continue;
    out.push({
      detector: `echo:${e.id}`,
      severity: e.severity || "low",
      precision: "exact",
      kind: "investigate",
      path: ".",
      files: [],
      key: `echo:${e.id}:${e.session}:${(e.evidence || [])[0] || ""}`,
      title: `${e.id}: ${String(e.detail).split(".")[0]}`,
      detail: e.detail,
      evidence: { count: e.support || 1, session: e.session, lines: e.evidence || [] },
      fix_hint: FIX[e.id] || "",
      status: "open",
      at: r.at,
    });
  }
  return out;
}

const FIX = {
  spin: "Change something before running it again, or read the last failure: the same command over the same tree returns the same answer.",
  oscillate: "Decide which of the two states is wanted and say why in a comment. A file that keeps reverting is two intentions, not one bug.",
  drift: "If this is an investigation, say so — `bb compile` gives it its own budget. If it is not, `bb pinpoint \"<the task>\"` names the files instead of finding them.",
  diminishing: "Close the session and open a new one on what is left. `bb pinpoint` hands the next one the brief instead of everything read so far.",
  converge: "Stop re-locating and close it: the scope has been the same files for three briefs running.",
};

export function write(r) {
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(LATEST(), JSON.stringify(r, null, 2) + "\n");
  return LATEST();
}

export function latest() {
  try { return JSON.parse(fs.readFileSync(LATEST(), "utf8")); } catch { return null; }  // never run here
}

/** Merge echo findings into the store, replacing the previous echo rows and
 *  leaving every detector row alone. Replaced and not appended: an echo is a
 *  statement about the record as it is NOW, and yesterday's spin is not an open
 *  problem, it is a thing that happened. */
export function file(r) {
  const prior = store.get("findings", []);
  const kept = (Array.isArray(prior) ? prior : []).filter((f) => f && !String(f.detector || "").startsWith("echo:"));
  const mine = asFindings(r).map((f) => ({ ...f, id: sha1(f.key).slice(0, 10) }));
  store.put("findings", [...kept, ...mine]);
  return mine.length;
}

// ── the verb ────────────────────────────────────────────────────────────────

const MARK = { hit: "HIT", ok: "ok", unknown: "unknown" };

export function report(r) {
  const L = [`  ECHOS — ${r.events} event(s) over ${r.sessions} session(s), ${r.hits} hit(s) in ${Math.round(r.ms || 0)}ms (${r.engine})`, ""];
  L.push(table((r.echos || []).map((e) => [
    MARK[e.verdict] || e.verdict, e.id, e.session ? e.session.slice(0, 12) : "—",
    e.support ? String(e.support) : "—", e.severity, String(e.detail).slice(0, 84),
  ]), { header: ["", "echo", "session", "n", "sev", "what it found"] }).split("\n").map((l) => "  " + l).join("\n"));
  const hits = (r.echos || []).filter((e) => e.verdict === "hit");
  for (const e of hits) {
    L.push("", `  ${e.id} — ${e.detail}`);
    if (e.evidence?.length) L.push(`    evidence: ${e.evidence.join("  ")}`);
    if (FIX[e.id]) L.push(`    ${FIX[e.id]}`);
  }
  const unknown = (r.echos || []).filter((e) => e.verdict === "unknown");
  if (unknown.length) {
    L.push("", "  could not look — unknown, not zero:");
    for (const e of unknown) L.push(`    ${e.id.padEnd(12)} ${e.detail}`);
  }
  if (r.unseen?.length) L.push(`\n  could not read: ${r.unseen.join(", ")}.`);
  return L.join("\n");
}

async function cmd({ _, flags }) {
  const cfg = load();
  const sub = _[0] || "run";
  if (sub === "show") {
    const r = latest();
    if (!r) { warn("nothing stored. bb echos"); return 2; }
    if (flags.json) { emit(r); return 0; }
    out(report(r));
    return 0;
  }
  if (sub === "list") {
    if (flags.json) { emit({ echos: IDS, thresholds: thresholds(cfg) }); return 0; }
    out(table(IDS.map((i) => [i, FIX[i] ? "yes" : "no", WHAT[i]]), { header: ["echo", "has a fix", "what it watches for"] })
      .split("\n").map((l) => "  " + l).join("\n"));
    out(`\n  thresholds: ${Object.entries(thresholds(cfg)).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    out("  every one is `echos.<name>` in .bundlebox/config.json, and every result prints the value that decided it.");
    return 0;
  }
  if (sub !== "run") { warn(`unknown echos sub-verb: ${sub}. run | show | list`); return 2; }
  if (cfg.echos?.enabled === false) { warn("echos.enabled is false in .bundlebox/config.json"); return 2; }
  const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const r = await run({ cfg, limit: Number(flags.limit) || 0, only });
  if (flags.write !== false) write(r);
  const filed = flags.file === false ? 0 : file(r);
  if (flags.json) { emit({ ...r, filed }); return r.hits ? 1 : 0; }
  out(report(r));
  if (filed) out(`\n  ${filed} finding(s) filed — \`bb findings\`, \`bb explain <id>\`. Stored at ${rel(LATEST())}.`);
  else out(`\n  nothing to file. Stored at ${rel(LATEST())}.`);
  return r.hits ? 1 : 0;
}

const WHAT = {
  spin: "the same command, again, with nothing edited between",
  oscillate: "a file returning to a value it already had",
  drift: "turns passing and not one file changing",
  diminishing: "the late half of a session costing more per change than the early half",
  converge: "the located scope has stopped moving — stop re-locating and close it",
};

export const commands = {
  echos: {
    help: "the five agents that watch the work rather than the tree: spin, oscillate, drift, diminishing, converge (0 tokens)",
    usage: "bb echos [run] [--only spin,drift] [--limit N] [--json] | bb echos show | bb echos list",
    long: [
      "  Every detector in this box reads the SOURCE. These read the RECORD of what sessions did to it,",
      "  which is the question none of the others could answer: is the work going anywhere.",
      "",
      "  Their inputs already exist. The command shapes come from the log the PostToolUse hook appends",
      "  for `bb lathe`; the turns, reads and edits come from the transcripts the agents themselves",
      "  wrote; the located scopes come from the brief records. Nothing here calls a model and nothing",
      "  here re-derives anything.",
      "",
      "  The implementation is Rust, in arc/src/echos/, because this runs over every event a workspace",
      "  has ever recorded and it runs at session end. A box with no compiled `arc` gets the identical",
      "  answer from the JavaScript fallback, and the report says which one answered.",
      "",
      `  \`spin\`, \`oscillate\`, \`drift\` and \`diminishing\` report trouble. \`converge\` reports a STOP`,
      "  condition — the located scope has been the same files for three briefs, so re-locating it is a",
      "  cost with no information in it. rc 1 when anything hit.",
    ].join("\n"),
    run: cmd,
  },
};
