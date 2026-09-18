# prompt4.md — abstain before you rank

What Needle 3 has that this box does not, which of it is buildable here, and the
gate that proves it landed. Needle 3 facts are from its README and release page,
read 2026-09-18. The localisation numbers are `bb bench swebench` on 2026-09-16,
12 instances and 16 gold files. The hook evidence is one session on 2026-09-18
and is n=3.

## Constraint: the same three independences prompt.md, prompt2.md and prompt3.md hold

No model, no harness, no agent, plain files. One line of it decides this
document: **a fitted coefficient table is not a model dependency.** `bb tokens
calibrate` already writes one to `calibration.json`, `src/doctor.js:107` prints
it with its sample count, and `expert/bundlebox_expert/model.py` already trains a
logistic regression by SGD and holds it out by time. Adding a second fitted head
is the same class of object as the first.

Shipping `needle3.cact` is not. The file is 8–29 MB of vendor weights at 2.125
bits per weight, a `pip install "cactus-needle[train]"` to tune, and telemetry on by
default in the binary — `NEEDLE_TELEMETRY=0` and `DO_NOT_TRACK=1` turn it off,
which means the default is a network call this box has never made.

## What was measured

| arm | recall |
|---|---|
| bare grep baseline | 31.3% |
| pinpoint, named as a candidate | 68.8% |
| pinpoint, budgeted into scope | 50.0% |

Ratio 64.5×, 98.5% saved, 12 instances, 16 gold files, no model called in either
arm.

The 8 in-scope misses split in two. **3 were named and not budgeted**: the locate
was right and the cut at `max_files=6` dropped it. **5 were never named**, and
they are not one kind of thing: `itrs_observed_transforms.py` is created by the
patch and does not exist at `base_commit`, `cds_parsetab.py` is a generated PLY
table, `builtin_frames/__init__.py` is a re-export barrel, and
`intermediate_rotation_transforms.py` and `io/ascii/rst.py` are ordinary source
files the lexical rank did not reach.

So the reachable ceiling on this sample is 15 of 16, and the gap that a better
ranking closes is 3 rows, not 8.

## The three facts the work follows from

**F1 — the box speaks when it has nothing to say.** `isTask` at
`src/wire/hooks.js:238` is `length >= 40 && TASK_SHAPED.test(p)`, a regex of 21
alternatives. In one session on 2026-09-18 it fired 3 times and all 3 were
questions about this design, not edits. Each fire emitted an edit scope and a
`npm run lint / npm test` gate: `src/cli.js:136 help` and `src/git/commit.js:32
message` off the words "help" and "message"; a 14-file scope reaching
`arc/src/echos/converge.rs` and `kernel/src/estimate.rs` off "features", "model"
and "similarity"; `src/pipeline/stages.js:244 gaps` off "gaps" and "prompt".
prompt3.md F1 recorded the same failure on the prompt that produced it. That is
4 instances and no counter, and n=3 is the number this ships with.

**F2 — every score in the locate path is a constant somebody typed.**
`PRECISION` in `expert/bundlebox_expert/confidence.py:11` is 3 constants keyed by
method. `ambiguity()` is 8 signals whose weights sum to 17, every one a presence
or a count test, so a locate that matched 3 irrelevant symbols fires neither
`no-location` nor `thin-statement`. `rank.js` carries `DECAY`, `EXPLICIT`,
`TEST_WEIGHT`, `MIN_TERM` and `INFORMATIVE`. `similarity()` is implemented 3
times — `src/janitor/heap.js:90` over term sets, `src/bench/gate.js:71` over
files then title words, `arc/src/echos/converge.rs:24`. None of them was fitted
and none reports a sample size.

**F3 — Needle 3's useful half is the confidence head, not the transformer.**
Four capabilities ship in that binary: tool calls, structured extraction, text
embedding, and a calibrated confidence on every response with an empty list
rather than a guess when nothing applies. The first three are classification over
closed sets here; only the embedding needs pretraining. The abstention contract is
already written in this tree, at the top of `model.py`: *"It refuses to steer
until it beats the base rate on the holdout; until then `predict` returns the
base rate and says so."*

## W1 — fit `isTask`, and let it return nothing

Replace the length-and-regex gate with a fitted binary head that reports a
calibrated probability, and emit no context below the threshold. The labels are a
join that already has both sides: the prompt the hook fired on, against whether
that session produced an `edit` event. `Event` in `arc/src/echos/mod.rs:44`
carries `kind: "brief"` and `kind: "edit"` keyed by `session` and `at`, which is
the same join prompt3.md W1 proposes for the locate.

`model.py` is the shape: `featurize()` serves training and prediction, SGD
trains, the holdout is by time, and it declines to steer until it beats the base
rate. Prompt features are cheap — length, the `TASK_SHAPED` hit as one feature
rather than the whole decision, imperative first token, a path or a symbol
present, a question mark, a bb verb named.

- Where: `src/wire/hooks.js`, `expert/bundlebox_expert/model.py`
- Expected: the 3 recorded false fires stop. No claim about the true-fire rate
  until the join runs.
- Gate: `bb uptake` reports fires and edits per session with `n` beside them, and
  a run below the sample floor reports `unknown` rather than a rate.
- Risk: a suppressed fire on a real task costs the session its locate. Threshold
  on the false-negative side and say which side it errs on.

## W2 — one calibrated confidence, four call sites

`PRECISION` is what a method can support and never moves; `for_rule()` blends it
toward observed hold-rate at `settled / (settled + SHRINKAGE)`. Extend
`featurize()` to triage features and the blend takes a third term: a per-finding
prior instead of a per-method constant. `value()`, `floor()` and the EV
arithmetic are untouched.

The harness is shipped. `triage.py:113 replay()` scores an alternative policy
against the `acted_on` labels from #45 for free, because promoting a finding does
not change whether somebody later fixed it.

- Where: `expert/bundlebox_expert/confidence.py`, `model.py`, `triage.py`
- Expected: a recall-minus-waste number for the fitted head against the shipped
  constant, on this workspace's own findings.
- Gate: it ships with its sample size, and it does not replace `PRECISION` unless
  it beats it on the holdout.

## W3 — graded distance without a foundation model

`ambiguity()` lacks a distance and the symbol index gives a boolean. An SVD over
the symbol × term matrix built from `symbols-*.md` gives one: 2,726 rows across
the five tables, deterministic, no weights to download. Co-occurrence is the
signal string equality cannot reach — `laneModel` and `assignCheckouts` are
related because they sit in `router.js` together, which no edit distance between
their names will ever say.

The distance is the ninth ambiguity signal, and it is the prerequisite W1 of
prompt3.md already named: the baseline comes first, the distance second.

- Where: `expert/bundlebox_expert/`, `src/pinpoint/ambiguity.js`, `src/pinpoint/rank.js`
- Expected: against the 3 named-but-not-budgeted rows, in-scope recall has 18.8
  points of room and a ceiling at named recall, 68.8%.
- Gate: `bb bench swebench --n 100` before and after. The current n=12 puts one
  instance at 6.25 points, which is larger than the whole predicted gain.

## W4 — one similarity, fitted, not three hand-weighted

`heap.js` states the constraint its version was written under: *"a merge decision
that costs an API call is a merge decision that never runs on a cron at 3am."*
That holds and this keeps it. Collapse the 3 implementations onto one scorer with
fitted weights over the features they each already compute — shared terms, shared
files, shared path prefix, title overlap — and keep the Jaccard as the documented
fallback when no fit exists.

- Where: `src/janitor/heap.js`, `src/bench/gate.js`, `arc/src/echos/converge.rs`
- Expected: one threshold to calibrate instead of three, and a merge rate that
  can be replayed.
- Risk: three call sites want different things from one number. If the fit cannot
  serve all three, keep three and say so in the report.

## What Needle 3 has that is not buildable here

Cross-vocabulary matching. `io/ascii/rst.py` is missed because the issue says
"RestructuredText" and no file in the repository ever writes that word, so no
co-occurrence over this corpus can learn the link. Pretraining on outside text is
the only source of it. On the sample above it is worth 1 gold file in 16, and it
is the one capability this document cannot replace with arithmetic.

The other three transfer as method, not as weights: abstention is a threshold on
a calibrated score, grammar-constrained output is free when the output is a
closed set, and the ladder from 2 to 20 layers is the same idea as declining to
steer until the holdout says otherwise.

## Measured and declined — do not re-open without new evidence

**Ship `needle3.cact`.** 8–29 MB of vendor weights, telemetry on by default, and
`pip install "cactus-needle[train]"` in the tune loop. What it uniquely buys is
the paragraph above: 1 gold file in 16. Reopen when W3 has run at n=100 and the
cross-vocabulary misses are counted rather than assumed.

**Needle 3 on `duplicate-blocks` or the sieve dedup.** Fuzzy matching turns an
exact set difference into a threshold and drops the detector from `exact` 0.95 to
heuristic. 448 of 791 findings are already duplication-shaped with no close path;
more of them is the wrong direction.

**Needle 3 on `anti-slop` or `ui-generic`.** Prose judgement from a 2-bit model
trades a rule a person can read for a score nobody can argue with.

**Needle 3 for TTFT.** Settled for `arc` already: local CPU against a measured
3,828 ms, and the guard runs after first token.

**Needle 3 to write prompt.md's W1 diff.** The turn lever is carrying the change,
and a 121M tool-caller does not write replacement regions. The floor is
`19,240 × (turns + 1)` and nothing here moves it.

## Gates

### G1 — nothing ships that moves prompt.md's numbers the wrong way

Solved rate 18/18 on both arms, token ratio at or above 1.36×, TTFT at or under
3,828 ms, wall at or under 29.4 s. `npm run lint` and `npm test` clean.

### G2 — every number here ships with its provenance

W1's evidence is n=3 from one session and reads as one. A head that has not
beaten its holdout reports the base rate and says so, which is what `model.py`
already does.

### G3 — the box keeps running with nothing reachable

`bb pinpoint` stays at 0 model tokens and under 1 s, measured at 0.47 s on this
tree. No weights are downloaded, no interpreter is required at run time, and
`python()` at `src/core/expert.js:14` returning `null` falls back to the shipped
constants rather than refusing to run.

## What this does not settle

- Whether 3 false fires in one session generalise. The join in W1 is the only
  thing that answers it, and it may report `unknown`.
- Whether an SVD over 2,726 symbol rows carries enough signal to move a rank. The
  matrix is small and sparse and no fit has been run on it.
- Whether the 3 named-but-not-budgeted rows are reordering failures or budget
  failures. They are counted together above and a cut-list replay separates them.
- Whether one fitted similarity serves three call sites. W4 assumes it and the
  fit is the test.
- Whether Needle 3's cross-vocabulary edge survives on code. Its benchmarks are
  mobile tool calls and field extraction, not symbol retrieval, and nobody here
  has run it.

## How to verify

```bash
bb bench swebench --n 100            # the localisation baseline, with n
bb slop messages/prompt4.md          # this file, against the fifteen rules
npm run lint && npm test
python3 -m pytest expert/tests
```
