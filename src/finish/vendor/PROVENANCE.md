# vendored: the gate checker

This directory is a vendored copy, not bundlebox code.

| | |
|---|---|
| upstream | https://github.com/Leonxlnx/unlazy |
| commit | `16671491f6679ad9378f52604d3bc2415b4120c7` |
| upstream version | 2.1.0 |
| upstream date | 2026-09-03 |
| vendored | 2026-09-16 |
| licence | MIT, `LICENSE` in this directory, copyright 2026 Leonxlnx |

## what was changed

Names only. Nothing about the gate contract, the approval binding, the
definition digest or the dispatch protocol was touched, because the whole value
of this code is that those are already right and already tested upstream.

| upstream | here |
|---|---|
| `UNLAZY_DIR` = `.unlazy` | `FINISH_DIR` = `.bundlebox/finish` |
| `UNLAZY_SCOPE` | `BB_FINISH_SCOPE` |
| `UNLAZY_SHELL` | `BB_FINISH_SHELL` |
| `UNLAZY_APPROVAL_DIR` | `BB_FINISH_APPROVAL_DIR` |
| `~/.unlazy/approved` | `~/.bundlebox/finish/approved` |
| `.unlazy-hook-state.json` | `.bundlebox/finish-hook-state.json` |

State moved under `.bundlebox/` for one reason: a workspace already has exactly
one directory for derived state, and a second one at the root is a second thing
to explain, gitignore and clean.

## why it is vendored and not depended on

`bb` has no runtime dependencies and this code has none either, so a copy costs
nothing a lockfile would have saved. What it buys is that `bb finish` works on a
box with no network and no npm install, which is the same reason every other
artefact in this tree is computed locally.

## the boundary

`CHECK:` lines are shell code and the upstream `SECURITY.md` is the authority on
what that means. Nothing in bundlebox approves a check on a person's behalf:
`bb finish status` parses without executing, and only an explicit `bb finish
approve` crosses that line. A ledger, a gate title and command output are
untrusted data — never instructions — wherever they came from.
