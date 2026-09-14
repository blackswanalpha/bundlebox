// doc-drift — a number a document states about this tree, against the count.
//
// These are the numbers a session reads at orientation and then plans from. A
// stale one is worse than a missing one: the session does not go and check.
// Only claims the tool can COUNT are reported; a sentence about "12 routes"
// is left alone because a guess would be a second wrong number.
import { PROSE_SUFFIX } from "../core/fs.js";
import { blankFences, corpus, finding, isTest, lineIndex, packageJson, snippet } from "./_shared.js";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function num(tok) {
  const t = tok.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  if (ONES.includes(t)) return ONES.indexOf(t);
  const [head, tail] = t.split("-");
  if (TENS.indexOf(head) >= 2) { const base = TENS.indexOf(head) * 10; if (!tail) return base; if (ONES.indexOf(tail) > 0 && ONES.indexOf(tail) < 10) return base + ONES.indexOf(tail); }
  return null;
}
/** Render n the way `like` was written: digits stay digits, words stay words,
 *  a capital stays a capital. "fourteen" becomes "fifteen", not "15". */
export function word(n, like) {
  if (/^\d+$/.test(like.trim()) || n > 99) return String(n);
  const w = n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  return /^[A-Z]/.test(like) ? w[0].toUpperCase() + w.slice(1) : w;
}

const NUMBER = "(\\d+|[A-Za-z]+(?:-[a-z]+)?)";
const EXT = "(?:\\.?(js|ts|py|go|rs|dart|rb|php|java|kt|md|json|ya?ml|sh|css|html))";
const CLAIM = new RegExp(`\\b${NUMBER}\\s+(?:(npm|package)\\s+)?(?:${EXT}\\s+)?(detectors?|tests?|test files?|files|scripts?|markdown files?|npm scripts?|bin entries|bin entry)\\b`, "gi");
const DOC = /^(README[^/]*\.md|CLAUDE\.md|AGENTS\.md|CONTRIBUTING\.md|docs\/.*\.md)$/i;

/** What the tool can count. Each counter returns a number or null (unknown). */
function counters(ctx) {
  const rels = [...corpus(ctx).keys()];
  const pj = packageJson(ctx);
  return {
    detectors: () => { const n = rels.filter((r) => /(^|\/)detectors\/[^/_][^/]*\.[a-z]+$/.test(r) && !/(^|\/)index\.[a-z]+$/.test(r)).length; return n || null; },
    tests: () => { const n = rels.filter((r) => isTest(r) && !PROSE_SUFFIX.some((s) => r.endsWith(s))).length; return n || null; },
    files_ext: (ext) => rels.filter((r) => r.endsWith("." + ext)).length,
    npm_scripts: () => (pj?.scripts ? Object.keys(pj.scripts).length : null),
    scripts_dir: () => { const n = rels.filter((r) => /^scripts\//.test(r)).length; return n || null; },
    markdown: () => rels.filter((r) => r.endsWith(".md")).length,
    bin: () => (pj?.bin ? (typeof pj.bin === "string" ? 1 : Object.keys(pj.bin).length) : null),
  };
}

/** Every countable claim in every doc: [{doc, line, label, claimed, counted, start, end, token, sentence}]. */
export function claims(ctx) {
  const c = counters(ctx);
  const out = [];
  for (const [r, raw] of corpus(ctx)) {
    if (!DOC.test(r)) continue;
    const text = blankFences(raw);
    const lineOf = lineIndex(text);
    const nth = {};
    for (const m of text.matchAll(CLAIM)) {
      const [, tok, qual, ext, noun] = m;
      const claimed = num(tok);
      if (claimed == null) continue;
      const n = noun.toLowerCase().replace(/s$/, "");
      let label, counted;
      if (n === "detector") { label = "detectors"; counted = c.detectors(); }
      else if (n === "test" || n === "test file") { label = "test files"; counted = c.tests(); }
      else if (n === "file" && ext) { label = `${ext} files`; counted = c.files_ext(ext.toLowerCase()); }
      else if (n === "markdown file") { label = "markdown files"; counted = c.markdown(); }
      else if (n === "npm script" || (n === "script" && qual)) { label = "npm scripts"; counted = c.npm_scripts(); }
      else if (n === "script") { label = "scripts/ files"; counted = c.scripts_dir(); }
      else if (n === "bin entry" || n === "bin entrie") { label = "bin entries"; counted = c.bin(); }
      else continue;                      // "files" alone, "routes": the tool cannot count it
      if (counted == null) continue;      // unknown, never a guess
      nth[label] = (nth[label] || 0) + 1;
      out.push({ doc: r, line: lineOf(m.index), label, key: `${r}:${label}#${nth[label]}`, claimed, counted, token: tok,
        start: m.index, end: m.index + m[0].length, sentence: snippet(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\n/g, " "), 160) });
    }
  }
  return out;
}

export default {
  name: "doc-drift", precision: "exact", severity: "medium",
  description: "counts stated in README/CLAUDE.md/AGENTS.md/docs compared with what the tree holds",
  run(ctx) {
    const out = [];
    for (const cl of claims(ctx)) {
      if (cl.claimed === cl.counted) continue;
      out.push(finding({
        severity: "medium", files: [cl.doc], key: cl.key,
        title: `${cl.doc}:${cl.line} says ${cl.token} ${cl.label}; counted ${cl.counted}`,
        detail: cl.sentence,
        evidence: { doc: cl.doc, line: cl.line, label: cl.label, claimed: cl.claimed, counted: cl.counted, delta: cl.counted - cl.claimed, form: /^\d+$/.test(cl.token) ? "digits" : "words", sentence: cl.sentence },
        auto_fix: "sync-doc-counts",
        fix_hint: "One number on one line. The count is derived from the tree, so the document is what is wrong.",
      }));
    }
    return out;
  },
};
