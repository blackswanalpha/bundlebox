// file.js — spawns nothing. The prompt and the command it would have run are
// written to disk and that is the whole run. It is the default for tests and
// dry runs because a test that spawns an agent is a test that costs money, and
// it is what `auto` falls back to on a box with no agent at all.
export default {
  name: "file",
  bin: null,
  instructionsFile: null,
  mcpConfig: null,

  detect() { return { name: "file", bin: null, path: null, version: null }; },
  leanFlags() { return []; },
  buildCmd() { return { argv: null, stdin: null, env: {}, note: "file adapter: prompt and command written, no process spawned" }; },
  parseEvent() { return null; },
  transcriptDirs() { return null; },
  readTranscript() { return null; },
};
