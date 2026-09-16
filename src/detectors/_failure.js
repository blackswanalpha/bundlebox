// _failure.js — what the three failure-handling detectors share.
//
// `swallowed-errors` already asks whether a catch discards the error. These ask
// the question after that one: given that the failure WAS noticed, what does
// the code tell its caller happened? Three answers are worth a finding, and
// they are different bugs:
//
//   silent-fallback  a substitute value the caller cannot tell from a real one
//   quiet-degrade    a capability switched off, and execution continues
//   fault-mask       success reported for something that failed
//
// All three need the same two primitives, and one copy of each is the point of
// this file: where a failure branch begins and ends, and whether a literal is
// a value a caller could distinguish from a real answer.
//
// heuristic, all of it: the branches are found by brace and indent scanning
// rather than by a parser, so a condition spanning three lines reads as none.
// The bias is set to under-report. A detector that cries about every `?? 0` is
// one somebody turns off, and then it reports nothing at all.

/** A condition that tests whether something FAILED. */
export const ERROR_COND = /\b(?:rc|code|status|exitCode)\s*(?:!==?|>)\s*0|\b(?:err|error|e)\s*(?:!==?|!=)\s*(?:nil|null|undefined)\b|![\w.]*(?:ok|success|valid|found|exists)\b|\b(?:!res|!result|!out|!data|!body)\b|\.(?:error|failed)\b|\bstatus\s*>=?\s*[45]\d\d/;

/** A comment anywhere on the line. This tree's convention: a fallback somebody
 *  decided on is a fallback somebody wrote a clause about, and every detector
 *  here goes quiet on one. */
export const EXPLAINED = /(\/\/|\/\*|#\s|--\s)/;

// A literal a caller CANNOT tell from a real answer. `null`, `undefined`,
// `false`, `0`, `-1`, `""`, `[]` and `{}` are the conventional ways to say
// "nothing", and a caller tests for them. `"main"`, `30`, `true` and a filled
// object are answers, and a caller that receives one believes it.
const INDISTINCT = /^(?:"[^"]+"|'[^']+'|`[^`$]+`|\{\s*\w+\s*:)/;
const NOTHING = /^(?:null|undefined|false|0|-0|-1|""|''|``|\[\s*\]|\{\s*\}|None|nil)$/;

// A value that states its own failure. `{ ok: false, why }` and `{ rc: 2 }` are
// the failure being RETURNED, which is the fix, not the bug — this tree returns
// them everywhere and a detector that flags them flags its own convention.
const REPORTS_FAILURE = /\b(?:ok|success|valid|passed?)\s*:\s*(?:false|0)|\b(?:rc|code|status|exitCode)\s*:\s*-?[1-9]|\b(?:error|err|why|failed|note|reason|message|declined)\s*:/;

/** True when returning this literal hides the failure from the caller. */
export function indistinct(literal) {
  const v = String(literal ?? "").trim().replace(/;$/, "");
  if (!v || NOTHING.test(v)) return false;
  if (REPORTS_FAILURE.test(v)) return false;
  return INDISTINCT.test(v);
}

const OPEN_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{|^\s*except\b[^:]*:|^\s*rescue\b/;
const INDENT_LANGS = new Set(["py", "ruby"]);

/** Every failure branch in a file, as `{ line, end, kind, head }` with 1-based
 *  inclusive line numbers. `kind` is "catch" when the branch is an exception
 *  handler and "guard" when it is an explicit test for failure. */
export function failureBranches(text, lang) {
  const lines = String(text).split("\n");
  const out = [];
  const indented = INDENT_LANGS.has(lang);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isCatch = OPEN_CATCH.test(l);
    const isGuard = !isCatch && /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/.test(l) && ERROR_COND.test(l);
    if (!isCatch && !isGuard) continue;
    let end = i, startCol = 0, endCol = -1;
    if (indented) {
      const base = (l.match(/^[ \t]*/) || [""])[0].length;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if ((lines[j].match(/^[ \t]*/) || [""])[0].length <= base) break;
        end = j;
      }
    } else {
      // From the brace that opens THIS branch. `(s) => { try { … } catch { … } }`
      // opens three on one line, and counting from the first makes the try body
      // part of the catch — which reads `return true` as a masked fault.
      const kw = isCatch ? l.search(/\bcatch\b|\bexcept\b|\brescue\b/) : l.search(/\bif\b/);
      const from = l.indexOf("{", kw < 0 ? 0 : kw);
      if (from < 0) { out.push({ line: i + 1, end: i + 1, kind: isCatch ? "catch" : "guard", head: l }); continue; }
      let depth = 0, started = false;
      outer: for (let j = i; j < lines.length; j++) {
        for (let k = j === i ? from : 0; k < lines[j].length; k++) {
          const c = lines[j][k];
          if (c === "{") { depth++; started = true; }
          else if (c === "}") depth--;
          if (started && depth === 0) { end = j; endCol = k + 1; break outer; }
        }
        end = j;
      }
      startCol = from;
    }
    out.push({ line: i + 1, end: end + 1, kind: isCatch ? "catch" : "guard", head: l, startCol, endCol });
  }
  return out;
}

/** The branch body as one string. A branch that opens and closes on the same
 *  line is that line's SLICE: taking the whole line takes whatever else shares
 *  it, and `(s) => { try { …; return true; } catch { return false; } }` then
 *  reads as a catch that returns true. */
export function bodyOf(lines, b) {
  if (b.end === b.line && b.endCol >= 0) return String(lines[b.line - 1] ?? "").slice(b.startCol, b.endCol);
  const out = lines.slice(b.line - 1, b.end);
  if (out.length) out[0] = String(out[0]).slice(b.startCol || 0);
  return out.join("\n");
}

/** True when the branch records the failure somewhere a person could read. */
export const RECORDS = /\b(throw|raise|panic|reject|log|warn|error|report|emit|console|print|fmt\.|logger|trace|append|record)\b/i;
