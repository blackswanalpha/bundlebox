# Price table provenance

`src/tokens/prices.js` carries `$ per million tokens` for the models the
session ledger can meet. Every row is a first-party API list price with the
cache-read multiplier that vendor publishes. Partner platforms (Bedrock,
Vertex, Azure) are priced separately and are not these numbers.

| vendor | source page | as of |
|---|---|---|
| Anthropic | https://www.anthropic.com/pricing (API tab) and the prompt-caching docs | 2026-09-13 |
| OpenAI | https://openai.com/api/pricing | 2026-09-13 |
| Google | https://ai.google.dev/pricing | 2026-09-13 |

Rules the table enforces:

- A model not in the table is reported with its tokens and **no cost**. An
  invented rate is a wrong report; a missing rate is a gap, and only one of
  those is recoverable.
- Cache write multipliers: Anthropic 1.25× at the 5-minute TTL, 2× at the
  1-hour TTL (Claude Code uses 1-hour). OpenAI and Google charge no write.
- Cache read multipliers: Anthropic 0.1× (0.025× on Fable 5.1), OpenAI 0.1×,
  Google 0.25× on 2.5 and 0.1× on 3.
- `bb tokens prices` prints the table with its date so a stale row is visible
  rather than silently applied to a year of sessions.

To update: edit `PER_MTOK`, bump `AS_OF`, and add a changelog line.
