# prompt.md — attack turns, not bytes

What to change in bundlebox, why each change earns its place, and the gate that
proves it landed. Every number below was measured on 2026-09-18 by
`bundlebox-projects/bench`: 36 Claude Code runs on `claude-sonnet-5`, six seeded
defects, three repeats per cell, both arms on an identical 39-file React Native
tree. Raw runs are in `bench/var/runs.jsonl`.

## Constraint: bundlebox is independent of the model, the harness and the agent

bundlebox derives artefacts on disk. It does not call a model, it does not own
the agent loop, and it is not built against one vendor. That independence is the
product, not an implementation detail, and every item below preserves it.

What that means today, checked in this tree:

- **No model.** There is no outbound call to any model endpoint in `src/`.
  `pinpoint`, `scan`, `snapgen`, `findings`, `bench` and `genesis` all run at 0
  model tokens. `bb tokens prices` carries 18 models across Anthropic, OpenAI
  and Google — a table used to price a session after the fact, not a binding to
  any of them.
- **No harness.** Claude Code's system prompt is 19,240 tokens today and a
  release can change it without warning; the same is true of its caching, its
  tool set and its turn policy. No item here replaces the harness, sets request
  parameters on its calls, or assumes a constant it does not control.
- **No agent.** `bb agents` knows claude, codex, gemini, opencode, aider, cursor
  and copilot. Agent-specific knowledge is confined to a flag stack per agent;
  every agent without one still works.
- **Plain files.** `.bundlebox/out` is 155 JSON files and 81 markdown files.
  Any model, any harness and any agent can read a brief, because a brief is
  markdown. Nothing is serialised in a format that needs bundlebox to open it.

The floor is therefore not ours, and neither is the agent that pays it. What
follows is what can be moved from outside both.

## What was measured

| | bare | packed | |
|---|---|---|---|
| tokens per run | 344,118 | 253,734 | **1.36×** |
| turns per run | 8.2 | 7.5 | 9% fewer |
| output per turn | 161 tok | 216 tok | 34% **more** |
| TTFT, median | 2,602 ms | 3,828 ms | 47% **slower** |
| wall per turn | 3.0 s | 4.2 s | 40% **slower** |
| cost, 18 runs | $3.39 | $3.57 | 5.3% **more** |
| solved | 18/18 | 18/18 | — |

`bb bench` over the same tasks reports 13.3× at `--cap 10` and 19.6× at
`--cap 25`. A real agent delivers 1.36×. The gap is not noise and not caching
luck: `bb bench`'s bare arm reads the top N files whole, and no agent does that.

## The three facts the work follows from

**F1 — cost is turns × context, and we only attack context.** 91.5% of the bare
arm's tokens are cache reads: the conversation replayed once per turn. Fresh
input is 16 tokens. Nothing is paying to read files. Cutting bytes 27% while
cutting turns 9% optimises the smaller term.

**F2 — the floor is not fixed, it is multiplied.** The harness system prompt
costs `19,240 × (turns + 1)`: written once, replayed every turn. At 8.2 turns
the replay comes to 176,367 tokens of a 344,118-token bare run, 51% of it. bundlebox cannot
change the coefficient. It can change the multiplier, and the multiplier is
turns:

| turns | floor | movable | total | vs bare |
|---|---|---|---|---|
| 7.5 (today) | 163,540 | 90,194 | 253,734 | 1.36× |
| 5 | 115,440 | 60,129 | 175,569 | 1.96× |
| 4 | 96,200 | 48,103 | 144,303 | 2.38× |
| 3 | 76,960 | 36,077 | 113,037 | **3.04×** |
| 2 | 57,720 | 24,052 | 81,772 | 4.21× |

Every turn removed takes 19,240 tokens of harness overhead with it. The turn
count is the whole argument for W1, and cutting it needs no cooperation from
the harness.

**F3 — the brief is half boilerplate, emitted last.** Diffing two briefs for
different tasks: 1,756 chars vary, 1,594 chars are byte-identical. The invariant
48% is emitted *after* the task-specific sections, so it can never form a cached
prefix and is re-prefilled every run. Those 1,594 chars are the TTFT regression.
Genesis packs are worse: two packs for unrelated surfaces are **90% identical**,
6 packs totalling 30.1 kB.

## The work

### W1 — carry the change, not just the coordinates

`bb pinpoint` says where the code is and stops. The agent then spends four turns
rediscovering what to write. Add a proposed edit to the brief: the region, and
the replacement for it, as a diff the agent can apply and verify.

The shape already exists in this repository. A `bb genesis` pack opens *"Everything
below was derived locally and costs nothing to restate. Do not re-derive it, do
not search for it"* and then carries the schema, the legal keys and the output
path — the derived half, done. Genesis does it for documents; pinpoint should do
it for findings.

- Where: `src/pinpoint/index.js`, `src/wire/brief.js`
- Expected: 7.5 turns → 3, which is **1.36× → 3.04×** by F2, and 31.5 s → 12.6 s
  of wall clock at today's 4.2 s/turn.
- Risk: a wrong diff costs more than no diff, because the agent must undo it.
  Gate on solved rate, not on tokens.

### W4 — invert the brief

Emit the invariant sections first, the task-specific ones last. No new concepts,
no new content: an ordering change in the emitter that turns 48% of every brief
from novel prefill into a cache hit.

- Where: `src/wire/brief.js`, `src/pinpoint/index.js`
- Expected: roughly half the TTFT regression, so ~3,828 ms → ~3,200 ms.
- Apply the same fix to genesis packs, where the shared fraction is 90%.

### W5 — delete the policy prose

`Do not` is 648 chars. `What this brief does not settle` is 384. Every run pays
prefill on both. Keep the lines that change what the agent does; delete the
lines that describe the brief to itself.

- Where: `src/wire/brief.js`
- Expected: with W4, TTFT at or below bare's 2,602 ms.
- Gate: solved rate must not move. If deleting a rule costs a fix, it was
  load-bearing and goes back.

### W6 — quiet the instructions

The packed arm emits 34% more output per turn, and output decode is what wall
clock is made of. "Touch nothing outside Scope" and "spend turns on the change,
not on finding it" read as instructions the model acknowledges rather than
obeys. Rewrite in the imperative, without the justification.

- Where: `src/wire/brief.js`
- Expected: 216 tok/turn → ~161, the bare arm's rate. At 4.2 s/turn that is most
  of the per-turn gap.

### W7 — pinpoint in the hook, never in the path

`bb pinpoint` takes 534 ms. Run serially before a session, that is 534 ms of
TTFT. Run in `UserPromptSubmit`, it overlaps session startup and costs nothing.
The hook already exists and already does this; the bench harness called it
serially and was wrong to.

- Where: `src/wire/agents.js` (hook wiring), `bench/run.mjs`
- Expected: −534 ms of user-perceived latency, and a bench number that measures
  bundlebox rather than the harness around it.

### W8 — measure on a tree that is not a toy

39 files proves nothing about scaling. The packed arm is flat at 7,724 tokens at
every `--cap`; the bare arm's movable part grows with the repository. Re-run this
matrix on `sampleone` and on a 400-file `tokenlab` tree.

- Where: `bench/run.mjs`, `tokenlab/bench/`
- Expected: the movable ratio widens. If it does not, the flat-packed-arm claim
  is wrong and should be retired with the rest.

### W9 — one cached preamble for every emitter

Pinpoint briefs repeat 48% of their bytes; genesis packs repeat 90%, and a full
genesis send is 12.0k tokens across 6 packs. Emit the shared preamble once, from
one place, ahead of the varying part, so both surfaces get the cache hit from a
single change.

- Where: `src/wire/brief.js`, `src/genesis/packs.js`
- Expected: ~27 kB of the 30.1 kB genesis corpus stops being novel prefill.

## Removed, and why

**W2 — own the floor.** Was: make `bb bridge` the harness, with four tools and a
system prompt under 2k, dropping the floor from 176,367 to ~18,000. Removed
because it makes bundlebox a harness vendor and binds it to an interface that
changes without notice. F2 now gets most of what W2 promised, by cutting the
multiplier instead of the coefficient.

**W3 — stop replaying tool results.** Was: enable `context_management` and
compaction. Removed for the same reason: those are request parameters on calls
bundlebox does not make. If the harness adds them, the numbers here improve on
their own and no bundlebox change is needed.

## Gates

### G1 — no regression

Nothing ships that moves any of these the wrong way, measured by re-running the
36-run matrix:

- solved rate stays **18/18 on both arms**. A cheaper run that does not fix the
  bug is not cheaper.
- token ratio ≥ **1.36×**.
- TTFT ≤ **3,828 ms**, wall ≤ **29.4 s**.
- `npm run lint` and `npm test` clean in bundlebox.
- test files are hashed before and after every run; a run that edits `test/` is
  void, not passing.

### G2 — cost must improve

Today the packed arm costs **5.3% more** ($3.57 vs $3.39): the brief bills at
cache-creation rates while the bare arm's replay bills at cache-read rates. This
is the one number that is currently negative and the one the work exists to flip.

- packed cost per solved task must fall **below** bare's, not draw level.
- report cost per *solved* task, not per run, so a failed cheap run cannot
  flatter the number.
- W4 and W9 are the direct levers: a cached prefix bills at 0.1× instead of
  1.25×. W1 is the indirect one, since a turn removed is a replay not billed.

### G3 — experience and operations

- `bb slop` clean on every brief template that ships.
- the brief stays readable by a person: a reviewer must be able to see what the
  agent was told without reading the emitter.
- `bb pinpoint` stays at 0 model tokens and under 1 s.
- `bb session` records the same MEASURED / ESTIMATE split it does now; no new
  number enters the ledger without its provenance.
- every claim in the README that quotes a multiple names the arm, the cap and
  the tree it came from.
- no work item introduces a dependency on a harness, an agent or a model. A
  brief must stay plain markdown that any of the seven agents in `bb agents`
  can be handed, and `bb pinpoint` must keep working with no model reachable at
  all. A vendor release must not be able to break bundlebox or silently change
  its numbers.
- the six defects in `bench/` are fixtures, not Claude fixtures. Re-running the
  matrix against a second agent is the check that the independence is real
  rather than stated.

## What to retire

The `--cap 25` number and the 100× framing. `bb bench`'s bare arm reads the top
N files whole; widening the cap inflates the strawman rather than sharpening the
comparison, which is why the ratio climbs 4.9× → 19.6× as the cap opens. Anyone
who instruments a real run finds 1.36× in an afternoon, and that costs more
credibility than the multiplier buys.

Also retire the 10–20× target. It assumed W2 and W3, and both are gone. The
number this plan is accountable for is **3.04× at three turns**, plus whatever
W8 measures on a real tree.

Fix `bb bench` itself: model the bare arm as an agent that greps and reads
ranges, not one that opens files whole. The measured bare arm read 16 tokens of
fresh input across 18 runs — the current model is not wrong by a little.

## What this does not settle

- Whether W1's proposed diff helps or hurts. A wrong diff is worse than none,
  and only the solved rate answers it.
- Whether three turns is reachable at all. F2's table is arithmetic, not a
  measurement; it assumes movable context per turn stays at 12,026.
- Whether any of this holds on another model, agent or harness. Every number
  here is of one pairing — Claude Code driving `claude-sonnet-5` — not of
  bundlebox. bundlebox is independent of all three; its measured numbers are
  not, and a second pairing is the only thing that separates them.
- The 19,240-token floor is Claude Code's today, and a release can move it.
  Every ratio here moves with it, which is the reason the harness is off limits.

## How to verify

```bash
cd bundlebox-projects/bench
node verify.mjs                      # every seeded defect still breaks its own test
BENCH_REPEATS=3 node run.mjs         # 36 runs, resumable, ~$7
node summarise.mjs                   # the table above, rebuilt
```

The harness is resumable: a run already in `var/runs.jsonl` is skipped, so a
killed job costs nothing. Temp trees are process-unique — two concurrent jobs
raced and corrupted a matrix once already, and those rows were discarded rather
than reported.
