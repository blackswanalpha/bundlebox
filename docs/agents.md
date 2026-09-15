# Agents: putting bundlebox in front of one, and running work through it

Two different questions, and they are answered by different halves of the tool.

**Integration** is bundlebox sitting *in front of* an agent you drive yourself.
You type into Claude Code or Codex as usual; bundlebox hands that session the
facts it would otherwise pay to rediscover. Nothing is spawned and nothing is
spent.

**Execution** is bundlebox *driving* agents. It packs findings into units, routes
units into lanes, and opens a session per lane with the prompt already written.
Execution is the only part of this tool that costs money, and it is gated behind
`--apply`.

You can use either half without the other.

---

## Part 1 — Integration

### The three surfaces

`bb wire` installs up to three things per agent. What an agent gets depends on
what that agent supports.

| surface | what it is | why it is free |
|---|---|---|
| **instructions** | a marked block in the file the agent already reads (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, a rules file) telling it to call `bb pinpoint` before searching and to read the reference tables instead of grepping | it is text the agent was going to load anyway |
| **MCP** | a stdio server exposing the zero-token verbs as tools the agent can call mid-session | the answers are parses, counts and set differences; no model is called |
| **hooks** | handlers the agent invokes at session start, on each prompt, before a read, after a tool call, on compaction and at session end | they run locally and return in milliseconds |

The block is written between `<!-- bundlebox:start -->` and
`<!-- bundlebox:end -->` markers, so `bb unwire` removes exactly what was added
and nothing you wrote. Every edit is a pure text transform over the file's
current content, which is why applying twice is byte-identical.

### One command

```bash
cd your-repo
bb wire                 # dry run: every file it would create or change, with a preview
bb wire --apply         # write them
bb wire status          # per agent: wired, partial or unwired, file by file
bb unwire --apply       # remove only bundlebox's blocks, entries and hook rows
```

With no `--agents`, bundlebox wires **every agent whose binary is on PATH**. Name
them explicitly to narrow it:

```bash
bb wire --agents claude --apply
bb wire --agents claude,codex,gemini --apply
bb wire --agents auto --apply          # the default, stated
```

Project scope is the default and writes into the repo. `--global` writes into
your home config instead, for agents that have one:

```bash
bb wire --global --apply
```

### What each agent gets

`verified` means the file shape was read off that agent on a real box and the
version is recorded in the descriptor. `unverified` means it came from the
vendor's documentation and has not been confirmed here — it is still written,
and `bb wire status` marks it, because a shape that turns out wrong should be
visible rather than silently absent.

| agent | instructions | MCP | hooks | scope | shape |
|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | `.mcp.json` | **all six** | project + global | verified |
| **Codex CLI** | `AGENTS.md` | `.codex/config.toml` | — | project + global | verified |
| **Gemini CLI** | `GEMINI.md` | `.gemini/settings.json` | — | project + global | verified |
| **OpenCode** | `AGENTS.md` | `opencode.json` | — | project + global | verified |
| **Cursor** | `.cursor/rules/bundlebox.mdc` | `.cursor/mcp.json` | — | project | unverified |
| **GitHub Copilot** | `.github/copilot-instructions.md` | `.vscode/mcp.json` | — | project | unverified |
| **Cline / Roo** | `.clinerules/bundlebox.md` | — (extension settings) | — | project | unverified |
| **Windsurf** | `.windsurf/rules/bundlebox.md` | — (per-user config) | — | project | unverified |
| **Aider** | `AGENTS.md` via `.aider.conf.yml` `read:` | — (no MCP) | — | project | unverified |
| **Amp** | `AGENTS.md` | — | — | project | unverified |

Three agents share `AGENTS.md`, so wiring Codex, OpenCode and Amp writes one
block, not three.

Aider has no MCP support, so it gets the instructions only, added to its
`read:` list. If you already have a `read:` key, bundlebox will not merge into
it — there is no YAML parser in a zero-dependency package — and the row says
`manual` with the exact line to add.

### The hooks

Claude Code is the only agent with a hook system bundlebox targets today. Six
events, each capped so it cannot become the cost it exists to avoid:

| event | handler | what it does |
|---|---|---|
| `SessionStart` | `bb hook session-start` | hands the session the reference-table index and the open findings, capped at 600 tokens |
| `UserPromptSubmit` | `bb hook prompt` | on a task-shaped prompt, suggests `bb pinpoint` before the search starts. Capped at 300 |
| `PreToolUse` (Read) | `bb hook pre-read` | a file past 35% of the working window gets a range suggestion. **Advisory, never a denial** |
| `PostToolUse` | `bb hook post-tool` | the sieve: shrinks an oversized tool result before it enters the window. **Off unless `sieve.enabled`** |
| `PreCompact` | `bb hook pre-compact` | records that the window was compacted |
| `SessionEnd` | `bb hook session-end` | measures what the session used and what it was spared |

Every handler reads JSON on stdin, prints at most one JSON object, and **always
exits 0**. A reporting hook that can fail a session is a reporting hook that will
eventually fail one. Failures go to `.bundlebox/var/hooks.log` so a hook that
stopped working is visible somewhere.

Turn individual surfaces off in `.bundlebox/config.json`:

```json
{
  "wire": {
    "inject_context": true,
    "measure_sessions": true,
    "guard_reads": true
  },
  "sieve": { "enabled": false }
}
```

### The MCP tools

`bb mcp` serves these over stdio as JSON-RPC 2.0, with no dependency. Every one
of them is a local computation.

| tool | answers |
|---|---|
| `bb_pinpoint` | one problem → the files, the symbol regions quoted, and a brief already sized to the window |
| `bb_context` | does this set of files fit in one session? `FITS` / `TIGHT` / `SPLIT` / `HEAVY` |
| `bb_snapgen` | reference tables: layout, symbols, routes, docs, commands, hot paths |
| `bb_findings` | open findings from the last scan |
| `bb_scan` | run the detectors now and return per-detector counts |
| `bb_oversight_brief` | what is already known about these files: god-shaped, duplicated, drifting |
| `bb_explain` | one finding in full, with evidence and the triage derivation |
| `bb_tokens_estimate` | tokens per file, with the calibrated estimator rather than chars/4 |
| `bb_session` | what this session used, measured, and what it saved |

To run the server by hand — to check it, or to wire an agent bundlebox does not
know about:

```bash
bb mcp        # speaks JSON-RPC 2.0 on stdio
```

### An agent that is not on the list

If it reads a markdown file at the repo root, add `AGENTS.md` to whatever list it
uses and you are done; `bb wire` already maintains that file.

If it speaks MCP, point it at `bb mcp`:

```json
{ "command": "bb", "args": ["mcp"] }
```

If it is a CLI that takes a prompt, it can still be a lane — see Part 2.

### Checking that it fired

Installed is not used. The instructions block is billed in every window of every
session whether the agent obeys it or not, so measure:

```bash
bb uptake            # per surface: installed, how often the chance came, how often it fired
bb uptake sessions   # the raw observation per session
```

A denominator here is an *opportunity*, not a session: `pinpoint` is counted only
against sessions that opened five or more distinct files, `tables` only against
sessions that ran a search. Surfaces that arrive in the system prompt — the block
itself, the `SessionStart` context, the read guard — are reported as **not
observable** rather than as 0%, because no transcript can answer for them.

> If `bb uptake` shows low rates, check `bb wire status` first. A surface that
> was never installed is not a surface the agent ignored.

---

## Part 2 — Running work through agents

Part 2 is the half that spends. Every verb below is a dry run until `--apply`.

### The flow

```bash
bb scan              # the detectors. Seconds, 0 tokens
bb findings          # what the store holds
bb compile           # findings -> units, each packed to one window
bb route             # units -> lanes, with conflicts as affinity and waves
bb run               # writes the exact prompt and command per lane, spawns nothing
bb run --apply       # opens the sessions
bb session           # what the last one used and saved, measured
```

`bb run` without `--apply` writes the full prompt and the exact argv to disk.
Read them before you spend. The split exists so the artefact is on disk before
the money is.

### Choosing the agent

```bash
bb run --apply --agent claude
bb run --apply --agent codex --max-parallel 2
bb run --apply --pr                      # open a draft PR when acceptance passes
```

Or set it once:

```json
{
  "lanes": {
    "agent": "auto",
    "model": "",
    "max_parallel": 4,
    "permission_mode": "acceptEdits",
    "max_budget_usd": 0,
    "daily_budget_usd": 0
  }
}
```

`auto` picks the first detected agent, and falls back to the `file` adapter on a
box with no agent at all — which spawns nothing and writes the prompt and the
command it *would* have run. The `file` adapter is also the default under test,
because a test that spawns an agent is a test that costs money.

### Any command as a lane

Set `lanes.agent` to `custom` and give it a template. Four tokens are
substituted:

```json
{
  "lanes": {
    "agent": "custom",
    "custom_command": "my-agent --file {prompt_file} --cwd {cwd} --model {model}"
  }
}
```

| token | becomes |
|---|---|
| `{prompt_file}` | path to the written prompt |
| `{prompt}` | the prompt text itself, as one argument |
| `{cwd}` | the lane's working directory |
| `{model}` | the configured model, or empty |

### What bounds a lane

- **A wall-clock timeout** enforced by the runner, not by the agent.
- **An env allowlist.** The tool never hands a spawned agent the whole parent
  environment.
- **`max_budget_usd`** per lane and `daily_budget_usd` across all of them.
- **The window guard.** Nothing opens an agent without asking `bb monitor` first:
  a session opened with twenty minutes of the billing block left is cut off
  half-written, which spends the tokens and produces nothing to accept.
- **Acceptance.** A lane's verdict is its gate's exit code. A unit with no
  acceptance is `unproven`, which is a state of its own and blocks `--pr` —
  skipped is not passed.

```bash
bb monitor           # what the 5-hour block has left, and the guard
bb session           # the bill, MEASURED off the transcript
```

### The lean session

For Claude Code lanes, bundlebox opens the session under a measured-minimal flag
stack: project settings only, no MCP servers, no slash-command listing, and only
the tools a briefed lane uses. On the reference workspace that moved the opening
window from 44.3k tokens to 29.2k before any work.

The lean stack is a *lane* setting, not something done to your interactive
sessions. Turn it off with `lanes.lean_session: false`.

---

## Reference

```bash
bb wire                 # dry run
bb wire --apply         # install into every detected agent
bb wire --agents claude --apply
bb wire --global --apply
bb wire status          # what is installed right now
bb unwire --apply       # remove only what bundlebox added
bb uptake               # what the sessions actually reached for
bb mcp                  # the server, on stdio
bb hook <event>         # a handler, by hand
bb doctor               # what this box can run, and which agents it found
```

Related: [the verb table](../README.md#the-verbs) · [CONVENTIONS.md](../CONVENTIONS.md)
