# Prior art: the running half

[prior-art.md](prior-art.md) covers seven projects read against the SOURCE half
of this factory. This is the second round, read in September 2026 against the
other half: what a system does while it is running, and what it costs to find
out.

| project | what it is |
|---|---|
| [Graft](https://github.com/trailhq/Graft) | a two-pass code graph — tree-sitter structure, then cached LLM summaries — written out as markdown files agents read like source, with a ~3 ms structural refresh against the working tree |
| [ARTEMIS](https://github.com/google/artemis) | natural-language Android automation: a reactive observe-and-act loop over the accessibility hierarchy, with a planner/operator/checker graph for the hard cases, an MCP server, and 99%+ on AndroidWorld |
| [Playwright's 2026 MCP work](https://qaskills.sh/blog/whats-new-playwright-2026) | a browser driven through accessibility-tree snapshots rather than screenshots or raw DOM |
| the mypa prototype | the shell-and-Python `bundlebox/` this package was ported from, whose `runbook`, `dotty` and `recom` never made the port |
| [anti-slop](https://github.com/dmmulroy/anti-slop) | already in [prior-art.md](prior-art.md) as a code ruleset; re-read here for a question it turns out not to answer |

---

## The one idea all four share

**Give the reader the structure, not the bytes.**

Graft writes markdown a session greps instead of a vector index it queries.
Playwright hands the model an accessibility snapshot instead of the DOM.
ARTEMIS reads the accessibility hierarchy rather than pixels, and falls back to
OCR and then to coordinates only when the hierarchy has nothing — a chain, not a
choice. All three are the same move bundlebox makes when it prints a signature
instead of a log line and a region instead of a file.

**A correction to the first version of this file**, which quoted Playwright's
"90–95% smaller than the HTML" as though it were a property of the technique.
It is a property of the PAGE. Measured here over CDP against three real ones:

| page | HTML | a11y tree, slimmed to role/name/state | |
|---|---|---|---|
| the sampleOne storefront — 4.5 kB, hand-written, semantic | 4,568 B | 9,554 B | **2.1× bigger** |
| a github.com repository page — framework-heavy | 440,779 B | 170,112 B | 61% smaller |
| the MDN Web API index — thousands of links | 239,203 B | 456,597 B | **1.9× bigger** |

A page that is mostly wrapper divs, inline styles and hydration payload
compresses enormously. A page that is mostly content does not, because HTML
spells a link in about forty bytes and an accessibility node costs about sixty
once its role, name and nodeId are counted. This is `bb bench`'s 78%-to-97%
range again, and quoting somebody's best case as a general behaviour is the
exact thing `marketing/linkedin.md` says not to do — including when the best
case is somebody else's.

**So the byte count is not the reason to use the tree.** The reason is that
`{"role":"button","name":"Add to cart","disabled":true}` survives a class
rename, a div restructure and a CSS refactor, and a selector does not. A
scenario asserting on six nodes carries six nodes; what the whole tree would
have cost never comes up.

The corollary is the part worth stealing: **every one of them names its
fallback**. Playwright's ARIA snapshot degrades to a selector. ARTEMIS's
hierarchy degrades to OCR degrades to pixels, and the trace says which was used.
Graft's semantic layer degrades to the structural one, which needs no key at
all. A compression that cannot say which rung it is standing on is a compression
whose answers cannot be compared with last week's.

`bb cookbook run` already prints its engine and why (`kernel engine (http base,
every pattern inside the subset)`). `bb runbook logs` now prints `via kernel` or
`via js` for the same reason.

---

## Graft → the freshness probe

Graft's queries run a structural refresh — about 3 ms — that compares
working-tree bytes against the fingerprint of the last build, and includes
uncommitted edits automatically. The LLM layer is never re-run without a flag.

That is the same mechanism as `bb scan`'s fingerprint skip, and bundlebox
already had it for the source. What it did **not** have was the same mechanism
for an *answer*: a conclusion somebody drove a browser or a phone to reach.

That gap is now `bb recom`. A record declares the facts its result rests on and
those are re-probed on every read. The probe that matters most is `git_paths`,
and it is `git_paths` for exactly Graft's reason: it hashes the working tree, so
a record goes stale on an uncommitted edit to what it was actually about, and
survives every unrelated commit.

**Not taken:** the semantic layer. An LLM-summarised node is a model call, and
bundlebox has no free way to make one. The structural half is the half that is
free, and it is the half `bb snapgen` and `bb pinpoint` already occupy.

**Not taken:** markdown as the artefact. Graft's markdown is read by a session
and so has to be prose. bundlebox's artefacts are read by `bb` first and a
session second, so they are JSON, and the prose is generated at the point of
reading. That way one board can be a table, a brief and a finding without three
copies of it existing.

---

## ARTEMIS → the readiness gate, and the incident that stays in context

ARTEMIS is the most directly relevant project here, because it is about driving
a real device and that is the most expensive thing a session can do.

### What came back

**1. Two profiles, named, with their costs stated.** Flash is a reactive loop at
3–5 s a step; Pro is a planner/operator/checker graph at 15–40 s a step. The
choice is declared per task rather than inferred. `bb cookbook`'s engine choice
(`kernel` or `js`) is the same shape and already prints its reason; what it
lacked was ARTEMIS's honesty about *wall clock per step*, which is why
`bb runbook up --wait` now reports how many probes a service took to answer.

**2. Pre-execution verification.** ARTEMIS checks a target against the live UI
before dispatching an action, "catching blocked targets before wasting tokens".
Generalised, that is: **do not start expensive work against a world you have not
confirmed**. `bb runbook up api --apply --wait` is that check. A corpus run
against a service that has not finished booting produces a red board for every
step, and a session then pays to read a board about nothing. Measured on
sampleOne, the wait costs 488 ms and removes a 14-finding false board.

**3. An execution incident stays in context until recovery.** ARTEMIS does not
hand a failure to a separate repair agent; the incident remains where the work
is. That is why `bb runbook logs` exits 1 on a high bucket and says *"nothing
below it is evidence about the product"* — a known failure is not a row to be
filed elsewhere, it is a statement about everything after it.

**4. History compression into searchable eras.** ARTEMIS chunks older steps and
makes them queryable rather than dropping them. The digest's cursor is the cheap
version: the raw file stays on disk with its path printed, so the evidence is
one `sed` away, and only the shapes are carried forward.

### What the pull requests say

`google/artemis`'s open and recently merged PRs are a list of the failure modes
this class of tool has, and four of them are worth designing against directly:

| PR | the class |
|---|---|
| #85 `stop interpolating package names and URLs into device shell strings` | **command injection through a data field.** `bb recom`'s probe vocabulary is closed and every `git`/`adb` call uses a fixed argument vector, with record text only ever in a positional slot — because a record arrives by pull request |
| #104, #82 `preserve numeric zero in task result turn counts`, `honor an explicit zero swipe duration` | **falsy zero.** A count of 0 and an absent count are different facts. `bb runbook`'s digest reports `0 bytes since the last call` as a row rather than as silence |
| #88 `stop reading a false-like all as a request to cancel every task` | **a falsy flag read as a wildcard.** The most expensive possible misread |
| #93, #91, #86 `stop tests leaking real spawn watchdogs`, `isolate from provider credentials` | **a test that touches the real world.** `test/digest.test.js` runs entirely against a temp dir and skips the kernel comparison by name when there is no binary |

### What was built against it

bundlebox does not install ARTEMIS and does not drive a phone. Its MCP entry
carries an absolute interpreter path, a `PYTHONPATH` and a `cwd` that only
`uv run artemis mcp --install` knows, and a second implementation of that guess
writes a server that never starts — which an agent sees as *no tools*, not as an
error. That is the silent-failure class this codebase exists to refuse.

So the integration is a gate, not a wrapper:

```
bb recom mobile                              is a driver registered, is a device attached
bb recom gate mobile/<id> -- <the drive>     run it only if the answer stopped holding
```

`gate` is `check` wired straight to the decision, and its safety property is an
asymmetry: **only `fresh` skips.** `stale`, `unknown` and a record that does not
exist all run the command, because a gate wrong in the `fresh` direction hands
back an answer about a world that moved and nothing downstream can tell, while a
gate wrong the other way costs one extra run. `test/gate.test.js` pins each of
the four paths.

The three adb probes the vocabulary already carried — `adb_state`,
`adb_package`, `adb_foreground` — are what a mobile record depends on, and
`bb recom template <id> --mobile --pkg <app>` fills them from the attached
device rather than from a guess.

One sentence is added to the agent instruction block, and only where a driver is
actually registered: the block sits in every session's window, so a sentence
about phones in a repository with no phone is tax on every prompt.

**Not taken:** the multi-agent graph. A planner, an operator and a checker are
three model calls per step. bundlebox's equivalent of the checker is the
acceptance command, whose exit code is the verdict and which costs nothing.

**Not taken:** the accessibility helper. Installing a service on the device to
read the screen layout is the correct answer for Android and has no analogue for
an HTTP service, which answers structurally already.

---

## Browser, desktop and iOS: what the same shape looks like elsewhere

Asked of each surface, the question *"what does the running system do, and what
does it cost to find out"* has the same answer and a different substrate:

| surface | the structured view | the fallback |
|---|---|---|
| browser | the accessibility tree — Playwright's ARIA snapshots, 90–95% smaller than the HTML | CSS/XPath selectors, then pixels |
| Android | the accessibility hierarchy, via a helper service that avoids taking the UiAutomation connection | OCR, then coordinates (ARTEMIS's chain) |
| iOS | the XCUITest element tree, reached through Appium, `idb`, or `xcrun simctl` for a simulator | screenshots |
| desktop | the platform accessibility API (AT-SPI, UIA, AX) | a screenshot and a click at a point |
| an HTTP service | **the response itself** | — |

The last row is the reason `bb cookbook` is cheap and the others are not: an
HTTP service already answers in a structured form, so there is no perception
step to pay for. A scenario is a request and an assertion, and the kernel runs
hundreds of them in seconds with no model anywhere.

This is worth stating plainly because it bounds the ambition: **the iOS and
desktop equivalents of `bb cookbook` are not cheap, and no amount of
engineering here makes them so.** What bundlebox can do for those surfaces is
the layer above — decide whether the run has to happen at all — which is
`bb recom`, and which is exactly where the mypa prototype put it.

A search in September 2026 surfaced no iOS equivalent of ARTEMIS with published
benchmark numbers; Appium and XCUITest remain the substrate, and the agent layer
above them is where the variation is.

---

## The mypa prototype → what the port had left behind

The Node port of this factory took `runbook`'s three cheapest ideas — services
as declared rows, offset reads, signatures instead of lines — and left the rest.
The rest turns out to be most of the value:

| in the prototype | in the port before this round | now |
|---|---|---|
| a `[groups]` table: the unit of work is a set, not a service | a comma list on each row | declared `groups`, `bb runbook groups` |
| an admission check refusing a set whose cages exceed free memory | absent | `src/runbook/memory.js`, `MemAvailable` / `vm_stat`, `--force` to override |
| `boot = 15` and a wait until the probe answers | `up` returned when the process existed | `up --wait`, kernel-side, parallel, reports attempts |
| `MemoryHigh` at 90% so the kernel reclaims before it kills | `MemoryMax` only | both, plus `MemorySwapMax=0`, and `perf` flags a service past the high mark |
| `digest.toml`: twelve named failures with severities | signatures only | `digest.json`, seven seeded buckets, `logs` exits 1 on a high one |
| `--level`, `--grep`, `--sample` | absent | all three, and they narrow signatures without ever hiding a bucket |
| `recom`: record, check, replay, refresh | absent | `bb recom`, with the probe vocabulary in the kernel |
| `dotty`: frames, films, contact sheets from two phones | absent | the browser half, over CDP; films and contact sheets deliberately not — see below |

### Why the normaliser moved to Rust

The prototype ran eight global Python regexes over every line. The port ran
eight global JavaScript ones. At 24,000 lines that is the runbook's entire cost,
and every shape being erased — a timestamp, a pid pair, a uuid, a hex blob, a
number with a unit, a quoted payload, a path — is recognisable from the
character in hand plus a bounded lookahead. So it is a single-pass scanner with
no backtracking, in `kernel/src/digest.rs`.

Measured on a 3.9 MB, 40,000-line log: **61 ms against 196 ms**, both returning
the same five signatures. `src/runbook/digest.js` is a line-for-line port of the
scanner rather than a second opinion about what a signature is, and
`test/digest.test.js` compares the two engines field by field on the same bytes
— because two normalisers would eventually disagree, and the one that drifted
would be the one reporting that nothing changed.

### What `recom` changed about where records live

The prototype wrote records into the three product repos, because `bundlebox/`
sat at an ungitted workspace root and a record kept beside it could be neither
reviewed nor restored. The port has no such problem: `.bundlebox/recom/records/`
is inside the repository the record is about. That removes `RECOM_ROOT`, the
generated in-repo `read.py`, and the selftest that checked three hand-copied
vocabularies had not drifted — a whole mechanism that existed only to work
around the missing git.

### `dotty`, the half of it that is cheap

`bb dotty` captured what two phones actually showed: frames, films, contact
sheets, and a `during` verb that ran a command with both phones recording. The
first read of this file said it was adb-shaped and that a capture layer over
adb, CDP, `simctl` and a desktop accessibility API was a project rather than a
module. That is still true of the whole of it. It turned out not to be true of
the browser.

Two things made the browser half cheap. A WebSocket client is about 120 lines of
`node:net` and `node:crypto` — the only part of RFC 6455 that CDP needs is that
client frames are masked and server frames are not — so it needs no `ws` and no
`puppeteer`, which would pull a second browser into `node_modules`. And
`Page.captureScreenshot` is one call on a connection that
`Accessibility.getFullAXTree` is already open on.

```
bb dotty targets                         what pages the browser has open
bb dotty shot checkout --url http://…    one frame, plus what was on screen as rows
bb dotty during send --reload -- <cmd>   a frame each side, and what changed between them
```

**The PNG is for the human; the accessibility summary is for the session.** An
image costs vision tokens, cannot be grepped and cannot be diffed. The same
screen as rows — `button "Add to cart" disabled` — is about a hundred tokens for
a whole page, survives a CSS refactor, and can be compared with the frame taken
ninety seconds ago. So a capture writes both and the verb prints the summary,
naming the file rather than showing it. That is the same trade as a signature
instead of a log line, one surface over.

`film` and `strip` are not ported and will not be: mp4, gif and contact sheets
need ffmpeg or an image library, and a dependency to make a picture prettier is
not one this factory can take.

**What carried is the honesty rule.** A frame that came back single-coloured is
marked BLANK and the verb exits 1, because a black rectangle filed as evidence is
worse than no evidence — a later session opens it, sees nothing wrong with the
file, and concludes the screen was blank. Node has `zlib`, so the check is a real
one: inflate the IDAT, reverse the scanline filters, compare a deterministic grid
of pixels. A frame that could not be decoded is `null`, never `false`, for the
same reason `unknown` is not `fresh`.

The diff between two screens is a MULTISET difference, and that is not a detail.
A product grid has ten identical `button "Add to cart"` nodes; deduplicating them
makes the one that became disabled invisible, and the page would report "nothing
changed" while showing something different.

**Android capture stays ARTEMIS's.** It already keeps timelines and video
replays against a session clock and `mobile_inspect_trace` fetches them, so an
`adb exec-out screencap` here would be a worse second implementation of a solved
problem. The seam is the recom record: whatever took the picture, `evidence`
points at it — which is what the prototype's
`evidence: ["dotty/out/<stamp>-<label>/"]` always meant.

## anti-slop, and the question it does not answer

`src/detectors/anti-slop.js` has ported dmmulroy's code rules since before this
round. Re-read for whether the ruleset could also govern the **prose** bundlebox
writes, the answer is no, and the reason is worth writing down: anti-slop is an
**Oxlint plugin for TypeScript and JavaScript**. Its twenty-odd rules are all
about code — `no-array-filter-map`, `no-chained-type-assertions`,
`no-unknown-parameters`, `require-safety-comment-for-type-assertion`. Its
`AGENTS.md` is six lines about the plugin's own repository. There is no prose
ruleset upstream to vendor.

So `src/slop/index.js` is the same **idea** in the same **shape** — every rule a
row with a name, a pattern, what it costs and what to do instead — applied to
the other thing this factory emits. It matters more here than in an editor for
one reason: **every brief bundlebox writes is read by a model and billed**. A
hedge is not a style complaint; it is tokens a lane pays for and then has to
decide to ignore.

Three families and one hard rule:

- **cost** — fillers, intensifiers, `in order to`, a closing recap of what the
  reader has just read. Deleted outright.
- **evidence** — `several files`, `check the config`, `this should work`. Each
  makes the reader go and get what the writer already had.
- **confidence** — stacked hedges, empty superlatives. Both leave the reader
  unable to tell what is known from what is guessed.
- **the rule**: `strip` only deletes and substitutes one-for-one. A rule with no
  `fix` is reported and never applied, because the correct replacement is a fact
  the rule does not have, and a cleaner that invented one would be a worse
  problem than the sentence it was fixing.

Fenced blocks, four-space-indented commands and **any line nothing fired on**
come back byte for byte. The last of those is not a nicety: whitespace in these
documents is structure — an evidence block, a hoisted header, an aligned table —
and a first draft that tidied every line damaged the thing the brief exists to
hand over. `test/slop.test.js` pins it.

`GUARDRAILS` is deliberately not stripped. `cacheStablePrefix` finds it by exact
string, so one word removed there would cost every lane in a run its shared
cache prefix — and a test asserts the block is already written to these rules,
so the day somebody adds a rule that fires on it, CI says so.

Inline code spans are masked before matching, at the same length, so a brief
that quotes a rule's own literal comes back untouched — this document tripped
five of its own rules before that was fixed, and a ruleset that mangles its
examples is one nobody runs twice.

**Known false positives, kept on purpose:** `pointer` fires on "run and check
the service", and `vague-subject` fires wherever a pronoun opens a sentence
whose subject the previous line named. Both are report-only, both are cheap to
read past, and tightening either pattern would cost the true positives they were
written for. Across the markdown in this repository and its projects
workspace the ruleset reports 91 hits, 74 of them from those two rules, and
strips 29 tokens — which is the honest number for prose already written to these
habits. The saving is on model-written prose, not on this.
