# Contrast, Focus and Target Size
- id: contrast-and-targets
- field: accessibility
- source: WCAG 2.2 SC 1.4.3, 1.4.11, 2.4.11, 2.5.8, 2.3.3 · https://www.w3.org/WAI/WCAG22/quickref/
- rule: access.floor
- check: text >= 4.5:1, large text and UI components >= 3:1, focus never invisible, targets >= 24px, motion respects prefers-reduced-motion
- severity: critical

**Claim.** These are normative requirements, not preferences. Where an aesthetic decision and a line here disagree, this wins, and the toolkit does not offer a waiver.

**On a screen.**
- Body text 4.5:1 against its actual background, including over images and gradients.
- Large text (>= 24px, or >= 19px bold) and every UI component boundary 3:1.
- `:focus-visible` is styled explicitly. Removing the outline without replacing it fails 2.4.11.
- Interactive targets 24×24 minimum (this toolkit holds 44 — see fitts-law).
- Every non-essential animation has a `prefers-reduced-motion: reduce` branch.
- Colour is never the only carrier of meaning: a state needs a second signal.

**The failure it prevents.** Grey-on-grey secondary text at 3.1:1, which is the most common accessibility failure in modern interfaces and is almost always chosen deliberately, for looks.

**How this toolkit checks it.** `check` computes real WCAG relative-luminance ratios over every declared token pair and fails below the floor. It reports `unknown` — never a pass — for text over an image or gradient, because a static ratio cannot be computed there.
