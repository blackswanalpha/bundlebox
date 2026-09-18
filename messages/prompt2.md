# prompt2.md — grapple: the handoff layer, and the gate that proves it earned its place

What to build, where each half lives, what to reuse instead of rebuild, and the
measurement that decides whether it stays. Nothing here is landed. Every
threshold below is declared before the work, not a result. The board counts were
measured on 2026-09-18 from `.bundlebox/var/findings.json`.

## Constraint: grapple does not break what makes bundlebox bundlebox

`bundlebox` derives artefacts on disk, calls no model, owns no agent loop and
binds to no vendor. grapple is the first subsystem whose subject is the *session
in flight*, so it is the first one that could break that. It must not.

- **No model call in `src/`.** Every grapple detector is a set operation, a
  counter or a hash comparison over artefacts that already exist. The one
  mechanism that needs a judge (§ M6, selective verification) is a proposal the
  operator runs, never an outbound call grapple makes.
- **No hosted judge.** A decision API answers the same question on every scan
  and bills for each one. grapple asks once and stores the answer. The section
  below prices both.
- **No harness assumption.** grapple reads what `src/wire/hooks.js` already
  receives and writes what it already returns. It adds one event to that table
  and no new integration point.
- **No agent assumption.** Anything agent-specific stays in the flag stack under
  `src/wire/agents.js`. An agent with no stack still gets the brief, the scope
  fence and the ledger.
- **Plain files.** `.bundlebox/out/grapple/` is JSON and markdown. A question is
  readable without bundlebox open.

## What grapple is

One concern: **every point where the deterministic system hands off to a person,
and takes the answer back.** Not a bag of missing features. If a proposed
mechanism is not a handoff, it does not go here.

Three gaps it closes, in the order they pay:

1. **Intent.** Briefs already print "what this brief does not settle", and then
   nobody asks. Every unsettled item is guessed or silently narrowed. A session
   is ~175k tokens; a question inside an open session is under 1k. The queue is
   the cheapest mechanism in the design.
2. **Agreement.** Two lanes can derive overlapping work and review pays the
   merge. Lane scope lists already exist in every pinpoint brief, so the
   collision is a set intersection at route time, at zero cost.
3. **Adoption.** `lathe` emits, `uptake` measures, `recom` gates, and nothing
   connects them. grapple's event log is the missing input: it is the record of
   what the box did by hand more than twice.

## What was measured

The board holds 994 rows, 793 of them open, across 33 detectors.

| precision | rows | what the row is |
|---|---|---|
| `exact` | 771 | a set difference or a parse; no judgement available to make |
| `heuristic` | 218 | a question a regex cannot answer |
| `probe` | 5 | a check that ran and saw |

The 218 are 6 detectors: `swallowed-errors` 82, `dead-exports` 80,
`missing-tests` 30, `silent-fallback` 19, `orphan-files` 4, `ui-generic` 2. Each
asks whether the swallow was deliberate, whether the export is public API,
whether the missing test was a choice. **That set is grapple's whole subject.**
The other 771 rows need no handoff, and a mechanism that asks about them is
spending attention on arithmetic.

## grapple is the judge, and the alternative is a subscription

A hosted decision model returns a calibrated prior over those 218 questions. The
person who wrote the swallow knows the answer. grapple asks the one who knows, so
its output is a label rather than an estimate, and it arrives with a reason
attached — which is what `bb explain` prints and what a model trained to return
typed decisions cannot produce.

The economics separate harder than the accuracy does. `bb cron` scans this
workspace every thirty minutes, so a hosted judge re-answers all 218 questions 48
times a day, at roughly $26 a month for one repository at published prices.
grapple's `store.js` is keyed like `findingId`, so each answer is given once and
held until the code under it moves. One is a subscription; the other is an asset
that outlives the session that produced it.

The same split is why **no reward model** appears under *What not to build*. The
occurrence of an override is already the signal, and a second estimator over the
same rows adds a number nobody can argue with in place of an answer somebody
gave.

## The corpus grapple exists to produce

grapple has a second output beyond the handoff, and it is the one the rest of the
box is blocked on. Fitting a promotion policy needs labelled findings. This tree
has 15 labelled `acted_on` by the #45 backfill, and `confidence.py` cannot move
`PRECISION` off its typed constants on 15 positives.

Every answered question is a label. The queue is therefore the label source for
`triage-calibrate`, and the volume it produces is a reportable number, not a side
effect. A grapple that closes handoffs and produces no labels has done half the
job it is capable of.

## The split: JS owns files and the loop, Python owns scoring

`expert/bundlebox_expert/__init__.py` already fixes the contract — stdlib only,
one JSON object on stdin, one on stdout, and the Node side owns the store and
the config. grapple follows it exactly.

**JS decides *whether* and *when*. Python decides *how much*.** If a thing
touches the filesystem, the hook payload or the CLI, it is JS. If it is
arithmetic over rows that JS already loaded, it is Python.

`python()` in `src/core/expert.js:14` returns `null` when no interpreter ≥3.9 is
found. **grapple must be fully functional with Python absent.** Without it the
rankings fall back to a documented total order (severity, then rework cost, then
path) and the drift score falls back to the raw counters. Nothing refuses to run.

## Files to add — JS, under `src/grapple/`

| file | holds | tier |
|---|---|---|
| `index.js` | verb dispatch: `bb grapple observe / ask / ratify / status / promote` | — |
| `store.js` | append-only event log + answer store, two key shapes | 0 |
| `detect.js` | scope intersection, drift counters, TTL expiry, no-progress | 0 |
| `ask.js` | question emission, answer recording, fingerprint expiry | low |
| `ratify.js` | batched proposals, confirm/reject, recorded disposition | 0 |
| `harvest.js` | labels nobody was asked for: closures, and edit-conditioned survival | 0 |
| `promote.js` | the lathe pipe: grapple events in, lathe proposals out | 0 |

One change outside the directory: add a **`pre-write`** event to `EVENTS` and
`CAPS` in `src/wire/hooks.js:22`. Budget it in the same class as `pre-read`
(900). `pre-write` is the only blocking check grapple adds, and it fires at the one
moment the agent has committed nothing.

**Answer keys, and why one is not enough.** `findingId` at
`src/core/store.js:213` is `sha1(detector|path|key)`. An intent answer takes the
same shape — `sha1(brief-id|unsettled-key)` plus the repo fingerprint it was
answered against — and expires when the fingerprint moves. Without that the same
question is asked once per session and the cost argument decays to 1:1.

A second key is what makes the throughput arithmetic work. An answer about a
*pattern* is keyed `sha1(detector|normalised-shape)` and carries no path, so it
reaches every row of that shape and survives the file it was first seen in. Both
key shapes live in `store.js` and a question declares which one it is asking
under. An instance answer never generalises and a pattern answer never expires
on a single file's fingerprint.

## Files to add — Python, under `expert/bundlebox_expert/`

One module, `grapple.py`, registered as a verb in `__main__.py`. Four functions,
each one JSON in and one JSON out:

- **`rank(items)`** — expected value of asking. For each unsettled item, the
  disambiguation value against the cost of asking, so the queue is ordered and
  the tail is dropped rather than asked. Suppress items whose answer is already
  in the store under a live fingerprint, and items a pattern answer already
  covers.
- **`propagate(answer, rows)`** — carry one pattern answer across structurally
  similar rows, with confidence decaying by distance. Propagation is what turns
  one answer into N labels, and it reads the fitted similarity rather than
  inventing a fourth one.
- **`drift(window)`** — score one transcript window for off-task and
  no-progress: repeated low-information calls, turns since last edit, scope
  delta against the brief. Returns a score and the signature that produced it,
  because the signature is what `promote.js` later feeds to lathe.
- **`promote(events)`** — whether a repeated pattern has earned a rule.

### Reuse `confidence.py`, do not write a second threshold

`confidence.py` already holds the exact machinery `promote` needs.
`SHRINKAGE = 4` with the blend at `settled / (settled + SHRINKAGE)` is the
documented answer to "three samples cannot override the method" — which is
precisely the risk in promoting a judgement from three occurrences. `value()`
already collapses severity, confidence and cost into expected severity-points
per 100k tokens, which is the EV unit `rank` needs.

Writing a new constant for either is the failure mode this section exists to
prevent.

## Cold start: what a workspace knows before anybody is asked

A fresh workspace has no answers, and the shipped constants are all it gets.
Three sources close that, none of them a network call.

**C1 — backfill from git before grapple ever ran.** Run the detector set at a
commit six months old, then ask git whether each finding's path later changed in
a way that removed it. #45 rejected this construction for live windows with a
number: 128 of 201 closure windows contained no commit at all, because work sits
in the working tree for hours. That objection is about thirty-minute windows.
Over a six-month historical window the blind spot mostly closes, and a repository
with history yields labels on turn one.

**C2 — ship a fitted prior instead of three typed constants.** `for_rule()` is
already the right structure: a base prior moved toward local hold-rate at
`settled / (settled + SHRINKAGE)`. The base today is `exact` 0.95, `probe` 0.80
and `heuristic` 0.60, three numbers covering 33 detectors. One fitted number per
contested detector, pooled across the repositories bundlebox has run in and
shipped in the package, gives a cold workspace a measured prior instead of a
guess. Six numbers, because six detectors are contested.

**C3 — cold start affects 22% of the board.** The 771 exact rows are correct in
a repository nobody has seen. The problem is bounded and it is worth stating,
because the same bound prices every alternative to solving it.

## Throughput: change the unit, not the rate

grapple can ask one or two questions per session before it stops being a queue
and starts being an interruption. 218 rows at that rate is months, and some of
them expire by fingerprint first. The rate is not the lever.

**T1 — ask per pattern, not per row.** 82 of the 218 are `swallowed-errors`. One
question about the shape settles dozens, and the pattern key in `store.js` is
what lets the answer reach them. `lathe` already clusters on "done by hand more
than twice", which is the same operation.

**T2 — propagate by similarity.** `propagate()` carries a pattern answer across
structurally similar rows with confidence decaying by distance. One answer must
become N labels or the arithmetic never closes.

**T3 — harvest the answers nobody was asked for.** 39 of the 218 contested rows
are already `resolved`. Those are labels today, at zero questions, and it is more
than twice the 15 `acted_on` positives the tree has been fitting on.

The tempting negative is wrong and the board says so. Median `seen_count` on
those rows is 70 and the maximum is 185, but `first_seen` spans four days: at 48
scans a day, 185 sightings means the finding survived from Monday to Thursday,
and four days of survival is not evidence that something is not a defect. The
construction that holds is survival **conditioned on the file being edited in
between** — somebody was in that file, changed it, and left the finding. That is
what `harvest.js` computes, from `witness` and git, and it costs no questions.

**T4 — batch, and route to contact.** `ratify.js` emits ten yes/no rows in one
proposal rather than ten interruptions: one decision moment, one recorded
disposition. Route by the files the session already has open, which `uptake`
records, because a question about code already in somebody's head costs almost no
attention.

Together: 39 rows are labelled now, six pattern questions cover the six
detectors, similarity carries those answers across the rest, and edit-conditioned
survival supplies negatives without asking anything. The queue asks tens of
questions rather than 218.

## What to reuse elsewhere, not rebuild

- Scope lists for the collision check: already emitted by `src/pinpoint/index.js`.
- Gate as oracle: `LEDGER()` at `src/finish/index.js:38`.
- Similarity for `propagate`: the fitted scorer, not a fourth hand-weighted one.
  Three already exist at `src/janitor/heap.js:90`, `src/bench/gate.js:71` and
  `arc/src/echos/converge.rs:24`.
- Rule retirement: point `lathe` at the override log. An override log is "done by hand
  more than twice" applied to a different table. Do not write a separate mechanism.
- Reach and retention of a promoted rule: `uptake` and `recom`, unchanged.

## What not to build

Named here so the work is not spent on them:

- **No quorum, no cross-check waves, no merge quorum.** Set intersection over
  scope lists answers the same question at zero cost.
- **No interrupt/resume checkpointing.** On resume a checkpointed node restarts
  from the top and re-executes what ran before it, which in bundlebox terms
  re-injects the brief and its quoted regions — a tier-0 mechanism turned into a
  ~30k re-spend per interrupt. Course-correct by injecting into context instead.
- **No reward model for override learning.** The occurrence of the override is
  the signal. Counting per `findingId` class is sufficient.
- **No hosted judge on the scan path.** 218 questions re-asked 48 times a day is
  a recurring bill for an answer grapple stores once, and the answer comes back
  without the reason that makes it usable in `bb explain`.
- **No second queue.** Specification uncertainty (what the operator wants) and
  model uncertainty (the agent is confidently wrong) are different channels with
  different triggers, but they share one store and one CLI surface.

## Phase 1 — observe only

Every detector runs. Nothing blocks, nothing is injected, nothing is asked.
grapple records what it *would* have done, and `harvest.js` runs for real,
because reading closures and edit-conditioned survival changes no session
behaviour and produces the base rates phases 2 and 3 need.

Observe-only is not caution. Every threshold in phases 2 and 3 needs a base rate that
does not exist yet: the real wrong-guess rate on unsettled items, the real
collision rate between lanes, the real drift frequency. A threshold set by guess
is a rule that is wrong identically in every session and arrives labelled as
fact at 0 tokens, which is the worst failure this repository can produce.

**Gate for phase 1:** `npm run lint`, `npm test`, and grapple changes no
observable session behaviour. Token delta per session must be **0**, because
nothing is injected. If the delta is not 0, phase 1 is not done. The harvest
reports its label count with `n`, and a count below the floor reports `unknown`
rather than a rate.

## Phase 2 — enforce, one blocking check

The `pre-write` scope guard refuses a write outside the brief's scope list and
returns a bounded message within its `CAPS` budget. Drift trips inject a
course correction asynchronously. The ask queue emits, pattern questions first.

**Gate for phase 2:** first-attempt gate pass rate rises and tokens per accepted
unit does not. Both measured through `src/bench`, the arms being bundlebox
without grapple and with it, on the same seeded-defect tree and the same three
repeats per cell already used for the numbers in `messages/prompt/prompt.md`.

If first-attempt pass rate does not move, phase 2 is ceremony and comes back
out. Declaring the gate first is what makes that removal decidable.

## Phase 3 — the lathe pipe

`promote.js` reads the grapple event log and emits lathe proposals:

- A clarification asked and answered identically across enough units, weighted
  by `confidence.py`, was never uncertainty. The answer was a decidable fact nobody
  encoded. Emit the detector. **Proposal only — ratify before it lands.**
- An override recurring against one `findingId` class retires that rule. May
  auto-apply.
- A drift signature recurring becomes a monitor dimension fitted to this
  workspace rather than a generic list. May auto-apply.

**The blind spot to keep open.** lathe can only promote from what grapple
recorded, and grapple only records what it detected. A failure mode with no
detector produces no events, so no rule is ever promoted for it and the monitor
set narrows toward what is already watched. Selective verification sampling must
stay outside this pipe. A test asserts it: a seeded failure class with no
detector must still be sampled after N promotion rounds.

## Tests

### JS — `test/grapple.test.js`

1. **Store identity.** Same brief, same unsettled key, same fingerprint yields
   one answer record, not two. Fingerprint moves, the answer expires and the
   question is askable again.
2. **Two key shapes.** A pattern answer reaches a row in a file it has never
   seen; an instance answer does not reach a second path. A fingerprint move
   expires the instance answer and leaves the pattern answer standing.
3. **Collision detection.** Two lane scope lists with a shared file are flagged;
   disjoint lists are not. Zero model calls, asserted by spy.
4. **Scope guard.** A write inside the brief scope passes; outside it is refused
   and the message fits the `CAPS` budget for `pre-write`.
5. **TTL.** An unanswered question past its TTL lands in an explicit
   expired-unanswered state, distinct from answered. Review must be able to tell
   them apart; a test asserts the two states never collapse.
6. **Harvest is conditioned, not counted.** A finding with a high `seen_count`
   whose file was never edited produces no label. The same finding with commits
   touching its path in the window produces one negative.
7. **Observe-only is inert.** With phase 1 config, no hook returns a decision
   and no bytes are injected.
8. **Degradation.** With `BB_PYTHON` pointing at a binary that cannot satisfy
   the ≥3.9 probe and no other interpreter resolvable, every grapple verb still
   exits 0, the queue is still ordered by the documented fallback, and nothing
   refuses to run.

### Python — `expert/tests/test_grapple.py`

1. `rank` is a total order with no ties on distinct inputs, and suppresses items
   with a live stored answer or a covering pattern answer.
2. `rank` returns the same output for the same input across runs. No clock, no
   randomness, no environment read.
3. `propagate` at zero distance returns the answer's own confidence, and at
   maximum distance returns the prior. Neither end invents a number.
4. `promote` with three identical samples does **not** clear the bar that
   `SHRINKAGE` sets, and the test asserts against `confidence.py`'s constant
   rather than a literal copied into the test.
5. `drift` returns a stable signature for the same window, because
   `promote.js` groups on that signature.
6. Stdlib only. The module imports nothing outside the standard library, and the
   test asserts it.

### The measurement — does it improve bundlebox

Unit tests prove it works. They cannot prove it helps. The improvement claim is
an A/B through `src/bench` on the seeded-defect tree, reporting five numbers per
arm:

| metric | why this one |
|---|---|
| first-attempt gate pass rate | the only capability-independent signal in the system |
| sessions per accepted unit | what a rejected unit costs end to end |
| tokens per accepted unit | catches grapple paying for itself in injected bytes |
| questions asked ÷ reworks avoided | whether the queue is earning or just interrupting |
| labels produced ÷ questions asked | whether T1 and T2 are working, or the queue is asking per row |

**Report the arms, not a summary.** If first-attempt pass rate rises while
tokens per accepted unit rises further, grapple lost and the honest report says
so.

Run the same arms on a weaker model as well as a strong one. The expectation to
test, not assume: course correction depends on the model's ability to act on it
against a plan it has already committed to, so the weak arm may gain less than
the strong one. If so, the better lever is routing by measured pass rate per
unit kind, and that result belongs in the report.

## The ledger

Declared before the work, run after:

```
npm run lint
npm test
node scripts/test.js                 # grapple.test.js green
python3 -m pytest expert/tests/test_grapple.py
bb slop messages/prompt2.md
bb bench --arms bare,grapple         # five metrics, both arms, three repeats
```

Phase 1 is done when the first four pass, the session token delta is 0, and the
harvest reports a label count with its `n`. Phase 2 and 3 are done when the bench
arms say so, and not before.
