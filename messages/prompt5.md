# prompt5.md — Jev's feature surface, and which of it this box can hold

What Jev is, feature by feature, and what each one implies here. Feature facts
are from `docs.typesafe.ai`, read 2026-09-18; the launch and training facts are
from public reporting of the 2026-09-15 launch and are not in the docs. Every
bundlebox line is from this tree. The cost arithmetic below is derived from the
published input price and this workspace's own scan cadence.

## Constraint: the same three independences the other four documents hold

No model, no harness, no agent, plain files. prompt4.md drew the line at a
fitted coefficient table, which stays local and deterministic. Jev is the other
side of that line: a hosted endpoint, priced per token, in the path of a decision
the box makes every thirty minutes. Nothing below changes that, and the work
items are written so the box still runs when the endpoint is gone.

## The feature surface

### Three question types, and the fields each returns

| type | answer fields | what it decides |
|---|---|---|
| `Choice` | `choice`, `probabilities`, `confidence` | one option from a defined set |
| `Score` | `score`, `legend`, `probabilities`, `confidence` | a position on ordered levels, and it may fall between two of them |
| `Noul` | `noul` | one probability from 0 to 1 that a statement is true |

`Noul` carries no `confidence` field. The probability is the whole answer, and a
value near 0.5 is the uncertain case rather than a separate signal.

### One request, many questions, evaluated in parallel

Question types mix freely in a single call, each question sees the same state,
and each returns under its own id. The docs state that "adding questions barely
changes the response time." The budget is around 32,000 tokens for the state and
the questions together, roughly 150,000 characters.

One question's answer never becomes context for another in the same request.
Chaining two judgements means two round trips, or an arithmetic combination the
caller performs in its own code.

### Confidence as a second axis

`confidence` is a statistic computed from the probability distribution and
collapsed to one number from 0 to 1: concentrated means confident, spread means
uncertain. The number summarises the distribution and is not one of its entries.
The documented pattern is three
bands — act, proceed with caution, do not act — and its example uses a 0.5 floor
for genuine uncertainty and 0.9 before a high-stakes irreversible operation.

### RLCD

Reinforcement Learning for Calibrated Decisions: the probabilities are optimised
against outcomes rather than against what a human rater preferred. The docs carry
the caveat that matters more than the claim: **"Calibration is measured across
groups of predictions; it does not guarantee that an individual answer is
correct."**

### What it will not do

"System One models do not write replies, produce code, or generate explanations."
The model cannot explain its decision. Input is text only — strings, JSON objects
and arrays of text; no images, audio or video.

### What it costs

$42 per billion input tokens, published. Reported end-to-end latency is 70–500 ms
and a 0% structured output error rate; neither figure appears in the docs. The
landing page claims 193.6× faster and 444.6× cheaper than an LLM on System One
tasks, which nobody here has reproduced.

## The three facts the work follows from

**F1 — every field above already has a constant standing in for it.** `Noul` is
`PRECISION` at `expert/bundlebox_expert/confidence.py:11`, 3 numbers keyed by
method. `Score` is `ambiguity()`, 8 signals whose weights sum to 17. `Choice` is
the model tier in `triage()`, which picks `opus` on `critical-always` and
otherwise reads a config floor. `confidence` is `for_rule()`, blending toward
observed hold-rate at `settled / (settled + SHRINKAGE)` with `SHRINKAGE = 4`. The
shapes match; what is missing is that none of the four was fitted.

**F2 — the one feature the box cannot accept is the absent explanation.**
`bb explain <id>` prints the derivation, `triage()` accumulates `steps` for
exactly that, and `expert/bundlebox_expert/triage.py` calls itself "the
authoritative, explainable copy" with `_fired` as the derivation. A model that
by design cannot explain its decision cannot sit where that derivation is
printed. The probability may be better than the constant; it is not a derivation
and no wrapper makes it one.

**F3 — the calibration caveat is this box's own rule, arriving from outside.**
"Calibration is measured across groups of predictions" is what G2 already
demands: a figure ships with its sample size or it reports `unknown`. On this
tree the closure labels from #45 are 15 acted on, 69 vanished, 30 unchanged and
87 unknown. Fifteen positives is the corpus that any promotion decision, hosted
or local, would have to be judged on.

## W1 — write the question schema before making any call

Express the box's four recurring decisions as the three primitives, as JSON, in
the repository. Promotion is a `Noul`: is this finding one a maintainer acts on.
Ambiguity is a `Score` over the 8 signals' levels. Lane and model tier is a
`Choice`. Locate quality is a `Noul` per candidate file.

The schema is worth writing whether or not a call is ever made, because it is the
same input a local fitted head takes, and writing it settles what the features
are before the question of who computes the answer.

- Where: `expert/bundlebox_expert/`, as data beside `confidence.py`
- Expected: four typed questions with their option sets and level legends, and
  no network dependency introduced.
- Gate: `python3 -m pytest expert/tests` passes with the schema loaded and no
  client installed.

## W2 — the cost, computed before the decision rather than after

793 open findings at roughly 2,000 tokens of state each is 1.59M input tokens for
one full pass, which at $42 per billion is $0.067. `bb cron` scans this workspace
every thirty minutes: 48 passes a day, $3.20 a day, about $96 a month for one
repository. A box that ships to any repository multiplies that by every workspace
it runs in.

Batching helps the round trip and not the bill, because the budget is shared
between state and questions and the state is the large half.

- Where: this document
- Expected: the number is the argument. A hosted call on the scan path costs
  about $96 per workspace per month and the local constant costs nothing.
- Gate: none. Arithmetic, from a published price and a measured cadence.

## W3 — if a call is ever made, it is a label source with an expiry

The one use that survives F2: ask Jev the `Noul`, record the answer beside the
outcome, and fit the local head on the pairs. `triage.py:113 replay()` already
scores an alternative policy against the labels for free, and
`applyTriagePolicy` at `src/core/store.js:203` already stores a fitted policy per
repository. Jev supplies priors the tree does not have 15 positives to estimate;
the fitted head replaces it and the dependency ends.

- Where: `expert/bundlebox_expert/triage.py`, `src/core/store.js`
- Expected: a labelled corpus larger than 15 positives, and a local policy fitted
  on it.
- Gate: the box promotes findings with the endpoint unreachable, on the fitted
  policy or on the shipped constants, and `bb doctor` says which.
- Risk: labels from a model are not labels from the world. Keep them in a
  separate column from `acted_on` and never blend the two in one fit.

## W4 — measure calibration, since that is the feature being bought

RLCD's claim is that a stated probability matches how often it is right.
`expert/bundlebox_expert/model.py:67` already trains against that objective —
`g = _sigmoid(z) - e["useful"]` is the log-loss gradient — and then grades itself
at line 94 on holdout accuracy at a 0.5 threshold and AUC. Neither metric can see
calibration: AUC is unchanged by any monotone transform of the score, and
thresholded accuracy discards the probability before measuring it.

Add a Brier score, an expected calibration error and reliability bins to
`train()`, report them with `n`, and gate on them. Until that exists there is no
number with which to compare a hosted decision to a local one.

- Where: `expert/bundlebox_expert/model.py`
- Expected: a reliability table for every fitted head, and a comparison axis that
  does not currently exist.
- Gate: a head whose ECE is worse than the constant it replaces does not ship.

## W5 — randomise the two decisions whose action changes their own label

Promotion is replayable because promoting a finding does not change whether
somebody later fixed it. Two other decisions have no such independence. The hook
firing changes what the session does next, and the brief's "the only files you
may edit" makes an obedient agent edit in scope by construction, which
prompt3.md W1 names as the confound in its own methodology.

Fire against the gate's decision on a small random fraction of prompts and record
both arms. Exploration is normally the expensive part of this; here `bb pinpoint`
is 0.47 s and 0 model tokens, so a 5% holdout costs almost nothing and is the
only thing that turns those two decisions into a measurable number.

- Where: `src/wire/hooks.js`, `src/uptake/index.js`
- Expected: unconfounded labels for the hook gate and the locate.
- Gate: the randomised arm is recorded as such and is never mixed into a
  reported rate without its own `n`.

## Measured and declined — do not re-open without new evidence

**Jev on the scan path.** $96 per workspace per month by W2, a network dependency
in a loop that runs every thirty minutes, and an endpoint whose outage stops the
board. G3 forbids it and the arithmetic agrees.

**Jev inside `bb explain`.** F2. A decision that cannot explain itself cannot be
printed where a derivation is printed, whatever its probability is worth.

**Jev for the locate.** The state budget is about 32,000 tokens and a locate
ranks against 2,726 symbol rows. The question does not fit in the state, and
splitting it across calls prices the scan again per candidate.

**Jev as a second opinion on `anti-slop`.** The rules are fifteen and readable,
`bb slop` exits 1 as a gate, and a probability replaces a rule somebody can argue
with.

**Waiting for Jev before doing W4.** The calibration metrics are the axis on
which a hosted decision would be judged. They are 40 lines and they are the
prerequisite, not the follow-up.

## Gates

### G1 — nothing ships that moves prompt.md's numbers the wrong way

Solved rate 18/18 on both arms, token ratio at or above 1.36×, TTFT at or under
3,828 ms, wall at or under 29.4 s. `npm run lint` and `npm test` clean.

### G2 — every number here ships with its provenance

The feature table is quoted from the vendor's documentation and is a claim by its
author, not a measurement by this box. The latency and error-rate figures are
from reporting and are marked as such. The cost is arithmetic from a published
price, and the corpus it is computed against is 793 findings with 15 positives.

### G3 — the box keeps running with nothing reachable

`bb pinpoint` stays at 0 model tokens and under 1 s. `bb scan`, `bb findings` and
`bb triage` answer with the endpoint unreachable, on the shipped constants if no
policy was ever fitted. No artefact under `.bundlebox/out/` may require a network
call to rebuild.

## What this does not settle

- Whether a `Noul` beats `PRECISION` on promotion. Fifteen positives may not
  separate them, and W3 exists to grow that number rather than to assume it.
- Whether the published 70–500 ms holds from this network. Nobody here has made
  a call.
- Whether $0.066 per pass is the right estimate. It assumes 2,000 tokens of state
  per finding and no state shared between questions in a batch.
- Whether the confidence bands the docs suggest, 0.5 and 0.9, transfer to a
  finding corpus in which 448 of 793 rows are duplication-shaped.
- Whether any of the four decisions is better expressed as a `Score` than a
  `Noul`. W1's schema is the first place that question becomes answerable.

## How to verify

```bash
python3 -m pytest expert/tests      # the schema loads with no client installed
bb explain <id>                     # the derivation this document protects
bb findings --json | wc -l          # the corpus the cost is computed against
bb slop messages/prompt5.md
npm run lint && npm test
```
