# The Zero-Token Control Layer

## Cutting what an AI coding agent reads by answering the cheap questions before it opens

Kamande Mbugua — September 2026 — v1.0

---

### Abstract

AI coding agents are billed for context, and most of the context in a working
session is orientation rather than judgement: where a symbol lives, whether two
tables agree, which command proves a change, what changed since last week. We
present bundlebox, a dependency-free control layer that answers every such
question with a parse, a count, a path check or a set difference before an agent
is opened, packs the answers into a brief sized to the agent's window, opens the
agent with a measured-minimal flag stack, and measures afterwards what the
session used and what it was spared. On the reference workspace the opening
window of a spawned session fell from 44.3k to 29.2k tokens (−34%) before any
work; a plan of the same findings fell from five sessions and 1.3M projected
tokens to two sessions and 351k (−74%); one pipeline tick displaced 226 agent
turns in 133 seconds at zero model cost. We describe the budget model, the
measurement discipline that keeps the reported numbers honest, the adapter
contract that lets the same layer drive Claude Code, Codex, Gemini CLI and
seven other agents, and the defects found while porting the original.

### 1. Where the tokens go

A session with a coding agent is a sequence of turns. Each turn re-sends the
window: system prompt, tool schemas, instruction files, every file read so far,
every tool result. Prompt caching makes the re-send cheap but not free, and it
is defeated by anything that changes the prefix.

Reading 170 sessions from one workspace's transcripts gave five medians:

| signal | value |
|---|---|
| files re-read within a session, as a share of reads | 0.37 |
| tool turns carrying a single call | 0.88 |
| sessions running past 60 turns | 0.52 |
| cache-read share of input | 0.99 |
| window growth per turn | 1,340 tokens |

The cache was doing its job. The turns were not. Half the sessions were long
because the agent was searching, and it was searching for facts a script could
have stated.

### 2. The admission test

The whole design reduces to one rule about what a model may be asked:

> If the answer is a set difference, a path check, a count or a parse, it is a
> detector and it costs nothing.

A detector produces a finding, and a finding must carry evidence: the lines,
the counts, the snippet. A finding that points at a file has moved the search
cost into the session instead of removing it.

Sixteen detectors ship. They are generic to any tree: broken doc links, TODO
census, secret scan, oversized files, merge markers, worktree hygiene, dead
exports, duplicated blocks, god files, orphan files, dead dependencies, doc
drift, lockfile drift, stale evidence, missing tests, debug leftovers. Each
declares its precision (`exact`, `probe`, `heuristic`) and that prior is blended
with the measured hold rate of past fixes, shrunk at `settled / (settled + 4)`,
so three samples cannot override the method and zero samples do not read as
certainty.

Findings are ranked by expected value, not severity:

```
ev = confidence × weight(severity) × n / max(est_tokens, 1000) × 100000
```

A cheap exact fix outranks an expensive heuristic one, which a severity floor
cannot express.

### 3. The budget model

A unit's projected context is four terms:

```
projected = overhead + brief + payload × churn + reserve
```

**Overhead** is probed, not assumed. A one-turn session under the exact spawn
flags reports the first usage block, and that block is the entire fixed cost.
Measured stacks on the reference box:

| stack | opening window |
|---|---|
| default spawn | 44.3k |
| lean: seven named tools, project settings only, no MCP, no slash commands, dynamic sections excluded | 29.2k |
| the same flags with the full tool set | 43.2k |

The flags are not independent. Naming the tools is what unlocks the rest, so
the stack is probed as a combination and never summed from separate claims.

**Payload** is costed per region where a finding names a symbol. A route table
is 2 to 4 percent of the file that holds it. The region is quoted in the brief
with line numbers, and the file is budgeted as `region + widen × (whole −
region)`. The widening factor is a declared bet: it was raised from 0.15 to
0.45 when the first real lane peaked at 1.26× its estimate, and it is
re-checked against every lane that finishes.

**Churn** is the term everyone forgets. A session that opens 60k of source
does not hold 60k; it holds the file, the edited file, the linter output about
the file and the diff. Measured near 2.4.

**Reserve** is per kind of unit: a table edit does not need the 40k an
investigation does.

The verdict is `FITS` under 78% of the ceiling, `TIGHT` under the ceiling,
`SPLIT` above it with more than one file, `HEAVY` when one file is the reason.
A split is first-fit-decreasing over directory groups, so the halves are still
coherent units of work. A plan of 33 files projected at 815k against a 350k
ceiling became five sessions before anchoring and two after.

### 4. Measured, estimated, unknown

Three refusals keep the reports true.

1. A measured number and a counterfactual are never added and never printed
   the same way. A session report has four rows: used (measured from the
   transcript, deduplicated by message id), saved by cache (measured: those
   tokens billed at the read discount), saved by the wire (measured from the
   proxy's counters, its own denominator), saved by automation (an estimate,
   printed as a range between the session's marginal and full per-turn cost).
2. A function that could not look returns unknown, never an empty answer. No
   `gh` binary means the PR survey is unknown, not clean. A renamed table that
   makes a parser return nothing must fail a self-test rather than report that
   the tables agree forever.
3. Green must mean something was checked. A unit with no acceptance command is
   `unproven`; it is not shipped. A skipped eval is not a pass. A model that
   cannot beat its own base rate on a time-split holdout answers with the base
   rate and says so.

### 5. Wiring into any agent

The layer talks to agents over two boundaries and imports nothing from them.

**Spawn.** An adapter builds the command line, delivers the prompt the way that
agent accepts it (stdin, argument or file), parses its usage events, and knows
where its transcripts live. Ten adapters ship. Flags are verified against each
binary's `--help` at build time and unverified ones are labelled.

**Hooks and MCP.** `bb wire` installs, per agent, an instruction block between
markers, a hook set where the agent supports hooks (session start injects the
table index; a pre-read hook advises a range when a file exceeds a third of the
window; session end measures the bill), and an MCP server entry. `bb mcp` is
JSON-RPC over stdio in 80 lines with no dependency, exposing `bb_pinpoint`,
`bb_context`, `bb_snapgen`, `bb_findings` and the rest as tools, so an agent
asks the factory instead of grepping.

**Prompt cache.** Briefs are assembled with the static guardrails first and the
evidence last. Four parallel lanes then share one cache write. The dynamic
system-prompt sections (cwd, git status) are excluded for the same reason.

### 6. The pipeline and what it learns

A session sequencing known steps is the most expensive way to run known steps.
`bb pipeline` runs a declared gear (scan → oversight → compile → route) in one
process with gates between stages, skipping any stage whose inputs did not
change, by one fingerprint `(count : sha1(path, mtime, size))`. Every stage
writes an episode: what was true before, wall clock, what it produced, how many
agent turns it displaced. Turns are counted (`files_read + commands + searches +
rows / 40`), never guessed.

The episode table trains a logistic model that predicts whether an optional
stage will produce anything. It refuses to steer until it beats the base rate
on the most recent 20% of episodes by time, and it prints a collinearity
warning when features share a weight, because in the reference data the verb,
its predecessor and the edge between them were one column wearing three names.

### 7. What the port fixed

Porting the reference implementation exposed twenty-one defects that changed
reported numbers or shipped unchecked work, among them: a savings row that
called a function that did not exist and was silently zero; a daily calibrator
that clobbered the probed overhead; a transcript matcher that counted other
projects; a secret scanner that stopped at the first match; a runner that could
hang before its first token; unproven lanes shipped as green PRs; a commit path
that fell through to `git add -A`; an adapter that never passed the prompt to
Codex and one that passed a filename to Gemini. The full list with file and
line is in the repository.

### 8. Limitations

The estimator is linear in three counts and calibrated per box; a tokenizer
would be exact and is a dependency this tool refuses. Detectors are regex over
source, not a parser; tree-sitter would find declarations the regexes miss.
The process model is trained on a label that is still a weak function of the
verb. Savings from the wire depend on an external binary and are reported only
when it answers.

### 9. Conclusion

The agent should touch about a tenth of the work. Everything a parse can settle
is settled locally for nothing; what remains is packed, budgeted and opened
under a measured stack; what it cost is read back from the transcript. The
numbers in this paper are arithmetic over work that was done, and every one of
them can be regenerated with `bb session` and `bb buckmaster episodes` on a
workspace that has run the tool.

### References

- Anthropic, Prompt caching, developer documentation, 2026.
- Anthropic, Claude Code hooks and headless mode, 2026.
- Model Context Protocol specification, 2025-06-18.
- headroomlabs-ai/headroom, local context compression proxy, Apache 2.0.
- The reference implementation: `mypa/bundlebox`, stdlib Python, 2026-08 to 2026-09.
