# Serial Position Effect
- id: serial-position
- field: psychology
- source: Ebbinghaus · https://lawsofux.com/serial-position-effect/
- rule: order.edges
- check: the most important items sit first or last in any ordered set
- severity: low

**Claim.** The first and last items in a series are recalled best; the middle is where things go to be forgotten.

**On a screen.** Put the two things that matter at the ends of a nav bar, not in the middle. In a settings list, the destructive action goes last on purpose — separated, at an edge, where it is both findable and not adjacent to anything routine.

**The failure it prevents.** Five-item tab bars where the most-used destination is the third.

**How this toolkit checks it.** Reported, not enforced. `check` prints the declared ordering of every nav set so the placement is a visible decision.
