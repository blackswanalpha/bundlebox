// doc-links — markdown that cites a path which is not there.
//
// A CLAUDE.md is read by every session that opens in this tree. A broken
// citation in it is paid for once per session, forever, and it sends the reader
// somewhere that does not exist, which is worse than saying nothing.
import fs from "node:fs";
import path from "node:path";
import { basenameIndex, blankFences, corpus, finding, lineIndex, snippet } from "./_shared.js";

const MD_LINK = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
const BACKTICK_PATH = /`([\w./\-]+\/[\w./\-]+\.\w{1,6})`/g;
// A scheme, an anchor, a glob or a template is not a path claim.
const NOT_A_PATH = /^[a-z][a-z0-9+.-]*:|^#|[*{}<>$]/i;

export default {
  name: "doc-links", precision: "exact", severity: "low",
  description: "markdown links and backtick paths that resolve to nothing",
  run(ctx) {
    const out = [];
    const index = basenameIndex(ctx);
    for (const [r, raw] of corpus(ctx)) {
      if (!r.endsWith(".md")) continue;
      const text = blankFences(raw);      // a path inside a code fence is an example, not a citation
      const lineOf = lineIndex(text);
      const broken = [];
      const seen = new Set();
      for (const re of [MD_LINK, BACKTICK_PATH]) {
        for (const m of text.matchAll(re)) {
          const target = m[1];
          if (NOT_A_PATH.test(target) || target === "." || target === "..") continue;
          const docDir = path.dirname(path.join(ctx.root, r));
          if (fs.existsSync(path.resolve(docDir, target)) || fs.existsSync(path.join(ctx.root, target))) continue;
          // A backtick path whose FIRST segment exists nowhere in the tree, and
          // whose basename exists nowhere either, is a path the document
          // describes (a file the tool writes, a foreign tree), not a citation
          // into this one. A basename that does exist elsewhere is the moved-file
          // case and stays. Markdown links stay strict: an author who wrote
          // [x](path) meant the reader to follow it.
          if (re === BACKTICK_PATH) {
            const head = target.replace(/^\.\//, "").split("/")[0];
            const headExists = head && (fs.existsSync(path.join(ctx.root, head)) || fs.existsSync(path.resolve(docDir, head)));
            const moved = (index.get(path.posix.basename(target)) || []).some((c) => c !== r);
            if (!headExists && !moved) continue;
          }
          const line = lineOf(m.index);
          if (seen.has(`${target}@${line}`)) continue;
          seen.add(`${target}@${line}`);
          const cands = (index.get(path.posix.basename(target)) || []).filter((c) => c !== r);
          broken.push({ target, line, snippet: snippet(raw.split("\n")[line - 1]), candidates: cands.slice(0, 5) });
        }
      }
      if (!broken.length) continue;
      const fixable = broken.filter((b) => b.candidates.length === 1).length;
      out.push(finding({
        severity: path.basename(r) === "CLAUDE.md" ? "medium" : "low",
        files: [r], key: r,
        title: `${r}: ${broken.length} citation(s) do not resolve`,
        detail: broken.slice(0, 15).map((b) => `  L${b.line}  ${b.target}${b.candidates.length === 1 ? `  -> ${b.candidates[0]}` : ""}`).join("\n"),
        evidence: { broken: broken.slice(0, 60), count: broken.length, fixable },
        // Only the moved-file case is mechanical; the actuator declines the rest.
        auto_fix: fixable ? "fix-doc-links" : null,
        fix_hint: "Either the file moved (fix the link) or the doc describes something that was deleted (delete the sentence, not just the link).",
      }));
    }
    return out;
  },
};
