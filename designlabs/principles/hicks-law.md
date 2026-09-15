# Hick's Law
- id: hicks-law
- field: hci
- source: Hick 1952, Hyman 1953 · https://lawsofux.com/hicks-law/
- rule: choice.count
- check: at most one primary action and at most five ranked choices per view
- severity: medium

**Claim.** Decision time grows with the logarithm of the number of choices. Not linearly — which is why ten options are not twice as slow as five, and why an eleventh is nearly free once the list is already long. The expensive move is going from one choice to three.

**On a screen.** One primary action. Everything else is secondary, tertiary, or behind a disclosure. A screen offering four equally weighted buttons has not made a decision and is asking the user to make it instead.

**The failure it prevents.** The "Get Started / Learn More / Watch Demo / Contact Sales" row, which is four teams each winning.

**How this toolkit checks it.** The screen registry declares which action is primary. `check` fails a screen declaring two primaries, and warns past five ranked choices.
