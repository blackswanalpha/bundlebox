// aider.js — aider, unverified: the binary is not on the box this was written
// on, so every flag here is from aider's published docs, not from `--help`.
// aider keeps `.aider.chat.history.md` in the cwd with no usage counts, so
// there is no transcript to read: `null`, not an empty ledger.
import { detectBin } from "./index.js";

export default {
  name: "aider",
  bin: "aider",
  instructionsFile: "CONVENTIONS.md",
  mcpConfig: null,
  verified: { flags: [], unverified: ["--message-file", "--yes-always", "--no-auto-commits", "--model"] },

  detect() { return detectBin("aider", "aider"); },
  leanFlags() { return []; },

  buildCmd({ promptFile, model } = {}) {
    const argv = ["aider", "--message-file", String(promptFile || ""), "--yes-always", "--no-auto-commits"];
    if (model) argv.push("--model", String(model));
    return { argv, stdin: null, env: {}, note: "unverified: aider not installed on the build box; flags from docs" };
  },

  parseEvent() { return null; },
  transcriptDirs() { return null; },
  readTranscript() { return null; },
};
