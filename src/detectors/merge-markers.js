// merge-markers — a conflict resolved by saving the file with the markers in.
// Nothing downstream works: the compiler, the tests and every lane that opens
// the file fail on the same three lines, each of them expensively.
import { blankFences, corpus, finding, isGeneratedText, snippet } from "./_shared.js";

const OPEN = /^<{7} /, CLOSE = /^>{7} /, MID = /^={7}(?: |$)/;

/** Every conflict block in a text, with 1-based line numbers and both sides.
 *  Exported so the detector's idea of a block and the actuator's cannot drift
 *  apart. `identical` marks the one block a machine may resolve: when the two
 *  sides are byte-identical there is nothing to choose between, which is what
 *  git writes when the same change arrives down two paths. */
export function conflictBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OPEN.test(lines[i])) continue;
    let mid = -1, close = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (OPEN.test(lines[k])) break;                 // nested: not a shape this understands
      if (mid < 0 && MID.test(lines[k])) mid = k;
      else if (CLOSE.test(lines[k])) { close = k; break; }
    }
    if (mid < 0 || close < 0) { out.push({ open: i + 1, mid: null, close: null, identical: false }); continue; }
    const ours = lines.slice(i + 1, mid), theirs = lines.slice(mid + 1, close);
    out.push({ open: i + 1, mid: mid + 1, close: close + 1, ours, theirs, identical: ours.join("\n") === theirs.join("\n") });
    i = close;
  }
  return out;
}

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
      // An actuator only when a block needs no choice made. A file of real
      // conflicts names none, so `bb fix` never reports it as closeable.
      const identical = conflictBlocks(text).filter((b) => b.identical);
      out.push(finding({
        severity: "high", files: [r], key: r,
        auto_fix: identical.length ? "resolve-identical-conflict" : null,
        title: `${r}: ${opens.length} unresolved conflict marker(s)`,
        detail: hits.slice(0, 10).map((h) => `  L${h.line}  ${h.snippet}`).join("\n"),
        evidence: { lines: opens.slice(0, 20), closes: closes.slice(0, 20), separators: mids.slice(0, 20), count: opens.length, hits: hits.slice(0, 20), identical: identical.length },
        fix_hint: "Resolve the conflict. Nothing that reads this file can succeed until it is gone.",
      }));
    }
    return out;
  },
};
