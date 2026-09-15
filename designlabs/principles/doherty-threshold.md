# The Doherty Threshold
- id: doherty-threshold
- field: hci
- source: Doherty & Thadani 1982, IBM · https://lawsofux.com/doherty-threshold/
- rule: motion.duration
- check: no transition over 400ms; acknowledge every input within 100ms
- severity: high

**Claim.** Productivity rises sharply when the system responds in under 400ms, because below that the user and the machine stay in the same loop and attention never leaves. Above it, the user disengages and the cost is not the wait — it is the re-entry.

**On a screen.** Three budgets: 100ms to acknowledge a press, 400ms to complete a transition, 1s before a determinate progress indicator is owed. Anything genuinely slower needs a skeleton showing the SHAPE of what is coming, not a spinner showing that something is happening.

**The failure it prevents.** 600ms "elegant" page transitions, which read as elegance once and as lag every time after.

**How this toolkit checks it.** `check` parses every declared duration in the motion scale and fails any over 400ms without a waiver. It also fails a screen that declares a loading state with no skeleton when its own budget says over 1s.
