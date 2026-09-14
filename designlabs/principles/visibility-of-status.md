# Visibility of System Status
- id: visibility-of-status
- field: hci
- source: Nielsen heuristic #1
- rule: state.coverage
- check: every screen declares rest, loading, empty, error, partial and offline, or states why one is impossible
- severity: high

**Claim.** The system should always keep the user informed about what is going on, through appropriate feedback within reasonable time. The oldest heuristic and still the most violated.

**On a screen.** Six states minimum, and the interesting ones are not `rest`:
- **loading** — with the shape of what is coming
- **empty** — first-run empty and emptied-by-filter are different screens
- **error** — what failed, whether it was retried, what the user can do
- **partial** — some of the data arrived; say which part did not
- **offline / degraded** — the product still has a job when a source is unreachable

**The failure it prevents.** The single largest gap between a design file and a shipped product. A design that only drew `rest` has drawn about one-sixth of the work.

**How this toolkit checks it.** This is the toolkit's central gate. The registry requires `states:` per screen, `check` fails a screen missing any of the six without a declared `impossible:` reason, and the browser self-test asserts every declared state renders visibly differently from `rest`.
