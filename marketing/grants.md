# Grant applications — drafts (2026-09-22)

Facts used below, all checkable: MIT, public at github.com/blackswanalpha/bundlebox,
on npm as `bundlebox` since 2026-09-19 (150 downloads in the last month), zero npm
dependencies, CI on Linux and macOS. Reference-workspace measurements from README.md:
opening window 44.3k -> 29.2k tokens (-34%), the same findings planned in 2 sessions
and 351k tokens instead of 5 and 1.3M (-74%). sampleOne: 5 bugs its 12 green unit
tests missed, found in 17 scenarios / 12 s / 0 model tokens.

---

## G1. FUTO microgrant ($1,000–$5,000) — email grantapps@futo.org

Subject: Microgrant application: bundlebox, a local tool that cuts what AI coding agents are billed for

Hello,

I am Victor Mbugua, sole maintainer of bundlebox (MIT,
https://github.com/blackswanalpha/bundlebox, `npm i -g bundlebox`).

AI coding agents are billed per token, and most of what they read is orientation:
where a symbol lives, which files a task touches, what changed. bundlebox answers
those questions locally, with parses, counts and set differences, before the agent
opens, and hands the agent a brief sized to its window. It never calls a model and
sends nothing off the machine. It works with Claude Code, Codex, Gemini CLI and
OpenCode, so a developer is not locked to one vendor.

Measured on the reference workspace: the opening window of each agent session fell
from 44.3k to 29.2k tokens (-34%), and the same set of findings was planned in 2
sessions and 351k tokens instead of 5 sessions and 1.3M (-74%). On a test ecommerce
service it found five bugs that twelve green unit tests missed, in 12 seconds and
with zero model tokens.

This matters for FUTO's mission because the cost of agentic coding is set by a few
model vendors. A local, vendor-neutral tool that cuts that cost keeps the developer
in control of their own machine and budget.

I am asking for $5,000 to fund three months of work on:
1. Windows support (currently best-effort, issue #1).
2. A reproducible public benchmark on third-party open-source repositories, so the
   savings are measured on code I did not write.
3. Documentation and install paths for developers outside the US and EU who pay for
   tokens out of pocket.

The project is released and usable today. Thank you for considering it.

Victor Mbugua
kamandexperb@gmail.com
https://github.com/blackswanalpha

---

## G2. OpenAI Codex for Open Source (up to $25k API credits + 6 months ChatGPT Pro)

Form: https://openai.com/form/codex-for-oss/ (sign in with GitHub as blackswanalpha).
The bar is 1,000 stars. bundlebox has 2, so this goes in under the "important role
in the ecosystem" exception. Odds are low. Apply anyway because it costs nothing.

Project description:
> bundlebox is an MIT CLI that cuts the tokens AI coding agents spend on orientation.
> It answers locally what a parse, count or set difference can answer, then opens
> Codex (or another agent) with a brief sized to its window. Measured: -34% opening
> window, -74% tokens for the same planned findings.

How you would use Codex (keep under the form's limit):
> bundlebox ships a Codex adapter (src/adapters/codex.js). Credits fund a public
> benchmark measuring Codex with and without bundlebox on third-party repositories,
> published in the repo.

"Why it matters to the ecosystem" (125 characters max):
> Cuts Codex token spend 34–74% by answering orientation questions locally. MIT,
> zero deps, vendor-neutral.

---

## G3. Microsoft for Startups Founders Hub (Azure + Azure OpenAI credits)

Sign up at https://www.microsoft.com/startups. No funding needed. Basic tier is
$1,000 with email verification, Enhanced is up to $5,000 with business verification.
It requires a B2B product, so describe bundlebox as developer tooling sold to teams.

One-line description:
> Developer tooling that cuts what engineering teams pay AI coding agents, by
> answering orientation questions locally before the agent runs.

---

## G4. Emergent Ventures (Mercatus) — https://mercatus.tfaforms.net/5099527

Rolling, global, no equity. The proposal box has three parts: (1) your personal
story, (2) one mainstream view you absolutely agree with, (3) the idea. Parts 1
and 2 must be written by Victor. Part 3 and the budget are drafted below.

Tweet (max 295 chars):
> AI coding agents are billed for every file they read, and most of it is orientation.
> bundlebox answers those questions locally for free, then hands the agent a brief.
> Open source, measured: 34–74% fewer tokens on the same work.

Part 3, the idea:
> AI coding agents are now how a growing share of software gets written, and they
> are billed per token. Most of those tokens are spent on orientation, not
> judgement: before an agent changes a line it reads files to learn where a symbol
> lives, which files a task touches, whether two tables agree and what changed
> since last week. A parser, a count or a set difference answers each of those
> questions for free. Today every team pays model prices for them, on every session.
>
> bundlebox (MIT, https://github.com/blackswanalpha/bundlebox, on npm) answers
> everything that code can answer before the agent opens, packs the answers into a
> brief sized to the agent's window, and measures afterwards what the session used
> and what it was spared. It never calls a model and works with Claude Code, Codex,
> Gemini CLI and OpenCode.
>
> What is new: the tools around coding agents compete on making the model do more.
> bundlebox takes work away from the model, and proves it with a ledger instead of
> a claim. Measured so far: the opening window per session fell 34% (44.3k to 29.2k
> tokens), and the same planned findings cost 74% fewer tokens (1.3M to 351k). On a
> test service it found five bugs that twelve green unit tests missed, with zero
> model tokens.
>
> Why it matters beyond cost: agent pricing is set by a handful of vendors. A free,
> local, vendor-neutral layer that cuts the bill makes agentic coding affordable for
> developers who pay out of pocket, including outside the US and EU.
>
> Status: public since 2026-09-14, on npm since 2026-09-19, solo maintainer. The
> honest gap is adoption: 2 stars and no outside teams yet. The grant closes it.

Budget (amount to confirm):
> 12 months, full time: maintainer living costs, CI and benchmark compute, and a
> public benchmark run on third-party repositories (DeepSWE with Sonnet 5 alone is
> ~$3,000 at $26.40 per task). Revenue path: a paid hosted team layer (shared
> savings ledger, org dashboard, budget controls) priced below the tokens it saves.
