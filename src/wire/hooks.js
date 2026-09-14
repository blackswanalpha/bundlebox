// hooks.js — `bb hook <event>`: the handlers an agent's hook system calls.
//
// Contract: read the payload on stdin (any shape, possibly empty), print at
// most one JSON object on stdout, ALWAYS exit 0 within the budget. A reporting
// hook that can fail a session is a reporting hook that will eventually fail
// a session. Failures are appended to .bundlebox/var/hooks.log so a hook that
// stopped working is visible somewhere, unlike the original's `2>/dev/null`.
import fs from "node:fs";
import path from "node:path";
import { VAR, OUT, ROOT, ensureDirs } from "../core/paths.js";
import { load } from "../core/config.js";
import * as store from "../core/store.js";
import { text as estimateText, file as estimateFile } from "../tokens/estimate.js";
import { now } from "../core/util.js";

const CAPS = { "session-start": 600, prompt: 300, "pre-read": 200 };

function readStdin() {
  try { const s = fs.readFileSync(0, "utf8"); return s.trim() ? JSON.parse(s) : {}; } catch { return {}; }
}
function log(event, msg) {
  try { ensureDirs(); fs.appendFileSync(path.join(VAR, "hooks.log"), `${now()} ${event} ${msg}\n`); } catch { /* the log is a courtesy */ }
}
function capTokens(s, cap) {
  if (estimateText(s, "prose") <= cap) return s;
  const lines = s.split("\n");
  while (lines.length > 1 && estimateText(lines.join("\n"), "prose") > cap) lines.pop();
  return lines.join("\n") + "\n…";
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function sessionStart() {
  const cfg = load();
  if (!cfg.wire.inject_context) return;
  const parts = [];
  const index = path.join(OUT, "snapgen", "INDEX.md");
  if (fs.existsSync(index)) parts.push("bundlebox reference tables (read instead of searching):\n" + fs.readFileSync(index, "utf8").trim());
  else parts.push("bundlebox: no snapgen tables yet — `bb snapgen build` writes layout, symbols, routes, docs, commands, hot.");
  const open = store.openFindings();
  if (open.length) {
    const by = {};
    for (const f of open) by[f.detector] = (by[f.detector] || 0) + 1;
    parts.push(`open findings: ${open.length} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")}) — \`bb findings\`, \`bb explain <id>\``);
  }
  parts.push("For a task: `bb pinpoint \"<task>\"` writes a located, budgeted brief; `bb context <files>` says whether a scope fits.");
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: capTokens(parts.join("\n\n"), CAPS["session-start"]) } });
}

async function prompt(payload) {
  const cfg = load();
  if (!cfg.wire.inject_context) return;
  const p = String(payload.prompt || payload.user_prompt || "");
  // Only a task-shaped prompt earns the suggestion; a question or a one-word reply does not.
  if (p.length < 40 || !/\b(fix|add|implement|refactor|change|update|write|remove|migrate|debug|investigate|make|build)\b/i.test(p)) return;
  const ctx = `bundlebox: before searching, run \`bb pinpoint "${p.slice(0, 120).replace(/"/g, "'")}"\` — it locates the symbols, quotes the regions and budgets the scope for 0 tokens (or call the bb_pinpoint MCP tool).`;
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: capTokens(ctx, CAPS.prompt) } });
}

async function preRead(payload) {
  const cfg = load();
  if (!cfg.wire.guard_reads) return;
  const fp = payload?.tool_input?.file_path || payload?.tool_input?.path;
  if (!fp || payload?.tool_input?.limit) return;           // a ranged read is already the advice
  const tokens = estimateFile(fp);
  const capacity = Number(cfg.budget.max_tokens) - Number(cfg.budget.reserve_output);
  if (!tokens || tokens < capacity * 0.35) return;
  // Advisory, never a denial: the agent may need the whole file. But it should know the price.
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    permissionDecisionReason: capTokens(`bundlebox: ${path.basename(fp)} is ~${Math.round(tokens / 1000)}k tokens (${Math.round(100 * tokens / capacity)}% of the working window). Read a range with offset/limit; \`bb pinpoint\` or the bb_pinpoint tool quotes the region you need.`, CAPS["pre-read"]) } });
}

async function preCompact(payload) {
  store.append("episodes", { kind: "hook", verb: "compaction", features: { trigger: payload.trigger || "auto" }, rc: 0, seconds: 0, produced: 0, turns_saved: 0, session_id: payload.session_id || "" });
}

async function sessionEnd(payload) {
  const cfg = load();
  if (!cfg.wire.measure_sessions) return;
  const { end } = await import("../tokens/session.js");
  const line = await end({ sessionId: payload.session_id || "", transcriptPath: payload.transcript_path || "" });
  if (line) process.stderr.write(String(line).trim() + "\n");   // stderr: shown to the person, never parsed by the harness
}

export async function handle(event) {
  const payload = readStdin();
  const t0 = Date.now();
  try {
    if (event === "session-start") await sessionStart(payload);
    else if (event === "prompt") await prompt(payload);
    else if (event === "pre-read") await preRead(payload);
    else if (event === "pre-compact") await preCompact(payload);
    else if (event === "session-end" || event === "stop") await sessionEnd(payload);
    else log(event || "(none)", "unknown event");
    log(event, `ok ${Date.now() - t0}ms`);
  } catch (e) {
    log(event, `error ${String(e && e.message || e).slice(0, 200)}`);
  }
  return 0;   // always
}
export const EVENTS = ["session-start", "prompt", "pre-read", "pre-compact", "session-end"];
