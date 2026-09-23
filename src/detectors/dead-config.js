// dead-config — a knob nothing reads.
//
// The set difference this box is built out of, pointed at its own settings. A
// configuration file declares what can be changed; a key nothing in the tree
// ever reads is a promise the code does not keep, and it is worse than a
// missing feature because somebody will set it and believe it did something.
//
// Measured, not guessed, and the method is the same one `dead-exports` uses:
// collect the keys a defaults object declares, collect every identifier the
// tree mentions, and report the difference. The two ways a key IS read are both
// admitted —
//
//     cfg.budget.churn_factor          named directly
//     cfg[section][name]               indexed, so the STRING appears
//
// — which is why a bare mention of the key's name anywhere counts. That makes
// this deliberately under-report: a key whose name collides with an ordinary
// word is never reported. Under-reporting is the right direction. The finding
// says "delete this or wire it up", and a false one sends somebody to delete a
// knob that works.
import { codeRels, corpus, finding, shaOf, wordSet, wordsOf } from "./_shared.js";
import { DEFAULTS } from "../core/config.js";
import * as filecache from "../core/filecache.js";

/** Every `section.key` a defaults object declares, two deep. Deeper than that is
 *  a data structure rather than a knob — `reserve_by_kind.fix` is a value of one
 *  setting, not a setting — and reporting its leaves would be noise. */
export function knobs(defaults = DEFAULTS) {
  const out = [];
  for (const [section, body] of Object.entries(defaults || {})) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    for (const [key, value] of Object.entries(body)) {
      out.push({ section, key, path: `${section}.${key}`, kind: Array.isArray(value) ? "list" : typeof value });
    }
  }
  return out;
}

/** Keys that exist to be read from OUTSIDE this tree, or by a name this scan
 *  cannot see. Each one names why, because an exception list with no reasons is
 *  where a detector goes to die. */
const EXEMPT = new Map([
  ["workspace.root", "assigned in `load()` itself, never read from config"],
  ["lanes.custom_command", "substituted into a command line by the runner, never named as a key"],
  ["cookbook.thresholds", "handed to the expert as a whole object; its leaves are the board's, not this tree's"],
  ["simulate.thresholds", "handed to the kernel as a whole object"],
  ["kernel.gates", "read as a map by every acceptance path; its keys are the user's"],
]);

export default {
  name: "dead-config", precision: "heuristic", severity: "low",
  description: "a key in the shipped defaults that nothing in the tree ever reads",
  run(ctx) {
    const text = corpus(ctx);
    // One pass over the source, not one per key: this is 60-odd keys against a
    // few hundred files, and the naive shape is a full re-read per key.
    const mentioned = new Set();
    const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
    for (const r of codeRels(ctx, { tests: true })) {
      // The defaults file declares them; mentioning a key there is not reading it.
      if (r.endsWith("core/config.js")) continue;
      const src = text.get(r);
      for (const w of wordSet(filecache.derived(r, shaOf(ctx, r, src), "words", () => wordsOf(WORD, src)))) mentioned.add(w);
    }
    const dead = [];
    for (const k of knobs()) {
      if (EXEMPT.has(k.path)) continue;
      if (mentioned.has(k.key)) continue;
      dead.push(k);
    }
    if (!dead.length) return [];
    // One finding, not one per key: the fix is a single pass over the defaults
    // object, and sixty findings for one edit is a worklist nobody opens.
    return [finding({
      severity: dead.length >= 6 ? "medium" : "low",
      files: ["src/core/config.js"], key: "dead-config",
      // Declared DESTRUCTIVE by the actuator: deleting a knob is a behaviour
      // change for anyone who already set it, however dead the key is here.
      auto_fix: "drop-dead-knob",
      title: `${dead.length} configuration key(s) that nothing in this tree reads`,
      detail: dead.map((k) => `  ${k.path}  (${k.kind})`).join("\n"),
      evidence: { keys: dead.map((k) => k.path), count: dead.length },
      fix_hint: "Delete the key, or read it where it was meant to change something. A knob nobody reads is worse than a missing one: somebody will set it and believe it did something.",
    })];
  },
};
