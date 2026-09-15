# Peak-End Rule
- id: peak-end-rule
- field: psychology
- source: Kahneman & Fredrickson · https://lawsofux.com/peak-end-rule/
- rule: flow.ending
- check: every flow declares its peak moment and its ending, including the failure ending
- severity: medium

**Claim.** People judge an experience by its most intense moment and its end, not by the average or the sum. A long mediocre flow with a good ending beats a short pleasant one that ends abruptly.

**On a screen.** Design the ending deliberately — the confirmation, the empty inbox, the thing that happens after the user is done. And design the FAILURE ending, because for a real fraction of users that is the only ending they see.

**The failure it prevents.** Flows lavished with attention up to the submit button and then ending on a bare "Success" toast, or worse, silence.

**How this toolkit checks it.** The studio registry requires `flow[]` rows to include a terminal node and a failure node. `check` fails a flow with no declared failure ending.
