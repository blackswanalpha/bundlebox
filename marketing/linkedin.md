# LinkedIn — launch kit for bundlebox

Nothing here is posted by the tool. Copy, adjust, post.

## Project entry (LinkedIn → Profile → Projects)

**Name:** bundlebox — the zero-token software factory for AI coding agents
**URL:** https://github.com/blackswanalpha/bundlebox
**Dates:** Aug 2026 – present
**Description:**
Open-source, dependency-free Node CLI that runs before, around and after an AI
coding agent (Claude Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode,
Aider…) and never calls a model itself. It scans a repo with sixteen static
detectors, packs findings into briefs sized to the agent's context window,
opens the agent under a measured-minimal flag stack, and reads back from the
transcript what the session used and what it was spared. Measured on the
reference workspace: −34% session overhead before any work, −74% projected
tokens for the same plan, 226 agent turns displaced per pipeline tick at zero
model cost. Ships as `npm i -g bundlebox`, wires into ten agents with
`bb wire`, and serves its verbs over MCP with `bb mcp`.

## Post 1 — launch

I spent a month measuring what my coding agents actually read.

37% of the files a session opened, it opened twice. 88% of tool turns carried
one call. Half of all sessions ran long enough to compact.

None of that was judgement. It was orientation: where is this symbol, do these
two tables agree, what is the test command. A script answers those for free.

So I built bundlebox: a control layer that answers every parse-shaped question
before the agent opens, packs the answers into a brief sized to the window, and
measures afterwards what the session cost and what it was spared.

Numbers from the reference box:
• opening window 44.3k → 29.2k tokens, before a word of work
• same plan: 5 sessions / 1.3M tokens → 2 sessions / 351k
• one pipeline tick: 226 agent turns displaced in 133s, 0 model tokens

Zero dependencies. Works with Claude Code, Codex, Gemini CLI, Cursor, Copilot,
OpenCode, Aider and any custom command. One install, one `bb wire`.

npm i -g bundlebox
github.com/blackswanalpha/bundlebox

#AIAgents #ClaudeCode #Codex #DeveloperTools #OpenSource

## Post 2 — the rule

One rule decides what my AI agents are allowed to be asked:

"If the answer is a set difference, a path check, a count or a parse, it is a
detector and it costs nothing."

Everything that passes that test runs locally in milliseconds. Everything that
fails it gets a brief with the evidence already inside, sized to fit the
window, and an acceptance command whose exit code is the verdict.

The agent should touch about a tenth of the work. bundlebox is the other nine
tenths.

github.com/blackswanalpha/bundlebox

## Post 3 — measured vs estimated

The most useful line in bundlebox's session report is the one that refuses to
add two numbers.

USED is measured to the token from the transcript.
SAVED (cache) is measured: those exact tokens billed at 0.1×.
SAVED (automation) is an estimate, printed as a range.

They are never summed. A savings claim that mixes a measurement with a
counterfactual is a number nobody can check, and nobody checks a number that
looks reasonable.

If your agent tooling reports one figure for "tokens saved", ask which kind.

## Post 4 — the port

Porting a 27k-line Python tool to dependency-free Node found 21 bugs that
changed reported numbers. My favourite three:

1. The savings row called a function that did not exist. Inside a broad
   except. It was zero for a month and looked like a modest result.
2. The daily calibrator overwrote the probed session overhead. Every lane was
   budgeted 27k tokens too high, silently, from the next morning.
3. The secret scanner reported one hit per pattern per file. A placeholder on
   line 3 muted a real key on line 40.

All three are the same bug: something that looked like an answer and wasn't.
The port has a self-test for each.

## Post 5 — MCP in 80 lines

Every agent speaks MCP now, so bundlebox serves its zero-token verbs as tools:
bb_pinpoint, bb_context, bb_snapgen, bb_findings.

The server is JSON-RPC over stdio in 80 lines of Node with no dependency.
An agent that can ask "where is this and does it fit" does not spend twelve
turns finding out.

`bb mcp`, and `bb wire --apply` registers it with whichever agents you have.

## Comment replies (keep ready)
- "Does it work with X?" → If X can be spawned from a shell and writes a
  transcript, yes via the custom adapter; ten agents have first-class adapters.
- "How do you know the savings are real?" → Three of the four rows are read
  off the transcript or the proxy's own counters. The fourth is labelled an
  estimate and printed as a range.
- "Why no dependencies?" → A cron worker at 03:00 runs what is on disk or it
  does not run.

## Post 2 — the ablation

Full text in `post-2-ablation.txt`. The shape, if you rewrite it: lead with the
denominator, not the percentage. The table is the post — it is the only part
that cannot be written by someone who did not run it. The claim at the end is
falsifiable on purpose (`regenerate the trees and the packed column should
still not move`), and the self-audit paragraph is not modesty, it is what makes
the first half credible.

Do not lead with 97%.

## Post 3 — silent failures (v0.2.0 progress)

Full text in `post-3-silent-failures.txt`. One thesis — every bug closed this
week failed by looking like it was working — five examples from the codebase,
then the release itself supplying three more.

The ending is the argument, so do not cut it for length. Three failures in one
afternoon at wildly different prices: a retired `macos-13` runner that sat
queued for thirty-four minutes without erroring, an npm 403 that named the fix
in two minutes, and a rate-limited account earned by retrying that 403 instead
of reading it. The third one is the author's fault and the post says so. Leave
that in — it is what stops the piece reading as a tool advert, and a post about
silent failure that hides its own would be the joke writing itself.

Do not soften "not on npm yet". A post claiming a clean launch while the release
is stuck is the exact failure mode it is complaining about.

When it does publish, swap that one clause for the npm line and keep all three
examples — they are the evidence, not the news.
