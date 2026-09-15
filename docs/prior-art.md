# Prior art: seven projects read, and what came back

Read in full and reviewed against bundlebox in September 2026; caliper and Chisle
were read a second time and each gave back a verb the first pass missed. Each row says
what the project does, what bundlebox took, and — the more useful column — what
it deliberately did not.

| project | what it is |
|---|---|
| [caliper](https://github.com/edonadei/caliper) | an evaluation harness for agent skills: a YAML spec of what "good" looks like, run `k` times, with `--ablate` to run the same tasks with the skill removed and `compare` to diff the two |
| [Chisle](https://github.com/JayPokale/Chisle) | an injected ruleset that cuts an agent's output tokens, with a benchmark directory that publishes the runs where it lost |
| [anti-slop](https://github.com/dmmulroy/anti-slop) | Oxlint rules that reject low-evidence TypeScript: chained assertions, `unknown` in contracts, open dictionaries, mocked modules |
| [Reticle](https://github.com/reticlehq/reticle) | a dev-only SDK inside the running app, exposed to the agent over MCP; it drives real flows and returns pass / fail / "couldn't tell" with the `file:line` |
| [Birdview](https://github.com/Qiuner/birdview) | architecture maps with stable module ids and explicit file ownership, plus agent-declared activity, rendered as one standalone HTML file |
| [Ouroboros](https://github.com/Q00/ouroboros) | a replayable agent loop with an interview that scores the ambiguity of a task before work starts, and a success contract the agent never sees the answer to |
| [ui-skills](https://github.com/ibelick/ui-skills) | a registry of UI skills with a CLI and an MCP server exposing `list_skills` / `get_skill` |

## What came back

### caliper → `bb bench`

The load-bearing idea is the **ablation**: you cannot claim a tool helps without
running the same task with the tool removed. Caliper removes a skill and runs
the agent twice. bundlebox cannot do that for free — a model call is the thing
it exists not to make — so the ablation moved down a level, from *what the model
produced* to *what the task cost to set up*:

    BARE    search the tree for the task's terms, open the top --cap files whole
    PACKED  the one `bb pinpoint` prompt for the same task

Both arms are token counts over text on disk, which buys something caliper's
arms cannot have: determinism. Two runs on one tree return the same number, and
that is asserted in CI and in `bb selftest`.

Also taken: caliper's insistence that the *control subject* is named in the
output. `bb bench` prints `--cap` in the report rather than hiding it in a
constant, because the bare arm's read budget is the one assumption in the
measurement.

**Not taken:** the `k`-times-and-report-a-success-rate loop. bundlebox has no
free way to run a task, so a success rate would be an estimate wearing a
percentage sign.

### Chisle → the losses column

Chisle's README is unusual in that it publishes its losing runs. `bb bench`
counts tasks where the packed arm cost MORE than the bare one and prints them in
the same table, and `bundlebox-projects/tokenlab` exists specifically to report
the range (78%–97% across nine rows) rather than the best row.

**Not taken:** the output-token ruleset itself. bundlebox does not sit in the
model's output path, and a rules block that claims to change how a model writes
is a claim it has no instrument to check.

### Chisle, read again → `bb sieve`

The second read found the half the first one walked past. Chisle compresses on
two axes and only one of them is the ruleset. The other is a `PostToolUse` hook
that rewrites an oversized **tool result** before the model reads it, and that
axis needs no instrument in the output path at all: the input is a string this
box already holds, the transform is deterministic, and the saving is a
subtraction. Everything the "not taken" above objected to is absent from it.

The input axis is also the compounding one, which is what makes it worth a
verb. A tool
result is billed when it arrives and again on every later turn of the session,
because the whole window is re-sent. Shrinking it once is paid back every turn
that follows — so a 4,000-line build log read at turn six is the most expensive
object in a long session, and nothing else in this factory was looking at it.

Taken, near enough verbatim, because the reasoning behind each is sound:

- **The tiers.** scrub (lossless: ANSI, blank runs, repeated lines) → dedup
  (byte-identical to this tool's previous output *in this session*, so the bytes
  are already in the window) → elide (head + tail).
- **The allowlist, and that it is an allowlist.** `Read`, `Edit` and `Write` are
  absent by construction: their output is the text a later exact-match edit is
  written against, so eliding a `Read` makes the model edit against text it
  never saw. A blocklist would admit the next edit-shaped tool on the day it
  ships.
- **Error salvage.** Lines matching an error vocabulary are carried out of the
  elided middle and kept verbatim, because the one line that mattered in a
  3,000-line log is the line the agent will otherwise re-run the build to find.
- **The spill.** The full text is written to disk before the cut and the marker
  carries the path, so recovery is a grep rather than a re-run — which matters
  most exactly where elision helps most, since a test run, a deploy or a
  `git log` is not idempotent.
- **`rebuildResponse` returning null on a shape it cannot rebuild.** Chisle
  shipped this as a bug fix and the bug is instructive: Claude Code validates
  `updatedToolOutput` against the tool's own schema and rejects a mismatch
  *silently*, so a hook handing back a bare string for an object-shaped Bash
  result logs savings the session never received. A ledger that counts rejected
  replacements is worse than no ledger.
- **The replay benchmark.** Chisle's `benchmarks/replay-compress.js` pushes real
  transcripts through the same pure transform, so the claim is measured before
  it is installed and costs nothing. `bb sieve replay` is the same idea against
  `bb`'s own ledger.

Changed, and each change is a doctrine this box already had:

- **The threshold is a share of the working window, not `8000` chars.** The same
  log is 6% of a 130k window and 1.5% of a 500k one, and only one of those is
  worth cutting (doctrine 9).
- **The saving is reported in tokens, twice, labelled.** Chisle reports chars
  and divides by four. `bb sieve replay` reports the estimator's number as
  ESTIMATE *and*, where the transcripts contain enough turns in which exactly
  one tool result arrived, the ratio read off the billed window growth
  (`ledger.windowDeltas`) as MEASURED. On this repo's own eight sessions the two
  land within 0.2% of each other, which is a result about the estimator as much
  as about the sieve (doctrine 3).
- **The ledger is a row per event, not two integers.** Which tool, which tier,
  before and after. "Saved 4.2M chars" cannot be argued with; "elide, Bash,
  117.3k → 2.8k" can.
- **A result whose producing tool cannot be identified is counted as unknown,
  not skipped silently** (doctrine 2), and the report prints what the allowlist
  *declined* beside what it took, because that column is the correctness half.

**Still not taken:** the ruleset. The objection above stands.

### caliper, read again → `bb uptake`

`bb bench` took caliper's ablation. The second read found the thing the ablation
sits on top of, which caliper calls **activation**: caliper never pastes a skill
into the prompt, it *installs* the skill where the agent looks and then reads
the transcript for evidence that the agent reached for it — so a run measures
the `description` (does it fire?) and the body (does it work?) as two separate
numbers that are never blended.

bundlebox had the first half and not the second. `bb wire --apply` installs an
instructions block, an MCP entry and a set of hooks into every agent on the box,
and `bb wire status` then reports that they are *installed*. Installed is not
used. The block is billed in every window of every session whether the agent
obeys it or not, so a surface nothing reaches for is not neutral — it is the
most expensive kind of dead code this factory can write, and nothing could see
it.

Taken:

- **Observe from the transcript, never from the prompt.** The same rule caliper
  uses for a `Skill` tool call or a read of `<name>/SKILL.md`: an MCP tool named
  `bb_*`, a shell segment whose first word is `bb`, a read of a path under
  `out/snapgen`.
- **`None` is a verdict and it is not failure.** Caliper's `check_activation`
  returns `None` when nothing was observable, and refuses to score it. Three of
  bundlebox's surfaces — the instructions block, the SessionStart context, the
  read guard — arrive in the system prompt or in a permission decision, neither
  of which is a turn. They are printed as **not observable, with the reason**,
  and never as 0%, which would be a measurement of nothing wearing a percentage
  sign (doctrine 8).
- **Per-subject `wanted / fired`, and the miss reported with its evidence.**
  Caliper's per-skill table is what catches a skill stealing a neighbour's
  prompts. The same shape here catches an instruction nothing obeys — and the
  useful column is not the rate, it is `pinpoint · session 4f3f9228 · opened 598
  file(s), 129 distinct`.

Changed:

- **The denominator is an opportunity, not an attempt.** Caliper controls the
  prompts, so every attempt is a chance by construction. bundlebox reads
  sessions it did not author, so the chance has to be derived: `pinpoint` is
  counted only against sessions that opened at least `READ_FLOOR` distinct
  files, `tables` only against sessions that ran a search. A session that opened
  one file is not a session that ignored `bb pinpoint`.
- **A file opened with `sed -n` counts exactly as much as one opened with
  `Read`.** Which of the two a session uses is a harness setting; counting only
  the tool reports a shell-first session as one that never opened anything.
- **Heredoc bodies are stripped before a command is read.** Every document this
  box writes about itself contains `bb scan`, and without this the verb reports
  a session that *wrote* the README as a session that ran half the CLI. This is
  the one place the measurement inverts if it is done naively, so it has its own
  test.

**Not taken:** ablation on this axis. Removing the instructions block and
re-running the session to see what changes needs a model call per arm, and the
opportunity denominator already answers the question the ablation was for.

### anti-slop → the `anti-slop` detector

Eight of its rules survive translation to a line-anchored scan with no type
information: adjacent eager `filter`/`map`, a reducer copying its accumulator
per element, chained assertions, `any` in a contract, open dictionaries, mocked
modules, `Reflect` escapes. Severity is graded so a single hit is `info` and
can never be promoted into work.

**Not taken:** everything requiring a type checker — `no-known-value-widening`,
`no-widen-then-assert`, the Effect group. A regex that guesses at a resolved
type is a detector nobody leaves enabled.

### Reticle → nothing new, and that is the finding

`bb cookbook` already is this: a corpus run against the process, with red steps
becoming findings that carry the evidence. Reticle reaches further — it reads
the store and the console from inside the app — and it needs an SDK in the
user's bundle to do it, which is a different trade than a dependency-free box
makes.

What reading it did produce: its three-state verdict (pass / fail / **couldn't
tell**) is the same instinct as bundlebox's `blocked` and `empty`, and checking
that they behave the same way is what surfaced the `simulate` bug where a clean
run could not close the findings a dirty one opened.

### Birdview → not yet

Its module-ownership map with evidence links is a better shape than `bb snapgen
layout`, which is a directory listing with counts. Worth doing; not done here,
because doing it properly means stable module ids that survive a rename, and
that is its own change.

### Ouroboros → the ambiguity ledger

Its interview scores how under-specified a task is *before* work starts. Every
signal that predicts it is already measured in bundlebox — no gate detected,
nothing in the symbol tables matched, no region located, no evidence on file, a
scope cut to fit — so `bb pinpoint` now carries a section stating them, scored,
with the reasons kept separate from the number.

**Not taken:** the generational loop that re-runs a failing agent until it
passes a contract it cannot see. That is a spending loop, and the one thing
this box will not install on a timer.

### ui-skills → not yet

Its registry shape (`list_skills`, `get_skill` over MCP) maps cleanly onto
`bb mcp` serving the snapgen tables as `list_tables` / `get_table`, which would
let an agent pull one table instead of being handed an index. Worth doing; the
MCP surface is currently nine named verbs and adding a second addressing scheme
to it is a design decision, not an afternoon.
