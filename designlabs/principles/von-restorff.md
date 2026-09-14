# Von Restorff Effect
- id: von-restorff
- field: psychology
- source: von Restorff 1933, the isolation effect · https://lawsofux.com/von-restorff-effect/
- rule: accent.scarcity
- check: at most one accented element per viewport
- severity: high

**Claim.** When several similar objects are present, the one that differs is the one remembered. The effect is a budget, not a technique: it is spent by every use, and a second accent halves the first.

**On a screen.** One accent colour, used for one thing. If the accent marks the primary action, it cannot also mark the active nav item, the unread badge and the brand logo — because then it marks nothing.

**The failure it prevents.** The dashboard where nine tiles all have a coloured header, so the one that needs attention is invisible. This is the single most common way a competent-looking UI fails at its job.

**How this toolkit checks it.** `check` counts accent-token uses per declared viewport and fails past one. The `ui-generic` detector flags trees where the accent appears on more than 5% of elements.
