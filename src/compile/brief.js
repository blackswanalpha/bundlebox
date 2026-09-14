// brief.js — a packed brief: evidence, regions, prior art, scope, acceptance.
//
// A session that has to find out what is wrong pays for the search twice: once
// in the tool results it reads, once in the context those results occupy for
// the rest of the run. The detectors already know what is wrong, exactly, so the
// brief's entire job is to hand that over in a form the session does not have
// to verify.
//
// Four rules the briefs follow:
//
//   Evidence, not pointers.  "table X is missing key Y" beats "check the
//   tables", by roughly the cost of reading two 1000-line files.
//
//   Say it once.  Six findings of one detector in one directory share a file,
//   a procedure and most of their evidence. Repeating those six times is six
//   times the tokens for one fact, so the shared part is hoisted into a header
//   and the per-finding part is reduced to the row that differs.
//
//   Region, not file.  The brief carries the REGION inline, with its line
//   numbers, so the common case is a session that never opens the file.
//
//   Acceptance is a command.  Not a description. The lane runs it and the exit
//   code is the verdict, so nothing has to be re-reviewed by a second session.
//   Its output is capped, because a failing analyzer is thousands of lines and
//   a session that reads all of them has spent a unit's budget learning it failed.
import { human } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import * as anc from "./anchors.js";

// Facts every lane needs and none should discover. Kept short on purpose: this
// is paid once per lane, and it is competing with the actual work.
//
// The token-discipline half is here rather than assumed, because lanes are
// opened lean: the user-level instructions that carry these habits in an
// interactive session are deliberately NOT loaded, and dropping them is most of
// the overhead saving. Whatever a lane needs from them, it needs here.
export const GUARDRAILS = `Constraints:
- Edit only files listed in Scope. Do not widen.
- Do not run a test suite. The acceptance command is the check.
- Never format a directory. One file at a time.
- Do not create files unless the task says to.

Budget:
- The Evidence is complete and correct. Do not re-derive it.
- Regions are quoted with line numbers. Read a file only if you need code the
  region does not show, and then read that range, not the file.
- Do not re-read a file you just edited. The edit tool already reported the result.
- No summary of what you are about to do, and no recap of what you did.
`;

// A command whose output a session will read. Uncapped, a failing analyzer is
// thousands of lines and a lane spends its remaining window learning it failed.
export const TAIL = 4000;
// The command already bounds its own output only when the bound is the LAST
// stage. `x | tail -n 5 | sort` still emits everything sort produces.
const BOUNDED = /\|\s*(?:tail|head)\b[^|]*$/;

/** Acceptance, with its output bounded. The exit code is what matters and
 *  `pipefail` is what keeps it after a pipe. */
export function cap(cmd, limit = TAIL) {
  cmd = String(cmd || "").trim();
  if (!cmd || BOUNDED.test(cmd)) return cmd;
  return `set -o pipefail; { ${cmd} ; } 2>&1 | tail -c ${limit}`;
}

const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** Every string literal inside a value, at any depth. */
function literals(v, acc = []) {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) for (const x of v) literals(x, acc);
  else if (v && typeof v === "object") for (const x of Object.values(v)) literals(x, acc);
  return acc;
}
/** True when every string in `v` already appears in the detail the detector
 *  wrote. Detectors that render their own evidence as lines and ALSO carry the
 *  same rows in `evidence` were paying for one fact twice — measured at 16% of
 *  a ui-generic brief. Numbers alone never qualify: a count is not a restatement
 *  of the line it was counted from. */
function covered(v, detail) {
  const ls = literals(v).filter((x) => x.length >= 3);
  return ls.length > 0 && ls.every((x) => detail.includes(x));
}
const empty = (v) => v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
// Sorted keys so two findings with the same evidence print byte-identical
// rows, which is what lets the prompt cache treat them as one prefix.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** One header for what the findings share, one row for what they do not.
 *
 *  Six findings of one detector carry the same table name, the same file pair
 *  and the same 60-word hint. Printed per finding that is six copies of one
 *  fact; hoisted it is one. */
export function evidenceBlock(findings) {
  const evs = findings.map((f) => f.evidence || {});
  // Hoisting needs something to hoist FROM. With one finding there is no
  // repetition to remove and a "common to every item below" header over a list
  // of one is a heading that costs more than it saves.
  const shared = {};
  if (findings.length >= 2) {
    for (const [k, v] of Object.entries(evs[0])) {
      if (isScalar(v) && evs.slice(1).every((e) => e[k] === v)) shared[k] = v;
    }
  }
  const hints = [...new Set(findings.map((f) => f.fix_hint).filter(Boolean))].sort();

  const out = [];
  const keys = Object.keys(shared).sort();
  if (keys.length) {
    out.push("Common to every item below:");
    for (const k of keys) out.push(`  ${k}: ${shared[k]}`);
    out.push("");
  }
  for (const f of findings) {
    out.push(`- ${f.title}`);
    // `detail` is prose the detector wrote and it is not always a restatement
    // of the evidence: for a review finding it IS the reviewer's comment, and a
    // brief without it asks a session to go and read the thread.
    const detail = String(f.detail || "").slice(0, 1500);
    for (const line of detail.split("\n")) out.push(`    ${line}`);
    const ev = f.evidence || {};
    for (const k of Object.keys(ev).sort()) {
      if (k in shared || empty(ev[k]) || covered(ev[k], detail)) continue;
      // Compact JSON on purpose: indented output on a 4-element list of short
      // strings is four lines and a dozen tokens of whitespace for what reads
      // identically on one.
      const s = typeof ev[k] === "string" ? ev[k] : stable(ev[k]);
      out.push(`    ${k}: ${s.slice(0, 1200)}`);
    }
  }
  for (const h of collapse(hints)) out.push("", `Procedure: ${h}`);
  return out.join("\n");
}

/** Six hints that differ by one name are one hint with a hole in it.
 *
 *  Collapsed only when the shared prefix and suffix are most of the text (80%
 *  of the shortest hint); below that the hints really are different and merging
 *  them would be losing information to save a line. */
export function collapse(hints) {
  if (hints.length < 2) return hints;
  const shortest = Math.min(...hints.map((h) => h.length));
  const first = hints[0];
  // Across ALL of them, not just the outermost pair: two hints can share a
  // trailing "s-screen" that a third does not, and a suffix taken from the
  // pair would then match nothing.
  let pre = 0;
  while (pre < shortest && hints.every((h) => h[pre] === first[pre])) pre++;
  let suf = 0;
  while (suf < shortest - pre && hints.every((h) => h[h.length - 1 - suf] === first[first.length - 1 - suf])) suf++;
  if (pre + suf < 0.8 * shortest) return hints;
  return [`${first.slice(0, pre)}<per item above>${first.slice(first.length - suf)}`];
}

/** The prior-art section. `rows` are {sha, date, subject, stat} from git log;
 *  empty or null renders nothing, because a heading over nothing is a lie. */
export function priorBlock(rows) {
  if (!rows || !rows.length) return "";
  const out = ["## Prior art — the last time this rule was fixed here", "",
    "These are real commits from this repo. Reuse the shape; do not assume the same files.", ""];
  for (const c of rows) {
    out.push(`- ${c.subject}  (commit ${String(c.sha).slice(0, 8)}${c.date ? `, ${c.date}` : ""})`);
    for (const ln of String(c.stat || "").split("\n").filter((l) => l.trim()).slice(0, 8)) out.push(`    ${ln.trim()}`);
  }
  out.push("");
  return out.join("\n");
}

/** The brief. Guardrails go LAST here because a person reads the title first;
 *  `cacheStablePrefix` reorders for the model. */
export function build({ title, findings, scope, acceptance = "", extra = "", anchors = [], prior = null }) {
  anchors = anchors || [];
  const ev = anchors.length ? anc.payload(scope, anchors) : estimate.files(scope || []);
  const anchored = new Set(ev.anchored || []);
  const scopeLines = Object.entries(ev.files).sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `- ${p}  (~${human(n)} tokens)${anchored.has(p) ? "  [region quoted above]" : ""}`);

  let regions = "";
  if (anchors.length) {
    regions = "\n## The regions this touches — quoted, current, do not re-read\n"
      + anchors.map((a) => "```\n" + anc.excerpt(a) + "\n```").join("\n\n") + "\n";
  }
  const priorText = priorBlock(prior);
  const done = cap(acceptance) || "(no automated acceptance — state what you changed and why)";
  return `# ${title}

## Evidence — already gathered, do not re-derive
${evidenceBlock(findings)}
${regions}${priorText ? "\n" + priorText : ""}
## Scope — the only files you may edit
${scopeLines.join("\n") || "- (none: investigation only)"}

## Done when
Run this and it must pass:

    ${done}

${extra ? extra.trimEnd() + "\n\n" : ""}${GUARDRAILS}`;
}

/** The same brief with the STATIC part first and the dynamic part last.
 *
 *  Prompt caches key on a prefix. Every lane's brief ends with the same
 *  guardrails and starts with evidence nobody else has, so as written the
 *  briefs share no prefix and each lane pays its own cache write. Moved to the
 *  front, the guardrails are one prefix every lane in a run reads from the
 *  cache; the evidence, which is unique per lane, is the only part written. */
export function cacheStablePrefix(brief) {
  const s = String(brief || "");
  const i = s.lastIndexOf(GUARDRAILS);
  if (i < 0) return `${GUARDRAILS}\n${s}`;
  const body = (s.slice(0, i) + s.slice(i + GUARDRAILS.length)).trimEnd();
  return `${GUARDRAILS}\n${body}\n`;
}
