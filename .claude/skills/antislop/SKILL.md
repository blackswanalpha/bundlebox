---
name: antislop
description: Write prose a model will be billed to re-read. Fifteen measured rules over three families - words that carry nothing, claims with the evidence filed off, and stacked hedges - each with what it costs and what to write instead. Use when writing or editing any markdown, brief, commit message, PR body, comment block, report, summary or design note in a repository, and whenever a hook reports anti-slop hits in something just written.
---

# anti-slop

Every document in a repository is read by the next session and billed again, every time, until
somebody deletes it. A document is the only artefact here that charges rent. So a hedge is not a
style preference: it is tokens a lane pays for and then has to decide to ignore.

Run the rules, do not memorise them:

```text
bb slop <file>                 every hit, by rule, with the line
bb slop fix <file> --apply     strip what cannot lose a fact, and say what it saved
bb slop rules                  the ruleset, and which rules rewrite
```

`bb slop` exits 1 when a file has any hit, so it works as a gate. Every brief, prompt, commit
message and PR body bundlebox writes already goes through the same rules before it is handed over.

## The three families

**COST — words that carry nothing.** Deleted outright, because deleting them cannot lose a fact.

| rule | what it costs |
|---|---|
| `filler-opener` | an opener that says a sentence is coming, before the sentence |
| `announcement` | narrating the next step instead of taking it |
| `closing-recap` | a recap of text the reader has just read, paid for twice |
| `intensifier` | an adverb that moves no number |
| `long-form` | four words doing one word's work |
| `flattery` | agreement with nothing behind it |
| `emoji` | decoration in a document a machine reads |

**EVIDENCE — a claim with the evidence filed off.** Reported, never rewritten: the correct
replacement is a fact the rule does not have, and a tool that invented one would be worse than the
sentence it was fixing.

| rule | what it costs |
|---|---|
| `uncounted` | a count the writer had, replaced with a word that is not one |
| `pointer` | sending the reader to find what the writer already read |
| `unproven-claim` | a claim about behaviour with no command behind it |
| `vague-subject` | a pronoun standing in for the thing being claimed about |

**CONFIDENCE — the reader cannot tell what is known from what is guessed.**

| rule | what it costs |
|---|---|
| `hedge-stack` | two hedges on one claim, which is not twice as careful |
| `empty-superlative` | an adjective that would be true of anything, so it distinguishes nothing |
| `not-only` | a shape that promises two facts and usually delivers one twice |
| `dash-chain` | three dashes in one line, which is three asides and no sentence |

## What to write instead

- **A count, not a word for one.** "several files" was a number when it was written. Write the
  number, or the paths.
- **The thing, not a pointer to it.** If the answer is one line of a config, quote the line. Sending
  the reader to go and get it makes them pay for the read the writer already did.
- **A command, not a belief.** "this should work" is a claim with no oracle. Name what was run and
  what it printed, or say plainly that it was not run.
- **One hedge or none.** Say what is known, then say what is not, as a separate sentence. Stacking
  qualifiers leaves both unreadable.
- **The subject.** Replace "it", "this" and "that" with the noun when the claim is about the noun.
- **Nothing at the end.** A closing recap is the cheapest paragraph to delete and the most common one
  to write.

## Where it does not apply

Code, fenced blocks and inline spans are masked and returned byte for byte. Never rewrite a quoted
region, a command, a test name, a log line or an error message to read better — they are evidence,
and their exact wording is the only thing that makes them evidence.

A hedge is sometimes the honest word. When the uncertainty is real, state it once and say what would
settle it. The rule these fifteen share is not brevity; it is that the reader can tell what is known
from what is guessed, and is not billed for anything else.
