# Jakob's Law
- id: jakobs-law
- field: ux
- source: Nielsen · https://lawsofux.com/jakobs-law/
- rule: convention.respect
- check: navigation, auth and checkout follow platform convention unless a waiver names the gain
- severity: medium

**Claim.** Users spend most of their time on other sites. They arrive expecting yours to work like those. Familiarity is not a lack of imagination; it is the budget you have left to spend somewhere that matters.

**On a screen.** Put the novelty where the product is actually different. A reinvented date picker costs the user real time and buys nothing. A reinvented way of showing what changed since yesterday might be the whole product.

**The failure it prevents.** Custom scrollbars, hijacked scroll, a hamburger that opens a full-screen takeover on desktop, a login flow with an original shape.

**How this toolkit checks it.** Not mechanically checkable. `check` reports it as a review item on any screen tagged `auth`, `nav` or `checkout`, and requires a `waiver:` sentence naming what the deviation buys.
