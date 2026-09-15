# Error Prevention and Recovery
- id: error-prevention
- field: hci
- source: Nielsen heuristics #5 and #9
- rule: error.recoverable
- check: destructive actions are undoable or confirmed; every error message names the next action
- severity: high

**Claim.** Preventing an error beats explaining it. Where an error is possible anyway, the message must be in plain language, say what went wrong, and offer a way forward.

**On a screen.** Prefer undo to confirm: a confirm dialog interrupts every correct action to catch a rare wrong one, while undo interrupts nobody. Reserve confirmation for the genuinely irreversible. Never write "Something went wrong."

**The failure it prevents.** Modal confirmation on every delete, which trains the user to dismiss dialogs unread, which is how the one that mattered gets dismissed too.

**How this toolkit checks it.** `check` fails a declared destructive action with neither `undo:` nor `confirm:`, and fails any error state whose copy contains no verb the user can act on.
