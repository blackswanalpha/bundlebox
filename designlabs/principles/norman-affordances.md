# Affordance, Signifier, Mapping, Feedback, Constraint
- id: norman-affordances
- field: hci
- source: Norman, The Design of Everyday Things (1988, rev. 2013)
- rule: affordance.signified
- check: every interactive element carries a visible signifier; every action returns feedback
- severity: high

**Claim.** An affordance is what an object permits. A signifier is the perceivable clue that it permits it. Software has no physical affordances at all, so it has nothing BUT signifiers — which is why a flat rectangle with no signifier is not minimal, it is silent.

**On a screen.** Five separate obligations:
- **Signifier** — a tappable row shows it is a door (a chevron, a shift on press, anything).
- **Mapping** — a control sits next to the thing it changes, and moves the way the thing moves.
- **Feedback** — every press answers within 100ms, whether or not the work is done.
- **Constraint** — an impossible action is prevented, not validated after the fact.
- **Conceptual model** — the user's story about how it works matches how it works.

**The failure it prevents.** The flat-design era's central defect: read-only rows and tappable rows rendered as the same pixels, so the user learns which is which by tapping.

**How this toolkit checks it.** `check` fails any element declared interactive whose declared states do not differ from `rest`, and any press path with no declared feedback inside 100ms.
