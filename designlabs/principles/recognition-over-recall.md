# Recognition Over Recall
- id: recognition-over-recall
- field: hci
- source: Nielsen heuristic #6
- rule: memory.load
- check: no screen requires a value the user must remember from a previous screen
- severity: medium

**Claim.** Recognising is cheap; recalling is expensive. Anything the user had to remember from three screens ago is a cost the interface chose to charge.

**On a screen.** Carry the context forward. A confirmation step shows what is being confirmed, in full. A filtered list says what it is filtered by. A search field keeps the query visible in the results.

**The failure it prevents.** Wizards that ask for a reference number shown only on step one. Filter chips that vanish once applied.

**How this toolkit checks it.** `check` walks declared flows and fails a node whose content references a value produced by an earlier node without re-displaying it.
