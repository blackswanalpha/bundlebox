// dead-exports — a symbol exported and referenced nowhere else in the tree.
// Heuristic: a name can be reached by a string, a framework or a consumer
// outside this repo, so the evidence is the declaration line and the claim is
// "not referenced in this corpus", never "unused".
import { langOf } from "../core/fs.js";
import { codeRels, corpus, finding, isTest, packageJson, snippet, usedElsewhere } from "./_shared.js";

const JS_DECL = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/gm;
const JS_LIST = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm;   // `export { a, b as c }` — not `export { x } from`
const PY_DECL = /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm;
const SKIP_NAME = new Set(["main", "default", "commands", "run", "setup", "teardown", "handler"]);

/** Files package.json names are a public surface: their exports are consumed
 *  by a process this corpus cannot see. */
function publicFiles(ctx) {
  const pj = packageJson(ctx);
  const s = new Set();
  if (!pj) return s;
  const add = (v) => { if (typeof v === "string") s.add(v.replace(/^\.\//, "")); else if (v && typeof v === "object") Object.values(v).forEach(add); };
  add(pj.main); add(pj.module); add(pj.bin); add(pj.exports); add(pj.types);
  return s;
}

export default {
  name: "dead-exports", precision: "heuristic", severity: "low",
  description: "exported symbols (JS/TS) and top-level defs (Python) referenced by no other file",
  run(ctx) {
    const out = [];
    const text = corpus(ctx);
    const pub = publicFiles(ctx);
    for (const r of codeRels(ctx, { tests: false })) {
      const lang = langOf(r);
      if (pub.has(r)) continue;
      const src = text.get(r);
      const decls = [];
      if (lang === "js" || lang === "ts") {
        if (/(^|\/)index\.[cm]?[jt]sx?$/.test(r)) continue;   // an index re-exports; its consumers are the package
        for (const m of src.matchAll(JS_DECL)) decls.push({ name: m[1], at: m.index });
        for (const m of src.matchAll(JS_LIST)) for (const part of m[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop();
          if (name) decls.push({ name, at: m.index });
        }
      } else if (lang === "py") {
        if (/(^|\/)__init__\.py$/.test(r)) continue;
        for (const m of src.matchAll(PY_DECL)) decls.push({ name: m[1], at: m.index });
      } else continue;
      const dead = [];
      for (const d of decls) {
        if (SKIP_NAME.has(d.name) || d.name.startsWith("_") || d.name.startsWith("test")) continue;
        if (usedElsewhere(ctx, d.name, r)) continue;
        const line = src.slice(0, d.at).split("\n").length;
        dead.push({ name: d.name, line, snippet: snippet(src.split("\n")[line - 1]) });
      }
      if (!dead.length) continue;
      out.push(finding({
        severity: "low", files: [r], key: r,
        title: `${r}: ${dead.length} export(s) referenced by no other file`,
        detail: dead.slice(0, 15).map((d) => `  L${d.line}  ${d.name}`).join("\n"),
        evidence: { symbols: dead.slice(0, 40), count: dead.length },
        fix_hint: "Delete it, or stop exporting it. A public API this repo does not own is the one false positive: check package consumers first.",
      }));
    }
    return out;
  },
};
