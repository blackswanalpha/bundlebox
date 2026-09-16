// wire/proxy.js — `bb proxy`: enforcement at the doorway instead of inside the
// agent.
//
// `bb uptake` measured what advice is worth on this workspace: the MCP tools
// fired in 0 of 19 sessions, pinpoint in 7 of the 17 that opened five or more
// distinct files. The answer for Claude Code was to stop advising and start
// running it — PreToolUse denies a read the brief already quotes, and
// UserPromptSubmit locates the task itself. That answer does not travel: hooks
// are Claude Code's, Codex and OpenCode have their own and narrower shapes, and
// several agents have none at all.
//
// What every one of them does have is a command line. So this wraps it:
//
//   pack    the prompt is located BEFORE the agent sees it, and the map goes
//           into the prompt itself. An agent with no hook system cannot be told
//           to call the locator; it can be handed what the locator returned.
//   serve   the brief is recorded per session, so the same `pre-read` quote
//           service and `bb uptake` measurement work for an agent that never
//           called anything.
//   sieve   the agent's own output passes through the identical pure transform
//           the PostToolUse hook runs, so log and test output is shrunk on the
//           way back for an agent that has no PostToolUse.
//
// It is what `lanes.custom_command` is for, and the substitution contract is
// that config's: `{prompt_file}` and `{cwd}`. `bb proxy -- claude -p ...` wraps
// anything; `bb proxy --agent codex -- codex exec ...` names the agent so the
// record says which one it was.
//
// Two things it deliberately does not do. It never edits the agent's argv apart
// from the prompt file — a proxy that rewrote flags would be a second, worse
// adapter. And it never fails the run: every step is wrapped, and a failure
// anywhere means the agent gets the prompt it would have got with no proxy at
// all, which is exactly the behaviour of not being installed.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, VAR, rel } from "../core/paths.js";
import { load } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { now, sha1, human } from "../core/util.js";
import * as brief from "./brief.js";

export const DIR = () => path.join(VAR, "proxy");

/** The prompt, from wherever this invocation carries it: a `{prompt_file}` the
 *  caller substituted, an explicit `--prompt-file`, or stdin. */
export function readPrompt({ file = "", argv = [] } = {}) {
  if (file) {
    try { return { text: fs.readFileSync(file, "utf8"), from: file }; } catch { return { text: "", from: "" }; }  // no prompt: the agent runs unpacked
  }
  // A path in the argv that exists and looks like a prompt file: this is how
  // `lanes.custom_command` hands one over after `{prompt_file}` is substituted.
  for (const a of argv) {
    if (typeof a !== "string" || a.startsWith("-")) continue;
    if (!/\.(txt|md|prompt)$/i.test(a)) continue;
    try { if (fs.statSync(a).isFile()) return { text: fs.readFileSync(a, "utf8"), from: a }; } catch { /* not that one */ }
  }
  try { return { text: fs.readFileSync(0, "utf8"), from: "-" }; } catch { return { text: "", from: "" }; }  // nothing on stdin either
}

/** Locate the task and return the band that goes in front of the prompt.
 *
 *  The MAP, not the regions — the same ~300 tokens the UserPromptSubmit hook
 *  injects, for the same reason: paying for every located region on every
 *  prompt spends the saving on regions the session never opens. The quoted
 *  regions stay on disk, and `bb pinpoint` or a hook serves one when a read
 *  asks for it. */
export async function pack(prompt, { sessionId = "", cfg = load() } = {}) {
  const p = String(prompt || "").trim();
  if (!p) return { ok: false, why: "no prompt to locate" };
  const hooks = await import("./hooks.js");
  if (!hooks.isTask(p)) return { ok: false, why: "not task-shaped; locating a greeting spends a turn's budget on nothing" };
  const held = brief.current({ maxAgeMin: Number(cfg.wire?.brief_max_age_min) || 45, sessionId });
  if (held && held.problem === p.slice(0, 400)) return { ok: true, band: brief.band(held), reused: true, rec: held };
  const pp = await import("../pinpoint/index.js");
  const t0 = Date.now();
  const b = await pp.build(p, { kind: "fix" });
  const rec = brief.record(b, { sessionId, briefPath: b.path });
  brief.activate(rec);
  brief.prune();
  return { ok: true, band: brief.band(rec), reused: false, rec, ms: Date.now() - t0,
    files: b.scope.length, regions: b.anchors.length, verdict: b.verdict };
}

/** The packed prompt file the agent is actually given. A NEW file beside the
 *  original, never the original rewritten: the caller owns that path, may read
 *  it afterwards, and a proxy that edits somebody else's file in place is a
 *  proxy that loses the thing it was handed. */
export function writePacked(text, { tag = "prompt" } = {}) {
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${tag}-${sha1(text).slice(0, 12)}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  prune(dir);
  return file;
}

const KEEP = 40;
function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))
      .map((f) => { const p = path.join(dir, f); return { p, t: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(KEEP)) { try { fs.unlinkSync(f.p); } catch { /* bounded is best-effort */ } }
  } catch { /* no dir, nothing to prune */ }
}

/** Substitute the packed file for the original everywhere the argv names it,
 *  and fill `{prompt_file}` / `{cwd}` if the caller left them unexpanded. */
export function rewriteArgv(argv, { from = "", to = "", cwd = ROOT } = {}) {
  return argv.map((a) => {
    let s = String(a);
    if (from && to && s === from) return to;
    s = s.replace(/\{prompt_file\}/g, to || from).replace(/\{cwd\}/g, cwd);
    return s;
  });
}

/** The output axis, applied to whatever the agent wrote.
 *
 *  Same pure transform the PostToolUse hook runs, so an agent with no
 *  PostToolUse gets the same compression and `bb sieve replay` still measures
 *  the identical thing. Text only: a stream-json agent's output is a protocol
 *  and cutting the middle out of a protocol produces something nothing can
 *  parse, so `--raw` (or a `--output-format` in the argv) turns it off. */
export async function sieveOut(text, { cfg = load(), tool = "proxy" } = {}) {
  if (!cfg.sieve?.enabled) return { text, tier: null };
  try {
    const { limitsFor, transform } = await import("../sieve/compress.js");
    const { spill } = await import("../sieve/index.js");
    const got = transform(text, limitsFor(cfg), { spill, tool });
    return got ? { text: got.text, tier: got.tier, before: got.before, after: got.after } : { text, tier: null };
  } catch { return { text, tier: null }; }   // a failed sieve hands back what the agent wrote
}

const STRUCTURED = /^--(output-format|json|stream-json)$/;
export const looksStructured = (argv) => argv.some((a) => STRUCTURED.test(String(a)));

/** Run the wrapped command with the packed prompt, sieve what comes back.
 *
 *  stdout is captured rather than inherited, because sieving it is the point.
 *  stderr is inherited: it is the agent talking to the person, it is not billed
 *  into anybody's window, and buffering it would hide a spawn failure until the
 *  process ended. */
export function runAgent(argv, { cwd = ROOT, input = null, onStdout = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: [input == null ? "inherit" : "pipe", "pipe", "inherit"] });
    } catch (e) { resolve({ rc: 127, out: "", error: String(e.message || e) }); return; }
    let buf = "";
    child.stdout.on("data", (d) => { const s = String(d); buf += s; if (onStdout) onStdout(s); });
    child.on("error", (e) => resolve({ rc: e.code === "ENOENT" ? 127 : 1, out: buf, error: String(e.message || e) }));
    child.on("close", (code) => resolve({ rc: code ?? 1, out: buf, error: "" }));
    if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* the agent closed it */ } }
  });
}

/** One proxied run, start to finish. Returns the record, so `--json` and the
 *  human output share one code path and cannot disagree. */
export async function run(argv, { cwd = ROOT, agent = "", promptFile = "", sessionId = "", raw = false, apply = true, cfg = load() } = {}) {
  const rec = { at: now(), agent: agent || "custom", cwd, command: argv.join(" "), packed: false, sieved: false };
  const got = readPrompt({ file: promptFile, argv });
  rec.prompt_from = got.from || "";
  rec.prompt_tokens = 0;

  let packedFile = "";
  let stdinText = got.from === "-" ? got.text : null;
  if (got.text.trim()) {
    const p = await pack(got.text, { sessionId, cfg });
    rec.pack = p.ok ? { reused: p.reused, files: p.files ?? null, regions: p.regions ?? null, verdict: p.verdict ?? null, ms: p.ms ?? null } : { why: p.why };
    if (p.ok && p.band) {
      const body = `${p.band}\n\n${got.text}`;
      rec.packed = true;
      if (got.from && got.from !== "-") { packedFile = writePacked(body, { tag: agent || "prompt" }); rec.packed_file = rel(packedFile); }
      else stdinText = body;
    }
  } else {
    rec.pack = { why: "nothing on stdin and no prompt file in the argv" };
  }

  const finalArgv = rewriteArgv(argv, { from: got.from && got.from !== "-" ? got.from : "", to: packedFile, cwd });
  rec.ran = finalArgv.join(" ");
  if (!apply) return { ...rec, state: "would run", rc: 0 };

  const structured = raw || looksStructured(finalArgv);
  const r = await runAgent(finalArgv, { cwd, input: stdinText,
    // Unsieved output is streamed as it arrives; sieved output cannot be, since
    // the transform needs the whole payload. A structured run is the common
    // case for a lane, and a lane that only prints at the end looks hung.
    onStdout: structured ? (s) => process.stdout.write(s) : null });
  rec.rc = r.rc;
  if (r.error) rec.error = r.error;
  if (!structured) {
    const s = await sieveOut(r.out, { cfg, tool: `proxy:${agent || "custom"}` });
    rec.sieved = Boolean(s.tier);
    if (s.tier) rec.sieve = { tier: s.tier, before: s.before, after: s.after };
    process.stdout.write(s.text);
  } else {
    rec.sieve = { tier: null, why: "structured output: cutting the middle out of a protocol produces something nothing can parse" };
  }
  return rec;
}

export const commands = {
  proxy: {
    help: "the doorway: pack, serve and sieve for an agent that has no hook system (0 model tokens of its own)",
    usage: "bb proxy [--agent codex] [--prompt-file f] [--raw] -- <agent command...>",
    long: [
      "  Hooks enforce on Claude Code. Every other agent gets the instructions block, and `bb uptake`",
      "  measures what that is worth: the MCP tools fired in 0 of 19 sessions on this workspace.",
      "",
      "  This moves the enforcement to the side that does it for nothing. The prompt is LOCATED before",
      "  the agent sees it and the map goes into the prompt; the brief is recorded per session, so the",
      "  read guard and `bb uptake` see an agent that never called anything; and the output comes back",
      "  through the same sieve the PostToolUse hook runs.",
      "",
      "  It is what `lanes.custom_command` is for:",
      "",
      '    "custom_command": "bb proxy --agent codex -- codex exec --cd {cwd} -" ',
      "",
      "  `{prompt_file}` and `{cwd}` are substituted as that setting documents. Nothing in the agent's",
      "  own argv is rewritten except the prompt file, and a failure anywhere hands the agent the prompt",
      "  it would have got with no proxy at all.",
    ].join("\n"),
    run: async ({ flags, rest }) => {
      const argv = (rest || []).filter(Boolean);
      if (!argv.length) { warn("nothing after `--` to run.\n  bb proxy -- <agent command...>"); return 2; }
      const r = await run(argv, {
        cwd: String(flags.cwd || ROOT),
        agent: String(flags.agent || ""),
        promptFile: String(flags.promptFile || ""),
        sessionId: String(flags.session || process.env.BB_SESSION_ID || ""),
        raw: !!flags.raw,
        apply: flags.dryRun !== true,
      });
      if (flags.json) { emit(r); return r.rc || 0; }
      if (r.state === "would run") { out(`  would run: ${r.ran}`); return 0; }
      // To stderr, always: stdout is the agent's and this is the proxy talking.
      const note = [`bundlebox proxy: ${r.packed ? `packed (${r.pack?.files ?? "?"} files, ${r.pack?.regions ?? "?"} regions, ${r.pack?.verdict || "?"})` : `not packed — ${r.pack?.why || "no prompt"}`}`];
      if (r.sieved) note.push(`sieved ${r.sieve.tier} ${human(r.sieve.before)} -> ${human(r.sieve.after)} chars`);
      process.stderr.write(`  ${note.join("; ")}\n`);
      return r.rc || 0;
    },
  },
};
