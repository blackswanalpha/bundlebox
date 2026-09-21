// drivers/ — what executes a `ui` step.
//
// One module per driver, all four functions on each, no model anywhere:
//
//   id            what `persona.json` names in `driver`
//   available()   `{ ok }` or `{ ok: false, why }` — asked before the corpus runs
//   open(ctx, t)  a session for target `t`; `ctx` is `{ root, base }`
//   act(s, a)     one parsed action against session `s`: `{ ok, why, got }`
//   close(s)      release it; called once per scenario
//
// A driver is declared by the corpus and never guessed. Guessing would mean a
// corpus written for a page silently driving a phone, and the first evidence of
// it would be a board of red steps about selectors that never existed.
import * as page from "./page.js";
import * as playwright from "./playwright.js";
import * as adb from "./adb.js";

export const DRIVERS = { page, playwright, adb };
export const ids = () => Object.keys(DRIVERS);
export const byId = (id) => DRIVERS[String(id || "")] || null;
