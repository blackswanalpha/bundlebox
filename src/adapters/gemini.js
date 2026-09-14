// gemini.js — Google's Gemini CLI, headless.
//
// Flags are from `gemini --help` on 0.39.1. The prompt is the VALUE of `-p`
// (a path there is read as literal text), and nothing is written to stdin
// because `-p` appends stdin to the prompt when any is present.
//
// Chats live in ~/.gemini/tmp/<sha256(cwd)>/chats/session-*.json (hash scheme
// verified against two real cwds on this box), and older installs also map
// cwd -> name in ~/.gemini/projects.json. Each `gemini` message carries
// `tokens: {input, output, cached, thoughts, tool, total}` and `model`.
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { detectBin, num, parseJson, promptText, readJsonFile, isDir, turn } from "./index.js";

export const GEMINI_HOME = path.join(os.homedir(), ".gemini");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Usage out of any of the three shapes Gemini uses, or null. */
function usageOf(o) {
  const um = o.usageMetadata || o.usage_metadata;
  if (um) return { input: num(um.promptTokenCount) - num(um.cachedContentTokenCount), cacheRead: num(um.cachedContentTokenCount), cacheWrite: 0,
    output: num(um.candidatesTokenCount), thinking: num(um.thoughtsTokenCount) };
  const t = o.tokens;
  if (t && typeof t === "object" && ("input" in t || "output" in t)) return { input: num(t.input) - num(t.cached), cacheRead: num(t.cached), cacheWrite: 0, output: num(t.output), thinking: num(t.thoughts) };
  return null;
}

export default {
  name: "gemini",
  bin: "gemini",
  instructionsFile: "GEMINI.md",
  mcpConfig: { file: ".gemini/settings.json", key: "mcpServers", shape: (s) => ({ command: s.command, args: s.args || [], env: s.env || {} }) },
  verified: { version: "0.39.1", flags: ["-p", "-m", "--approval-mode", "--yolo", "--output-format"], unverified: ["stream-json event shape"] },

  detect() { return detectBin("gemini", "gemini"); },
  leanFlags() { return []; },

  buildCmd(o = {}) {
    const argv = ["gemini", "-p", promptText(o)];
    if (o.model) argv.push("-m", String(o.model));
    argv.push("--approval-mode", o.permissionMode === "plan" ? "plan" : "yolo");
    argv.push("--output-format", "stream-json");
    return { argv, stdin: null, env: {}, note: "flags verified on gemini 0.39.1; stream-json event shape unverified" };
  },

  parseEvent(line) {
    const o = parseJson(line);
    if (!o) return null;
    // `--output-format json` ends with one object carrying per-model stats.
    if (o.stats?.models && typeof o.stats.models === "object") {
      const r = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
      for (const m of Object.values(o.stats.models)) {
        const t = m?.tokens || {};
        r.input += num(t.prompt) - num(t.cached); r.cacheRead += num(t.cached); r.output += num(t.candidates); r.thinking += num(t.thoughts);
      }
      return { isResult: true, resultUsage: r };
    }
    const u = usageOf(o) || usageOf(o.message || {}) || usageOf(o.response || {});
    if (!u) return null;
    return { msgId: String(o.id || o.messageId || o.timestamp || ""), model: o.model || o.message?.model || "", ...u, isResult: false };
  },

  transcriptDirs(root, priorRoots = []) {
    if (!isDir(GEMINI_HOME)) return null;
    const map = readJsonFile(path.join(GEMINI_HOME, "projects.json"))?.projects || {};
    const out = [];
    for (const r of [root, ...(priorRoots || [])]) {
      for (const key of [sha256(String(r)), map[r]].filter(Boolean)) {
        const d = path.join(GEMINI_HOME, "tmp", key, "chats");
        if (isDir(d)) out.push(d);
      }
    }
    return [...new Set(out)];
  },

  readTranscript(file) {
    const o = readJsonFile(file);
    if (!o || !Array.isArray(o.messages)) return null;
    let model = null;
    const turns = [];
    for (const m of o.messages) {
      if (m?.type !== "gemini") continue;
      const u = usageOf(m);
      if (!u) continue;
      if (!model && m.model) model = m.model;
      const toolUses = [], toolResults = [];
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        toolUses.push({ name: tc.name || "", input: tc.args ?? {} });
        if (tc.result !== undefined) { const t = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result); toolResults.push({ chars: t.length, text: t }); }
      }
      turns.push(turn({ msgId: m.id || "", ts: m.timestamp || null, model: m.model || "", ...u, toolUses, toolResults, text: typeof m.content === "string" ? m.content : "" }));
    }
    return { sessionId: String(o.sessionId || path.basename(file, ".json")), cwd: null, model, agent: "gemini", turns };
  },
};
