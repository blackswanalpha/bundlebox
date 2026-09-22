# The non-inferiority trial

bundlebox does not claim to solve more tasks. It claims **the same work on less
context**: on SWE-bench Verified, 2.8k tokens against 8.7k for the same issue,
with the maintainer's own changed files in scope 64.3% of the time against
24.6% bare. A benchmark that asks "does it score higher?" is asking a question
the product does not answer, and a null result from it would be uninformative.

The question that matches the claim is: **does the smaller window cost you any
outcome?** That is a non-inferiority trial, and it is a different design from
the superiority run this directory was first scoped for.

## The hypothesis, fixed before the first trial

Let `p_bb` and `p_bare` be resolve rates on the same tasks, same model, same
scaffold.

    H0   p_bb  <  p_bare - M        bundlebox costs more than M of outcome
    H1   p_bb  >=  p_bare - M       it does not

Reject H0 and the claim is "3.1x less context, no worse than M". Fail to reject
and the honest sentence is "this run could not rule out a loss of M", which is a
result and gets published as one.

**M = 7.5 points, declared here, before any trial runs.** Not chosen to be
reachable: chosen because a tool that costs more than about one task in
thirteen is not worth its install, whatever it saves on tokens. Changing M after
seeing data invalidates the trial; if M is wrong, it is wrong now.

## Sizing

Both arms run the identical tasks, so this is McNemar's on the discordant pairs,
not two independent proportions. Tasks needed at 80% power, one-sided 2.5%, with
the true difference at zero:

| margin M | arms disagree 15% | 25% | 35% |
|---|---|---|---|
| 5.0 pts | 471 | 785 | 1099 |
| **7.5 pts** | **210** | **349** | **489** |
| 10.0 pts | 118 | 197 | 275 |
| 12.5 pts | 76 | 126 | 176 |

The discordance rate is unknown until a run happens. **DeepSWE has 113 tasks**,
which is not enough for M = 7.5 at any of these assumptions.

Three honest ways out, in order of preference:

1. **Run DeepSWE at k=3 attempts per task.** `pier run -k 3` gives 339 trials
   per arm off 113 tasks. Attempts within a task are correlated, so this buys
   less than tripling the corpus, but it is the cheapest real power available
   and it also measures per-task variance, which nothing here has.
2. **Widen M to 12.5 and say so.** 113 tasks support it at low-to-moderate
   discordance. The resulting claim is weaker and must be stated as such.
3. **Use SWE-bench Verified's 500 tasks instead.** Enough for M = 5. It needs
   the official harness and a Docker image per repository, which is a bigger
   build than `bench/deepswe/agent.py`, and its tasks are shorter-horizon.

**Do not** run the corpus, see the result, and then pick the margin that makes
it significant.

## The model

Not `claude-sonnet-5`, despite it being the obvious pick. On the published board
it is the worst row on both axes this trial cares about:

| model | score | $/task | tokens/task | steps | 226 trials |
|---|---|---|---|---|---|
| claude-opus-5 | 74% | $11.84 | 118k | 99 | $2,676 |
| claude-opus-4.8 | 59% | $13.22 | 135k | 120 | $2,988 |
| claude-fable-5 | 70% | $13.41 | 80k | 68 | $3,031 |
| claude-sonnet-5 | 54% | $26.40 | 214k | 268 | $5,966 |

`claude-opus-5` is cheaper **and** better: half the cost, twenty points higher,
118k tokens over 99 steps against 214k over 268. Use it. The scaffold here is
`claude-code`, so the model has to be a Claude one; within that set there is no
argument for anything else.

Those per-task figures come from `mini-swe-agent` on the public board, not from
`claude-code`, so treat them as an order of magnitude rather than a quote.

## What gets recorded

Per task, per arm, from the trial itself and not from anywhere else:

- `reward` (binary), `f2p_passed/f2p_total`, `p2p_passed/p2p_total`
- input tokens, output tokens, cache reads, dollars, steps, wall-clock
- whether the bundlebox arm called `bb_pinpoint` at all, and how often

That last one is a validity check, not a result. An arm that never called the
tool is not a bundlebox arm, and its trials are void rather than negative.

## Analysis, also fixed now

- **Primary.** Exact McNemar on discordant pairs; report the one-sided 97.5%
  lower bound on `p_bb - p_bare` against `-M`.
- **Co-primary, and the one the product actually rests on.** Input tokens per
  task, both arms, paired. Reported with its own interval, never combined with
  the outcome into a single score.
- **Reported whatever it says.** A confidence interval that includes `-M` is
  published as an inconclusive run at this sample size, with the sample size.
  No post-hoc subgroup, no dropping tasks that failed for "environment reasons"
  unless the failure is identical in both arms.

## Before spending anything

1. The account needs credit. The first attempt died on `"Credit balance is too
   low"` with a 0-byte patch and a `reward: 0` that measured nothing.
2. `pier run --agent oracle` on one task must return `reward: 1`. It did on
   2026-09-22, which is what makes the harness trustworthy here.
3. Disk: each task image is ~0.84GB compressed and ~2.8GB unpacked, and they are
   per-task with nothing shared. 113 tasks is roughly 95GB down and 300GB
   resident, so images have to be pruned as the run proceeds.
