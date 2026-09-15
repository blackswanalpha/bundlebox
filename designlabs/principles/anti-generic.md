# Anti-Generic
- id: anti-generic
- field: doctrine
- source: this toolkit
- rule: generic.tells
- check: the ui-generic detector finds no more than two tells in a tree
- severity: high

**Claim.** An interface assembled from the defaults of the current tooling reads as machine-made, and users now recognise it on sight. The tells are specific, countable, and each one is a decision that was never made.

**The tells, and what each one means.**

| tell | what it actually is |
|---|---|
| Indigo/violet gradient hero (`#6366f1` → `#8b5cf6`, 135deg) | the framework's default accent, shipped unexamined |
| Inter or `system-ui` as the only family | no typographic decision was taken at all |
| One radius everywhere (8px, 12px) | radius carries no hierarchy, so it carries nothing |
| The same `box-shadow` on every surface | elevation is decorative, not spatial |
| Emoji standing in for icons | no icon decision; breaks across platforms and in greyscale |
| Centred hero + exactly three feature cards | the template, not the product |
| Copy: "Elevate", "Seamlessly", "Unlock the power of" | written to fill a slot, not to say a thing |
| Every gap a multiple of 8, three distinct values | a scale with no rhythm: nothing is close, nothing is far |
| `:hover` styled, `:focus-visible` and `:disabled` absent | only the happy path was drawn |

**What to do instead — in order of leverage.**
1. **Change the typeface.** It moves more than everything below it combined. One characterful face for display, one boring one for text.
2. **Derive the palette from one committed hue**, not from a framework's named ramp. Keep the accent scarce (see von-restorff).
3. **Make the spacing scale non-linear** — 4, 8, 12, 20, 32, 52. Near things get near; far things get far.
4. **Make radius mean something** — small on dense controls, large on surfaces, and never the same number on both.
5. **Draw the six states** before drawing a second screen (see visibility-of-status). State coverage is what separates a product from a shot.
6. **Take structure from published systems, refuse their skin.** M3's state layers and token roles are excellent; M3's colours make every app look like every other app.

**Where the patterns come from instead.** A pattern you install still arrives with someone else's taste attached, so take the mechanism and re-token the surface: `ui-skills` (MIT, CLI and MCP, `npx ui-skills get <skill>`) for web, `fwc-swiftui-skills` for Apple platforms. Both are in `bb designlabs sources --kind patterns`.

**The code-side sibling.** `anti-slop` is the same thesis applied to TypeScript: twenty Oxlint rules that reject low-evidence patterns, vendored into the repo rather than depended on. It says nothing about an interface and `ui-generic` says nothing about a type assertion. Run both.

**How this toolkit checks it.** `bb scan` runs the `ui-generic` detector, which counts the tells above with file and line evidence, **per top-level directory** — aggregated over a whole repo these counts cancel, and one corrected stylesheet hides an uncorrected one. `bb designlabs check` fails a tree over the configured threshold.
