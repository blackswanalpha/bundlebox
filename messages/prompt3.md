# prompt3.md — measure the tick, not the index

What to add to `bb cron`'s thirty-minute tick, why each item earns its place, and
the gate that proves it landed. Every number below was measured on this tree on
2026-09-18 by the verb named beside it. Nothing here is landed.

The question this came out of was whether `arc/` could act as an automated
workhorse. It already is one, in the two jobs its cost structure justifies, and
the open work is in the tick that calls it — not in a new index.

## Constraint: the same three independences prompt.md and prompt2.md hold

No model call in `src/`. No harness assumption. No agent binding. Every item
below is a join, a counter or a threshold change over artefacts already on disk,
and each one must keep working with nothing reachable.

`messages/prompt.md` owns the prefill work (W4, W5, W6, W9: brief ordering,
policy prose, output per turn, shared preamble). This file does not restate it.
Those items move TTFT and wall clock. These move what the box knows about its
own accuracy.

## What was measured

| what | number | verb |
|---|---|---|
| open findings | 791 | `bb findings` |
| of those, duplication-shaped | 448 (254 `duplicate-blocks`, 194 `oversight:duplication`) | `bb findings` |
| of those, needing reference data | 1 (`dead-config`) | `bb findings` |
| echos pass | 8,151 events, 30 sessions, 12 ms, answered by `arc` | `bb echos` |
| tool calls per turn | 1.03 over 4,670 turns across 26 sessions | `bb echos` (batching) |
| worst session | 452 calls over 452 turns, 1.00 per turn | `bb echos` (batching) |
| briefs on disk | 52 | `.bundlebox/out/pinpoint/` |
| briefs with linked edits | 0; `stray` needs 2 and returns `unknown` | `bb echos` (stray) |
| scope convergence | 0 consecutive pairs at or above 0.95; 3 needed | `bb echos` (converge) |
| agents installed and verified | 4: claude, codex, gemini, opencode | `bb agents` |
| environment artefacts | 9 of 9 present, every one under 1 h old | `bb env` |
| compiled index | 107.3 kb | `bb env` |

## The three facts the work follows from

**F1 — the box measures the code and does not measure its own aim.** Twenty-six
detectors score files. Nothing scores whether a locate was right. `ambiguity()`
has eight signals and every one is a presence or count test: `no-location` fires
only when `!b.symbols?.length && !b.grep?.length`, so a locate that matched
three irrelevant symbols reports no ambiguity at all. On the prompt that produced
this file the hook returned `src/adapters/index.js`, `src/git/commit.js` and
`src/run/runner.js`, matched off the words "prompt" and "message". Neither
`no-location` nor `thin-statement` fired.

**F2 — a board nobody can close is a board nobody reads.** 448 of 791 findings
are duplication-shaped, at 8–23k tokens of scope each. Deduplicating two 40-line
windows means choosing an abstraction and deciding where it lives, which no
actuator will ever do — `src/actuators/index.js` declines rather than guess, and
declining is the correct behaviour. The rule is producing rows with no close path.

**F3 — every turn is a full replay, and the box runs at one fact per turn.** 1.03
tool calls per turn over 4,670 turns. `messages/prompt.md` measured 91.5% of the
bare arm's tokens as cache reads; batching is the same waste seen from the other
side. Two independent calls in one turn cost one replay, apart they cost two.

## W1 — locate-replay: score the locate against what was edited

The labels already exist. `Event` in `arc/src/echos/mod.rs:44` carries
`kind: "brief"` with `scope: Vec<String>`, and `kind: "edit"` with `file` and
`hash`, both keyed by `session` and `at`. Join a brief to the edits that followed
it in the same session and every locate the box has made has a ground truth.

The scorer already exists. `expert/bundlebox_expert/confidence.py` blends a
method's supported precision toward observed hold-rate at
`settled / (settled + SHRINKAGE)`, so three samples cannot override the method
and zero samples report neither 0 nor 1. `PRECISION` gains a `lexical` key and
`for_rule()` output becomes the ninth ambiguity signal.

The harness pattern already exists. `triage-replay` and `triage-calibrate` are
shipped verbs; #45 built the promotion simulator and the labels to feed it.

**The confound is the whole methodology.** The brief says "Scope — the only files
you may edit", so an obedient agent edits inside the scope by construction and
precision reads high for a reason unrelated to the locate being right. The signal
is only in the exceptions: edits outside scope, files pulled from the `cut` list,
and candidates opened under the "say which one you opened and why" rule. Score
those rows. Filter reverted edits with the `hash` field, the way `oscillate` and
`drift` already do — a file changed and changed back is a wrong turn, not a
target.

- Where: `expert/bundlebox_expert/` (new verb), `src/pinpoint/ambiguity.js`
- Expected: a baseline precision and recall for the lexical locate, printed with
  its sample size, over the exception rows of 52 briefs.
- Gate: the number ships with `n` beside it, and a run with too few exception
  rows reports `unknown` rather than a figure. Rule 2 of the echos doctrine.

## W2 — recalibrate the throttle so the board has a close path

`expert/bundlebox_expert/throttle.py` has four limits in `cfg.expert.throttle`:
`max_promotions`, `max_tokens`, `per_detector`, `cooldown_runs`. `per_detector`
exists so one noisy detector cannot spend the whole budget on itself, and
`duplicate-blocks` has 254 rows on this board. The limit is not holding.

Either raise the `duplicate-blocks` window past 8 lines until the rows it
produces are ones somebody would act on, or stop promoting it and let it report
as a count. A tree whose own detectors are structurally similar will always
produce these rows.

- Where: `.bundlebox/config.json`, `expert/bundlebox_expert/throttle.py`
- Expected: 791 findings down to a board where every promoted row has a close
  path — an actuator, or a named person-sized change.
- Gate: no detector contributes more than `per_detector` after the change, and
  the suppressed count is printed rather than silently dropped. A finding that
  stops being promoted must still be countable.

## W3 — composite verbs for the situations echos already names

At 1.03 calls per turn the cheapest available win is a verb that answers a whole
situation in one call, and the situations are already named by the echos: a
`spin` hit is a session re-asking one question, a `drift` hit is investigation
with no edits, `bb env` already knows which artefacts are missing. `bb pinpoint`
is the proof the shape works — it replaces an entire search phase in one call.

- Where: `src/console/`, the verb registry
- Expected: the three or four situations that occur most across 30 recorded
  sessions each answerable in one call.
- Gate: measured, not asserted. `bb echos` re-run after the verbs ship must show
  calls-per-turn above 1.03. If sessions do not use them the number will not
  move, and the verbs are not the fix.

## W4 — the second-agent matrix

`bb agents` reports claude 2.1.276, codex 0.111.0, gemini 0.39.1 and opencode
1.18.31 installed and verified on this box. The levelling claim — that a brief
compresses the spread between models by moving work from search and judgement to
a named edit against a named gate — has never been run against a second pairing.

`messages/prompt.md` G3 already committed to this: the six defects in `bench/`
are fixtures, not Claude fixtures, and a second agent is the check that the
independence is real rather than stated.

**The fixtures are the blocker, not the harness.** Both arms solve 18/18 today,
so 1.36× is a token ratio with no quality difference to narrow. Levelling cannot
be demonstrated on a test everything passes.

- Where: `bundlebox-projects/bench/run.mjs`
- Expected: cells where the bare arm fails and the packed arm succeeds. If a
  weaker agent also goes 6/6 bare, the defects are too easy and harder ones are
  the prerequisite for every claim in this section.
- Gate: report solved rate per agent per arm. A ratio quoted without naming the
  agent, the cap and the tree does not ship.

## Measured and declined — do not re-open without new evidence

**Embeddings in `arc`.** A vector section would give a graded distance where the
index gives a boolean, and a distance is what `ambiguity()` lacks. Declined for
now because the baseline does not exist: W1 is the prerequisite. A general-text
embedding model may also rank `op_lookup` and `rev_at` worse than string
equality does, and that is untested.

**A reference index in `arc`.** Every snapgen table and both of arc's sorted
arrays are declaration-side; nothing answers "where is this name used", so
`usedElsewhere()` scans identifier sets and `basenames()` walks the whole tree.
Declined because it would unlock one finding on this board. 448 of 791 are
duplication, which no reference data closes.

**Env-based threshold tuning in `arc`.** Calibration belongs in `expert/`, which
already has `throttle`, `thresholds`, `triage-calibrate` and
`scenario-calibrate`. `arc` compiles an index and has no business deciding a
threshold. W2 is that work, in the right module.

**`arc` for TTFT.** TTFT is prefill of novel bytes. `arc` moves microseconds of
local CPU against a measured 3,828 ms, and the guard runs after first token, not
before it. The levers are in `messages/prompt.md`.

## Gates

### G1 — nothing ships that moves prompt.md's numbers the wrong way

Solved rate stays 18/18 on both arms, token ratio at or above 1.36×, TTFT at or
under 3,828 ms, wall at or under 29.4 s. `npm run lint` and `npm test` clean.

### G2 — every number here ships with its provenance

`bb session` keeps the MEASURED / ESTIMATE split. A figure without its sample
size, its threshold and the verb that produced it does not enter the ledger.
W1's baseline is the first test of this: it is a small-sample number and must
read as one.

### G3 — the box keeps running with nothing reachable

`bb pinpoint` stays at 0 model tokens and under 1 s. `bb cron --apply` keeps
9 of 9 artefacts fresh with no agent involved. No item above may make an
artefact depend on a model, a harness or a network.

## What this does not settle

- Whether the exception rows in 52 briefs are enough to say anything. W1 may
  report `unknown`, and that is a result.
- Whether `duplicate-blocks` at any window is worth promoting on a tree whose
  detectors are structurally similar by design.
- Whether composite verbs change agent behaviour. A verb that exists and is not
  called moves nothing, and no threshold here can force the call.
- Whether levelling holds at all. The claim is a prediction from the shape of the work —
  search and judgement vary between models, a named edit against a named gate
  varies less — and W4 is the first measurement of it.
- Whether `arc` is finished. The binary is finished as a workhorse under today's board.
  A board with a different shape would reopen the reference index.

## How to verify

```bash
bb env                               # 9 of 9 artefacts, every one under 1 h
bb echos                             # the eight hits and the two that say unknown
bb findings --limit 791              # the board this file is about
bb agents                            # the four verified agents W4 needs
```
