// copilot.js — GitHub Copilot CLI, unverified: not installed on the build box,
// flags from GitHub's docs. No usage stream and no known transcript layout,
// so both readers return null (unknown).
import { detectBin, promptText } from "./index.js";

export default {
  name: "copilot",
  bin: "copilot",
  instructionsFile: ".github/copilot-instructions.md",
  mcpConfig: { file: ".vscode/mcp.json", key: "servers", shape: (s) => ({ type: "stdio", command: s.command, args: s.args || [], env: s.env || {} }) },
  verified: { flags: [], unverified: ["-p", "--allow-all-tools", "--model"] },

  detect() { return detectBin("copilot", "copilot"); },
  leanFlags() { return []; },

  buildCmd(o = {}) {
    const argv = ["copilot", "-p", promptText(o), "--allow-all-tools"];
    if (o.model) argv.push("--model", String(o.model));
    return { argv, stdin: null, env: {}, note: "unverified: copilot not installed on the build box; flags from docs" };
  },

  parseEvent() { return null; },
  transcriptDirs() { return null; },
  readTranscript() { return null; },
};
