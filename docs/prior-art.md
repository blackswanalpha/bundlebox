# Prior art: seven projects read, and what came back

Read in full and reviewed against bundlebox in September 2026. Each row says
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
