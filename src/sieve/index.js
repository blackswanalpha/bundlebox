// sieve/index.js — `bb sieve`: the disk and the CLI around the pure compressor.
//
// Everything that can fail lives here and none of it may throw: this module is
// called from a PostToolUse hook, and a reporting hook that can break a session
// is a reporting hook that will eventually break one. Every path returns null
// on error and the session sees the original output, untouched.
//
// Three things are kept on disk, and they are kept apart:
//   var/sieve/<tool>-<hash>.txt   the elided originals, so the dropped middle is
//                                 a grep away instead of a re-run. Bounded.
//   var/sieve/last.json           one hash per tool for the CURRENT session, the
//                                 only state the dedup tier has.
//   store `sieve` (JSONL)         one row per event: which tool, which tier,
//                                 before, after. A ledger that says only
//                                 "saved 4.2M chars" cannot be audited; one that
//                                 says which tool and which tier can.
import fs from "node:fs";
import path from "node:path";
import { VAR, ensureDirs } from "../core/paths.js";
import { load, readJson, writeJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { human, now, sha1, pad, table } from "../core/util.js";
import * as store from "../core/store.js";
import { limitsFor, allowed, transform, rebuild, extractText, duplicateMarker, DEDUP_MIN } from "./compress.js";
import { text as estimateText } from "../tokens/estimate.js";
import { replay } from "./replay.js";

export * from "./compress.js";
export { replay, replaySession, measuredRatio } from "./replay.js";

export const DIR = () => path.join(VAR, "sieve");
const STATE = () => path.join(DIR(), "last.json");
const SPILL_KEEP = 40;

// ── spill: the escape hatch that makes the lossy tier affordable ─────────────

/** Write the full text and return its path, or "" if the disk said no. Never
 *  throws: a failed spill costs the recovery note, not the compression. */
export function spill(text, tool = "tool") {
  try {
    const dir = DIR();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = String(tool).replace(/[^A-Za-z0-9_-]/g, "") || "tool";
    const file = path.join(dir, `${safe}-${sha1(text).slice(0, 12)}.txt`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, { mode: 0o600 });
    prune(dir);
    return file;
  } catch { return ""; }
}

/** Newest SPILL_KEEP survive. Runs at most once per elided output. */
function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))
      .map((f) => { const p = path.join(dir, f); return { p, t: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(SPILL_KEEP)) { try { fs.unlinkSync(f.p); } catch { /* bounded is best-effort */ } }
  } catch { /* no dir, nothing to prune */ }
}

// ── dedup state, keyed by session ───────────────────────────────────────────

/** Has this tool already produced these exact bytes IN THIS SESSION?
 *
 *  `toolUseId` guards the one way this can lie: a hook registered twice (a
 *  plugin manifest plus a leftover settings entry) is invoked twice for the
 *  SAME call, and the second invocation would otherwise match the hash the
 *  first one just stored and report first-seen output as a duplicate of itself. */
export function seenBefore(tool, text, sessionId, toolUseId = "") {
  if (!sessionId || text.length < DEDUP_MIN) return false;
  try {
    const p = STATE();
    try { if (fs.lstatSync(p).isSymbolicLink()) return false; } catch (e) { if (e.code !== "ENOENT") return false; }
    let state = readJson(p, null);
    if (!state || typeof state !== "object" || state.session !== sessionId) state = { session: sessionId, tools: {} };
    if (!state.tools || typeof state.tools !== "object") state.tools = {};
    const h = sha1(text);
    const rec = state.tools[tool] || {};
    const dup = rec.hash === h && !(toolUseId && rec.id && rec.id === toolUseId);
    state.tools[tool] = { hash: h, id: toolUseId || rec.id || "" };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, state);
    return dup;
  } catch { return false; }
}

// ── the hook ────────────────────────────────────────────────────────────────

/** One PostToolUse payload -> the replacement text, or null to leave it alone.
 *  Exported separately from the emit so a test can assert the decision without
 *  a process, and so `bb sieve check` runs the identical path. */
export function decide(payload, cfg = load()) {
  if (!payload || typeof payload !== "object") return null;
  if (!cfg.sieve?.enabled) return null;
  const limits = limitsFor(cfg);
  const tool = String(payload.tool_name || "");
  if (!allowed(tool, limits)) return null;
  const body = extractText(payload.tool_response != null ? payload.tool_response : payload.tool_output);
  if (!body) return null;

  if (seenBefore(tool, body, String(payload.session_id || ""), String(payload.tool_use_id || ""))) {
    const marker = duplicateMarker(tool, body);
    if (marker.length < body.length) {
      return { text: marker, tier: "dedup", tool, before: body.length, after: marker.length };
    }
  }
  const got = transform(body, limits, { spill, tool });
  return got ? { ...got, tool } : null;
}

/** The hook body. Prints at most one JSON object, always returns 0. */
export function postTool(payload) {
  const got = decide(payload);
  if (!got) return 0;
  const response = payload.tool_response != null ? payload.tool_response : payload.tool_output;
  const rebuilt = rebuild(response, got.text);
  // A shape we cannot rebuild is silently rejected by the harness, so emitting
  // it would fill the ledger with savings the session never got. Emit nothing.
  if (rebuilt == null) return 0;
  try {
    store.append("sieve", { ts: now(), session_id: String(payload.session_id || ""), tool: got.tool, tier: got.tier,
      before: got.before, after: got.after, saved: got.before - got.after });
  } catch { /* the ledger is a courtesy; the compression already happened */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: rebuilt } }) + "\n");
  return 0;
}

// ── what the ledger holds ───────────────────────────────────────────────────

/** MEASURED: every event the hook actually emitted, folded by tool and tier. */
export function ledger({ limit = 0 } = {}) {
  const rows = store.rows("sieve", limit ? { limit } : {});
  const byTool = {}, byTier = { scrub: 0, elide: 0, dedup: 0 };
  let before = 0, after = 0;
  for (const r of rows) {
    const b = Number(r.before) || 0, a = Number(r.after) || 0;
    before += b; after += a;
    byTier[r.tier] = (byTier[r.tier] || 0) + (b - a);
    const t = (byTool[r.tool] ||= { n: 0, saved: 0 });
    t.n += 1; t.saved += b - a;
  }
  return { events: rows.length, before, after, saved: before - after, by_tool: byTool, by_tier: byTier,
    sessions: new Set(rows.map((r) => r.session_id).filter(Boolean)).size };
}

// ── commands ────────────────────────────────────────────────────────────────

const read = (p) => (p === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.isAbsolute(p) ? p : path.join(process.cwd(), p), "utf8"));
const pctOf = (a, b) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : "n/a");

function status(cfg, flags) {
  const limits = limitsFor(cfg);
  const led = ledger();
  if (flags.json) { emit({ enabled: !!cfg.sieve?.enabled, limits, ledger: led, spill_dir: DIR() }); return 0; }
  out(`  sieve  ${cfg.sieve?.enabled ? "enabled" : "disabled"} — set sieve.enabled in .bundlebox/config.json; the hook is installed by \`bb wire --apply\``);
  out(table([
    ["cap per result", `${human(limits.maxTokens)} tokens (${cfg.sieve?.max_share} of the working window)`],
    ["kept", `first ${limits.headLines} lines, last ${limits.tailLines}`],
    ["tools", limits.tools.join(", ")],
    ["never touched", "Read, Edit, Write — their output is what a later edit is matched against"],
    ["spill", DIR()],
  ]).split("\n").map((l) => "  " + l).join("\n"));
  out("");
  if (!led.events) {
    out("  ledger: empty. Nothing has gone through the hook on this box yet.");
    out("  `bb sieve replay` measures what it WOULD have saved on the sessions already on disk — 0 tokens, no wiring needed.");
    return 0;
  }
  out(`  ledger  MEASURED over ${led.events} event(s) across ${led.sessions} session(s)`);
  out(`    ${human(led.before)} -> ${human(led.after)} chars, saved ${human(led.saved)} (${pctOf(led.saved, led.before)})`);
  out(`    by tier: scrub ${human(led.by_tier.scrub || 0)} (lossless), dedup ${human(led.by_tier.dedup || 0)}, elide ${human(led.by_tier.elide || 0)} (lossy)`);
  const tools = Object.entries(led.by_tool).sort((a, b) => b[1].saved - a[1].saved).slice(0, 8);
  out(table(tools.map(([t, v]) => [t, String(v.n), human(v.saved)]), { header: ["tool", "events", "chars saved"] })
    .split("\n").map((l) => "    " + l).join("\n"));
  return 0;
}

function showReplay(flags) {
  const r = replay({ limit: Number(flags.limit) || 0 });
  if (flags.json) { emit(r); return 0; }
  if (!r.scanned) {
    warn("  no tool results found in any transcript for this workspace.");
    if (r.unseen.length) warn(`  could not look at: ${r.unseen.join(", ")} — that is unknown, not zero.`);
    return 2;
  }
  out(`  replay over ${r.sessions} session(s) — cap ${human(r.limits.maxTokens)} tokens, head ${r.limits.headLines}, tail ${r.limits.tailLines}`);
  out("");
  out(table([
    ["tool results scanned", `${r.scanned.toLocaleString("en-US")}  (${human(r.chars)} chars)`],
    ["scrubbed / elided", `${r.touched.toLocaleString("en-US")}  (${human(r.before)} -> ${human(r.after)})`],
    ["deduped repeats", `${r.dedup.toLocaleString("en-US")}  (${human(r.dedup_chars)} chars)`],
    ["outputs with errors carried out of the cut", String(r.salvaged)],
    ["chars saved", `${human(r.saved_chars)}  (${pctOf(r.saved_chars, r.chars)} of all tool output)`],
  ]).split("\n").map((l) => "  " + l).join("\n"));
  out("");
  out(`  tokens saved   ${human(r.saved_tokens_estimate)}   ESTIMATE  (the estimator, both sides of the transform)`);
  if (r.saved_tokens_measured == null) {
    out(`  tokens saved   unknown                MEASURED  (needs turns where exactly one tool result arrived; found ${r.measured_samples})`);
  } else {
    out(`  tokens saved   ${human(r.saved_tokens_measured)}   MEASURED  (${Math.round(r.measured_ratio * 1000) / 1000} tok/char, median of ${r.measured_samples} billed window deltas)`);
  }
  if (r.unnamed) out(`\n  ${r.unnamed.toLocaleString("en-US")} result(s) carried no tool name and were skipped: unknown, not zero.`);
  if (r.unseen.length) out(`  could not look at: ${r.unseen.join(", ")}.`);

  const tools = Object.entries(r.by_tool).sort((a, b) => (b[1].before - b[1].after) - (a[1].before - a[1].after)).slice(0, 10);
  if (tools.length) {
    out("\n  where it came from\n");
    out(table(tools.map(([t, v]) => [t, String(v.n), String(v.dedup), human(v.before - v.after), pctOf(v.before - v.after, v.before)]),
      { header: ["tool", "touched", "dedup", "chars saved", "of its own"] }).split("\n").map((l) => "    " + l).join("\n"));
  }
  const skipped = Object.entries(r.skipped).sort((a, b) => b[1] - a[1]);
  if (skipped.length) {
    out("\n  big outputs the allowlist did NOT touch (this is the correctness half, not a miss)\n");
    for (const [t, n] of skipped.slice(0, 8)) out(`    ${pad(t, 22)} ${human(n)} chars`);
  }
  return 0;
}

function check(target, cfg, flags) {
  let src;
  try { src = read(String(target)); } catch (e) { warn(`cannot read ${target}: ${e.message}`); return 2; }
  const limits = limitsFor(cfg);
  const got = transform(src, limits, { tool: String(flags.tool || "Bash") });
  if (flags.json) { emit(got ? { ...got, text: flags.text ? got.text : undefined } : { tier: null, before: src.length, after: src.length }); return 0; }
  if (!got) { out(`  ${target}: ${human(src.length)} chars, ${human(estimateText(src, "code"))} tokens — under the ${human(limits.maxTokens)}-token cap, nothing to do.`); return 0; }
  out(`  ${target}  ${got.tier}  ${human(got.before)} -> ${human(got.after)} chars, ${human(got.tokens_before)} -> ${human(got.tokens_after)} tokens`);
  if (flags.text) process.stdout.write(got.text + "\n");
  else out("  --text prints the compressed output.");
  return 0;
}
async function cmd({ _, flags }) {
  const cfg = load();
  const sub = _[0] || "status";
  if (sub === "replay") return showReplay(flags);
  if (sub === "check") { const t = _[1]; if (!t) { warn("bb sieve check <file|-> [--text]"); return 2; } return check(t, cfg, flags); }
  if (sub === "spill") {
    let files = [];
    try { files = fs.readdirSync(DIR()).filter((f) => f.endsWith(".txt")); } catch { /* none yet */ }
    if (flags.json) { emit({ dir: DIR(), files }); return 0; }
    if (!files.length) { out(`  no spilled output under ${DIR()} — nothing has been elided on this box.`); return 0; }
    out(`  ${files.length} elided original(s) under ${DIR()} — grep these instead of re-running the command:`);
    for (const f of files.sort()) out(`    ${f}`);
    return 0;
  }
  if (sub === "status" || !sub) return status(cfg, flags);
  warn(`unknown sub-verb \`${sub}\`. bb sieve [status|replay|check <file>|spill]`);
  return 2;
}

export const commands = {
  sieve: {
    help: "the input axis: shrink a tool result before it enters the window, and measure it on transcripts that already exist (0 tokens)",
    usage: "bb sieve [status] | bb sieve replay [--limit N] [--json] | bb sieve check <file|-> [--text] | bb sieve spill",
    long: [
      "  bb sieve replay        what it WOULD have saved, over this workspace's own transcripts. Deterministic, free.",
      "  bb sieve               the thresholds, the allowlist, and what the hook has actually saved so far.",
      "  bb sieve check <f>     one payload through the same transform, so a threshold can be argued with.",
      "  bb sieve spill         the elided originals, kept so recovery is a grep and never a re-run.",
      "",
      "Every other verb shrinks what a session is ASKED to read. This one shrinks what it reads because it",
      "ran a command: a 4,000-line test log is billed when it arrives and again on every later turn, because",
      "the whole window is re-sent. Three tiers — scrub (lossless), dedup (already in the window), elide",
      "(head + tail + the error lines carried out of the middle). Read, Edit and Write are never touched:",
      "their output is the text a later exact-match edit is written against.",
      "",
      "Installed by `bb wire --apply` as a PostToolUse hook, and off until `sieve.enabled` is set.",
      "Measure first: `bb sieve replay` needs no wiring and spends nothing.",
    ].join("\n"),
    run: cmd,
  },
};
