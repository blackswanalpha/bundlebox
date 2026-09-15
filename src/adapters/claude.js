// claude.js — Claude Code as a headless lane. The one adapter whose stream and
// transcript shapes were read off a live session on this box (2.1.270).
//
// Every flag below is in `claude --help` for 2.1.270. `--max-turns` is NOT in
// that help and is therefore not emitted: a flag the binary does not document
// is a lane that may refuse to start, and the runner bounds a lane with its
// own wall-clock timer and `--max-budget-usd` instead.
//
// The lean stack (measured 44.3k -> 29.2k of opening window on the reference
// box, see tokens/probe.js) gives up: the user's global CLAUDE.md and memory
// index (`--setting-sources project`), MCP servers (`--strict-mcp-config`),
// the skills listing (`--disable-slash-commands`), and every tool a briefed
// lane does not use (`--tools`). `--exclude-dynamic-system-prompt-sections`
// moves cwd/env/git status out of the system prompt so parallel lanes share a
// cache prefix. The flags interact, so they are probed as a set, not summed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBin, num, parseJson, jsonLines, blockText, turn, isDir } from "./index.js";

// Deliberately short: every name here is a schema in every lane's window.
export const LANE_TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "TodoWrite"];
export const LEAN_FLAGS = ["--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project",
  "--exclude-dynamic-system-prompt-sections"];
export const PROJECTS = path.join(os.homedir(), ".claude", "projects");

/** ~/.claude/projects directory name for a cwd. `/`, `.` and `_` all become `-`,
 *  which is what Claude Code does on this box.
 *
 *  A Windows path also carries `\\` and a drive colon, and neither is legal in a
 *  directory name: `slug("C:\\Users\\me\\ws")` used to return itself, and the
 *  caller then tried to create `projects\\C:\\Users\\me\\ws` and got ENOENT.
 *
 *  UNVERIFIED on Windows: what Claude Code itself writes there has not been
 *  observed from this box. `transcriptDirs` matches against the real directory
 *  listing, so a wrong guess finds nothing — exactly what happens today — but it
 *  no longer builds a path the OS refuses. */
export const slug = (p) => String(p).replace(/[/\\:._]/g, "-");

/** The window a turn arrived in: what the provider re-read to answer it. */
export const windowOf = (u) => num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);

export default {
  name: "claude",
  bin: "claude",
  instructionsFile: "CLAUDE.md",
  mcpConfig: { file: ".mcp.json", key: "mcpServers", shape: (s) => ({ command: s.command, args: s.args || [], env: s.env || {} }) },
  verified: { version: "2.1.270", flags: ["-p", "--output-format", "--verbose", "--model", "--permission-mode", "--session-id",
    "--max-budget-usd", "--name", "--add-dir", "--no-session-persistence", ...LEAN_FLAGS.filter((f) => f.startsWith("--")), "--tools"],
    dropped: { "--max-turns": "not in `claude --help` 2.1.270" } },

  detect() { return detectBin("claude", "claude"); },
  leanFlags(tools = LANE_TOOLS) { return [...LEAN_FLAGS, "--tools", ...tools]; },

  buildCmd({ promptFile, cwd, model, maxTurns, permissionMode, sessionId, budgetUsd, allowedTools, name, addDirs, lean = true } = {}) {
    const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose"];
    if (model) argv.push("--model", String(model));
    argv.push("--permission-mode", permissionMode || "acceptEdits");
    if (sessionId) argv.push("--session-id", String(sessionId));
    if (budgetUsd) argv.push("--max-budget-usd", String(budgetUsd));
    if (name) argv.push("--name", String(name));
    for (const d of addDirs || []) argv.push("--add-dir", String(d));
    const notes = [];
    if (maxTurns) notes.push("--max-turns dropped: not in `claude --help` 2.1.270; the lane is bounded by the runner's timer");
    // `--tools <tools...>` is variadic and swallows everything after it, so the
    // stack goes last and the prompt goes on stdin: a packed brief is tens of
    // kilobytes and ARG_MAX is not the place to find that out.
    if (lean) argv.push(...LEAN_FLAGS, "--tools", ...(allowedTools?.length ? allowedTools : LANE_TOOLS));
    else if (allowedTools?.length) argv.push("--tools", ...allowedTools);
    void promptFile; void cwd;
    return { argv, stdin: "prompt", env: {}, note: notes.join("; ") };
  },

  parseEvent(line) {
    const o = parseJson(line);
    if (!o) return null;
    if (o.type === "assistant") {
      const m = o.message || {};
      const u = m.usage;
      if (!u) return null;
      return { msgId: String(m.id || o.uuid || ""), model: m.model || "", input: num(u.input_tokens), output: num(u.output_tokens),
        cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens),
        thinking: num(u.output_tokens_details?.thinking_tokens), isResult: false };
    }
    if (o.type === "result") {
      // The per-turn output numbers in the stream are early snapshots; the
      // `result` event carries the totals the provider actually billed.
      let output = 0, thinking = 0;
      for (const pm of Object.values(o.modelUsage || {})) {
        if (!pm || typeof pm !== "object") continue;
        output += num(pm.outputTokens); thinking += num(pm.thinkingTokens);
      }
      const u = o.usage || {};
      return { isResult: true, sessionId: o.session_id || null, turns: num(o.num_turns), costUsd: o.total_cost_usd ?? null,
        resultUsage: { output: output || num(u.output_tokens), thinking, input: num(u.input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens) } };
    }
    return null;
  },

  /** `<slug>` exactly, plus `<slug>-<name>` only when `<root>/<name>` is a real
   *  directory (a worktree checkout). Never a loose prefix: `-foo` and
   *  `-foo-bar` are two different workspaces that happen to share a prefix. */
  transcriptDirs(root, priorRoots = []) {
    if (!isDir(PROJECTS)) return null;
    let names;
    try { names = fs.readdirSync(PROJECTS); } catch { return null; }
    const out = [];
    for (const r of [root, ...(priorRoots || [])]) {
      const s = slug(r);
      if (names.includes(s)) out.push(path.join(PROJECTS, s));
      for (const n of names) {
        if (!n.startsWith(s + "-")) continue;
        const rest = n.slice(s.length + 1);
        if (isDir(path.join(r, rest)) || isDir(path.join(r, rest.replace(/-/g, "/")))) out.push(path.join(PROJECTS, n));
      }
    }
    return [...new Set(out)];
  },

  /** One record per API turn, not per line. Claude Code writes one line per
   *  content block and repeats the same usage block on each, so lines are
   *  grouped by `message.id` with the LAST usage winning (the output count
   *  grows across a streamed turn). `<synthetic>` rows are harness messages
   *  the API never billed and are dropped. */
  readTranscript(file) {
    const lines = jsonLines(file);
    if (!lines) return null;
    let sessionId = null, cwd = null, model = null, saw = false, last = null;
    const byId = new Map(), turns = [];
    for (const o of lines) {
      if (o.sessionId && !sessionId) sessionId = String(o.sessionId);
      if (o.cwd && !cwd) cwd = String(o.cwd);
      if (o.type === "assistant") {
        saw = true;
        const m = o.message || {}, u = m.usage;
        if (!u || String(m.model || "").includes("synthetic")) continue;
        const mid = String(m.id || o.uuid || "");
        let t = byId.get(mid);
        if (!t) { t = turn({ msgId: mid, ts: o.timestamp || null, model: m.model || "" }); byId.set(mid, t); turns.push(t); }
        t.input = num(u.input_tokens); t.output = num(u.output_tokens);
        t.cacheWrite = num(u.cache_creation_input_tokens); t.cacheRead = num(u.cache_read_input_tokens);
        t.thinking = num(u.output_tokens_details?.thinking_tokens);
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text") t.text += (t.text ? "\n" : "") + (b.text || "");
          else if (b.type === "tool_use") t.toolUses.push({ name: b.name || "", input: b.input ?? {} });
        }
        if (!model) model = m.model || null;
        last = t;
      } else if (o.type === "user") {
        saw = true;
        const c = o.message?.content;
        if (!Array.isArray(c) || !last) continue;
        for (const b of c) {
          if (!b || b.type !== "tool_result") continue;
          const text = blockText(b.content);
          last.toolResults.push({ chars: text.length, text });
        }
      }
    }
    if (!saw && !sessionId) return null;
    return { sessionId: sessionId || path.basename(file, ".jsonl"), cwd, model, agent: "claude", turns };
  },
};
