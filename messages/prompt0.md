# prompt0.md — wire the learning path before the documents that assume it

Four wiring gaps, what each one costs, and the command that proves it closed.
prompt2.md, prompt4.md and prompt5.md all assume a fitted policy is reachable
from a schedule. No schedule reaches one, and no code in any of them fixes
that. Everything below was measured on 2026-09-18 by `bb doctor`, `bb pipeline`, `bb cron`,
`bb cookbook check` and `.bundlebox/var/calibration.json`.

## Constraint: a wiring fix adds no mechanism

Every verb named here is already shipped. `triage-calibrate` and
`scenario-calibrate` are registered in `expert/bundlebox_expert/__main__.py`,
`cookbook run` is a gear step, and `bb cron --apply` already installs a crontab
entry. Nothing below writes a new detector, a new store or a new threshold. If a
change here needs a new file, it belongs in one of the other four documents.

## What was measured

`bb doctor`: 20 rows, 19 ok, one warn — "pipeline 9 of 11 stages hold; first
gap: scenarios". The kernel serves 11 of 11 ops, the window is at 4.8% of the
five-hour block, and `.bundlebox` holds 64.9 MB.

`bb cron` has one entry:

```
*/30 * * * * … flock -n … bb pipeline run factory --apply --quiet >> …/factory.log
```

`factory.log` is 0 bytes and dated 2026-09-15, which is `--quiet` with no errors
rather than a job that never ran: the 20:00 tick rebuilt `layout`, `routes` and
`docs` and refit the token calibration at 20:00:44 on 685 samples.

`.bundlebox/var/calibration.json` holds six keys — `tokens`, `calibrated_at`,
`fit`, `overhead_observed`, `overhead_tokens`, `churn_factor`, `fit_churn`.
**There is no `triage` key.**

`bb cookbook check`: two corpora. `bb` declares `base http://127.0.0.1:7788`
with 20 scenarios and 55 steps. `prompt` declares an empty base with 0 scenarios
and 10 surfaces. Nothing is listening on 7788.

## The three facts the work follows from

**F1 — the derivation path ticks and the learning path has no stage.** Every
gear on the cron entry reads the repository: intake, orient, measure, buckmaster,
watch. The only fitted thing among them is `tokens calibrate`, which estimates
cost and decides nothing. `applyTriagePolicy` at `src/core/store.js:203` has
never run in this workspace, so every promotion on a 793-row board is deciding
from the shipped `PRECISION` constants — 0.95, 0.80, 0.60 — while #45's replay
simulator and its 15 `acted_on` labels sit unused.

**F2 — a gear declared `on: cron` is not a gear on cron.** `scenarios`,
`situation`, `full` and `ops` all carry `on: cron` in their declaration.
`bb cron` installs one entry and it runs `factory`, which is intake, orient,
measure, buckmaster and watch. The declaration is an eligibility, not a
schedule, and nothing in `bb doctor` distinguishes "this gear is not installed"
from "this gear ran and failed".

**F3 — a stage that needs a live service is not a wiring gap.** The `scenarios`
stage at `src/pipeline/stages.js:107` asks whether the corpus has been run since
it last changed. `corpus_base` is 1, because `facts.js:51` returns 1 when *any*
corpus declares a base and `bb` declares one. So the gate opens, `cookbook run`
is eligible, and the service it would run against is not up. Reporting that as a
pipeline gap tells the reader the corpus was not run, when what happened is that
there was nothing to run it against.

## W1 — put `triage-calibrate` on `measure`

`measure` already ends `… → tokens calibrate → echos`. Add `triage calibrate`
beside it, gated on having enough labels: the verb already refuses and returns
the shipped policy when the corpus is too thin, which is the same contract
`scenario-calibrate` holds.

- Where: `src/pipeline/gears.js`
- Expected: `calibration.json` grows a `triage` key with its sample size, and
  `bb doctor`'s calibration row reports both fits rather than one.
- Gate: `bb doctor` prints a `triage` fit with `n` beside it, or prints that the
  corpus is too thin. A fitted policy with no sample count is a fail.
- Risk: fitting on 15 positives produces a number about 15 findings. The verb's
  existing floor is what stops that, and W1 must not lower it.

## W2 — install what is declared, or stop declaring it

Two ways to close F2 and they are not equivalent. Either `bb cron --apply`
installs a second entry for `full` on a slower cadence than thirty minutes, or
the gears that cannot run unattended drop `cron` from their `on:` list and read
`hand` only.

The second is the honest one for `genesis` and `audit`, which are hand verbs by
design. The first is right for `situation`, which is cheap and local.

- Where: `src/pipeline/gears.js`, `src/monitor/` (the cron writer)
- Expected: every gear carrying `on: cron` has a crontab entry that reaches it,
  and every gear without one says `hand`.
- Gate: `bb cron` lists an entry for each distinct cron gear, and `bb doctor`
  reports a gear that is declared-but-uninstalled as its own row rather than as
  a pipeline gap.

## W3 — gate the scenarios gear on reachability, not only on the base

The `situation` gear already guards on `[services > 0]`, and `services` is one of
the facts `facts.js` computes. The `scenarios` gear guards on
`[corpus_base == 1 and scenarios > 0]` and never asks whether the base answers.

Add the third term. A corpus run against a dead port is a board full of
connection errors, which is worse than no board: it reads as twenty failing
scenarios rather than one absent service.

- Where: `src/pipeline/gears.js`, and the stage's `exit()` at
  `src/pipeline/stages.js:107`
- Expected: with nothing on 7788 the stage reports `unknown` with the reason,
  the way it already does when no base is declared at all.
- Gate: `bb doctor` with the service down reports 10 of 11 stages and names the
  unreachable base. With the service up it reports 11 of 11 after one
  `bb cookbook run`.

## W4 — seed the `prompt` corpus or retire it

`prompt` has an empty base, 0 scenarios and 10 surfaces. It contributes nothing
to `cookbook run`, and it makes `bb doctor`'s corpora row read "2 corpus/corpora"
when one of them cannot be run. `corpus_base` survives its removal, because `bb`
declares the base that satisfies `facts.js:51`.

- Where: `.bundlebox/cookbook/prompt/`
- Expected: either 10 surfaces with scenarios written against a declared base, or
  one corpus on the board.
- Gate: `bb cookbook check` reports no corpus with 0 scenarios.

## Measured and declined — do not re-open without new evidence

**Running `full` every thirty minutes.** `factory` is described as "one tick of
the whole free path" and `scenarios` is not free: it needs a service up and it
writes a board. A cadence that assumes a running system produces a red board
every time the system is down, and a board nobody can trust is prompt3.md F2 in
a different table.

**Making `bb doctor` fix what it reports.** The fix lines are commands a person
runs. A diagnostic that repairs its own findings cannot be used to check whether
the repair worked.

**Adding a stage for `bb slop`.** It already runs as a gate on the documents it
governs and exits 1 on a hit. A pipeline stage would report prose quality as
infrastructure health, which is two boards for one fact.

## Gates

### G1 — nothing here changes what a session sees

Token delta per session is 0. No gear on the cron path emits into a hook, and
`bb pinpoint` stays at 0 model tokens and under 1 s. `npm run lint` and
`npm test` clean.

### G2 — every fit ships with its sample size

The `triage` key carries `n`, and a fit below the floor writes the shipped policy
with the reason rather than a number. `bb doctor` prints whichever is in force.

### G3 — the box keeps running with nothing reachable

With no service on 7788, no interpreter and no network, `bb scan`, `bb findings`,
`bb pinpoint` and `bb doctor` all still answer. A gear that cannot run reports
`unknown` and the tick continues to the next one.

## What this does not settle

- Whether 15 `acted_on` labels are enough for `triage-calibrate` to return
  anything but the shipped policy. W1 makes the verb reachable; it does not make
  the corpus thick.
- What cadence `full` deserves. Thirty minutes is wrong and the right number
  depends on how often the service is up, which nobody has measured.
- Whether `situation` is cheap enough for the cron path. It calls `runbook
  status` and `viewport build`, and neither has been timed on this tree.
- Whether the `prompt` corpus was meant to be seeded or was a scaffold. The
  directory does not say and git does not either.

## How to verify

```bash
bb doctor                            # 20 rows; the pipeline row is the subject
bb cron                              # one entry today, and what W2 adds
bb pipeline                          # which gears carry on: cron
bb cookbook check                    # two corpora, one of them empty
python3 -c "import json;print(list(json.load(open('.bundlebox/var/calibration.json'))))"
npm run lint && npm test
```
