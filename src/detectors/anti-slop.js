// anti-slop — JavaScript and TypeScript patterns that are not bugs and are not
// style either: each one is a place where the code claims less than it knows.
//
// Three families, and the reason each is worth a finding rather than a lint
// warning nobody reads:
//
//   COST      a second eager pass over an array, or an accumulator copied once
//             per element. Both are quadratic where linear was available and
//             both are invisible until the array is large.
//   EVIDENCE  a chained assertion, `any` in a contract, an open dictionary.
//             Each throws away a type the caller already proved, so the next
//             reader — human or agent — has to re-derive it from the call site.
//   SEAM      a mocked module. The test then proves the mock works.
//
// Measured, not guessed: every hit carries the file, the line and the text.
// Comment lines are skipped, because a pattern inside a comment is prose.
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";

const JS = new Set(["js", "ts"]);
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

/** Every rule is a name, a pattern, what it costs and what to do instead.
 *  Data, so adding one is a row and not a branch. */
export const RULES = [
  { id: "filter-then-map", re: /\.filter\s*\([^;]*\)\s*\.map\s*\(/,
    why: "two eager passes over the same array",
    fix: "one `.flatMap` or one `for…of` that tests and pushes in a single pass" },
  { id: "reduce-accumulator-copy", re: /\.reduce\s*\(\s*\(?\s*[\w$]+[^)]*\)?\s*=>\s*\(?\s*[{[]\s*\.\.\./,
    why: "the accumulator is copied once per element, so the reduce is quadratic",
    fix: "mutate a local object or Map inside the reducer and return it, or build with `Object.fromEntries`" },
  { id: "chained-assertion", re: /\bas\s+(?!const\b)[\w.<>[\]|\s]+\s+as\s+(?!const\b)[\w.<>[\]]/,
    why: "an assertion asserted again fabricates a type nothing checked",
    fix: "parse at the boundary and carry the parsed type, or narrow with a predicate that can fail" },
  { id: "conditional-empty-spread", re: /\.\.\.\(\s*[^)]*\?\s*\{[^}]*\}\s*:\s*\{\s*\}\s*\)|\.\.\.\(\s*[^)]*&&\s*\{[^}]*\}\s*\)/,
    why: "a field that is sometimes absent and sometimes present, decided at a call site",
    fix: "declare the field optional and assign it, so every reader sees one shape" },
  { id: "module-mock", re: /\b(vi|jest)\.(mock|doMock)\s*\(|unstable_mockModule\s*\(/,
    why: "the test then proves the mock works",
    fix: "pass the dependency in, and give the test the real one it wants" },
  { id: "open-dictionary", re: /Record\s*<\s*string\s*,\s*(any|unknown|object)\s*>|\{\s*\[\s*\w+\s*:\s*string\s*\]\s*:\s*(any|unknown)\s*\}/,
    why: "a dictionary whose values are unconstrained is a contract that promises nothing",
    fix: "name the value type, or a finite key union, so a wrong read fails where it is written" },
  { id: "reflect-escape", re: /\bReflect\.(get|apply)\s*\(/,
    why: "property access and calls routed around the type system",
    fix: "call the function, or read the property, and let the checker see it" },
  { id: "any-contract", re: /(\([^)]*:\s*any\b[^)]*\)|\)\s*:\s*any\b)/,
    why: "`any` in a signature spreads: every caller of it is also unchecked",
    fix: "the narrowest type the body actually needs, or `unknown` plus one parse at the edge" },
];

const TS_ONLY = new Set(["chained-assertion", "open-dictionary", "any-contract"]);

export default {
  name: "anti-slop", precision: "exact", severity: "low",
  description: "JS/TS patterns that discard evidence or pay a quadratic cost: double array passes, copied reducer accumulators, chained assertions, `any` contracts, open dictionaries, mocked modules",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    for (const r of codeRels(ctx)) {
      const lang = langOf(r);
      if (!JS.has(lang)) continue;
      const ts = lang === "ts" || /\.tsx?$/.test(r);
      const hits = [];
      const byRule = {};
      text.get(r).split("\n").forEach((line, i) => {
        if (COMMENT.test(line)) return;
        for (const rule of RULES) {
          if (TS_ONLY.has(rule.id) && !ts) continue;
          if (!rule.re.test(line)) continue;
          hits.push({ line: i + 1, rule: rule.id, snippet: snippet(line) });
          byRule[rule.id] = (byRule[rule.id] || 0) + 1;
          return;
        }
      });
      if (!hits.length) continue;
      const names = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
      out.push(finding({
        // One rule firing once is a note and is filed as one: `info` never
        // promotes, so a single `.filter().map()` over a three-element array
        // cannot become a work unit. Three rules in one file is a habit.
        severity: hits.length >= 6 || names.length >= 3 ? "medium" : hits.length >= 2 ? "low" : "info",
        files: [r], key: r,
        // One rule here is a rewrite; the other seven are decisions about a
        // type or a seam, and the actuator declines each of them by name.
        auto_fix: hits.some((h) => h.rule === "filter-then-map") ? "flatten-filter-map" : null,
        title: `${r}: ${hits.length} anti-slop hit(s) — ${names.map(([n, c]) => `${c} ${n}`).join(", ")}`,
        detail: hits.slice(0, 20).map((h) => {
          const rule = RULES.find((x) => x.id === h.rule);
          return `  L${h.line}  ${h.rule}: ${rule.why}\n          ${h.snippet}`;
        }).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length, rules: byRule },
        fix_hint: names.map(([n]) => `${n}: ${RULES.find((x) => x.id === n).fix}`).join(" · "),
      }));
    }
    return out;
  },
};
