// guidelines.js — the instruction a session gets, written from what was measured.
//
// A guideline is published only for a rule that has hits in THIS tree, and
// every number in it comes from the stored scan: the files, the medians, the
// bar. Four parts, in this order on purpose: the rule as one imperative
// sentence (it has to survive being pasted alone), the evidence here, the
// failure it prevents, and a check that can be run WHILE WRITING against the
// tree's own medians. "Keep functions short" changes nothing; "this tree's
// median longest function is 41 lines, split before 60" is a check a model can
// apply to its own output before it finishes the line.
import fs from "node:fs";
import path from "node:path";
import { rel, abs } from "../core/paths.js";
import { human } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { makeRegistry } from "../kit/registry.js";
import * as runner from "../kit/runner.js";
import * as rules from "./rules.js";

export const DIR = path.join(rules.DIR, "guidelines");
export const agentLinesPath = () => path.join(DIR, "AGENT-lines.md");

const fmt = (n) => (n == null ? "?" : Number.isInteger(n) ? String(n) : Number(n).toFixed(n < 1 ? 3 : 1).replace(/\.?0+$/, ""));
const pct = (r) => `${Math.round((r || 0) * 100)}%`;
const bar = (t, name, med) => Math.max(t[`${name}_floor`], t[`${name}_x_median`] * (med || 0));
/** The medians the check quotes: one tree's when the scan has one, the largest tree's otherwise. */
function medians(doc) {
  const trees = Object.entries(doc.base || {});
  if (!trees.length) return { tree: ".", b: {} };
  const [tree, b] = trees.sort((p, q) => q[1].files - p[1].files)[0];
  return { tree, b };
}

/** id -> {title, rule, why, check(doc)}. Prose lives here; numbers come from the scan. */
export const CATALOGUE = {
  "god-file": {
    title: "Read the region, not the file",
    rule: "Before opening a file the scan lists as a god file, locate the symbol and read its range.",
    why: "A file that does not fit a payload lands whole in every session that touches any part of it, and the churn multiplier is paid on all of it. The region a change needs is usually under 5% of the file.",
    check: (doc, t) => { const { tree, b } = medians(doc); return `This tree's median file is ${fmt(b.median_lines)} lines; the god-file bar here is ${fmt(bar(t, "god_lines", b.median_lines))} lines with ${t.god_functions}+ functions, or ${pct(t.god_payload_share)} of a ${human(doc.capacity)}-token payload. When the file you are adding to is past that bar, add the code somewhere else and ask for a line range instead of the file (tree \`${tree}\`).`; },
  },
  bloat: {
    title: "One function, one thing",
    rule: "Split a function before it passes this tree's own long-function bar; past the nesting bar, return early instead of indenting.",
    why: "A long or deeply nested function is what makes a change unreviewable and a test impossible to write against one branch.",
    check: (doc, t) => { const { b } = medians(doc); return `Count while you write: this tree's median longest function is ${fmt(b.median_fn_max)} lines and its median nesting depth is ${fmt(b.median_depth)}. The bars are ${fmt(bar(t, "long_function", b.median_fn_max))} lines and depth ${fmt(bar(t, "nesting", b.median_depth))}. If the function you are writing crosses either, the seam is usually at a blank line you already put in.`; },
  },
  duplication: {
    title: "One copy of a decision",
    rule: "Before writing a block that resembles one you have seen in this tree, find it and call it.",
    why: "Two copies of a rule are two places a fix has to land, and the second one never gets it. A session that must read both copies to be sure they agree pays for the same lines twice.",
    check: (doc, t) => `The scan reports pairs sharing ${t.dupe_pair_lines}+ normalised lines in ${t.dupe_window}-line windows. If the block you are writing felt familiar, grep the symbols table for the nearest name, read the one hit, and call it or state in a comment why this case differs.`,
  },
  "vibe-coded": {
    title: "Say why, never what",
    rule: "Write comments that explain a decision. Delete any comment that restates the line below it, any commented-out code, and any V2 beside a V1.",
    why: "A comment that restates the line under it fills the space where the reason should be. A file where such marks cluster is a file nobody has read since it was written.",
    check: (doc, t) => { const { b } = medians(doc); const med = Math.max(b.median_mark_density || 0, 0.5); return `This tree's median mark density is ${fmt(med)} per 100 code lines; the bar is ${fmt(Math.max(t.vibe_density_floor, med * t.vibe_density_x_median))}. Before finishing a file, count its narration comments, commented-out lines, TODOs, twins and unnamed numbers; more than ${fmt(Math.max(t.vibe_density_floor, med * t.vibe_density_x_median))} per 100 lines is over the bar.`; },
  },
  suppression: {
    title: "Fix it or name it",
    rule: "Never add a bare suppression. A suppression carries the reason it is correct, on the same line.",
    why: "Each suppression removes one file from the analyser's coverage; the gate stays green because it stopped looking, and a bare one gets copied by the next person who hits the same error.",
    check: (doc, t) => { const { b } = medians(doc); return `This tree's median is ${fmt(b.median_suppressions)} suppressions per file and the bar is ${fmt(bar(t, "suppressions", b.median_suppressions))}. Before writing \`eslint-disable\`, \`@ts-ignore\`, \`# noqa\` or \`# type: ignore\`, satisfy the check or put the reason on the same line.`; },
  },
  "swallowed-errors": {
    title: "Never drop a failure",
    rule: "An empty catch is a bug. Record, degrade, or rethrow, and say which in the catch body.",
    why: "`catch (e) {}` and `except: pass` decide that a failure does not need to be visible, once, silently, at a keystroke, and nothing downstream can tell it happened.",  // quoted example, not a catch
    check: (doc, t) => { const { b } = medians(doc); return `This tree's median is ${fmt(b.median_swallows)} swallowed errors per file and the bar is ${fmt(bar(t, "swallows", b.median_swallows))}. Every catch body you write has at least one statement, and if that statement is a comment it says why the failure is safe to ignore.`; },
  },
  "commented-code": {
    title: "Delete it; git has it",
    rule: "Never leave code commented out.",
    why: "A commented block reads as live on every search and is a previous version nobody decided to delete.",
    check: (doc, t) => { const { b } = medians(doc); return `This tree's median is ${fmt(b.median_commented_code)} commented-out lines per file and the bar is ${fmt(bar(t, "commented_code", b.median_commented_code))}. When you replace a block, remove it rather than commenting it.`; },
  },
  "comment-poor": {
    title: "Write down the decisions",
    rule: "A file over the size bar carries at least one comment per non-obvious decision.",
    why: "A long file with no comments makes every reader rediscover its choices, and a session pays that in reads.",
    check: (doc, t) => { const { b } = medians(doc); return `This tree's median comment ratio is ${pct(b.median_comment_ratio)}; the bar for a file over ${t.comment_poor_lines} lines is ${pct(Math.min(t.comment_ratio_floor, t.comment_ratio_x_median * (b.median_comment_ratio || 0)))}. One line of why per branch you would have to explain in review.`; },
  },
};

function doc(rule, doc_, findings) {
  const c = CATALOGUE[rule];
  const t = doc_.thresholds || rules.DEFAULT_THRESHOLDS;
  const top = findings.slice(0, 10);
  const L = [`# ${c.title}`, "", `**${c.rule}**`, "",
    "## Evidence in this tree", "",
    `\`bb oversight scan\` on ${String(doc_.at).slice(0, 10)} over ${doc_.trees.join(", ")}: ${doc_.totals.files} files, ${human(doc_.totals.code_lines)} code lines. ${findings.length} finding(s) for this rule.`, "",
    ...top.map((f) => `- ${f.title}`), "",
    "## Why", "", c.why, "",
    "## While writing", "", c.check(doc_, t), ""];
  const marks = top.flatMap((f) => f.evidence?.marks || []).slice(0, 10);
  if (marks.length) L.push("Examples, with line numbers:", "", "```", ...marks.map((k) => `${k.kind.padEnd(20)} :${String(k.line).padEnd(6)} ${k.text}`), "```", "");
  L.push("---", "", "_Generated by `bb oversight guidelines --build` from the stored scan. Do not edit; change `oversight` thresholds in `.bundlebox/config.json` or re-scan._");
  return L.join("\n");
}

/** Write one document per rule with hits, INDEX.md, and AGENT-lines.md. Uses
 *  the stored scan (pass one to avoid a re-read). */
export function build(scanDoc = rules.latest()) {
  if (!scanDoc) return null;
  const byRule = {};
  for (const f of scanDoc.findings || []) { const r = f.detector.replace(/^oversight:/, ""); (byRule[r] ||= []).push(f); }
  const reg = makeRegistry("oversight-guidelines", DIR, {
    title: "oversight — the guidelines this tree measured itself needing",
    blurb: "Each is one imperative sentence plus the measurement from THIS tree that produced it. Only rules with hits are published.\nPaste-ready lines: [`AGENT-lines.md`](AGENT-lines.md), never inserted anywhere for you.",
  });
  const inputs = () => [rules.latestPath()];
  for (const r of rules.RULES) if (byRule[r]?.length) reg.add({ name: r, group: "measured", description: CATALOGUE[r].rule, inputs, build: () => doc(r, scanDoc, byRule[r]) });
  // Stale documents for rules that no longer fire would be quoted by pinpoint as current.
  for (const r of rules.RULES) if (!byRule[r]?.length) { try { fs.rmSync(path.join(DIR, `${r}.md`)); } catch { /* not there */ } }
  return runner.build(reg, { force: true }).then((rows) => { agentLines(scanDoc); return { rows, registry: reg, index: path.join(DIR, "INDEX.md") }; });
}

/** The paste-ready block, ranked by finding count. Written, never inserted:
 *  a line in an agent's instructions file is a standing order for every future
 *  session, and that is a person's call. */
export function agentLines(scanDoc = rules.latest()) {
  if (!scanDoc) return null;
  const counts = Object.fromEntries(rules.RULES.map((r) => [r, (scanDoc.findings || []).filter((f) => f.detector === `oversight:${r}`).length]));
  const ranked = rules.RULES.filter((r) => counts[r]).sort((p, q) => counts[q] - counts[p]);
  const L = ["# Agent-instruction lines, from what this tree measures", "",
    "Paste what you agree with into CLAUDE.md, AGENTS.md or the equivalent. Nothing here is inserted for you.", "",
    `Measured ${String(scanDoc.at).slice(0, 16)} over ${scanDoc.trees.join(", ")}.`, "", "```markdown", "## How to work in this tree"];
  for (const r of ranked) L.push(`- ${CATALOGUE[r].rule}  <!-- ${counts[r]} file(s) -->`);
  if (!ranked.length) L.push("- (no rule fired on the last scan)");
  L.push("```", "", "| guideline | findings |", "|---|---|", ...ranked.map((r) => `| [\`${r}\`](${r}.md) | ${counts[r]} |`));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(agentLinesPath(), L.join("\n") + "\n");
  return agentLinesPath();
}

/** What a session must know before editing THESE files, under 300 tokens, from
 *  the stored scan only. */
export function brief(paths, scanDoc = rules.latest(), { maxTokens = 300 } = {}) {
  const rels = paths.map((p) => rel(abs(p)));
  if (!scanDoc) return `no oversight scan on file; run \`bb oversight scan\` (files: ${rels.join(", ")})`;
  const byPath = new Map((scanDoc.files || []).map((m) => [m.path, m]));
  const L = [`oversight ${String(scanDoc.at).slice(0, 10)}:`];
  for (const r of rels) {
    const m = byPath.get(r);
    const hits = (scanDoc.findings || []).filter((f) => (f.files || []).includes(r));
    if (!m && !hits.length) { L.push(`- ${r}: not in the last scan`); continue; }
    const head = m ? `${m.lines} lines, ~${human(m.tokens)} tok, ${m.functions} fn (longest ${m.fn_max}), depth ${m.max_depth}, ${m.mark_total} marks` : "";
    L.push(`- ${r}: ${head}`);
    for (const f of hits.slice(0, 3)) L.push(`  - ${f.detector.replace(/^oversight:/, "")}: ${f.title.replace(/^`[^`]*`:?\s*(is\s)?/, "")}`);
    const twins = (scanDoc.dupes?.pairs || []).filter((p) => rel(p.a) === r || rel(p.b) === r).slice(0, 2);
    for (const p of twins) L.push(`  - shares ${p.shared_lines} lines with ${rel(p.a) === r ? rel(p.b) : rel(p.a)}; a fix here probably lands there too`);
  }
  // Trim whole lines from the end until it fits; a cut mid-line reads as complete.
  while (L.length > 1 && estimate.text(L.join("\n"), "prose") > maxTokens) L.pop();
  return L.join("\n");
}
