# Review of the reference implementation

Findings from a full read of `mypa/bundlebox` (stdlib Python, ~27k lines, 42
verbs) made before the port. Each carries a code so it can be cited. `Fixed`
means the port closes it; `Kept out` means the subsystem did not travel;
`Open` means the port carries the same limitation and says so.

## A. Wrong numbers and silent failures

| code | where | what | status |
|---|---|---|---|
| A1 | `tokens/session.py:137` | calls `hr.status()`, which does not exist; the wire savings row was always 0 inside a broad `except` | Fixed |
| A2 | `workers/meter.py:46` | daily calibrate overwrote `overhead_lean` and the session profile; lanes budgeted against a 27k-higher overhead | Fixed: read-merge |
| A3 | `tokens/ledger.py:79` | transcript dir match by loose prefix counted other projects' sessions | Fixed: exact slug |
| A4 | `tokens/ledger.py:158` | every unseen turn attributed to whichever run folded next | Fixed |
| A5 | `control/rules.py:150` | `critical-always` fired after `judgement-call`, promoting analyzer residue to an opus lane | Fixed: judgement sticky |
| A6 | `control/outcomes.py:267` | `ended` never written, so every open finding read as recurred on first scoring | Fixed |
| A7 | `workers/sweep.py:81` | unattended sweep ran DESTRUCTIVE actuators | Fixed |
| A8 | `detectors.py:669` | secret-scan: first match per pattern per file; a placeholder muted real keys later in the file; 200 KB read cap | Fixed: matchAll, per-match placeholder |
| A9 | `detectors.py:576` | module-level mutable used as a parameter | Fixed |
| A10 | `detectors._age_days`, `remote.age_min` | UTC timestamps parsed as local | Fixed |
| A11 | `session.py:168` | a null `first_ts` collapsed the automation row to zero | Fixed |
| A12 | `store.py:353` | sqlite connections never closed; schema re-applied per call | Kept out: JSON store |
| A13 | `anchors.py:286` | excerpt could print a negative line count | Fixed |
| A14 | `detectors.py:416` | empty siblings list made a regex that matched nothing, reporting clean forever | Kept out |
| A15 | `detectors.py:336` | colliding declarations across files, last writer wins | Fixed |
| A16 | `rules.py:795` | behind count from `@{upstream}`, pull from configured base | Fixed |
| A17 | `rules.py:159` | a typo in `promote_at` silently promoted nothing | Fixed: default with warning |
| A18 | `headroom.py:262` | `killpg` on an unvalidated pid file | Fixed: cmdline check |
| A21 | `tokens/lean.py:95` | the probe spends money and did not say so | Fixed: requires `--probe`, warns |
| A22 | `lean.py:159` | wire overhead printed with the wrong sign framing | Fixed |

## B. Runner and shipping

| code | where | what | status |
|---|---|---|---|
| B1 | `cli.py:358` | a plan with local units could not be reloaded | Fixed: stored as objects |
| B3 | `runner.py:289` | missing `claude` binary crashed the whole run | Fixed: rc 127 per lane |
| B5 | `runner.py:289` | stderr never drained, pipe deadlock | Fixed |
| B6 | `runner.py:306` | timeout only checked while output flowed | Fixed: independent timer |
| B8 | `standby.py:126` | overhead and reserve double-counted per unit | Kept out |
| B9 | `router.py:113` | device index by global lane index | Kept out: no devices |
| B10 | `runner.py:395` | sum of peaks reported as a peak | Fixed: not reported |
| B11 | `store.py:510` | resumed lanes' usage rows silently dropped | Fixed: last-wins upsert |
| B13 | `cli.py:364` | `run --apply` never ran the local actuators it pulled out of the plan | Fixed: `bb fix` is the branch and the plan says so |
| B14 | `runner.py:339` | unproven lanes shipped as green PRs | Fixed |
| B15 | `gitops.py:193` | empty scope fell through to `git add -A` | Fixed: refuse |
| B17 | `gitops.py:315` | operator precedence lost the PR url | Fixed |
| B20 | `gitops.py:350` | `pr_ready` ignored pending checks | Fixed |
| B25 | `kit/runner.py:55` | tables rebuilt in full before the fingerprint check | Fixed: inputs first |
| B29 | `wiring.py:182` | orphan check by basename only | Fixed: resolved imports |
| B31/32/33 | `gitops.py` | secret sweep gaps, exact-match flag guard, porcelain parse breaks on renames | Fixed |
| B34 | `compiler.py:77` | `cap()` disarmed on any `| tail` substring | Fixed: ends-with only |
| B35 | `router.py:184` | shared-checkout lane carried a branch that was never created | Fixed: `branch: null` + warning |
| B37 | `runner.py:291` | full parent env handed to every lane | Fixed: allowlist |
| B39 | `runner.py:270` | dry-run `.cmd` not shell-safe | Fixed |

## C. Learning loop

| code | where | what | status |
|---|---|---|---|
| C1 | `switchgear/verbs.py:121` | `len()` of a dict added a constant 5 to the oversight count | Fixed |
| C2 | `switchgear/runner.py:210` | skipped count off by one | Fixed |
| C3 | `switchgear/runner.py:145` | `skip_if_fresh` without inputs was a silent no-op | Fixed: warns |
| C4 | `bridgeswap/adapters.py:74` | codex adapter never received its prompt | Fixed |
| C5 | `bridgeswap/adapters.py:76` | gemini adapter received a filename as the prompt | Fixed |
| C8/C9 | `buckmaster/memory.py` | documented decay rule not implemented; `last_seen` bumped on every write so decay never fired | Fixed |
| C14/C15/C16 | thresholds | three thresholds loaded and read by no rule; two metrics computed and read by no verdict | Fixed: a test asserts every threshold is read |
| C26 | `switchgear/spec.py:148` | a second fingerprint implementation | Fixed: one |
| C32 | `episodes.py:186` | the training label was a function of the verb, which was also a feature | Open: label is order-aware now, still weak |
| C33 | `switchgear/runner.py:137` | train/serve feature skew | Fixed: one `featurize` |
| C35 | `switchgear/report.py:25` | base-rate predictions printed as if from the model | Fixed |
| C36 | `episodes.autolabel` | a stage could certify itself useful | Fixed |
| C38 | `bridgeswap/call.py:213` | daily ceiling failed open and counted the human's sessions | Fixed: fails closed, counts lane/bridge spend only |
| C39 | config | `bridgeswap.enabled` was never read | Fixed |
| C45 | `session-end.sh` | hook silent by construction; a corpus past 120s produced nothing | Fixed: hook always exits 0 but writes a status line to `var/hooks.log` |
| C46 | `block-*.sh` | hooks failed open without `jq` | Fixed: hooks are Node, no jq |

## D. Coupling that stayed behind

The mock engine (`viewport`), device fleet (`dotty`, `build --fanout`), persona
corpora (`cookbook`, `mainboard`), the FastAPI route parser, Sentry wiring
checks, the Flutter arm-table detectors and the 30-entry `DOC_CLAIMS` table are
product code, not tooling. `snapgen routes` and `doc-drift` carry the generic
shape of two of them.

## E. Documentation drift found in the original

Thirteen counts in the original's own README and CLAUDE.md were wrong at review
time (three actuators vs seven, 39 selftest checks vs 46, six gears vs seven,
six views vs seven, `anchor_widen` 15% vs 0.45 in config). The `doc-drift`
detector in this package is pointed at its own README on every CI run.
