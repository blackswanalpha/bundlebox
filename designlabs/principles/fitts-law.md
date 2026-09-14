# Fitts's Law
- id: fitts-law
- field: hci
- source: Fitts 1954, Index of Difficulty · https://lawsofux.com/fittss-law/
- rule: target.min-size
- check: every interactive element measures >= 44px on both axes, or declares why not
- severity: high

**Claim.** Time to acquire a target is a function of its distance and its size. Small and far is slow; large and near is fast. The relationship is logarithmic, so doubling a small target buys much more than doubling a large one.

**On a screen.** The primary action is the largest thing you can afford and sits where the thumb already is. A 24px icon button in a corner is a deliberate cost, not a default. Screen edges are infinitely deep targets — a control flush to an edge is easier to hit than the same control 8px inside it.

**The failure it prevents.** Icon-only toolbars with 20px glyphs and 4px gaps, where the user aims twice. Destructive actions placed one pixel-row from a common one.

**How this toolkit checks it.** `bb designlabs check` reads declared component geometry and fails any interactive element under 44×44 that carries no `waiver:` note. WCAG 2.2 SC 2.5.8 sets the floor at 24×24; 44 is the platform convention on both iOS and Android and is what this toolkit holds.
