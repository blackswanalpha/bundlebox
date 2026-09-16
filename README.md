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
bb pinpoint  ->  a brief     where the work is, quoted and budgeted, before a model opens
bb arc       ->  an index    every declaration in one file, read in microseconds  0 tokens
bb route     ->  lanes       who does it, where, in what wave
bb run       ->  sessions    the only verb that spends
bb finish    ->  a ledger    what proves this done, declared first and run after   0 tokens
bb git       ->  PRs         commit, push, draft PR, review, gated merge     0 tokens
bb runbook   ->  the system  is it up, is it ANSWERING, what broke since    0 tokens
bb recom     ->  an answer   what was already driven, and whether it holds   0 tokens
bb recom gate->  a decision  and therefore whether to drive at all           0 tokens
bb dotty     ->  a screen    what it showed, as rows a session can diff      0 tokens
bb sieve     ->  a window    a tool result shrunk before it is billed twice    0 tokens
bb uptake    ->  a verdict   of everything wired in, what sessions reached for 0 tokens
bb monitor   ->  the window  what the 5-hour block has left, and the guard   0 tokens
bb session   ->  the bill    what a session used and saved, measured         0 tokens
bb lathe     ->  automation  what this box did by hand more than twice, as scripts 0 tokens
bb env       ->  a checklist what a complete .bundlebox holds, and whether this has 0 tokens
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

Needs Node ≥ 20 and git. Linux, macOS and Windows are supported: CI runs the full suite on all three against Node 20, 22 and 24. Two known gaps remain on Windows — a **piped** acceptance gate reports the last command's exit code rather than the first failure, because `cmd.exe` has no `set -o pipefail` (unpiped gates are exact), and `bb session` may not find transcripts, because the name Claude Code gives its projects directory there has not been verified. Three optional Rust and Python components make it faster and smarter, and
everything degrades cleanly without them:

- **Rust kernel** (`bbk`): tree walks, fingerprints, token estimates, duplicate
  windows, symbol indexes, acceptance gates with real timeouts, worktrees.
  `bb kernel install` fetches a release binary; `bb kernel build` compiles it
  with cargo. Without it the JS implementations run, and a selftest pins both
  to identical answers.
- **Rust index compiler** (`arc`): compiles the derived symbol tables into one
  binary index the read and search guards answer from, 13x faster than scanning
  the tables in a cold hook process. `bb arc build`, recompiled by
  `bb snapgen build` when the tables move. Every reader falls back to scanning
  the tables when the index is absent, truncated or not an index, because "there
  is no index" and "nothing is declared" are different answers.
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
bb wire --apply    # hooks, skills, instruction blocks and MCP entries for every agent
bb env up --apply  # build everything a session reads, so nothing is derived by searching
bb scan            # the detectors. Seconds, 0 tokens
bb findings        # what the store holds; bb explain <id> for one
bb pinpoint gaps   # every open finding as a located, quoted, budgeted brief
bb pinpoint next   # make one of them the ACTIVE brief the guards answer from
bb compile         # findings -> units, each packed to one window (dry run)
bb route           # units -> lanes (dry run)
bb run             # writes the exact prompt and command per lane, spawns nothing
bb run --apply     # spawns the sessions
bb finish check    # run the acceptance ledger; unproven never reads as green
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

`bb wire --apply` installs four things per agent detected on the box: an
instruction block between markers, hooks where the agent supports them, skills
where it loads them, and an MCP server entry. `bb unwire` removes only its own
blocks, entries, hook rows and skills.

| agent | instructions | hooks | skills | MCP |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | UserPromptSubmit (builds the brief), PreToolUse Read/Grep/Bash (serves it), SessionStart (table index), PostToolUse (the sieve, off until `sieve.enabled`), PreCompact, SessionEnd (the bill) | `.claude/skills` | `.mcp.json` |
| Codex CLI | `AGENTS.md` | — | `.codex/skills` | `.codex/config.toml` |
| Gemini CLI | `GEMINI.md` | — | — | `.gemini/settings.json` |
| Cursor | `.cursor/rules/bundlebox.mdc` | — | — | `.cursor/mcp.json` |
| GitHub Copilot | `.github/copilot-instructions.md` | — | — | `.vscode/mcp.json` |
| OpenCode | `AGENTS.md` | — | — | `opencode.json` |
| Cline / Roo | `.clinerules/bundlebox.md` | — | — | — |
| Windsurf | `.windsurf/rules/bundlebox.md` | — | — | — |
| Aider | `.aider.conf.yml` reads `AGENTS.md` | — | — | — |
| any command | `lanes.custom_command` with `{prompt_file}` `{cwd}` `{model}` | — | — | — |

Two skills ship and cost nothing until they trigger, which is the property an
instruction block does not have: it arrives in every system prompt and is billed
whether the session was about it or not. `bb-finish` is completion discipline
backed by runnable gates; `antislop` is the prose ruleset with what each rule
costs and what to write instead.

`bb mcp` serves `bb_pinpoint`, `bb_context`, `bb_snapgen`, `bb_findings`,
`bb_scan`, `bb_oversight_brief`, `bb_explain`, `bb_tokens_estimate` and
`bb_session` over stdio as JSON-RPC 2.0, with no dependency.

Full guide, including the agents not in this table, how to wire one bundlebox
does not know about, and how to drive agents as lanes:
**[docs/agents.md](docs/agents.md)**. `bb uptake` then reports which of the
installed surfaces the sessions reached for.

### Advisory lost; enforcement is the fix

`bb uptake` measured the gap. Over 15 sessions on this workspace the MCP tools
fired in 0, `pinpoint` in 3 of the 13 sessions that opened five or more distinct
files, and the reference tables in 5 of the 15 that ran a search. Those 13
sessions opened between 30 and 598 files each. Everything wired in front of the
agent was a recommendation, and a recommendation loses to the model's own habit
about three times in four.

So the wiring changed kind.

**Run it, do not recommend it.** UserPromptSubmit builds the brief itself on a
task-shaped prompt — 0.47s against a 15s budget, because every input `pinpoint`
reads is a stored artefact and it computes none of them. What enters the window
is the map, about 300 tokens.

**Serve what it found.** PreToolUse denies a read whose region the brief already
quotes and hands the quote back in the denial reason; denies an exact duplicate
read; denies a declaration search the symbol tables already answer and hands back
the rows; and asks before opening a file that was cut for budget. A file in scope
is never fully blocked — Claude Code needs one successful read before it will
edit, so the denial names the range and that read is allowed. Grep is the
declared tool and Bash is where the measured transcripts search, so both
are guarded.

**Rank on specificity and path.** Enforcing a brief raises the cost of a bad
locate. Inverse document frequency over the candidate set stops an exact match on
a name the tree uses everywhere from outscoring a loose match on a rare one, and
a directory named `wire` now counts as evidence about what a file is for. An
explicitly named file is pinned first rather than scored.

## The verbs

| verb | answers | cost |
|---|---|---|
| `scan`, `findings`, `explain`, `fix` | sixteen generic detectors with evidence and expected-value triage; local actuators that write a patch before a file | 0 |
| `compile`, `route`, `context`, `gates` | units packed to a window with quoted regions and hoisted evidence; lanes with conflicts as affinity and waves; does this scope fit | 0 |
| `run` | lanes on the chosen agent; env allowlist; hard timeout; acceptance as the verdict; `unproven` blocks `--pr` | spends |
| `git` | commit, push, draft PR, review → findings, gated merge, with guards | 0 |
| `tokens`, `session` | estimate, calibrate, probe the overhead, prices; used and saved per session, MEASURED / ESTIMATE | 0 (probe spends one turn) |
| `snapgen`, `oversight` | fingerprinted tables; god files, bloat, duplication, vibe-coded marks and the guideline each produces | 0 |
| `pinpoint` | one problem → one located, quoted, budgeted brief. `gaps` turns every open finding, every oversight measurement and every declared standard that failed or has no evidence into one; `next` makes one the session's ACTIVE brief, which is the record the PreToolUse guards answer from. `unproven` never collapses into `failed`, and the scope of a failed standard is the files of the findings that failed it, not the area — handing over a directory is not localisation | 0 |
| `arc` | the declaration index. The guards ask one question on every tool call — is this name declared, and where — and it was answered by scanning 20,000 lines of markdown with a regex per line. `arc` compiles those tables into one binary file: two sorted id arrays, one by name and one by the reversed name, so exact, prefix and suffix are each a single binary search. 2,322 declarations in 92.4KB. 1.80ms per call from the tables, 0.14ms cold from the index, 0.073ms warm | 0 |
| `finish` | the acceptance ledger, derived from the active brief and the detected gates, written before the work and run after it. A `CHECK:` line is shell code, so `status` and `lint` never execute one and `approve` is the only verb that crosses that boundary — it binds the command, the expectation, the resolved working directory, the shell, the timeout and the inherited PATH, and asks again if any of them moves. `lint` catches an oracle that cannot fail at authoring time; `reverify` re-runs the runnable gates of work that came back | 0 |
| `lathe` | what this workspace did by hand more than twice, emitted as scripts, snippets, boilerplate and completions. Four count-based models over artefacts already on disk — closed contiguous sequences over the verbs and commands sessions ran, the expert's logistic outcome model, the janitor's decayed memory, and prefix entropy over the compiled index. Every row names its support; nothing is proposed from one occurrence | 0 |
| `env` | what a complete `.bundlebox` holds and whether this one does. Every row is an artefact some session would otherwise derive by searching the tree, and every row is produced by a verb that cannot spend money, so a missing row is a turn somebody will pay for. `bb env up --apply` runs the bootstrap gear | 0 |
| `genesis` | a document or a prompt becomes a world model, a seeded corpus, and the briefs that fill it; coverage is a set difference | 0 |
| `cookbook`, `simulate` | a persona's week against the running system, executed by the kernel; the same request at rising concurrency against a floor-relative budget | 0 |
| `mainboard`, `failsafe` | six views over one ledger and which pipeline stage does not hold; what is failing, why, and the op | 0 |
| `runbook` | declared services and groups; `up` refuses a set whose cages exceed free memory and `--wait` returns when the service ANSWERS; 40,000 log lines as twenty signatures and the failures this workspace already paid to learn, arriving named | 0 |
| `recom` | has this automation already been run, and is its result still true; a record declares the facts it rests on and they are re-probed on every read — `fresh`, `stale` naming what moved, or `unknown`. `bb recom gate <id> -- <cmd>` wires that verdict straight to the decision, so an expensive drive happens only when its answer stopped holding | 0 |
| `dotty` | what the screen showed, over the Chrome DevTools Protocol with no dependency: a PNG for a person and an accessibility summary for the session, a frame each side of a command, and a BLANK verdict on a frame that is a picture of nothing | 0 |
| `slop` | the prose ruleset every brief, commit message and PR body is stripped by before a lane is billed for it, and the `antislop` skill that states the same fifteen rules with what each one costs and what to write instead | 0 |
| `sieve` | the input axis: a tool result scrubbed, deduped or elided before it enters the window, so a 4,000-line log is not re-sent on every later turn. Read/Edit/Write are never touched, error lines are carried out of the cut, and the dropped middle spills to disk so recovery is a grep. `bb sieve replay` measures it against this workspace's own transcripts before anything is wired | 0 |
| `uptake` | installed is not used: which of the wired surfaces — the MCP tools, `bb` itself, `pinpoint`, the reference tables — sessions reached for, against the moments each one was for, with every miss and what the session did instead. A surface that arrives in the system prompt is reported as not observable, never as 0% | 0 |
| `frames` | a dataframe over the factory's own data with evals as JSON files a person can argue with | 0 |
| `auditor` | the bar declared BEFORE the work — scope, standards, governance, assurance, derived from the tree's own signals — then `gate` checks it after, where `unproven` never reads as green. Dated per-area reviews are ingested as findings and checked for drift | 0 |
| `monitor`, `commandcenter` | the five-hour block, the burn rate and the guard in front of every spend; one read-only page for the workspace | 0 |
| `pipeline`, `buckmaster`, `bridge`, `scripts` | gears with gates and fingerprinted skips; episodes, signals, rules, model, memory, outcomes; the one packed doorway to an agent; tagged scripts | 0 (bridge spends with `--run --spend`) |
| `snapgen skeleton`, `blast`, `callers` | a file's declarations without its bodies (13x less to read on this tree); what a diff can reach through import edges and what reading it costs; who imports a symbol, reported apart from who merely names it | 0 |
| `bench swebench` | the same two arms on public SWE-bench Verified instances: does the packed window contain the files the maintainer's own patch touched, and what did it cost. Localisation and context, never a resolve rate | 0 |
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

It **pushes** rather than polls. The store is files, so the filesystem already
knows when something changed: `/api/stream` watches it, recomputes the state
once per change however many tabs are open, and sends it. A 10s timer was wrong
in both directions — a run that finished was invisible for nine seconds, and an
idle workspace recomputed everything six times a minute per open tab. The header
always says which state the connection is in (`live`, `polling`,
`reconnecting`, `static`), because a dashboard that cannot tell you it has lost
the server is worse than one that is plainly offline: the stale numbers still
look like numbers.

| route | what it answers |
|---|---|
| `GET /` | the page: what the factory saved, the window, the pipeline, every session |
| `GET /health` | `{ok, service, version}` — the one route that answers without reading the store |
| `GET /api/state` | everything the page renders, as JSON |
| `GET /api/bench` | the last `bb bench` run: bare, packed, saved, per task |
| `GET /api/stream` | server-sent events: the state, pushed when the store changes |

## Architecture

```
bin/bb.js            the entrypoint
src/                 Node, ESM, zero dependencies — every verb, the adapters, the store, the command centre
skills/              the skills bb wire installs: bb-finish, antislop
kernel/              Rust — bbk: walk, fingerprint, estimate, dupes, symbols, anchor, gate, worktree,
                     and the scenario runner, the load simulator and the health probe
arc/                 Rust — the declaration index compiler. src/arc/read.js is the in-process reader,
                     which is where the speed-up lands; the binary is the reference implementation
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

- [docs/agents.md](docs/agents.md): integrating bundlebox into every agent, and running work through them
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

MIT. `src/finish/vendor/` is vendored from
[Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy) 2.1.0 (MIT, commit
`1667149`), renamed and otherwise untouched;
[src/finish/vendor/PROVENANCE.md](src/finish/vendor/PROVENANCE.md) records every
rename and why nothing else moved. bundlebox began as a stdlib-Python factory wired into one workspace; this
package is its portable core, rebuilt and corrected. The optional wire
integration talks to [headroom](https://github.com/headroomlabs-ai/headroom)
over the process boundary and never imports it.
