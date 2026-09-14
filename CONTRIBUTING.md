# Contributing to bundlebox

Thank you for wanting to. This is a small, deliberate codebase and the rules
below exist so it stays one.

## How a change gets in

**`main` is protected. Nobody pushes to it directly.** Every change arrives as a
pull request, and only the repository owner merges.

```bash
# fork it, then
git clone git@github.com:<you>/bundlebox.git
cd bundlebox
git checkout -b feat/the-thing
# ... work ...
npm run lint && npm test          # both must pass before you open the PR
git push -u origin feat/the-thing
gh pr create --base main
```

A pull request is merged when all of these hold:

1. CI is green on Linux, macOS and Windows, across Node 20, 22 and 24.
2. The owner has approved it. `.github/CODEOWNERS` requests that review
   automatically.
3. Every review conversation is resolved.

If you do not have write access, fork the repository — you will not be able to
push a branch to it, and that is intentional.

## What the code has to hold to

The full list is in [CONVENTIONS.md](CONVENTIONS.md). The four that get changes
sent back most often:

- **Zero runtime dependencies.** Node ≥ 20, ESM, no build step, no
  `node_modules`. `npm i -g bundlebox` has to be one command that works offline
  afterwards. The Rust kernel builds with nothing but `rustc` and `cargo`; the
  Python expert system is standard library only.
- **Degrade to *unknown*, never to a plausible answer.** Return `null` when you
  could not look and `[]` only when you looked and found nothing. A verb that
  prints a zero where it should print "I could not see" is the bug this whole
  tree exists to remove.
- **A measured number and an estimate are never added, and never printed the
  same way.** Label rows `MEASURED` / `ESTIMATE`.
- **Every verb is a dry run until `--apply`.** Only `bb run` and
  `bb bridge send` may spend tokens, and both ask the window guard first.

## Tests

```bash
npm test          # node:test over test/*.test.js
npm run lint      # node --check plus the house rules
bb selftest       # the silent-failure checks; each prints its measurement
```

New behaviour needs a test that would fail without it. Where two runtimes
implement the same fact — the kernel and the JavaScript engine, most of all —
the test pins them to identical answers, because which runtime happens to be
installed must not change a number.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). Say what
changed and why it was wrong before; a commit message that only restates the
diff is one nobody can use later. No co-author or attribution trailers.

## Reporting something

An issue is most useful with the output of `bb doctor` and the exact command you
ran. If it is a wrong *number* rather than a crash, say which number and what you
expected — that is usually a defect in what the tool measured, which is the kind
worth finding.
