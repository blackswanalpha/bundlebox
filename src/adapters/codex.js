// codex.js — OpenAI Codex CLI, non-interactive form.
//
// Flags are from `codex exec --help` on codex-cli 0.111.0. The prompt goes on
// stdin (`-` is the documented stdin marker); the reference implementation
// passed a file path as the prompt, which made the lane read the path string.
//
// Sessions are written to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Only
// the `session_meta` / `turn_context` / `response_item` records were seen on
// this box; the `event_msg`/`token_count` usage record is taken from upstream
// and marked unverified. A rollout with no usage record returns null (unknown),
// never an empty session that reads as free.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBin, num, parseJson, jsonLines, blockText, turn, isDir } from "./index.js";

export const SESSIONS = path.join(os.homedir(), ".codex", "sessions");

const usageOf = (u) => ({
  // Codex reports input INCLUDING the cached part; split it so the rows agree
  // with the Claude shape (fresh + cache_read) and price correctly.
  input: Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens)), cacheRead: num(u.cached_input_tokens),
  cacheWrite: 0, output: num(u.output_tokens), thinking: num(u.reasoning_output_tokens),
});

export default {
  name: "codex",
  bin: "codex",
  instructionsFile: "AGENTS.md",
  mcpConfig: { file: ".codex/config.toml", key: "mcp_servers", format: "toml", shape: (s) => ({ command: s.command, args: s.args || [], env: s.env || {} }) },
  verified: { version: "0.111.0", flags: ["exec", "--full-auto", "--json", "-m", "-C", "-"], unverified: ["--json event shape", "token_count transcript record"] },

  detect() { return detectBin("codex", "codex"); },
  leanFlags() { return []; },

  buildCmd({ cwd, model } = {}) {
    const argv = ["codex", "exec", "--full-auto", "--json"];
    if (model) argv.push("-m", String(model));
    if (cwd) argv.push("-C", String(cwd));
    argv.push("-");
    return { argv, stdin: "prompt", env: {}, note: "flags verified on codex-cli 0.111.0; --json event shape unverified" };
  },

  parseEvent(line) {
    const o = parseJson(line);
    if (!o) return null;
    if (o.type === "thread.started" && o.thread_id) return { sessionId: String(o.thread_id), isResult: false, msgId: null };
    if (o.type === "turn.completed" && o.usage) return { isResult: true, resultUsage: usageOf(o.usage) };
    const p = o.payload;
    if (o.type === "event_msg" && p?.type === "token_count") {
      const u = p.info?.last_token_usage || p.info?.total_token_usage;
      if (!u) return null;
      return { msgId: `tc-${o.timestamp || ""}`, model: p.info?.model || "", ...usageOf(u), isResult: false };
    }
    return null;
  },

  /** Every day directory. Codex keys sessions by date, not by cwd, so the
   *  reader filters on `session_meta.cwd` via `transcriptCwd`. */
  transcriptDirs() {
    if (!isDir(SESSIONS)) return null;
    const out = [];
    for (const y of ls(SESSIONS)) for (const m of ls(path.join(SESSIONS, y))) for (const d of ls(path.join(SESSIONS, y, m))) out.push(path.join(SESSIONS, y, m, d));
    return out;
  },

  /** The cwd from the first line only, so the ledger can skip other
   *  workspaces' rollouts without parsing megabytes. */
  transcriptCwd(file) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(16384);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString("utf8", 0, n).split("\n")[0];
      const o = parseJson(first);
      return o?.type === "session_meta" ? (o.payload?.cwd || null) : null;
    } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  },

  readTranscript(file) {
    const lines = jsonLines(file);
    if (!lines) return null;
    const meta = lines.find((o) => o.type === "session_meta");
    if (!meta) return null;
    let model = null, n = 0;
    const turns = [];
    let pending = turn({ msgId: "" });
    for (const o of lines) {
      const p = o.payload || {};
      if (o.type === "turn_context" && p.model && !model) model = String(p.model);
      if (o.type === "response_item") {
        if (p.type === "message" && p.role === "assistant") pending.text += (pending.text ? "\n" : "") + blockText(p.content);
        else if (p.type === "function_call") pending.toolUses.push({ name: p.name || "", input: p.arguments ?? "" });
        else if (p.type === "function_call_output") { const t = blockText(p.output); pending.toolResults.push({ chars: t.length, text: t }); }
      }
      if (o.type === "event_msg" && p.type === "token_count") {
        const u = p.info?.last_token_usage;
        if (!u) continue;
        n += 1;
        turns.push(turn({ ...pending, msgId: `tc-${n}`, ts: o.timestamp || null, model: model || "", ...usageOf(u) }));
        pending = turn({ msgId: "" });
      }
    }
    // The usage record shape is unverified on this box: no rollout here carried
    // one. A file with none is "unknown", not "free".
    if (!turns.length) return null;
    return { sessionId: String(meta.payload?.id || path.basename(file, ".jsonl")), cwd: meta.payload?.cwd || null, model, agent: "codex", turns };
  },
};

function ls(d) { try { return fs.readdirSync(d).filter((x) => !x.startsWith(".")).sort(); } catch { return []; } }
