// orphan-files — a source file nothing imports, requires or names.
//
// Real resolution, not basename matching: the original called `util/log.js`
// and `core/log.js` the same file. A language the import graph cannot resolve
// (Go packages import directories) yields nothing here, which is "unknown",
// never "orphan". Heuristic because a file can be loaded by a string, a
// framework convention or a process outside this tree.
import { langOf } from "../core/fs.js";
import { CONFIG_RE, ENTRY_RE, codeRels, corpus, finding, importGraph, isTest, packageJson } from "./_shared.js";

const RESOLVED = new Set(["js", "ts", "vue", "svelte", "py", "dart", "rust", "ruby", "php"]);
const RUN_BY_HAND = /(^|\/)(bin|scripts?|tools?|migrations?|examples?|benchmarks?)\//;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg|Makefile|Cargo\.toml|pubspec\.yaml|Dockerfile|[^/]*\.ya?ml|README[^/]*\.md|CLAUDE\.md|AGENTS\.md)$/;

export default {
  name: "orphan-files", precision: "heuristic", severity: "low",
  description: "source files never imported, required or referenced by path",
  run(ctx) {
    const text = corpus(ctx);
    const { fanIn } = importGraph(ctx);
    // Anything a manifest, script or README names is reached by a tool.
    const named = [];
    for (const [r, t] of text) if (MANIFEST.test(r) || r.endsWith(".sh") || r.endsWith(".json")) named.push(t);
    const pj = packageJson(ctx);
    const namedText = named.join("\n") + JSON.stringify(pj || {});
    const byDir = new Map();
    for (const r of codeRels(ctx, { tests: false })) {
      if (!RESOLVED.has(langOf(r))) continue;
      if (ENTRY_RE.test(r) || CONFIG_RE.test(r) || RUN_BY_HAND.test(r) || isTest(r)) continue;
      if (fanIn.get(r)) continue;
      const stem = r.replace(/\.[^.]+$/, "");
      if (namedText.includes(r) || namedText.includes(stem)) continue;
      // A path string anywhere else in the corpus (a dynamic import, a config
      // key, a docs table) counts as a reference.
      let referenced = false;
      for (const [o, t] of text) { if (o !== r && (t.includes(r) || t.includes("/" + r.split("/").pop()))) { referenced = true; break; } }
      if (referenced) continue;
      const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ".";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(r);
    }
    const out = [];
    for (const [dir, files] of [...byDir].sort()) {
      out.push(finding({
        severity: "low", kind: "investigate", files, path: dir, key: dir,
        title: `${dir}: ${files.length} file(s) nothing imports or names`,
        detail: files.slice(0, 20).map((f) => `  ${f} (${text.get(f).split("\n").length} lines)`).join("\n"),
        evidence: { files: files.slice(0, 50), count: files.length, lines: Object.fromEntries(files.slice(0, 50).map((f) => [f, text.get(f).split("\n").length])) },
        fix_hint: "Delete it or import it. If a framework loads it by convention, list the convention in workspace config so the next scan knows.",
      }));
    }
    return out;
  },
};
