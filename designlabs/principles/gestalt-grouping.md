# Gestalt Grouping
- id: gestalt-grouping
- field: perception
- source: Wertheimer 1923; proximity, similarity, common region, continuity
- rule: group.by-space
- check: grouping is carried by whitespace and shared region before borders or colour
- severity: high

**Claim.** The eye groups before it reads. Things near each other are one thing; things that look alike are one kind; things inside a shared boundary belong together. These operate below attention and cannot be argued with by a label.

**On a screen.** The distance between a label and its own field must be smaller than the distance to the next field. When it is not, no amount of styling fixes the form — the user reads the label as belonging to the field above it. This one relationship is the most common layout bug in software.

**The failure it prevents.** Cards with borders around groups that whitespace already made obvious, which is decoration; and evenly spaced stacks where nothing groups, which is worse.

**How this toolkit checks it.** `check` asserts that every declared label/control pair has an internal gap strictly smaller than its external gap, and flags containers whose only grouping signal is a 1px border.
