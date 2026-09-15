# Miller's Law
- id: millers-law
- field: psychology
- source: Miller 1956, The Magical Number Seven · https://lawsofux.com/millers-law/
- rule: group.size
- check: no ungrouped run longer than 7 siblings; prefer 5
- severity: low

**Claim.** Working memory holds about seven chunks. The number is often misquoted as a limit on list length — it is not. It is a limit on how many things can be held at once, and the lever is chunking: seven items in three named groups costs three chunks, not seven.

**On a screen.** A twenty-row list is fine if it is sectioned and scannable. A twenty-field form with no grouping is not. Phone numbers are chunked for exactly this reason.

**The failure it prevents.** Settings pages that are one flat column of forty switches.

**How this toolkit checks it.** `check` counts sibling elements per declared region and warns past seven with no grouping container.
