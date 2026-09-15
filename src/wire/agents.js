// wire/agents.js — what `bb wire` writes into each agent, as data.
//
// Every agent reads instructions from a different file and MCP servers from a
// different shape, and the only way to keep ten of those honest is to make
// each one a plain descriptor: which file, which edit kind, what content. The
// edit kinds are deliberately few (block, json, toml, owned, yaml) because
// each one has to be idempotent AND reversible: `bb wire --apply` twice must
// be byte-identical, and `bb unwire` must leave everything the user wrote.
//
// `verified` says where the shape came from. Claude Code, Codex, Gemini CLI
// and OpenCode were read off this box (binary help + a live config file).
// Cursor, Copilot, Windsurf, Cline/Roo, Aider and Amp are from vendor docs and
// are marked unverified so a wrong guess is a known gap, never a silent one.
import os from "node:os";
import path from "node:path";

export const START = "<!-- bundlebox:start -->";
export const END = "<!-- bundlebox:end -->";

// One shared block, ~250 tokens. Short on purpose: it sits in EVERY session's
// window, so every sentence here is paid for on every prompt.
export const BASE = `${START}
## bundlebox — zero-token facts about this repository

- Before searching for where a task lives, call the \`bb_pinpoint\` MCP tool (or run \`bb pinpoint "<task>"\`). It returns the files, the symbols and a packed brief that already fits the window.
- For layout, symbols and call sites read \`.bundlebox/out/snapgen/INDEX.md\` and the table it points to, instead of grepping the tree.
- Before opening a large scope run \`bb context <files>\` (or \`bb_context\`) to see whether it fits; read a range (offset/limit) when it does not.
- Never edit anything under \`.bundlebox/out/\`: it is generated and fingerprinted.
- Open findings: \`bb findings\` (or \`bb_findings\`); the derivation behind one: \`bb explain <id>\`.
${END}`;

// Added ONLY when a mobile driver is actually registered on this box. Driving a
// phone is the most expensive thing a session can ask for, so the line is worth
// its tokens where there is a phone — and is pure tax where there is not, which
// is why it is not in BASE.
export const MOBILE = `- Driving a device costs ~10 minutes and ~24k tokens. Before calling \`mobile_run_task\`, run \`bb recom gate mobile/<id> -- <the drive>\`: it prints the recorded answer and runs nothing when every fact it rests on still reads the same, and runs the drive when one has moved. \`bb recom mobile\` says whether a device is attached.`;

/** The block as written into a file. Composed rather than constant because a
 *  sentence about phones in a repository with no phone is a sentence every
 *  prompt pays for and no session uses. */
export function instructions({ mobile = false } = {}) {
  if (!mobile) return BASE;
  return BASE.replace(`\n${END}`, `\n${MOBILE}\n${END}`);
}

// Kept so a caller that only wants the base block still reads naturally.
export const INSTRUCTIONS = BASE;

// The MCP server every agent points at. `bb` on PATH, not an absolute path:
// the file is committed and other people's boxes do not share this one's HOME.
export const SERVER = { command: "bb", args: ["mcp"] };

// Claude Code hook events -> `bb hook <event>`. Timeouts are seconds. The
// SessionEnd one is long because it folds a transcript; the rest read files.
export const CLAUDE_HOOKS = [
  { event: "SessionStart", cmd: "session-start", timeout: 30 },
  { event: "UserPromptSubmit", cmd: "prompt", timeout: 15 },
  { event: "PreToolUse", matcher: "Read", cmd: "pre-read", timeout: 10 },
  // No matcher: which tools it may touch is an allowlist inside the handler, so
  // a tool added to Claude Code cannot quietly become eligible by matching a
  // pattern here. Off unless `sieve.enabled`, and the handler returns instantly.
  { event: "PostToolUse", cmd: "post-tool", timeout: 15 },
  { event: "PreCompact", cmd: "pre-compact", timeout: 30 },
  { event: "SessionEnd", cmd: "session-end", timeout: 120, statusMessage: "bundlebox: measuring what this session used and saved" },
];

export const HOOK_PREFIX = "bb hook ";
export const isOurHook = (h) => h && typeof h === "object" && typeof h.command === "string" && /(^|[\s/])bb(\.js)? hook /.test(h.command);

const home = (...p) => path.join(os.homedir(), ...p);

/** Per-agent descriptors. `files(scope)` returns the edits for project or global scope;
 *  an agent with no global location returns [] for global and the caller says so. */
export const AGENTS = {
  claude: {
    label: "Claude Code",
    bin: "claude",
    verified: "claude 2.1.270 on this box: `claude mcp add --help` (stdio default, --scope project writes .mcp.json), hooks schema from a live ~/.claude/settings.json",
    files: (scope) => scope === "global"
      ? [
        { path: home(".claude", "CLAUDE.md"), kind: "block" },
        { path: home(".claude", "settings.json"), kind: "json", edit: "claude-hooks" },
      ]
      : [
        { path: "CLAUDE.md", kind: "block" },
        { path: ".mcp.json", kind: "json", edit: "mcp", key: "mcpServers", shape: () => ({ command: SERVER.command, args: SERVER.args }) },
        { path: path.join(".claude", "settings.json"), kind: "json", edit: "claude-hooks" },
      ],
  },
  codex: {
    label: "Codex CLI",
    bin: "codex",
    verified: "codex-cli 0.111.0 on this box: ~/.codex/config.toml carries [mcp_servers.<name>] with command/args; project AGENTS.md is read (docs)",
    files: (scope) => scope === "global"
      ? [
        { path: home(".codex", "AGENTS.md"), kind: "block" },
        { path: home(".codex", "config.toml"), kind: "toml", section: "mcp_servers.bundlebox", body: `command = "bb"\nargs = ["mcp"]` },
      ]
      : [
        { path: "AGENTS.md", kind: "block" },
        { path: path.join(".codex", "config.toml"), kind: "toml", section: "mcp_servers.bundlebox", body: `command = "bb"\nargs = ["mcp"]` },
      ],
  },
  gemini: {
    label: "Gemini CLI",
    bin: "gemini",
    verified: "gemini 0.39.1 on this box: ~/.gemini/settings.json carries mcpServers.<name> {command,args,env}; GEMINI.md is the context file",
    files: (scope) => scope === "global"
      ? [
        { path: home(".gemini", "GEMINI.md"), kind: "block" },
        { path: home(".gemini", "settings.json"), kind: "json", edit: "mcp", key: "mcpServers", shape: () => ({ command: SERVER.command, args: SERVER.args, env: {} }) },
      ]
      : [
        { path: "GEMINI.md", kind: "block" },
        { path: path.join(".gemini", "settings.json"), kind: "json", edit: "mcp", key: "mcpServers", shape: () => ({ command: SERVER.command, args: SERVER.args, env: {} }) },
      ],
  },
  opencode: {
    label: "OpenCode",
    bin: "opencode",
    verified: "opencode on this box: ~/.config/opencode/opencode.json carries mcp.<name> {type:\"local\", command:[...], enabled}; AGENTS.md is read",
    files: (scope) => scope === "global"
      ? [
        { path: home(".config", "opencode", "AGENTS.md"), kind: "block" },
        { path: home(".config", "opencode", "opencode.json"), kind: "json", edit: "mcp", key: "mcp", shape: () => ({ type: "local", command: [SERVER.command, ...SERVER.args], enabled: true }) },
      ]
      : [
        { path: "AGENTS.md", kind: "block" },
        { path: "opencode.json", kind: "json", edit: "mcp", key: "mcp", shape: () => ({ type: "local", command: [SERVER.command, ...SERVER.args], enabled: true }) },
      ],
  },
  cursor: {
    label: "Cursor",
    bin: "cursor-agent",
    verified: null,
    unverified: "Cursor docs: .cursor/rules/*.mdc with `alwaysApply: true` frontmatter; .cursor/mcp.json mcpServers.<name> {command,args}",
    files: (scope) => scope === "global" ? [] : [
      { path: path.join(".cursor", "rules", "bundlebox.mdc"), kind: "owned", content: `---\ndescription: bundlebox zero-token facts about this repository\nalwaysApply: true\n---\n\n${INSTRUCTIONS}\n` },
      { path: path.join(".cursor", "mcp.json"), kind: "json", edit: "mcp", key: "mcpServers", shape: () => ({ command: SERVER.command, args: SERVER.args }) },
    ],
  },
  copilot: {
    label: "GitHub Copilot (VS Code)",
    bin: "copilot",
    verified: null,
    unverified: "Copilot docs: .github/copilot-instructions.md is read; VS Code .vscode/mcp.json servers.<name> {type:\"stdio\",command,args}",
    files: (scope) => scope === "global" ? [] : [
      { path: path.join(".github", "copilot-instructions.md"), kind: "block" },
      { path: path.join(".vscode", "mcp.json"), kind: "json", edit: "mcp", key: "servers", shape: () => ({ type: "stdio", command: SERVER.command, args: SERVER.args }) },
    ],
  },
  cline: {
    label: "Cline / Roo Code",
    bin: "cline",
    verified: null,
    unverified: "Cline docs: .clinerules/ directory of markdown rule files; MCP servers are configured in the extension's own settings, not a repo file",
    files: (scope) => scope === "global" ? [] : [
      { path: path.join(".clinerules", "bundlebox.md"), kind: "owned", content: INSTRUCTIONS + "\n" },
    ],
  },
  windsurf: {
    label: "Windsurf",
    bin: "windsurf",
    verified: null,
    unverified: "Windsurf docs: .windsurf/rules/*.md; MCP servers live in ~/.codeium/windsurf/mcp_config.json, which is per-user and not written here",
    files: (scope) => scope === "global" ? [] : [
      { path: path.join(".windsurf", "rules", "bundlebox.md"), kind: "owned", content: INSTRUCTIONS + "\n" },
    ],
  },
  aider: {
    label: "Aider",
    bin: "aider",
    verified: null,
    unverified: "Aider docs: .aider.conf.yml `read:` list of files added read-only to every chat; no MCP support",
    files: (scope) => scope === "global" ? [] : [
      { path: "AGENTS.md", kind: "block" },
      { path: ".aider.conf.yml", kind: "yaml-read", entry: "AGENTS.md" },
    ],
  },
  amp: {
    label: "Amp",
    bin: "amp",
    verified: null,
    unverified: "Amp docs: AGENTS.md is read from the repo root",
    files: (scope) => scope === "global" ? [] : [
      { path: "AGENTS.md", kind: "block" },
    ],
  },
};

export const ORDER = Object.keys(AGENTS);

/** Agents whose binary is on PATH, via the adapters when present. `bb wire`
 *  installs into these under `--agents auto`. Agents with no adapter (cline,
 *  windsurf, amp) are probed by binary name only. */
export async function detectAgents() {
  let which;
  try { ({ which } = await import("../core/exec.js")); } catch { return []; }
  const out = [];
  for (const name of ORDER) {
    const a = AGENTS[name];
    if (which(a.bin)) out.push(name);
  }
  return out;
}
