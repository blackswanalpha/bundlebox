# bundlebox, explained

This document is the long-form answer to three questions: what bundlebox is,
why it is shaped the way it is, and how it differs from the workspace tool it
grew out of. The README is the short version.

## 1. The problem

An AI coding agent is charged for what it reads. Most of what it reads in a
typical session is not the problem it was asked to solve. It is orientation:
where the code is, which function serves which route, whether two tables agree,
what the test command is, what changed since last week. Measured over 170
sessions in the workspace bundlebox was built for, the median session re-read
37% of the files it opened, spent 88% of its tool turns on a single call, and
half of all sessions ran long enough to compact at least once.

Every one of those questions has an answer that a parse, a count, a path check
or a set difference can produce in milliseconds for nothing. The agent was
paying tokens for arithmetic.

## 2. The thesis

bundlebox is a control layer that runs before, around and after the agent, and
never calls a model itself. The rule for what belongs in it:

> If the answer is a set difference, a path check, a count or a parse, it is a
> detector and it costs nothing.

Everything that fails that test is packed into a brief the agent can act on
without searching, and the agent is opened with the smallest window that can
hold that brief plus the files it names. What the agent used, and what the
factory saved it from paying, is measured off the transcript the agent already
writes.

The design goal stated as a number: a model should touch about a tenth of the
work.

## 3. The flow

```
bb scan      findings    what is wrong, with evidence         0 tokens
bb fix       patches     the local actuators close what they can   0 tokens
bb compile   units       what to do about the rest, each packed to one window
bb route     lanes       who does it, where, in what wave
bb run       sessions    the only verb that spends
bb git       PRs         commit, push, draft PR, review, merge   0 tokens
bb session   the bill    what a session used and saved, measured
```

In front of that spine sits the half that turns a document into work, and it has
exactly one paid stage:

```
bb genesis <doc>   a world model: surfaces, actors, rules, capabilities   0 tokens
bb genesis plan    of everything it declares, what no scenario touches    0 tokens
bb genesis pack    one small brief per surface, derived half already done 0 tokens
bb genesis send    the judgement half, and only that half           THE ONLY SPEND
bb cookbook run    what came back, executed against the running system    0 tokens
bb simulate run    the same request at a hundred callers                  0 tokens
bb mainboard gaps  which stage does not hold, and the command that closes it
```

Deciding WHAT to write is a set difference over the document and the corpus and
costs nothing. Writing it — the voice, the `rule` block, the assertions — is a
judgement, and it is the only part a model is asked for. The split is the whole
design, and it is why the brief carries the routes, the tier, the rules to cite
with their line numbers, the step skeleton and the acceptance command already
worked out. The agent is told what to write, not asked what is missing.

A pipeline does not fail by erroring. It fails by SKIPPING — a corpus nobody
ran, a board older than the scenarios in it, findings nobody compiled. Each of
those is silent and each makes the next stage produce a confident answer about
stale inputs, so every stage carries an exit criterion that is evaluated now
rather than a memory of having run once. `bb mainboard gaps` evaluates all ten
and names the one command that closes the first one that does not hold.

Around that spine sit the verbs that answer questions a session would otherwise
pay to answer:

| verb | the question it answers for free |
|---|---|
| `bb snapgen` | what is where: layout, symbols, routes, docs, commands, hot files, as fingerprinted tables |
| `bb pinpoint` | for one problem, which files, which regions, what is already known, and does it fit |
| `bb context` | will this scope fit in one session, and if not where does it cut |
| `bb oversight` | which files are god-shaped, duplicated, bloated or vibe-coded, and what to tell a session about it |
| `bb pipeline` | run six verbs in one process with gates between them instead of asking a session to sequence them |
| `bb buckmaster` | how sessions actually spend turns, and the recommendations the measurements support |
| `bb bridge` | the one doorway out of free: a packed call handed to an agent, drafted by default |
| `bb wire` | install all of the above into Claude Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Cline, Windsurf, Aider and Amp |
| `bb mcp` | the same verbs as MCP tools, so any agent can ask instead of search |
| `bb cookbook` | what the RUNNING system does with a persona's week, run by the kernel: red steps are findings carrying the rule they contradict |
| `bb simulate` | what it does at rising concurrency, against a budget that is a multiple of the floor measured in that same run |
| `bb mainboard` | six views over one ledger — is it up, does it obey its rules, could a person get through, what breaks under load, what answers without credentials, what nothing covers |
| `bb runbook` | the running system: services under a real cage, and forty thousand log lines as twenty signatures read by offset |
| `bb frames` | a dataframe over the factory's own data, and evals as JSON files a person can argue with |
| `bb failsafe` | what is failing now, the cause this workspace already paid to learn, the op that closes it — and what every source was blind to |
| `bb blackice` | the per-area audit: dated, never edited, ingested as findings, and checked for drift against the tree it described |
| `bb monitor` | what the current five-hour block has left, and the guard asked immediately before anything spends |
| `bb commandcenter` | one read-only page: the pipeline, the window, every session with its own title and what the local path displaced for it |

## 4. Where the tokens go, and where they come back

A session's context is four terms stacked:

```
projected = overhead + brief + payload × churn + reserve
```

- **overhead** is the system prompt, tool schemas and instruction files, before
  a word of the task. It is probed, not assumed: `bb tokens profile --probe`
  opens a one-turn session under the exact flags a lane spawns with and reads
  the first usage block.
- **brief** is the compiled instructions and evidence.
- **payload** is every file in scope, read once. When a finding names a symbol,
  the payload is the located region plus a widening allowance, not the file.
- **churn** is the term everyone forgets: the same files re-read after edits,
  plus tool output about them. It measures near 2.4 on real transcripts.
- **reserve** is held back for the model's own output, per kind of unit.

Five levers act on those terms, in the order they were measured to matter:

1. **Lean session flags.** Naming the seven tools a lane uses, dropping user
   settings sources, MCP servers and slash commands took a lane's opening
   window from 44.3k to 29.2k tokens on the reference box. The flags are not
   independent, so the stack is probed as a combination.
2. **Region, not file.** A route table is 2 to 4 percent of the file that holds
   it. Quoting the located region with line numbers turns the common case into a
   session that never opens the file.
3. **Say it once.** Facts shared by every finding in a unit are hoisted into one
   header. Six near-identical hints become one with a hole in it.
4. **Cache-stable prefix.** The static guardrails go first and the dynamic
   evidence last, so parallel lanes share a prompt-cache write instead of each
   priming their own. Cache reads bill at a tenth of input.
5. **The wire.** An optional local compression proxy (headroom) in front of the
   lane, talked to over the process boundary and never imported. Reported as a
   separate row with its own denominator, because a cache bust can take back
   what compression removed.

## 5. What is measured and what is estimated

Two kinds of number appear in every report and they are never added together:

| row | how it is known |
|---|---|
| used | measured to the token from the transcript, deduplicated by message id |
| saved: cache | measured: those exact tokens billed at the cache-read discount |
| saved: wire | measured from the proxy's own counters, when it is up |
| saved: automation | an estimate, printed as a range: turns the local verbs displaced × this session's own marginal-to-full per-turn cost |

A model with no price in the table is reported with its tokens and no cost.
A verb that could not look returns unknown, never an empty list. A unit with no
acceptance command is marked unproven, not passed.

## 6. What changed from the original

bundlebox began as a stdlib-Python factory wired into one five-repo workspace
(Flutter, FastAPI, Convex). This package is the portable core of that tool,
rebuilt in dependency-free Node so it installs with one `npm i -g` and wires
into any agent. The reference implementation is a 27k-line tree with 42 verbs;
roughly a third of it was product-specific (a mock engine, device fleets, persona
corpora) and stays behind.

Beyond portability, the rebuild closed the defects found in a review of the
original. The ones that changed reported numbers:

| in the original | here |
|---|---|
| the wire savings row called a function that did not exist and was silently zero | `session` reads the proxy's `/stats` and prints n/a when it cannot |
| the daily calibrator overwrote the probed session overhead, silently regressing every lane budget by ~27k | calibration writes are read-merge |
| the transcript matcher used a loose prefix and counted other projects' sessions | exact slug match, worktree children only when the directory exists |
| every unseen turn was charged to whichever run folded next | run attribution only for sessions the run spawned |
| `secret-scan` reported one hit per pattern per file and a placeholder muted the rest | every match reported, placeholder tested per match |
| a critical survey finding overrode the judgement rule and opened an expensive lane | judgement is sticky |
| unattended sweeps ran destructive actuators | `DESTRUCTIVE` is honoured everywhere |
| a lane could hang forever before its first token; stderr was never drained | hard timer independent of output; stderr drained |
| units with no acceptance shipped as green PRs | `unproven` blocks `--pr` |
| a commit with no scope fell through to `git add -A` | refused |
| the codex adapter never passed its prompt; the gemini adapter passed a filename as the prompt | per-adapter delivery contract, verified against `--help` |
| the process model's train and serve features differed | one `featurize()` for both, with a collinearity warning |
| memory decay never fired because `last_seen` was bumped on every write | `last_seen` moves only on re-derivation |
| two fingerprint implementations | one |
| the whole shell environment was handed to every lane | allowlist |

The full list is in `docs/review-of-the-original.md`.

## 7. Three runtimes, one set of answers

The CLI, the adapters and the store are Node with no dependencies, because a
global install must be one command and a cron worker must run what is on disk.
Two operations classes do not belong in a scripting runtime and were moved out:

- **The kernel** (`kernel/`, Rust, binary `bbk`) owns the work where a
  JavaScript process fails in ways that look like answers: walking a large tree
  without exhausting the heap, hashing thousands of files for a fingerprint,
  sliding-window duplicate detection, running an acceptance gate under a real
  timeout with a bounded output, adding and seeding a worktree. JSON in, JSON
  out, over a pipe.
- **The expert system** (`expert/`, Python stdlib) owns the rules and the
  learning: the forward-chaining engine with explainable derivations, triage,
  confidence shrinkage, transcript signals, the eight recommendation rules, the
  process graph, the logistic model and memory.

Both are optional. Without the kernel the JS implementations run; without
python3 the learning verbs say so and the zero-token path is unaffected. Where
two runtimes implement the same fact, a test pins them to identical answers,
because which runtime happens to be installed must not change a number.

## 8. What it does not do

- It does not judge intent. A finding is a fact with evidence; whether the fact
  matters is triaged by a rule you can read, and anything past that costs a
  session.
- It does not add a dependency. There is no runtime `node_modules`. A cron
  worker at 03:00 runs what is on disk or it does not run.
- It does not talk to the network on an ordinary verb. `bb update` and `bb git`
  are the exceptions and they say so.
- It does not post anything anywhere on its own. `bb git pr` drafts; `bb bridge`
  drafts; both need a flag to send.

## 9. Vocabulary

- **finding**: one detected fact with evidence, a detector, a severity and a file set.
- **unit**: findings packed to fit one window, with a scope, a brief and an acceptance command.
- **lane**: a scheduled session: a checkout, a budget, a wave, an agent.
- **brief**: the prompt a lane opens with.
- **anchor / region**: a located declaration, costed and quoted instead of its file.
- **actuator**: a local fix that writes a patch before it writes a file, and declines rather than guesses.
- **gate**: the project's own test or lint entrypoint, whose exit code is the verdict.
- **episode**: one row per local action: what was true before, wall clock, what it produced, turns displaced.
- **gear**: a declared pipeline over verbs with gates between stages.
- **world**: a document read into surfaces, actors, rules and capabilities, every item citing the line it came from.
- **capability**: one thing the world says the system can do, addressable — `GET /orders`, `npm test`.
- **scenario**: an ordered list of steps under one surface, carrying the rule it asserts, quoted from the source.
- **board**: the result of running a corpus: per-surface passed, failed, blocked and empty, with evidence.
- **view**: one producer of board findings, filed through `record()` into the same store the detectors write to.
- **block**: a five-hour rolling billing window that starts with the first turn after a gap.
- **stage**: one step of the pipeline, with an exit criterion evaluated now and the one command that closes it.
