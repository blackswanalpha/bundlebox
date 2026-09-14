# Progressive Disclosure
- id: progressive-disclosure
- field: ux
- source: Nielsen; Norman, The Design of Everyday Things
- rule: disclosure.layers
- check: no screen shows more than its primary job; secondary controls are one layer down and reachable in one action
- severity: medium

**Claim.** Show the few options most people need; put the rest one deliberate step away. The cost of a second layer is one action. The cost of showing everything is that nothing is findable.

**On a screen.** The default view answers the common question completely. Advanced controls live behind a named affordance — not a hover, not a long-press, not a gesture nobody discovers.

**The failure it prevents.** Both directions: the settings screen with 40 visible switches, and the "clean" screen that buried the one control users need on every visit.

**How this toolkit checks it.** Each screen declares `primary` and `secondary` control sets. `check` fails a screen rendering a secondary control at the top level, and fails a disclosure that needs more than one action to open.
