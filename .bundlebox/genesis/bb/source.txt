<p align="center"><img src="assets/logo.svg" width="112" alt="bundlebox"></p>

<h1 align="center">bundlebox</h1>
<p align="center"><b>The zero-token software factory for AI coding agents.</b><br>
Scan, pack, route and run work across Claude Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Aider and any custom agent, and measure every token a session used and was spared.</p>

<p align="center">
<a href="https://www.npmjs.com/package/bundlebox"><img src="https://img.shields.io/npm/v/bundlebox?color=1F7A5C" alt="npm"></a>
<a href="https://github.com/blackswanalpha/bundlebox/actions/workflows/ci.yml"><img src="https://github.com/blackswanalpha/bundlebox/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3FB58A" alt="MIT"></a>
</p>

An AI coding agent is billed for what it reads, and most of what it reads is
orientation, not judgement: where a symbol lives, whether two tables agree,
which command proves a change, what changed since last week. bundlebox answers
every question a parse, a count, a path check or a set difference can answer
*before* the agent opens, packs the answers into a brief sized to the agent's
window, opens the agent under a measured-minimal flag stack, and measures
afterwards what the session used and what it was spared. It never calls a
model itself.

```
bb genesis   ->  a world     a doc becomes surfaces, rules and capabilities  0 tokens
bb scan      ->  findings    what is wrong, with evidence                    0 tokens
bb fix       ->  patches     local actuators close what they can             0 tokens
bb cookbook  ->  a board     what the RUNNING system does, run by the kernel 0 tokens
bb simulate  ->  limits      what it does at a hundred callers               0 tokens
bb compile   ->  units       what to do about the rest, packed to one window
bb route     ->  lanes       who does it, where, in what wave
bb run       ->  sessions    the only verb that spends
bb git       ->  PRs         commit, push, draft PR, review, gated merge     0 tokens
bb monitor   ->  the window  what the 5-hour block has left, and the guard   0 tokens
bb session   ->  the bill    what a session used and saved, measured         0 tokens
```

Measured on the reference workspace (regenerate with `bb session`, `bb tokens profile --probe`, `bb buckmaster episodes`):

| | before | after |
|---|---|---|
| opening window per spawned session, before any work | 44.3k tokens | 29.2k tokens (−34%) |
| the same findings, planned | 5 sessions, 1.3M projected | 2 sessions, 351k (−74%) |
| one pipeline tick (`bb pipeline run intake`) | 226 agent turns | 133 s, 0 model tokens |

## Install

```bash
npm i -g bundlebox
# or
curl -fsSL https://raw.githubusercontent.com/blackswanalpha/bundlebox/main/scripts/install.sh | sh
```

Needs Node ≥ 20 and git. Linux, macOS and Windows are supported: CI runs the full suite on all three against Node 20, 22 and 24. Two known gaps remain on Windows — a **piped** acceptance gate reports the last command's exit code rather than the first failure, because `cmd.exe` has no `set -o pipefail` (unpiped gates are exact), and `bb session` may not find transcripts, because the name Claude Code gives its projects directory there has not been verified. Two optional runtimes make it faster and smarter, and
everything degrades cleanly without them:

- **Rust kernel** (`bbk`): tree walks, fingerprints, token estimates, duplicate
  windows, symbol indexes, acceptance gates with real timeouts, worktrees.
  `bb kernel install` fetches a release binary; `bb kernel build` compiles it
  with cargo. Without it the JS implementations run, and a selftest pins both
  to identical answers.
- **Python expert system** (`bundlebox_expert`, stdlib only): the rule engine
  with explainable derivations, confidence shrinkage, transcript signals, the
  process model and memory. `bb buckmaster` needs python3 ≥ 3.9; nothing in the
  zero-token path does.

There are no npm dependencies. A cron worker at 03:00 runs what is on disk or it does not run.

## Start here

```bash
cd your-repo
bb init            # detect languages, agents and gates; write .bundlebox/config.json
bb doctor          # what this box can run, which runtime serves each op
bb wire --apply    # hooks, instruction blocks and MCP entries for every agent found
bb scan            # the detectors. Seconds, 0 tokens
bb findings        # what the store holds; bb explain <id> for one
bb compile         # findings -> units, each packed to one window (dry run)
bb route           # units -> lanes (dry run)
bb run             # writes the exact prompt and command per lane, spawns nothing
bb run --apply     # spawns the sessions
bb session         # what the last session used and saved
```

From a document instead of from the code:

```bash
bb genesis docs/PRD.md --base http://127.0.0.1:4400   # surfaces, rules, capabilities, a seeded corpus
bb genesis plan                                       # what nothing covers, ranked and tiered
bb genesis pack                                       # one small brief per surface
bb genesis send calendar --run --spend                # the only step that costs anything
bb cookbook check && bb cookbook run                  # the kernel executes what came back
bb mainboard gaps                                     # the first stage that does not hold, and its fix
bb commandcenter                                      # one page: the pipeline, the window, every session
```

Every verb is a dry run until `--apply`. Only `run` and `bridge send` can spend.

## Wiring into agents

`bb wire --apply` installs three things per agent detected on the box: an
instruction block between markers, hooks where the agent supports them, and an
MCP server entry. `bb unwire` removes only its own blocks.

| agent | instructions | hooks | MCP |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | SessionStart (table index), PreToolUse Read (range advice past 35% of the window), PreCompact, SessionEnd (the bill) | `.mcp.json` |
| Codex CLI | `AGENTS.md` | — | `.codex/config.toml` |
| Gemini CLI | `GEMINI.md` | — | `.gemini/settings.json` |
| Cursor | `.cursor/rules/bundlebox.mdc` | — | `.cursor/mcp.json` |
| GitHub Copilot | `.github/copilot-instructions.md` | — | `.vscode/mcp.json` |
| OpenCode | `AGENTS.md` | — | `opencode.json` |
| Cline / Roo | `.clinerules/bundlebox.md` | — | — |
| Windsurf | `.windsurf/rules/bundlebox.md` | — | — |
| Aider | `.aider.conf.yml` reads `AGENTS.md` | — | — |
| any command | `lanes.custom_command` with `{prompt_file}` `{cwd}` `{model}` | — | — |

`bb mcp` serves `bb_pinpoint`, `bb_context`, `bb_snapgen`, `bb_findings`,
`bb_scan`, `bb_oversight_brief`, `bb_explain`, `bb_tokens_estimate` and
`bb_session` over stdio as JSON-RPC 2.0, with no dependency.

## The verbs

| verb | answers | cost |
|---|---|---|
| `scan`, `findings`, `explain`, `fix` | sixteen generic detectors with evidence and expected-value triage; local actuators that write a patch before a file | 0 |
| `compile`, `route`, `context`, `gates` | units packed to a window with quoted regions and hoisted evidence; lanes with conflicts as affinity and waves; does this scope fit | 0 |
| `run` | lanes on the chosen agent; env allowlist; hard timeout; acceptance as the verdict; `unproven` blocks `--pr` | spends |
| `git` | commit, push, draft PR, review → findings, gated merge, with guards | 0 |
| `tokens`, `session` | estimate, calibrate, probe the overhead, prices; used and saved per session, MEASURED / ESTIMATE | 0 (probe spends one turn) |
| `snapgen`, `pinpoint`, `oversight` | fingerprinted tables; one problem → one budgeted brief; god files, bloat, duplication, vibe-coded marks and the guideline each produces | 0 |
| `genesis` | a document or a prompt becomes a world model, a seeded corpus, and the briefs that fill it; coverage is a set difference | 0 |
| `cookbook`, `simulate` | a persona's week against the running system, executed by the kernel; the same request at rising concurrency against a floor-relative budget | 0 |
| `mainboard`, `runbook`, `failsafe` | six views over one ledger and which pipeline stage does not hold; services, log signatures by offset; what is failing, why, and the op | 0 |
| `frames`, `blackice` | a dataframe over the factory's own data with evals as JSON; per-area dated audits, ingested as findings and checked for drift | 0 |
| `monitor`, `commandcenter` | the five-hour block, the burn rate and the guard in front of every spend; one read-only page for the workspace | 0 |
| `pipeline`, `buckmaster`, `bridge`, `scripts` | gears with gates and fingerprinted skips; episodes, signals, rules, model, memory, outcomes; the one packed doorway to an agent; tagged scripts | 0 (bridge spends with `--run --spend`) |
| `wire`, `mcp`, `hook` | install into agents; serve over MCP; the hook handlers | 0 |
| `init`, `doctor`, `selftest`, `update`, `kernel`, `cron` | setup; what this box can run; silent-failure checks; the updater; the kernel; the unattended worker | 0 |

## The budget model

```
projected = overhead + brief + payload × churn + reserve
```

Overhead is probed, not assumed. Payload is the located region plus a widening
allowance when a symbol is named, not the file. Churn is the term everyone
forgets and it measures near 2.4. Reserve is per kind of unit. The verdict is
`FITS`, `TIGHT`, `SPLIT` or `HEAVY`, and a split respects directory locality.
Five levers act on those terms, in measured order: the lean flag stack, region
not file, say it once, a cache-stable prefix, and optionally a local compression
proxy on the wire reported on its own row. See [EXPLANATION.md](EXPLANATION.md).

## Measured vs estimated

Two kinds of number appear in every report and are never added: used and
cache-saved are measured off the transcript; automation-saved is an estimate
printed as a range. A model with no price is reported with tokens and no cost.
A verb that could not look says unknown. A unit with no acceptance is
`unproven`, not passed.

There is a third number and it is measured on both sides. `bb bench` runs the
same task twice — once with the factory in front of it and once without — and
reports the difference:

```bash
bb bench init                 # a suite from the open findings that name a file
bb bench run                  # both arms, per task, with the losses printed
bb bench show --json
```

BARE searches the tree for the task's terms and reads the top files whole,
which is what a session does on a box where nothing is installed. PACKED is the
one `bb pinpoint` prompt for the same task. Both arms are counted by the same
estimator over text on disk, so neither calls a model and a second run on the
same tree returns the same number. A task that costs more packed than bare is
printed in the table, not dropped.

Every `bb pinpoint` brief carries one more section, and it is the one worth
reading first: **what this brief does not settle.** No gate detected, nothing in
the symbol tables matched, no region located, no evidence on file, a scope that
had to be cut to fit — each is stated with its reason rather than filled in by
guessing, and scored so two briefs can be compared. A question costs one turn;
a wrong assumption costs the review that catches it.

## The command centre

`bb commandcenter` serves one read-only page for the workspace on
`127.0.0.1:7788`, and `bb commandcenter build` writes the same page as a single
file with the state embedded. It binds to loopback, has no write route, and
nothing on it calls a model.

| route | what it answers |
|---|---|
| `GET /` | the page: what the factory saved, the window, the pipeline, every session |
| `GET /health` | `{ok, service, version}` — the one route that answers without reading the store |
| `GET /api/state` | everything the page renders, as JSON |
| `GET /api/bench` | the last `bb bench` run: bare, packed, saved, per task |

## Architecture

```
bin/bb.js            the entrypoint
src/                 Node, ESM, zero dependencies — every verb, the adapters, the store, the command centre
kernel/              Rust — bbk: walk, fingerprint, estimate, dupes, symbols, anchor, gate, worktree,
                     and the scenario runner, the load simulator and the health probe
expert/              Python (stdlib) — rule engine, triage, confidence, signals, rules, graph, model, memory,
                     the world derivation, coverage planning, scenario selection and board verdicts
.bundlebox/          per-repo: config.json, cookbook/ (corpora), genesis/ (world models),
                     var/ (store, boards, simulations, calibration), out/ (tables, briefs, packs, the page)
```

The kernel runs a corpus on threads with one connection per worker and a shared
pacer; a 130-step corpus that takes two minutes paced against a real limiter
takes under a second against a local mirror. It speaks `http` only, because TLS
would be a dependency it must build without — the JavaScript engine runs when
the base is `https`, when the kernel is absent, or when a corpus uses a pattern
outside the kernel's documented subset, and the board names which engine ran and
why. `test/scenario.test.js` pins the two to identical answers.

The three runtimes agree by test: `test/kernel.test.js` and
`test/expert.test.js` pin the kernel and the expert system to the JS answers.
One implementation per fact where only one runtime has it; parity where two do.

## Configuration

One file, `.bundlebox/config.json`, holding only the keys you changed. Every
default lives in `src/core/config.js` with its reason. Measured values live in
`.bundlebox/var/calibration.json` and are written by read-merge.

```json
{
  "lanes": { "agent": "claude", "max_parallel": 4, "model": "sonnet", "daily_budget_usd": 20 },
  "budget": { "max_tokens": 160000, "churn_factor": 2.4, "anchor_widen": 0.45 },
  "kernel": { "gates": { ".": { "quick": "npm test", "full": "npm run lint && npm test" } } },
  "detectors": { "promote_at": "medium" }
}
```

## Documentation

- [docs/index.html](docs/index.html): the reference site
- [EXPLANATION.md](EXPLANATION.md): the thesis, the flow, what changed from the original
- [whitepaper/bundlebox-whitepaper.md](whitepaper/bundlebox-whitepaper.md)
- [docs/review-of-the-original.md](docs/review-of-the-original.md): the defects found in the reference implementation
- [docs/prices.md](docs/prices.md): price table provenance
- [docs/prior-art.md](docs/prior-art.md): seven projects read, what came back and what did not
- [CHANGELOG.md](CHANGELOG.md) and [changelogs/](changelogs/)
- [CONVENTIONS.md](CONVENTIONS.md): how the code is organised, for contributors

## Releases

Tags `vX.Y.Z` on `main` build the kernel for five targets, publish to npm with
provenance, and create a GitHub release with the binaries and the changelog.
`bb update` checks the registry at most once a day; `bb update --apply` installs.

## License

MIT. bundlebox began as a stdlib-Python factory wired into one workspace; this
package is its portable core, rebuilt and corrected. The optional wire
integration talks to [headroom](https://github.com/headroomlabs-ai/headroom)
over the process boundary and never imports it.
