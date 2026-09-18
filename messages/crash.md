# crash.md — what to fix in bundlebox

Found while debugging why the `SessionEnd` hook in the `mypa` workspace recorded
nothing for four consecutive sessions. Every item below was reproduced against
the installed copy (`~/.local/lib/node_modules/bundlebox`, v0.5.0, identical
version to this tree). Dates: 2026-09-17.

The headline: **bundlebox lost four sessions of accounting and reported success
the whole time.** 322.0M tokens used and 343.8M+ saved went unrecorded. Nothing
in `bb session list`, `bb doctor` or the hook's own output said so.

---

## F1 — the launcher dies under a minimal PATH, and the caller cannot tell

`bin/bb.js` is `#!/usr/bin/env node`. On this box `node` is at
`~/.local/bin/node`, which is not on the PATH a hook, cron job or systemd unit
inherits.

```
$ env PATH=/usr/bin:/bin bb session list
/usr/bin/env: 'node': No such file or directory
$ echo $?
127
```

127 is the correct exit, but nothing else about the failure is usable: the error
names `env` and `node`, never bundlebox, so a caller that redirects stderr —
which every well-behaved reporting hook does, because a hook that writes to
stderr on a good day is a hook that gets muted — sees only a silent non-zero and
no output.

This is the root cause of the four lost sessions. The `mypa` hook had it doubly:
a stale path to a `bundlebox/bb` that no longer exists, and behind it this.

**Fix:** make `bin/bb` a POSIX shell wrapper that locates a usable `node`
(`command -v node`, then `$HOME/.local/bin/node`, then the common install
prefixes) and `exec`s it, or have `npm install -g` write a launcher that hardcodes
the interpreter that installed it. A tool whose whole selling point is running
unattended at 03:00 cannot assume an interactive PATH.

## F2 — `session end` writes a record for a session that does not exist

`src/tokens/session.js:264` calls `write(m)` on whatever `measure()` returns,
with no guard.

```
$ bb session end --session zzz-does-not-exist
tokens used 0 ($0.00) MEASURED · saved 0+ ($0.00+) MEASURED+ESTIMATE · 0 turns, peak window 0
$ echo $?
0
$ ls .bundlebox/var/sessions/zzz-does-not-exist.md
-rw-rw-r-- 1 mbugua mbugua 974 Sep 17 10:49
```

An id with no transcript behind it gets a full 974-byte record and a row in
`index.md`, and exit 0 says it worked. Two bad consequences: junk accumulates in
the index, and a hook passing a `session_id` the harness shaped differently
writes a zero row instead of failing loudly.

**Fix:** in `end()`, when `m.used.turns === 0` and no transcript resolved, skip
the write and exit non-zero with one line on stderr naming the id and the path it
looked for. A zero-turn session that genuinely happened (an opened-and-closed
window) is real and should still record — the distinguishing fact is whether a
transcript was found, not whether it had turns.

## F3 — no way to remove a record

`src/tokens/session.js` exports `write()` and `list()` and nothing else. Removing
the junk from F2 meant `rm`-ing `var/sessions/<id>.md` and hand-editing
`var/sessions/index.md` — editing a generated file by hand, which is the exact
thing `CLAUDE.md` tells every caller never to do.

**Fix:** `bb session rm <id>`, rewriting `index.md` through the same `write()`
path that owns its format.

## F4 — no backfill verb

Recovering the four lost sessions meant a shell loop over
`~/.claude/projects/<slug>/*.jsonl`, reading first and last timestamps out of
each with `jq` to work out which ones were in the gap, then calling
`bb session end --session <id> --transcript <path>` once per file.

`src/lathe/index.js:250` already has `backfill(limit, maxMb)`, bounded on both
axes, for exactly this shape of problem. `session` should reuse it.

**Fix:** `bb session backfill [--since <date>] [--transcripts N]` — measure every
transcript for this workspace that has no record yet, skip the ones that do,
print one line per session written. That turns a 20-minute hand-reconstruction
into one command, and it is what anyone hitting F1 will need first.

## F5 — `var/findings.json` is 165 MB

In the `mypa` workspace, `.bundlebox/var/findings.json` is **165 MB** as of
2026-09-17T10:17. Every other file in `var/` is under 3 MB.

This is not a crash, but it is the shape of one: a single JSON document that must
be parsed whole to answer `bb findings`, growing without a rotation policy, in the
directory the tool writes to on every run. `var/shapes.jsonl` already documents
the fix for this class of problem in `src/lathe/record.js` — `MAX_ROWS = 20000`
and drop the oldest half — with a comment explaining that a rotation keeping
everything is "a file somebody eventually deletes by hand."

**Fix:** give `findings.json` the same bound, or move it to JSONL with the same
rotation `shapes.jsonl` has.

---

## J1 — `janitor` mark pass reaches nothing, so no object is ever promoted

From the last applied compile in the `mypa` workspace
(`.bundlebox/var/janitor.json`, 2026-09-16T22:24:47Z):

```json
"mark": { "total": 1155, "reached": 0, "unreached": 1155, "promoted": 0, "roots": 12 }
```

Twelve roots were found and **zero of 1155 objects were reached**. `bb help
janitor` describes the pass as "reachability traced from what the sessions
actually opened, not from age. Survivors are promoted a generation, which puts
them further out of the sweep's reach." With `promoted: 0` that never happens:
nothing is ever protected, every object stays permanently sweep-eligible, and
the generational half of the design is inert.

The pass does not crash and does not warn — it reports its own zero as a normal
result, so the compile looks healthy and the numbers downstream of it (`kept`,
`retracted`) are produced as if reachability had been consulted.

**Fix:** find out whether the 12 roots are resolving to nothing or the traversal
never runs. Either way, `reached === 0 && total > 0` is not a valid outcome for
this pass and should be an error, not a silent statistic — it is the one number
in the run that cannot legitimately be zero.

## J2 — `bb janitor` says "read-only" and writes 1.1 MB

`bb janitor` with no subcommand ends with:

```
read-only. `bb janitor compile` to write the window, `bb janitor prune` to clean the sources.
```

and `bb help janitor` declares `effect  writes --apply`. Both are wrong. Every
bare invocation rewrites all five files in `.bundlebox/out/janitor/` —
`WINDOW.md`, `HEAP.md`, `RULES.md`, `heap.jsonl`, `diagnostics.json`, about
1.1 MB.

Verified by mtime and content across two consecutive bare runs; the only content
difference between them is the embedded compile timestamp, so the output is
deterministic — it is the writing itself that is undeclared.

```
WINDOW.md mtime before=1789631523 after=1789631548 changed=YES
diff: 1 line, the `Compiled by bb janitor at <ts>` header
```

This matters beyond tidiness. `WINDOW.md` is the placed image an agent loads, so
a command documented as safe to run silently replaces the artefact another
session may be reading, and a status check is indistinguishable on disk from a
deliberate `compile`.

**Fix:** either have the bare verb compute in memory and write nothing, or drop
the "read-only" line and declare the write in `bb help janitor`. The first is
what the text promises.

---

## Priority

| | What | Why first |
|---|---|---|
| F1 | PATH / shebang | Root cause. Silently disables every unattended caller. |
| F2 | Bogus records written, exit 0 | Corrupts the ledger and hides F1. |
| F4 | `session backfill` | What you need the moment F1 bites anyone else. |
| J1 | `janitor` mark pass reaches 0 | A whole pass is inert and reports it as normal. |
| F5 | 165 MB `findings.json` | Growing unbounded right now. |
| F3 | `session rm` | Cleanup, needed once F2 has already written junk. |
| J2 | `janitor` writes while claiming read-only | Wrong docs on a safe-looking command. |

F1 and F2 compound: the first makes the tool fail, the second makes the failure
look like success. Either alone is a bug you notice in a day. Together they cost
four sessions.

J1 and J2 share the shape of F2: a pass or a command that does the wrong thing
and reports it as a normal, successful result. Four of the seven findings here
are not failures to do the work — they are failures to say the work did not
happen.
