// slop/index.js — anti-slop for the prose this factory writes.
//
// `src/detectors/anti-slop.js` is the CODE half, ported from dmmulroy's oxlint
// ruleset: JavaScript and TypeScript shapes where the code claims less than it
// knows. That ruleset is about code and only about code — it has no prose
// rules, and there is no upstream prose ruleset to vendor. This is the same
// idea applied to the other thing bundlebox emits, built in the same shape:
// every rule is a row with a name, a pattern, what it costs and what to do
// instead, so adding one is data and not a branch.
//
// It matters here more than it does in an editor, because every brief this
// factory writes is READ BY A MODEL AND BILLED. A hedge is not a style
// complaint; it is tokens the lane pays for and then has to decide to ignore.
// Three families:
//
//   COST        words that carry nothing. Fillers, intensifiers, "in order to",
//               a closing recap of what the reader just read. Deleted outright.
//   EVIDENCE    a claim with the evidence filed off — "several files", "check
//               the config", "this should work". Each makes the reader go and
//               get what the writer already had.
//   CONFIDENCE  stacked hedges and empty superlatives. Both leave the reader
//               unable to tell what is known from what is guessed.
//
// `strip` only does what cannot lose a fact: deletions and one-for-one
// replacements, never a rewrite. `lint` reports the rest, because a detector
// that silently rewrote a claim would be a worse problem than the claim.
import { text as estimateText } from "../tokens/estimate.js";

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Every rule: what it is called, what it matches, what it costs, and what to
 *  do instead. `fix` present means `strip` applies it; absent means the rule
 *  can only be reported, because the correct replacement is a fact the rule
 *  does not have. */
export const RULES = [
  // ── COST ──────────────────────────────────────────────────────────────────
  { id: "filler-opener", family: "cost",
    // The next letter is captured and re-capitalised HERE rather than by a
    // pass over the line, because a line-wrapped sentence has a full stop in
    // the middle of it and a blanket pass would capitalise the wrong word.
    re: /(^|(?<=[.!?]\s))(basically|essentially|in essence|simply put|at its core|fundamentally|it'?s worth noting that|it is worth noting that|it'?s important to note that|it is important to note that|note that,?|as (?:you can see|we can see)|needless to say),?\s+([a-z])?/gi,
    fix: (m, pre, _word, next) => pre + cap(next || ""),
    why: "an opener that says a sentence is coming, before the sentence",
    to: "delete it and start with the sentence" },

  { id: "announcement", family: "cost",
    re: /(^|(?<=\n))\s*(let'?s |now let'?s |i'?ll now |i will now |first,? i(?:'| wi)ll |here'?s what i found:?|here is what i found:?|let me )[^\n]*\n?/gi,
    fix: () => "",
    why: "narrating the next step instead of taking it",
    to: "do the thing; the result is the report" },

  { id: "closing-recap", family: "cost",
    re: /(^|\n)\s*(in summary|to summari[sz]e|in conclusion|to sum up|overall,|to recap)[^\n]*(\n(?!\n)[^\n]*)*/gi,
    fix: (m, pre) => pre,
    why: "a recap of text the reader has just read, paid for twice",
    to: "delete it; put the conclusion first instead" },

  { id: "intensifier", family: "cost",
    re: /\b(very|really|quite|extremely|incredibly|truly|highly|significantly|substantially|absolutely|definitely|certainly|actually|simply|basically)\s+(?=[a-z])/gi,
    fix: () => "",
    why: "an adverb that moves no number",
    to: "the measurement, or nothing" },

  { id: "long-form", family: "cost",
    re: /\b(in order to|due to the fact that|at this point in time|for the purpose of|in the event that|is able to|are able to|has the ability to|a large number of|in spite of the fact that|with regard to|utili[sz]e[sd]?|leverage[sd]?(?=\s+(?:the|our|its|a|an)\b))\b/gi,
    fix: (m) => ({
      "in order to": "to", "due to the fact that": "because", "at this point in time": "now",
      "for the purpose of": "for", "in the event that": "if", "is able to": "can", "are able to": "can",
      "has the ability to": "can", "a large number of": "many", "in spite of the fact that": "although",
      "with regard to": "about", utilize: "use", utilise: "use", utilizes: "uses", utilises: "uses",
      utilized: "used", utilised: "used", leverage: "use", leverages: "uses", leveraged: "used",
    }[m.toLowerCase()] ?? m),
    why: "four words doing one word's work",
    to: "the short form" },

  { id: "flattery", family: "cost",
    re: /\b(great question|excellent question|you'?re absolutely right|that'?s a great point|happy to help|i hope this helps)\b[!.,]?\s*/gi,
    fix: () => "",
    why: "agreement with nothing behind it",
    to: "delete it; if the point is right, say why" },

  { id: "emoji", family: "cost",
    re: /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}\u{FE0F}\u{2705}\u{274C}\u{2728}]/gu,
    fix: () => "",
    why: "decoration in a document a machine reads",
    to: "nothing" },

  // ── EVIDENCE ──────────────────────────────────────────────────────────────
  { id: "uncounted", family: "evidence",
    re: /\b(several|a number of|various|multiple|numerous|a few|some)\s+(files?|places?|issues?|findings?|tests?|cases?|errors?|callers?|modules?|functions?|rows?|services?)\b/gi,
    why: "a count the writer had, replaced with a word that is not one",
    to: "the number, and the list if it is short" },

  { id: "pointer", family: "evidence",
    re: /\b(check (?:the|your)|take a look at|look at the|refer to the|see the relevant|you (?:may|might) want to|consider (?:checking|looking|reviewing))\b/gi,
    why: "sending the reader to find what the writer already read",
    to: "the finding itself, with the file and the line" },

  { id: "unproven-claim", family: "evidence",
    re: /\b(this should (?:work|fix|resolve|handle)|should be fine|ought to work|will ensure that|this ensures that|properly handles?|correctly handles?)\b/gi,
    why: "a claim about behaviour with no command behind it",
    to: "the acceptance command and its exit code" },

  { id: "vague-subject", family: "evidence",
    re: /(^|(?<=[.!?]\s))(this|that|it) (is|was|means|shows|indicates|suggests) /gi,
    why: "a pronoun standing in for the thing being claimed about",
    to: "name it; the reader cannot scroll back inside a context window" },

  // ── CONFIDENCE ────────────────────────────────────────────────────────────
  { id: "hedge-stack", family: "confidence",
    re: /\b(might|may|could|should|would)\s+(possibly|potentially|perhaps|maybe|likely|conceivably)\b|\b(possibly|potentially|perhaps)\s+(might|may|could)\b/gi,
    why: "two hedges on one claim, which is not twice as careful",
    to: "one hedge, or the measurement that removes the need for either" },

  { id: "empty-superlative", family: "confidence",
    re: /\b(comprehensive|robust|seamless|powerful|cutting.edge|state.of.the.art|world.class|best.in.class|enterprise.grade|blazing(?:ly)? fast|rock.solid|battle.tested)\b/gi,
    why: "an adjective that would be true of anything, so it distinguishes nothing",
    to: "the property it is standing in for, measured" },

  { id: "not-only", family: "confidence",
    re: /\bnot only\b[^.!?]*\bbut also\b/gi,
    why: "a shape that promises two facts and usually delivers one twice",
    to: "both facts, as two sentences, or the one that is real" },

  { id: "dash-chain", family: "confidence",
    re: /[^\n]*—[^\n]*—[^\n]*—[^\n]*/g,
    why: "three dashes in one line, which is three asides and no sentence",
    to: "full stops" },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));
const FENCE = /^(\s*)(```|~~~)/;

/** Inline code is not prose either. A brief that quotes `in order to` as the
 *  literal string a rule matches, or names a field called `several files`, must
 *  come back with that span untouched — this document is the first example of
 *  it, and a ruleset that mangles its own examples is one nobody runs twice.
 *
 *  The span is replaced by NULs of the SAME LENGTH, so every match offset from
 *  the masked line is an offset into the real one, and no rule pattern can
 *  match a NUL. */
function mask(line) {
  return line.replace(/`+[^`]*`+/g, (m) => "\u0000".repeat(m.length));
}

/** Fenced code blocks and indented command lines are never prose: a rule that
 *  fired inside one would delete part of a command the reader has to run. */
function proseLines(textIn) {
  const lines = String(textIn ?? "").split("\n");
  const mask = new Array(lines.length).fill(true);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fenced = !fenced; mask[i] = false; continue; }
    if (fenced) { mask[i] = false; continue; }
    if (/^\s{4,}\S/.test(lines[i])) mask[i] = false;
  }
  return { lines, mask };
}

/** Every hit, with the line, the rule and the text. Measured, not guessed. */
export function lint(textIn, { only = null } = {}) {
  const { lines, mask: isProse } = proseLines(textIn);
  const rules = RULES.filter((r) => !only || only.includes(r.id));
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isProse[i]) continue;
    const subject = mask(lines[i]);
    for (const r of rules) {
      r.re.lastIndex = 0;
      for (const m of subject.matchAll(r.re)) {
        const t = String(m[0]).trim();
        if (!t) continue;
        hits.push({ line: i + 1, rule: r.id, family: r.family, text: t.slice(0, 80) });
      }
    }
  }
  const byRule = {};
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] || 0) + 1;
  return { hits, byRule, count: hits.length };
}

/** Remove what can be removed without losing a fact.
 *
 *  Only deletions and one-for-one replacements: a rule with no `fix` is
 *  reported and never applied, because the correct replacement is a fact the
 *  rule does not have and a detector that invented one would be worse than the
 *  sentence it was fixing. */
export function strip(textIn) {
  const before = String(textIn ?? "");
  const { lines, mask: isProse } = proseLines(before);
  const applied = {};
  const fixable = RULES.filter((r) => r.fix);
  const out = lines.map((line, i) => {
    if (!isProse[i]) return line;
    let s = line;
    for (const r of fixable) {
      r.re.lastIndex = 0;
      // Matched against the masked line so an inline code span is never
      // rewritten, and spliced into the real one at the offsets that gives.
      const edits = [];
      for (const m of mask(s).matchAll(r.re)) {
        applied[r.id] = (applied[r.id] || 0) + 1;
        const v = r.fix(m[0], m[1] ?? "", ...m.slice(2));
        edits.push([m.index, m.index + m[0].length, typeof v === "string" ? v : String(v ?? "")]);
      }
      for (const [from, to, v] of edits.reverse()) s = s.slice(0, from) + v + s.slice(to);
    }
    // A line nothing fired on is returned byte for byte. Whitespace in these
    // documents is structure — an evidence block, a hoisted header, an aligned
    // table — and tidying a line that was already correct is how a cleaner
    // damages the thing it was meant to leave alone.
    if (s === line) return line;
    const indent = /^[ \t]*/.exec(s)[0];
    const rest = s.slice(indent.length).replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1").replace(/[ \t]+$/, "");
    return indent + rest;
  }).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");

  const t0 = estimateText(before, "prose");
  const t1 = estimateText(out, "prose");
  return { text: out, applied, tokens_before: t0, tokens_after: t1, tokens_saved: Math.max(0, t0 - t1) };
}

/** The one call every summary writer in this factory makes. Strips what is
 *  safe and returns the text; the accounting is available from `strip` when a
 *  caller wants to report it. */
export const clean = (textIn) => strip(textIn).text;

// ── the verb ────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { out, warn, emit } from "../core/log.js";
import { table, pad } from "../core/util.js";

const read = (p) => (p === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.isAbsolute(p) ? p : path.join(process.cwd(), p), "utf8"));

async function cmd({ _, flags }) {
  const sub = _[0] || "";
  if (sub === "rules") {
    if (flags.json) { emit({ rules: RULES.map(({ id, family, why, to, fix }) => ({ id, family, why, instead: to, strips: Boolean(fix) })) }); return 0; }
    out(table(RULES.map((r) => [r.family, r.id, r.fix ? "strips" : "reports", r.why]),
      { header: ["family", "rule", "", "what it costs"] }).split("\n").map((l) => "  " + l).join("\n"));
    out("\n  `strips` rules are applied by `bb slop fix` and by every summary this factory writes.");
    out("  `reports` rules never rewrite: the correct replacement is a fact the rule does not have.");
    return 0;
  }

  const target = sub === "fix" || sub === "check" ? _[1] : sub;
  if (!target) { warn("bb slop <file|-> | fix <file|-> | rules"); return 2; }
  let src;
  try { src = read(String(target)); } catch (e) { warn(`cannot read ${target}: ${e.message}`); return 2; }

  if (sub === "fix") {
    const r = strip(src);
    if (flags.apply && target !== "-") {
      fs.writeFileSync(path.isAbsolute(String(target)) ? String(target) : path.join(process.cwd(), String(target)), r.text);
      if (flags.json) { emit({ file: target, ...r, text: undefined }); return 0; }
      out(`  ${target}  ${r.tokens_before} -> ${r.tokens_after} tokens (−${r.tokens_saved})`);
      for (const [id, n] of Object.entries(r.applied)) out(`    ${pad(id, 20)} ${n}`);
      return 0;
    }
    if (flags.json) { emit(r); return 0; }
    process.stdout.write(r.text + "\n");
    return 0;
  }

  const l = lint(src);
  const r = strip(src);
  if (flags.json) { emit({ ...l, tokens_before: r.tokens_before, tokens_after: r.tokens_after, tokens_saved: r.tokens_saved }); return l.count ? 1 : 0; }
  if (!l.count) { out(`  ${target}: clean`); return 0; }
  out(table(l.hits.slice(0, 60).map((h) => [`L${h.line}`, h.family, h.rule, h.text]),
    { header: ["where", "family", "rule", "text"] }).split("\n").map((l2) => "  " + l2).join("\n"));
  out(`\n  ${l.count} hit(s) across ${Object.keys(l.byRule).length} rule(s).`);
  out(`  stripping what is safe: ${r.tokens_before} -> ${r.tokens_after} tokens (−${r.tokens_saved}). bb slop fix ${target} --apply`);
  for (const id of Object.keys(l.byRule)) {
    const rule = BY_ID.get(id);
    if (rule && !rule.fix) out(`  ${pad(id, 20)} not stripped — ${rule.to}`);
  }
  return 1;
}

export const commands = {
  slop: {
    help: "anti-slop for prose: what a summary says that costs tokens and carries nothing (0 model tokens)",
    usage: "bb slop <file|-> | bb slop fix <file|-> [--apply] | bb slop rules [--json]",
    long: [
      "  bb slop README.md              every hit, by rule, with the line",
      "  bb slop fix brief.md --apply   strip what cannot lose a fact, and say what it saved",
      "  bb slop rules                  the ruleset, and which rules rewrite",
      "",
      "Every brief, prompt, commit message and PR body this factory writes is stripped by the same",
      "rules before it is handed over, because a lane pays for every word of it. Exits 1 when a",
      "file has any hit, so it works as a gate.",
    ].join("\n"),
    run: cmd,
  },
};
