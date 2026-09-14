// merge-markers — a conflict resolved by saving the file with the markers in.
// Nothing downstream works: the compiler, the tests and every lane that opens
// the file fail on the same three lines, each of them expensively.
import { blankFences, corpus, finding, isGeneratedText, snippet } from "./_shared.js";

const OPEN = /^<{7} /, CLOSE = /^>{7} /, MID = /^={7}(?: |$)/;

export default {
  name: "merge-markers", precision: "exact", severity: "high",
  description: "unresolved git conflict markers at line start",
  run(ctx) {
    const out = [];
    for (const [r, raw] of corpus(ctx)) {
      if (!raw.includes("<<<<<<< ")) continue;
      if (isGeneratedText(r, raw)) continue;
      // A markdown file explaining conflict markers shows them in a fence.
      const text = r.endsWith(".md") ? blankFences(raw) : raw;
      const lines = text.split("\n");
      const opens = [], closes = [], mids = [];
      lines.forEach((l, i) => { if (OPEN.test(l)) opens.push(i + 1); else if (CLOSE.test(l)) closes.push(i + 1); else if (MID.test(l)) mids.push(i + 1); });
      // A lone `<<<<<<< ` in a string is not a conflict; a conflict has both ends.
      if (!opens.length || !closes.length) continue;
      const hits = opens.map((n) => ({ line: n, snippet: snippet(lines[n - 1]) }));
      out.push(finding({
        severity: "high", files: [r], key: r,
        title: `${r}: ${opens.length} unresolved conflict marker(s)`,
        detail: hits.slice(0, 10).map((h) => `  L${h.line}  ${h.snippet}`).join("\n"),
        evidence: { lines: opens.slice(0, 20), closes: closes.slice(0, 20), separators: mids.slice(0, 20), count: opens.length, hits: hits.slice(0, 20) },
        fix_hint: "Resolve the conflict. Nothing that reads this file can succeed until it is gone.",
      }));
    }
    return out;
  },
};
