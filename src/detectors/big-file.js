// big-file — a file no single session can hold with room to work.
//
// A token finding, not a style one: any unit that must read this file whole
// has spent a third of its window before doing anything. A survey (JUDGEMENT):
// "split this file" is an architecture call, and its real value is as a
// planning input to the router.
import { human } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { codeRels, corpus, finding } from "./_shared.js";

// Fractions of the window, not absolute sizes: 60k tokens is big in a 160k
// window and ordinary in a 1M one.
export const THRESHOLDS = { medium_at: 0.35, high_at: 0.7 };

export default {
  name: "big-file", precision: "exact", severity: "medium",
  description: "files whose token estimate exceeds 35% of one session's working window",
  run(ctx) {
    const b = ctx.cfg.budget;
    // reserve_output, NOT reserve_by_kind: a file's size is a property of the
    // file, and the kind of unit that will touch it is decided later by the
    // router. Using one kind's reserve would make the same file "big" for a
    // write and "fine" for a fix, and the finding would flip between scans.
    const cap = Math.max(1, (b.max_tokens || 160000) - (b.reserve_output || 0));
    const out = [];
    const text = corpus(ctx);
    for (const r of codeRels(ctx)) {
      const n = estimate.text(text.get(r), "code");
      if (n < cap * THRESHOLDS.medium_at) continue;
      const pct = Math.round((n / cap) * 100);
      out.push(finding({
        severity: n > cap * THRESHOLDS.high_at ? "high" : "medium", kind: "investigate",
        files: [r], key: r,
        title: `${r}: ${human(n)} tokens (${pct}% of one session's working window)`,
        detail: `working window is ${human(cap)} tokens (max_tokens - reserve_output)`,
        evidence: { tokens: n, capacity: cap, pct, lines: text.get(r).split("\n").length, thresholds: THRESHOLDS },
        fix_hint: "Any unit that touches this file is a one-file lane. Either split the file or write the brief so the session reads a region.",
      }));
    }
    return out.sort((a, b2) => b2.evidence.tokens - a.evidence.tokens);
  },
};
