# prompt6.md — close the loop: from any statement to a verified scenario to a fix, and back

What `bb genesis practice` proved on 2026-09-20, what the recursive simulator
the question describes still lacks, which of it is buildable under the three
independences, and the gate that proves each piece landed. The practice numbers
are one live round on this workspace's `bb` world. The test counts are
`npm test` on the same day.

## Constraint: the same three independences prompt.md, prompt2.md and prompt3.md hold

No model, no harness, no agent, plain files, for every fact. Spend is allowed
in exactly one place, the actor, and it stays behind `bridge.enabled`, the daily
ceiling and the window guard. Nothing below adds a second place.

## What was measured

| measure | value |
|---|---|
| packs sent | 1 (`start-here`) |
| agent session | claude, 221 s, acceptance passed |
| scenarios written / kept / rejected | 1 / 1 / 0 |
| verifier board | 4 steps passed |
| coverage before → after | 96.6% → 96.6% |
| tests | 609, 0 failures; 3 new in `test/practice.test.js` |

Coverage did not move because the kept scenario runs `node bin/bb.js cookbook
check` and the plan wants the literal `bb cookbook check && bb cookbook run`.
The matcher is exact and the agent paraphrased. The miss is a fact about the
matcher, recorded, not a fault of the loop.

The base at 127.0.0.1:7788 was started by hand before the round. Nothing in
`practice()` starts it.

## The facts the work follows from

**F1 — the inlet reads prose only.** `readSource()` in `src/genesis/world.js:26`
takes a document path, `-` for stdin, or `--prompt`. A finding row, a ticket or
a crash report has no way in, and a finding already carries the three fields a
scenario skeleton needs: the path, the rule it contradicts and the evidence.

**F2 — the scenario language is three step kinds.** `do` is an HTTP call, `run`
is a command, `static` is a file assertion; `corpus.check()` refuses a fourth.
Nothing drives a browser, an emulator or a desktop app. `src/recom/artemis.js`
states the position: a phone driven from natural language is a model call per
step, and `bb recom gate` exists to avoid the drive.

**F3 — practice assumes the environment is up.** `verify()` in
`src/genesis/practice.js` reads the base from `persona.json` and runs. `up()` in
`src/runbook/lifecycle.js:45` starts a declared service and `wait` returns when
it answers, and practice never calls either.

**F4 — practice finds and stops.** A red step under a quoted rule becomes a
finding through `store.mergeFindings`. Compile, route and run exist and are
hand-gated: `run` spawns nothing without `--apply`, and the `pr` gear is dry.

**F5 — the gears are triggers, not a graph.** `on:` in `src/pipeline/gears.js`
is one of `cron`, `session-start`, `session-end`, `hand`. The `practice` gear is
hand-only and the built-in cron gears never spend, by the rule at the top of the
file: a tick has to be a gear that cannot do anything it would need permission
for.

## W1 — a finding, a ticket or a crash becomes a world

Add two inlets beside the document: `bb genesis --finding <id>` reads a row from
the store, `bb genesis --ticket <file>` reads a pasted issue. Both produce the
same world shape: one surface named from the path, one rule quoted from the
finding's `detail` or the ticket's body, one capability per command or route
the text names, and `unknown` for everything else. `world-derive` already does
the second half for prose. The first half is a field mapping.

- Where: `src/genesis/world.js`, `expert/bundlebox_expert/world.py`
- Expected: a `silent-fallback` finding produces a one-scenario plan whose
  skeleton asserts the fallback is not taken.
- Gate: `bb genesis --finding <id>` on this workspace's open findings yields a
  world with at least one capability for every row that names a route or a
  command, and `unknown` rows for the rest. `npm test` carries one fixture per
  inlet.

## W2 — practice brings the base up, and says when it could not

Before `verify()`, resolve the persona's base against `services.json`. When a
service declares that base, call `up()` and `wait`. When none does, the round
reports `no service declares <base>` and keeps every validated scenario as
`validated; not run`, which it already does today.

- Where: `src/genesis/practice.js`, `src/runbook/lifecycle.js`
- Expected: the live round above runs with no hand start.
- Gate: `test/practice.test.js` gains a case where the service is declared and
  down, and the round's report names the service it started.
- Risk: a service that starts and never answers. `wait` has a ceiling; the
  round reports the ceiling and rejects nothing on it.

## W3 — practice hands its findings to compile and route

After a round that kept a red-under-rule scenario, run `compile` and `route`
with `write: true` over the findings it merged, and report the lane. Running the
lane stays behind `bb run --apply`. The loop then ends with a packed, budgeted
unit rather than a row, and a person or W4 decides the spend.

- Where: `src/genesis/practice.js`, `src/compile/index.js`, `src/route/index.js`
- Expected: `practice.json` carries `units` and `lanes` per round.
- Gate: the report names the unit for the kept red scenario and `bb run` lists
  the lane, dry.

## W4 — one tick that may spend, declared as such

A gear field `spends: true`, refused on `cron` unless `bridge.enabled`,
`bridge.daily_budget_usd > 0` and `lanes.daily_budget_usd > 0` all hold. The
`practice` gear gains a fourth stage, `run --apply`, under that field. The rule
at the top of `gears.js` stays true in its letter: a tick cannot do what it
would need permission for, and the three keys are the permission.

- Where: `src/pipeline/gears.js`, `src/pipeline/spec.js`, `src/pipeline/runner.js`
- Expected: `bb pipeline run practice --apply` on a cron line closes one finding
  per tick inside the ceilings, and refuses with the missing key named when it
  cannot.
- Gate: `test/pipeline.test.js` proves the refusal with each key absent, and the
  run with all three present against the file adapter.
- Risk: the ceilings are measured at the next ledger fold, not at spawn. A tick
  that lands inside the fold gap can overspend by one lane. Report it in the
  ledger as `over_by`; do not pretend the gap is closed.

## W5 — the fourth step kind, deterministic

`ui` steps: `{"ui": "click #submit"}`, `{"ui": "type #email …"}`,
`{"ui": "expect text …"}`, executed by a driver the corpus declares in
`persona.json` (`driver: "playwright" | "adb"`), with no model between the step
and the action. Every selector and every expected string is written into the
scenario by the actor at practice time, once, and replayed for free afterwards.
Mobile follows the same shape over `adb` with resource ids, not screenshots.

- Where: `src/cookbook/expect.js`, `src/cookbook/engine.js`,
  `src/cookbook/corpus.js`, a new `src/cookbook/drivers/`
- Expected: a browser scenario runs in the js engine at zero tokens after the
  round that wrote it.
- Gate: one fixture page under `test/`, one scenario over it, green in the
  suite, and `corpus.check()` refusing a `ui` step whose driver is undeclared.
- Risk: a selector moves and the step reds about the corpus. A renamed route
  produces the same failure today, and the same lesson row records it.

## Measured and declined — do not re-open without new evidence

**Jev in the loop.** None of W1 to W5 is a classification. W1 to W4 are field
mappings, a call, and gates. W5 needs actions, and Jev returns no text. Its two
candidate seats are the corpus-versus-system verdict on a rejected scenario and
the pruning of lessons, both currently rules, both fractions of a cent. Reopen
after W3 has run for a month and the rule's misses are counted.

**A model-driven driver for W5.** ARTEMIS or an agent per step: ten minutes and
twenty-four thousand tokens per drive, recorded in `artemis.js`. The corpus is
replayed on every tick, which is the case this factory exists to make free.

**A second findings store for practice.** `mainboard/index.js` already refused
this: a finding in its own file is one compile cannot pack.

## Gates

### G1 — the three independences hold after every W

`bb pinpoint` at 0 model tokens and under 1 s. `python()` returning `null` falls
back to the shipped constants. No new network call outside the actor.

### G2 — every spend is one row

Each agent session lands as one `call` episode with `est_tokens`, `seconds` and
`useful`, as the live round did (`genesis:start-here`, 221 s, useful 1). A W4
tick that spends and writes no row is a failed gate.

### G3 — nothing here moves prompt.md's numbers the wrong way

Solved rate 18/18 on both arms, token ratio at or above 1.36×, TTFT at or under
3,828 ms. `npm run lint` and `npm test` clean.

## What this does not settle

- Whether the exact capability matcher should accept `node bin/bb.js x` for
  `bb x`. One instance, recorded above. Count before changing it.
- Whether a ticket's prose derives as well as a PRD's. `world-derive` was fitted
  on documents; tickets are shorter and angrier.
- How W4's fold gap should be closed. `over_by` reports it and does not close
  it.
- Whether `adb` resource ids are stable enough across builds for W5's replay to
  stay free. No corpus has run on a phone here.

## How to verify

```bash
bb genesis practice --rounds 1 --max 1 --run --spend    # one round, one session
bb slop messages/prompt6.md                              # this file
npm run lint && npm test
```
