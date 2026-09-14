// cursor.js — Cursor's `cursor-agent`, unverified: not installed on the build
// box, flags from Cursor's docs. No on-disk transcript location is known, so
// the reader returns null (unknown) rather than an empty session.
import { detectBin, parseJson, promptText, num } from "./index.js";

export default {
  name: "cursor",
  bin: "cursor-agent",
  instructionsFile: "AGENTS.md",
  mcpConfig: { file: ".cursor/mcp.json", key: "mcpServers", shape: (s) => ({ command: s.command, args: s.args || [], env: s.env || {} }) },
  verified: { flags: [], unverified: ["-p", "--output-format", "--model"] },

  detect() { return detectBin("cursor", "cursor-agent"); },
  leanFlags() { return []; },

  buildCmd(o = {}) {
    const argv = ["cursor-agent", "-p", promptText(o), "--output-format", "json"];
    if (o.model) argv.push("--model", String(o.model));
    return { argv, stdin: null, env: {}, note: "unverified: cursor-agent not installed on the build box; flags from docs" };
  },

  parseEvent(line) {
    const o = parseJson(line);
    const u = o?.usage;
    if (!u || typeof u !== "object") return null;
    return { msgId: String(o.id || o.message_id || ""), model: o.model || "", input: num(u.input_tokens), output: num(u.output_tokens),
      cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens), thinking: 0, isResult: o.type === "result" };
  },
  transcriptDirs() { return null; },
  readTranscript() { return null; },
};
