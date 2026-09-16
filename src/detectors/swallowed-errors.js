// swallowed-errors — a catch block that discards the error and says nothing.
//
// The failure this finds is the one that costs the most to debug later and the
// least to prevent now: an exception caught, dropped, and replaced with a
// default, so the code keeps running against a world it has misread. Six months
// on, the symptom is a value that is wrong and a stack trace that never
// existed.
//
// It is NOT a rule against empty catches. This tree is full of them and most
// are correct — a hook that cannot break a session, a prune that is
// best-effort, a probe whose failure IS the answer. What separates those from a
// bug is that somebody wrote down why, on the line, which is exactly the
// convention already in use here:
//
//     } catch { return 0; }                    // a lost row costs the model one occurrence
//     catch { /* not there yet */ }
//
// So the rule is: an empty or value-only catch with NO comment in or beside it.
// That makes the finding actionable in one of two ways, both cheap — write the
// sentence, or handle the error — and it makes the detector quiet on a codebase
// that already explains itself.
//
// heuristic, not exact: the body is matched with a brace scan rather than a
// parser, so a catch whose comment sits three lines above it reads as bare.
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, snippet } from "./_shared.js";

/** Languages whose catch shape this understands. A language not here is not
 *  scanned at all, rather than scanned with a rule written for another one. */
const CATCH = {
  js: /\bcatch\s*(?:\(([^)]*)\))?\s*\{/g,
  ts: /\bcatch\s*(?:\(([^)]*)\))?\s*\{/g,
  java: /\bcatch\s*\(([^)]*)\)\s*\{/g,
  kotlin: /\bcatch\s*\(([^)]*)\)\s*\{/g,
  php: /\bcatch\s*\(([^)]*)\)\s*\{/g,
  py: /^[ \t]*except\b([^:]*):/gm,
  ruby: /^[ \t]*rescue\b([^\n]*)$/gm,
  go: /\bif\s+err\s*!=\s*nil\s*\{/g,
};

/** The body of a braced block starting at the `{` at `open`. Returns "" when the
 *  braces do not close inside the file, which is what a minified bundle or a
 *  brace inside a string looks like from here. */
function braced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return text.slice(open + 1, i); }
  }
  return "";
}

/** An indented suite under a `except:`/`rescue` header, by indentation. */
function suite(lines, from) {
  const base = (lines[from].match(/^[ \t]*/) || [""])[0].length;
    const body = [];
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { body.push(l); continue; }
    if ((l.match(/^[ \t]*/) || [""])[0].length <= base) break;
    body.push(l);
  }
  return body.join("\n");
}

const COMMENTED = /(\/\/|\/\*|#|--)/;
/** A body that does nothing with the error. `pass`, `return <literal>`, a bare
 *  value, `continue`, `break`, or nothing at all. Anything that MENTIONS the
 *  caught name, logs, rethrows or calls something is handling it. */
function silent(body, name) {
  const code = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/#.*$/, "")).join("\n").trim();
  if (!code) return true;
  if (name && new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`).test(code)) return false;
  if (/\b(throw|raise|panic|log|warn|error|report|emit|console|print|fmt\.|logger|trace)\b/i.test(code)) return false;
  return /^(pass|continue|break|return(\s+(null|nil|None|undefined|false|true|0|-1|""|''|\[\]|\{\}))?|;)*$/.test(code.replace(/\s+/g, " ").trim());
}

export default {
  name: "swallowed-errors", precision: "heuristic", severity: "medium",
  description: "a catch/except/rescue that discards the error with no comment saying why",
  run(ctx) {
    const text = corpus(ctx);
    const out = [];
    for (const r of codeRels(ctx, { tests: false })) {
      const lang = langOf(r);
      const re = CATCH[lang];
      if (!re) continue;
      const src = text.get(r);
      const lines = src.split("\n");
      const hits = [];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const lineNo = src.slice(0, m.index).split("\n").length;
        const header = lines[lineNo - 1] || "";
        // The convention this tree already uses: the reason is on the line.
        // A commented catch is a decision somebody made and wrote down.
        if (COMMENTED.test(header.slice(header.indexOf("catch") >= 0 ? header.indexOf("catch") : 0))) continue;
        const name = (m[1] || "").trim().split(/[\s:,]/)[0] || "";
        const body = lang === "py" || lang === "ruby"
          ? suite(lines, lineNo - 1)
          : braced(src, src.indexOf("{", m.index + m[0].length - 1));
        if (COMMENTED.test(body)) continue;              // the reason is inside the block
        if (!silent(body, name)) continue;
        hits.push({ line: lineNo, snippet: snippet(header) });
        if (hits.length >= 50) break;
      }
      if (!hits.length) continue;
      out.push(finding({
        severity: hits.length >= 5 ? "medium" : "low",
        files: [r], key: r,
        title: `${r}: ${hits.length} error(s) caught and discarded with no reason given`,
        detail: hits.slice(0, 15).map((h) => `  L${h.line}  ${h.snippet}`).join("\n"),
        evidence: { hits: hits.slice(0, 50), count: hits.length },
        fix_hint: "Either handle it, or say in one clause on the line why dropping it is right — `} catch { /* the file is not there yet */ }`. This tree already writes them that way; the detector is quiet on the ones that do.",
      }));
    }
    return out;
  },
};
