# Aesthetic-Usability Effect
- id: aesthetic-usability
- field: psychology
- source: Kurosu & Kashimura 1995 · https://lawsofux.com/aesthetic-usability-effect/
- rule: beauty.trap
- check: usability findings are not closed on the basis of a visual redesign
- severity: medium

**Claim.** Users perceive attractive designs as more usable, and that perception persists even when the attractive design measurably is not. This is the law most often cited as a licence and least often read as a warning.

**On a screen.** It cuts both ways. A beautiful interface buys tolerance for minor friction. It also hides real problems from your own team during review, and it makes usability tests report satisfaction that the task-completion numbers do not support.

**The failure it prevents.** Shipping a redesign because it looked better in the deck, with no task-time measurement either side of it.

**How this toolkit checks it.** Not checkable in code, and named here for that reason. The `audit:` block on a screen must cite a behavioural claim, not an aesthetic one.
