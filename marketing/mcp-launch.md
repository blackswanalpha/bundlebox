# MCP launch — the posts

Nothing here is posted by the tool. Copy, adjust, post.

Every post leads with the SWE-bench number, because it is the only claim in the
kit that a competitor's README does not also make. Order matters: the registry
record and the two list PRs go first, so the traffic these posts create lands on
a listing that already exists.

The charts and the method are live at https://blackswanalpha.github.io/bundlebox/docs/benchmark/ — every post
below links it, because a table in a comment is a claim and the page is the
working.

---

## Hacker News — Show HN

**Title:** `Show HN: 67.5% of what my coding agent read was orientation, not judgement`

**URL:** `https://github.com/blackswanalpha/bundlebox`

**First comment (post it yourself, immediately):**

I kept paying Opus to grep. Not to decide anything — to find out where a symbol
lives, which files a task touches, whether two tables still agree. Each of
those is a parse or a set difference, and I was being billed per token for it.

bundlebox answers those questions before the agent opens, and packs the answers
into a brief sized to the window. It never calls a model.

To find out whether that was worth anything I ran two arms over 100 SWE-bench
Verified instances. Same checkout, same issue text, same estimator. The bare arm
does what an agent does with a shell: grep the tree, read what came back, open
an 80-line range in each of the top ten files. The other arm is one `bb pinpoint`
brief. Neither arm called a model, so neither number is a guess about one.

| | bare | brief |
|---|---|---|
| context per task | 8.7k tok | 2.8k tok |
| gold files in scope | 24.6% (31/126) | 64.3% (81/126) |
| every gold file present | 26/100 | 61/100 |
| files put in front of the model | 10 read whole | 6.8 in scope |

Two things I want to be straight about.

The recall figure is a localisation score against the maintainer's own patch. It
is not a resolve rate. No model was called and no test was run, so I cannot tell
you it fixes more bugs — only that the files the fix touches are in the window
more often.

Charts, the per-instance spread and the method: https://blackswanalpha.github.io/bundlebox/docs/benchmark/

And there is one chart that does not favour it: building the brief takes 8.9s
against 246ms to grep and read. 6.6s of that is constructing the symbol space
for a repository it has never seen, which a workspace pays once rather than per
task. The trade is seconds of your CPU for tokens of the model's window.

The result I did not expect came from measuring uptake. Over 15 sessions on this
workspace the MCP tools fired in 0 of them. `pinpoint` fired in 3 of the 13
sessions that opened five or more distinct files. Those 13 sessions opened
between 30 and 598 files each. Everything I had wired in front of the agent was
a recommendation, and a recommendation loses to the model's own habit about
three times in four. The fix was hooks that answer the read instead of asking
the model to prefer a tool.

Node >= 20, zero runtime dependencies, MIT. `npx -y bundlebox mcp` for the MCP
server, `npm i -g bundlebox` for the CLI.

---

## Reddit — r/mcp

**Title:** `I measured my MCP server instead of describing it: 8.7k -> 2.8k tokens per task on SWE-bench Verified`

**Body:**

Every code-context MCP server's README claims it saves tokens. Mine did too, and
I had no idea whether it was true, so I built the two-arm harness instead of
writing another paragraph.

100 SWE-bench Verified instances. Same checkout, same issue text, same
estimator. Arm A greps the tree, reads what came back, opens an 80-line range in
each of the top ten files — what an agent does with a shell. Arm B is one
`bb_pinpoint` call. Neither arm called a model, so both numbers are token counts
over text on disk.

- Context per task: 8.7k -> 2.8k (67.5% less)
- Gold files inside the packed scope: 24.6% -> 64.3%
- Instances where every gold file made the window: 26/100 -> 61/100

The recall number is a file-level localisation score against the patch that
ships with the dataset. The score is not a resolve rate, and I would rather say that
here than have somebody find it out.

The cost side, since nobody posts theirs: the brief takes 8.9s to assemble
against 246ms for grep-and-read, and 6.6s of that is first-visit symbol
construction a workspace pays once.

Every chart, including that one: https://blackswanalpha.github.io/bundlebox/docs/benchmark/

Nine stdio tools, zero dependencies, MIT: `bb_pinpoint`, `bb_context`,
`bb_snapgen`, `bb_findings`, `bb_scan`, `bb_oversight_brief`, `bb_explain`,
`bb_tokens_estimate`, `bb_session`.

`npx -y bundlebox mcp`

Repo: https://github.com/blackswanalpha/bundlebox

Happy to run the harness against a repo you pick if you think 100 instances of
SWE-bench flatter it.

---

## Reddit — r/ClaudeAI

**Title:** `I wired six surfaces into Claude Code, then measured which ones it used. The MCP tools fired zero times.`

**Body:**

I build a tool that wires itself into Claude Code: an instruction block, hooks,
skills, and an MCP server with nine tools. Then I wrote something to read back
from the transcripts which of those surfaces sessions reached for.

Over 15 sessions on my own workspace:

- The MCP tools fired in 0 sessions.
- `pinpoint` fired in 3 of the 13 sessions that opened five or more distinct files.
- The reference tables were read in 5 of the 15 sessions that ran a search.
- Those 13 sessions opened between 30 and 598 files each.

Everything I had installed was advisory. The instruction block arrives in every
system prompt and is billed whether the session is about it or not, and a
recommendation loses to the model's own habit about three times in four.

What worked was not a better description of the tool. A PreToolUse hook did,
by answering the Read and the Grep with the packed brief, so the cheap path is
the one the model was already taking.

If you ship anything that wires into Claude Code, measure uptake before you
write another line of the instruction block. Mine cost tokens in every
session to be ignored in most of them.

Repo, MIT: https://github.com/blackswanalpha/bundlebox
Benchmarks, since I would rather be measured than believed: https://blackswanalpha.github.io/bundlebox/docs/benchmark/

---

## X — thread

1/ I kept paying Opus to grep.

Not to decide anything. To find out where a symbol lives and which files a task
touches. Both are a parse away, and both were billed per token.

So I measured how much of a session was that.

2/ Two arms, 100 SWE-bench Verified instances, same checkout and same estimator.

Bare: grep the tree, read what came back, open the top 10 files.
Packed: one brief.

Neither arm called a model. Both numbers are token counts over text on disk.

3/ Context per task: 8.7k -> 2.8k.
Gold files inside the window: 24.6% -> 64.3%.
Instances with every gold file present: 26/100 -> 61/100.

Those are localisation scores against the maintainer's patch, not resolve rates.
No model ran.

https://blackswanalpha.github.io/bundlebox/docs/benchmark/

4/ The chart that does not favour it:

Building the brief takes 8.9s. Grep-and-read takes 246ms.

6.6s of the 8.9 is the symbol space for a repo it has never seen, paid once per
workspace rather than per task. The trade is seconds of my CPU for tokens of the
window.

5/ The part I did not expect.

I measured which of the wired surfaces sessions used. The MCP tools: 0 of 15.
pinpoint: 3 of the 13 sessions that opened 5+ files. Those sessions opened
between 30 and 598 files each.

6/ Everything installed in front of the agent was a recommendation, and a
recommendation loses to the model's habit about three times in four.

Hooks that answer the read beat a tool description that asks the model to prefer
something.

7/ Zero runtime dependencies, Node >= 20, MIT.

npx -y bundlebox mcp

https://github.com/blackswanalpha/bundlebox
