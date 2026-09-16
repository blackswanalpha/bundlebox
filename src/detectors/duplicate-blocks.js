// duplicate-blocks — the same run of code in two files.
//
// Lines are normalised (comments, string contents and whitespace removed) and
// hashed in 8-line windows; a PAIR of files is reported when the lines those
// shared windows cover add up to 24 or more across both sides. Files with few
// distinct lines are tables, not code, and are skipped: a lookup table copied
// between two locales is not a refactor target.
import { langOf } from "../core/fs.js";
import { sha1 } from "../core/util.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";
import * as kernel from "../core/kernel.js";
import { abs, rel } from "../core/paths.js";

export const THRESHOLDS = { window: 8, min_shared_lines: 24, min_distinct_ratio: 0.25, max_locations_per_hash: 50 };
const HASH_COMMENT = new Set(["py", "ruby", "sh", "yaml", "toml", "r", "pl"]);
const TRIVIAL = /^[{}()[\];,]*$/;

export function normalise(r, src) {
  const lang = langOf(r);
  const rows = [];
  src.split("\n").forEach((line, i) => {
    let l = line;
    l = l.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/`(?:\\.|[^`\\])*`/g, "``");
    l = HASH_COMMENT.has(lang) ? l.replace(/#.*$/, "") : l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    l = l.replace(/\s+/g, "");
    if (!l || TRIVIAL.test(l)) return;
    rows.push({ text: l, line: i + 1 });
  });
  return rows;
}

export default {
  name: "duplicate-blocks", precision: "exact", severity: "medium",
  description: "8-line normalised windows shared between two files, 24+ lines in total",
  run(ctx) {
    const W = THRESHOLDS.window;
    const text = corpus(ctx);
    const rels = codeRels(ctx);
    // The kernel runs the same normalisation and window hashing without holding
    // every window of every file in a JS heap. Same pairs, same line counts.
    if (rels.length > 40) {
      const k = kernel.call("dupes", { paths: rels.map(abs), window: W, min_shared_lines: THRESHOLDS.min_shared_lines, min_distinct_ratio: THRESHOLDS.min_distinct_ratio,
        hash_comment_paths: rels.filter((r) => HASH_COMMENT.has(langOf(r))).map(abs) });
      if (k && Array.isArray(k.pairs)) {
        return k.pairs.map((p) => {
          const a = rel(p.a), b = rel(p.b);
          const line = (text.get(a) || "").split("\n")[p.a_line - 1];
          return finding({
            severity: "medium", files: [a, b], path: a, key: `${a}|${b}`, auto_fix: "plan-block-lift",
            title: `${a} and ${b}: ${p.shared_lines} lines in shared ${W}-line windows`,
            detail: `  ${a}:${p.a_line}-${p.a_end}\n  ${b}:${p.b_line}\n  ${snippet(line)}`,
            evidence: { shared_lines: p.shared_lines, first: { a: `${a}:${p.a_line}-${p.a_end}`, b: `${b}:${p.b_line}`, snippet: snippet(line) }, thresholds: THRESHOLDS, via: "kernel" },
            fix_hint: "Lift the shared block into one place. If the two copies are meant to diverge, say so in a comment at each.",
          });
        });
      }
    }
    const locs = new Map();    // hash -> [{r, start, end}]
    for (const r of rels) {
      const rows = normalise(r, text.get(r));
      if (rows.length < W) continue;
      const distinct = new Set(rows.map((x) => x.text)).size / rows.length;
      if (distinct < THRESHOLDS.min_distinct_ratio) continue;
      for (let i = 0; i + W <= rows.length; i++) {
        const h = sha1(rows.slice(i, i + W).map((x) => x.text).join("\n")).slice(0, 16);
        if (!locs.has(h)) locs.set(h, []);
        locs.get(h).push({ r, start: rows[i].line, end: rows[i + W - 1].line });
      }
    }
    const pairs = new Map();   // "a|b" -> {a, b, linesA:Set, linesB:Set, first}
    for (const [h, ls] of locs) {
      if (ls.length < 2 || ls.length > THRESHOLDS.max_locations_per_hash) continue;
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        const [x, y] = ls[i].r < ls[j].r ? [ls[i], ls[j]] : [ls[j], ls[i]];
        if (x.r === y.r) continue;
        const k = `${x.r}|${y.r}`;
        if (!pairs.has(k)) pairs.set(k, { a: x.r, b: y.r, la: new Set(), lb: new Set(), first: { hash: h, a: x, b: y } });
        const p = pairs.get(k);
        for (let n = x.start; n <= x.end; n++) p.la.add(n);
        for (let n = y.start; n <= y.end; n++) p.lb.add(n);
        if (x.start < p.first.a.start) p.first = { hash: h, a: x, b: y };
      }
    }
    const out = [];
    for (const p of pairs.values()) {
      const shared = p.la.size + p.lb.size;
      if (shared < THRESHOLDS.min_shared_lines) continue;
      const fa = p.first.a, fb = p.first.b;
      out.push(finding({
        severity: "medium", files: [p.a, p.b], path: p.a, key: `${p.a}|${p.b}`, auto_fix: "plan-block-lift",
        title: `${p.a} and ${p.b}: ${shared} lines in shared ${W}-line windows`,
        detail: `  ${p.a}:${fa.start}-${fa.end}\n  ${p.b}:${fb.start}-${fb.end}\n  ${snippet(text.get(p.a).split("\n")[fa.start - 1])}`,
        evidence: { shared_lines: shared, lines_a: p.la.size, lines_b: p.lb.size, first: { a: `${p.a}:${fa.start}-${fa.end}`, b: `${p.b}:${fb.start}-${fb.end}`, snippet: snippet(text.get(p.a).split("\n")[fa.start - 1]) }, thresholds: THRESHOLDS },
        fix_hint: "Lift the shared block into one place. If the two copies are meant to diverge, say so in a comment at each.",
      }));
    }
    return out.sort((x, y) => y.evidence.shared_lines - x.evidence.shared_lines);
  },
};
