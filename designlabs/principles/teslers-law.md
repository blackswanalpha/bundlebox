# Tesler's Law
- id: teslers-law
- field: ux
- source: Larry Tesler, conservation of complexity · https://lawsofux.com/teslers-law/
- rule: complexity.owner
- check: every screen names who absorbs its irreducible complexity
- severity: medium

**Claim.** Every system has an amount of complexity that cannot be removed. It can only be moved — into the product, or onto the user. Simplifying an interface without absorbing the work somewhere else is not simplification, it is a transfer.

**On a screen.** A date field that accepts "next tuesday" absorbed complexity. A date field that demands DD/MM/YYYY transferred it. Both look equally simple in a screenshot, which is why screenshots are a bad way to judge this.

**The failure it prevents.** Minimal UIs that are minimal because the hard cases were declared out of scope, then reappear as support tickets.

**How this toolkit checks it.** Each screen's `audit:` block names the complexity it absorbs and the complexity it transfers. `check` fails an audit that claims neither.
