// opencode.js — OpenCode, headless via `opencode run`.
//
// Flags are from `opencode run --help` on 1.18.27. `--auto` is what lets a
// lane get past permission prompts nobody is there to answer; it is skipped
// under a `plan` permission mode. The prompt is the positional message.
//
// Storage (verified on this box, ~/.local/share/opencode/storage):
//   project/<id>.json           {id, worktree}
//   session/<projectID>/ses_*.json   {id, directory, title, ...}
//   message/<sessionID>/msg_*.json   {role, modelID, tokens:{input,output,reasoning,cache:{read,write}}, time}
//   part/<messageID>/prt_*.json      {type:"text"|"tool"|"step-finish", ...}
// The "transcript file" is the session json; messages are read beside it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBin, num, parseJson, promptText, readJsonFile, isDir, listFiles, turn } from "./index.js";

export const STORAGE = path.join(os.homedir(), ".local", "share", "opencode", "storage");

const usageOf = (t) => (t && typeof t === "object" && ("input" in t || "output" in t)
  ? { input: num(t.input), output: num(t.output), cacheRead: num(t.cache?.read), cacheWrite: num(t.cache?.write), thinking: num(t.reasoning) }
  : null);

export default {
  name: "opencode",
  bin: "opencode",
  instructionsFile: "AGENTS.md",
  mcpConfig: { file: "opencode.json", key: "mcp", shape: (s) => ({ type: "local", command: [s.command, ...(s.args || [])], environment: s.env || {}, enabled: true }) },
  verified: { version: "1.18.27", flags: ["run", "--model", "--format", "--dir", "--auto"], unverified: ["--format json event envelope"] },

  detect() { return detectBin("opencode", "opencode"); },
  leanFlags() { return []; },

  buildCmd(o = {}) {
    const argv = ["opencode", "run"];
    if (o.model) argv.push("--model", String(o.model));
    argv.push("--format", "json");
    if (o.cwd) argv.push("--dir", String(o.cwd));
    if (o.permissionMode !== "plan") argv.push("--auto");
    argv.push(promptText(o));
    return { argv, stdin: null, env: {}, note: "flags verified on opencode 1.18.27; json event envelope unverified" };
  },

  parseEvent(line) {
    const o = parseJson(line);
    if (!o) return null;
    const part = o.part || o.properties?.part || o;
    const u = usageOf(part.tokens) || usageOf(o.tokens);
    if (!u) return null;
    return { msgId: String(part.messageID || part.id || o.id || ""), model: part.modelID || o.modelID || "", ...u, isResult: false };
  },

  transcriptDirs(root, priorRoots = []) {
    if (!isDir(STORAGE)) return null;
    const want = new Set([root, ...(priorRoots || [])].map(String));
    const out = [];
    for (const f of listFiles(path.join(STORAGE, "project"), ".json")) {
      const p = readJsonFile(f);
      if (p?.id && want.has(String(p.worktree)) && isDir(path.join(STORAGE, "session", p.id))) out.push(path.join(STORAGE, "session", p.id));
    }
    return out;
  },

  readTranscript(file) {
    const s = readJsonFile(file);
    if (!s?.id) return null;
    const mdir = path.join(STORAGE, "message", s.id);
    // 1.18 keeps an sqlite copy too; when the json message store for a session
    // is absent we could not look, and that is null rather than a free session.
    if (!isDir(mdir)) return null;
    const msgs = listFiles(mdir, ".json").map(readJsonFile).filter((m) => m?.role === "assistant" && m.tokens).sort((a, b) => num(a.time?.created) - num(b.time?.created));
    let model = null;
    const turns = [];
    for (const m of msgs) {
      const u = usageOf(m.tokens);
      if (!u) continue;
      if (!model && m.modelID) model = m.modelID;
      const toolUses = [], toolResults = [];
      let text = "";
      for (const p of listFiles(path.join(STORAGE, "part", m.id), ".json").map(readJsonFile)) {
        if (!p) continue;
        if (p.type === "text") text += (text ? "\n" : "") + (p.text || "");
        else if (p.type === "tool") {
          toolUses.push({ id: String(p.callID || p.id || ""), name: p.tool || "", input: p.state?.input ?? {} });
          const out = p.state?.output;
          if (typeof out === "string") toolResults.push({ chars: out.length, text: out, id: String(p.callID || p.id || ""), tool: p.tool || "" });
        }
      }
      turns.push(turn({ msgId: m.id, ts: m.time?.created ? new Date(m.time.created).toISOString() : null, model: m.modelID || "", ...u, toolUses, toolResults, text }));
    }
    return { sessionId: String(s.id), cwd: s.directory || null, model, agent: "opencode", turns };
  },
};
void fs;
