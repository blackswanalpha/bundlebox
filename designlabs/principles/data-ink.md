# Data-Ink Ratio
- id: data-ink
- field: information-design
- source: Tufte, The Visual Display of Quantitative Information (1983)
- rule: chrome.budget
- check: no screen exceeds its declared element budget
- severity: medium

**Claim.** Maximise the share of ink that carries information; erase the rest, and erase again. Gridlines, borders, shadows, badges and containers are ink that says nothing.

**On a screen.** Every border is a claim that whitespace could not group these items. Usually whitespace could. Every icon beside a text label is a claim that the label was insufficient. Usually it was not.

**The failure it prevents.** The "dashboard" that is twelve bordered cards, each with an icon, a title, a subtitle, a sparkline and a badge, communicating four numbers.

**How this toolkit checks it.** Each screen declares an element budget in its `audit:` block. `check` counts rendered elements against it and fails an overrun, which makes decoration cost something at review time.
