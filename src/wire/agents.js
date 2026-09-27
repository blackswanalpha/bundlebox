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
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "../core/paths.js";
import { load } from "../core/config.js";

export const START = "<!-- bundlebox:start -->";
export const END = "<!-- bundlebox:end -->";

export const HEADING = "## bundlebox — zero-token facts about this repository";

/** The block, one addressable line at a time.
 *
 *  It used to be one template string, which made it un-trimmable: every line in
 *  it is billed in EVERY window of EVERY session whether the agent reaches for
 *  it or not, and `bb uptake` measures exactly which ones nothing reaches for.
 *  A surface that cannot be measured off a line cannot be removed, so the block
 *  is now rows with ids, and `bb wire trim --apply` writes the ids of the dead
 *  ones into `wire.trim`.
 *
 *  `surface` names the `bb uptake` row a line is ABOUT, and it is what makes
 *  the trim a measurement rather than an opinion. A line with no surface — the
 *  one about not editing generated files — is never trimmed automatically: it
 *  is a prohibition, and nothing observable happens when a session obeys it. */
export const BULLETS = [
  { id: "pinpoint", surface: "pinpoint",
    text: "Before searching for where a task lives, call the `bb_pinpoint` MCP tool (or run `bb pinpoint \"<task>\"`). It returns the files, the symbols and a packed brief that already fits the window." },
  { id: "tables", surface: "tables",
    text: "For layout, symbols and call sites read `.bundlebox/out/snapgen/INDEX.md` and the table it points to, instead of grepping the tree." },
  { id: "context", surface: "mcp",
    text: "Before opening a large scope run `bb context <files>` (or `bb_context`) to see whether it fits; read a range (offset/limit) when it does not." },
  { id: "generated", surface: null,
    text: "Never edit anything under `.bundlebox/out/`: it is generated and fingerprinted." },
  { id: "findings", surface: "cli",
    text: "Open findings: `bb findings` (or `bb_findings`); the derivation behind one: `bb explain <id>`." },
];

/** The whole block, every line, as it has always been written. Kept as a
 *  constant so a caller that means "all of it" does not have to know about
 *  trimming. */
export const BASE = [START, HEADING, "", ...BULLETS.map((b) => `- ${b.text}`), END].join("\n");

// Added ONLY when a mobile driver is actually registered on this box. Driving a
// phone is the most expensive thing a session can ask for, so the line is worth
// its tokens where there is a phone — and is pure tax where there is not, which
// is why it is not in BASE.
export const MOBILE = `- Driving a device costs ~10 minutes and ~24k tokens. Before calling \`mobile_run_task\`, run \`bb recom gate mobile/<id> -- <the drive>\`: it prints the recorded answer and runs nothing when every fact it rests on still reads the same, and runs the drive when one has moved. \`bb recom mobile\` says whether a device is attached.`;

/** The block as written into a file. Composed rather than constant because a
 *  sentence about phones in a repository with no phone is a sentence every
 *  prompt pays for and no session uses — and, now, because a line `bb uptake`
 *  measured nobody reaching for is the same tax with a different name.
 *
 *  `trim` is a list of bullet ids to leave out. An unknown id is ignored rather
 *  than an error: it is config, it arrives by hand and by `--apply`, and a
 *  typo there must not stop every agent on the box being wired. */
export function instructions({ mobile = false, trim = [] } = {}) {
  const drop = new Set((trim || []).map(String));
  const kept = BULLETS.filter((b) => !drop.has(b.id));
  // Trimming everything would install a heading and nothing under it, which is
  // pure cost. An empty block is not written at all.
  if (!kept.length) return "";
  const lines = [START, HEADING, "", ...kept.map((b) => `- ${b.text}`)];
  if (mobile) lines.push(MOBILE);
  lines.push(END);
  return lines.join("\n");
}

// Kept so a caller that only wants the base block still reads naturally.
export const INSTRUCTIONS = BASE;

/** The block for an agent whose whole FILE is ours — Cursor's `.mdc`, Cline's
 *  and Windsurf's rule files. Those three have no markers to splice between, so
 *  the descriptor carries the content, and it has to read `wire.trim` when the
 *  plan is built rather than when this module is imported, or a trim would
 *  never reach them. */
export const ownedBlock = () => instructions({ trim: load().wire?.trim || [] });

// The MCP server every agent points at. `bb` on PATH, not an absolute path:
// the file is committed and other people's boxes do not share this one's HOME.
export const SERVER = { command: "bb", args: ["mcp"] };

// Claude Code hook events -> `bb hook <event>`. Timeouts are seconds. The
// SessionEnd one is long because it folds a transcript; the rest read files.
export const CLAUDE_HOOKS = [
  { event: "SessionStart", cmd: "session-start", timeout: 30 },
  { event: "UserPromptSubmit", cmd: "prompt", timeout: 15 },
  { event: "PreToolUse", matcher: "Read", cmd: "pre-read", timeout: 10 },
  // The search side of the same guard. Grep is the declared tool; Bash is where
  // the measured transcripts actually do it — `sed -n`, `cat`, `grep -rn`. The
  // handler parses one simple read or one simple search out of a command and
  // leaves everything else alone, so `npm test` is never a candidate.
  { event: "PreToolUse", matcher: "Grep|Bash", cmd: "pre-search", timeout: 10 },
  // grapple's one blocking check: a write outside the brief's scope list, at
  // the one moment the agent has committed nothing. Records only while
  // `grapple.phase` is observe; the handler returns nothing in that phase.
  { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit", cmd: "pre-write", timeout: 10 },
  // No matcher: which tools it may touch is an allowlist inside the handler, so
  // a tool added to Claude Code cannot quietly become eligible by matching a
  // pattern here. Off unless `sieve.enabled`, and the handler returns instantly.
  { event: "PostToolUse", cmd: "post-tool", timeout: 15 },
  { event: "PreCompact", cmd: "pre-compact", timeout: 30 },
  // The fourth verification layer, and the only one independent of the work:
  // does the ledger this session declared still have unmet gates? Executes no
  // check, and is silent in a workspace with no GATES.md.
  { event: "Stop", cmd: "stop", timeout: 30 },
  { event: "SessionEnd", cmd: "session-end", timeout: 120, statusMessage: "bundlebox: measuring what this session used and saved" },
];

export const HOOK_PREFIX = "bb hook ";
export const isOurHook = (h) => h && typeof h === "object" && typeof h.command === "string" && /(^|[\s/])bb(\.js)? hook /.test(h.command);

// ── the enforcement gap, past Claude Code ───────────────────────────────────
//
// `CLAUDE_HOOKS` above is why the guards work on one agent. `bb uptake` is why
// that matters: on this workspace the MCP tools fired in 0 of 19 sessions and
// pinpoint in 7 of the 17 that opened five or more distinct files. A surface
// the model may decline on a hunch gets declined, and everything bundlebox
// installs into the other nine agents is exactly that kind of surface.
//
// So: where an agent HAS a hook system, install the same two guards into it.
// Where it has none, `bb proxy` wraps the command line instead.
//
// Every shape here is UNVERIFIED and says so, which is this file's existing
// rule for a descriptor read out of vendor documentation rather than off this
// box. That is also why `wire.agent_hooks` is off by default: a guess that
// writes a hooks file an agent then refuses to start with is a worse failure
// than not being installed, and the person on that agent is the one who can
// tell in one run.
export const AGENT_HOOKS = {
  cursor: {
    unverified: "Cursor docs: .cursor/hooks.json, `{version, hooks: {beforeReadFile, beforeShellExecution, ...}}`, each entry `{command}` speaking JSON on stdin/stdout",
    path: () => path.join(".cursor", "hooks.json"),
    // `beforeReadFile` is the read guard and `beforeShellExecution` is the
    // search guard, which is the same split `CLAUDE_HOOKS` makes: half the
    // reads in the measured transcripts arrive through a shell.
    shape: () => ({
      version: 1,
      hooks: {
        beforeReadFile: [{ command: `${HOOK_PREFIX}pre-read` }],
        beforeShellExecution: [{ command: `${HOOK_PREFIX}pre-search` }],
        stop: [{ command: `${HOOK_PREFIX}session-end` }],
      },
    }),
  },
  opencode: {
    unverified: "OpenCode docs: plugins are JS modules under .opencode/plugin/ exporting async hooks; `tool.execute.before` is the pre-tool point",
    path: () => path.join(".opencode", "plugin", "bundlebox.js"),
    // A file, not a config entry: OpenCode's extension point is code. It is
    // owned outright, so `bb unwire` deletes it.
    content: () => [
      "// bundlebox — installed by `bb wire --apply`. Delete it, or run `bb unwire`.",
      "//",
      "// OpenCode has no PreToolUse of its own, so the guard runs as a plugin: the",
      "// same `bb hook pre-read` and `bb hook pre-search` handlers Claude Code",
      "// calls, over the same JSON contract, so there is one implementation of the",
      "// decision and not two that drift.",
      "import { spawnSync } from \"node:child_process\";",
      "",
      "const ask = (event, payload) => {",
      "  try {",
      "    const r = spawnSync(\"bb\", [\"hook\", event], { input: JSON.stringify(payload), encoding: \"utf8\", timeout: 10000 });",
      "    return r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null;",
      "  } catch { return null; }          // a guard that can break a session will eventually break one",
      "};",
      "",
      "export const bundlebox = async () => ({",
      "  \"tool.execute.before\": async (input, output) => {",
      "    const name = String(input?.tool || \"\");",
      "    const event = name === \"read\" ? \"pre-read\" : /^(grep|glob|bash)$/.test(name) ? \"pre-search\" : \"\";",
      "    if (!event) return;",
      "    const got = ask(event, { tool_name: name, tool_input: output?.args || input?.args || {}, session_id: input?.sessionID || \"\" });",
      "    const d = got?.hookSpecificOutput;",
      "    if (d?.permissionDecision === \"deny\") throw new Error(d.permissionDecisionReason || \"bundlebox: already located\");",
      "  },",
      "});",
    ].join("\n"),
  },
  codex: {
    unverified: "Codex CLI docs: config.toml carries `notify = [...]`, a program called with a JSON argument on session events. It is a NOTIFICATION point and cannot deny a tool call: pack at the doorway with `bb proxy` instead",
    path: () => path.join(".codex", "config.toml"),
    section: "hooks",
    body: `notify = ["bb", "hook", "session-end"]`,
    // Named so `bb wire status` can say the guard is NOT available here rather
    // than implying an installed notify hook is one.
    advisory: true,
  },
};

/** Hook rows for an agent, or [] when this box does not know that agent's hook
 *  system or `wire.agent_hooks` is off. */
export function hookFiles(name, scope) {
  if (scope === "global") return [];                         // every shape here is per project
  if (!load().wire?.agent_hooks) return [];
  const h = AGENT_HOOKS[name];
  if (!h) return [];
  if (h.content) return [{ path: h.path(), kind: "owned", content: h.content() + "\n", unverified: h.unverified }];
  if (h.section) return [{ path: h.path(), kind: "toml", section: h.section, body: h.body, unverified: h.unverified }];
  return [{ path: h.path(), kind: "json", edit: "agent-hooks", shape: h.shape, unverified: h.unverified }];
}

const home = (...p) => path.join(os.homedir(), ...p);

// ── skills ──────────────────────────────────────────────────────────────────
//
// A skill is a directory an agent loads on its own trigger, so it is the one
// surface here that costs nothing until the moment it is needed — unlike the
// instructions block, which arrives in every system prompt and is billed
// whether or not the session was about that.
//
// Enumerated from the package, not listed here. A skill added to `skills/` is
// wired by the next `bb wire --apply`, and a list in this file that disagreed
// with the directory would be a third thing to keep in sync.
export const SKILLS_DIR = () => path.join(PKG_ROOT, "skills");
export function skills() {
  let names;
  try { names = fs.readdirSync(SKILLS_DIR(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }  // no skills dir: no skills
  const out = [];
  for (const name of names) {
    const dir = path.join(SKILLS_DIR(), name);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }  // removed since readdir
    if (!files.includes("SKILL.md")) continue;               // a directory with no SKILL.md is not a skill
    out.push({ name, dir, files });
  }
  return out;
}

/** Skill rows for an agent that loads them from a directory. */
function skillFiles(base) {
  const rows = [];
  for (const s of skills()) for (const f of s.files) rows.push({ path: path.join(base, s.name, f), kind: "copy", from: path.join(s.dir, f) });
  return rows;
}

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
        ...skillFiles(home(".claude", "skills")),
      ]
      : [
        { path: "CLAUDE.md", kind: "block" },
        { path: ".mcp.json", kind: "json", edit: "mcp", key: "mcpServers", shape: () => ({ command: SERVER.command, args: SERVER.args }) },
        { path: path.join(".claude", "settings.json"), kind: "json", edit: "claude-hooks" },
        ...skillFiles(path.join(".claude", "skills")),
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
        ...skillFiles(home(".codex", "skills")),
      ]
      : [
        { path: "AGENTS.md", kind: "block" },
        { path: path.join(".codex", "config.toml"), kind: "toml", section: "mcp_servers.bundlebox", body: `command = "bb"\nargs = ["mcp"]` },
        ...skillFiles(path.join(".codex", "skills")),
        ...hookFiles("codex", scope),
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
        ...hookFiles("opencode", scope),
      ],
  },
  cursor: {
    label: "Cursor",
    bin: "cursor-agent",
    verified: null,
    unverified: "Cursor docs: .cursor/rules/*.mdc with `alwaysApply: true` frontmatter; .cursor/mcp.json mcpServers.<name> {command,args}",
    files: (scope) => scope === "global" ? [] : [
      { path: path.join(".cursor", "rules", "bundlebox.mdc"), kind: "owned", content: `---\ndescription: bundlebox zero-token facts about this repository\nalwaysApply: true\n---\n\n${ownedBlock()}\n` },
      { path: path.join(".cursor", "mcp.json"), kind: "json", edit: "mcp", key: "mcpServers", shape: () => ({ command: SERVER.command, args: SERVER.args }) },
      ...hookFiles("cursor", scope),
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
      { path: path.join(".clinerules", "bundlebox.md"), kind: "owned", content: ownedBlock() + "\n" },
    ],
  },
  windsurf: {
    label: "Windsurf",
    bin: "windsurf",
    verified: null,
    unverified: "Windsurf docs: .windsurf/rules/*.md; MCP servers live in ~/.codeium/windsurf/mcp_config.json, which is per-user and not written here",
    files: (scope) => scope === "global" ? [] : [
      { path: path.join(".windsurf", "rules", "bundlebox.md"), kind: "owned", content: ownedBlock() + "\n" },
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
  try { ({ which } = await import("../core/exec.js")); } catch (e) { if (e.code !== "ERR_MODULE_NOT_FOUND") throw e; return []; }
  const out = [];
  for (const name of ORDER) {
    const a = AGENTS[name];
    if (which(a.bin)) out.push(name);
  }
  return out;
}
