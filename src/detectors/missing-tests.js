// missing-tests — recently changed source files with no test that names them.
// Heuristic: a test can cover a file without naming it, so the claim is "no
// test file references this", scoped to the last 30 commits because that is
// where a missing test is still cheap to write.
import { CONFIG_RE, codeRels, corpus, finding, gitAvailable, isTest } from "./_shared.js";

export const COMMITS = 30;
const stem = (r) => r.split("/").pop().replace(/\.[^.]+$/, "");
/** `foo.test.js`, `test_foo.py`, `foo_test.go`, `foo.spec.ts`, `FooTest.java` -> `foo`. */
const testStem = (r) => stem(r).replace(/^test_/, "").replace(/(_test|\.test|\.spec|_spec|Tests?)$/, "").toLowerCase();

export default {
  name: "missing-tests", precision: "heuristic", severity: "low",
  description: `source files changed in the last ${COMMITS} commits with no test file naming them`,
  run(ctx) {
    if (!gitAvailable(ctx)) return [];
    const log = ctx.git(["log", `-${COMMITS}`, "--name-only", "--pretty=format:"]);
    if (log.rc !== 0) return [];
    const text = corpus(ctx);
    const changed = new Set(log.out.split("\n").map((l) => l.trim()).filter(Boolean));
    const source = new Set(codeRels(ctx, { tests: false }));
    const tests = codeRels(ctx).filter(isTest);
    const stems = new Set(tests.map(testStem));
    const testText = tests.map((t) => text.get(t)).join("\n");
    const byDir = new Map();
    for (const r of changed) {
      if (!source.has(r) || CONFIG_RE.test(r)) continue;
      const s = stem(r).toLowerCase();
      if (stems.has(s)) continue;
      // A test that imports the file by path covers it even without the name.
      if (testText.includes(r) || new RegExp(`[/'"\`]${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-z]+`).test(testText)) continue;
      const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ".";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(r);
    }
    const out = [];
    for (const [dir, files] of [...byDir].sort()) {
      out.push(finding({
        severity: "low", kind: "verify", files, path: dir, key: dir,
        auto_fix: "scaffold-test",
        title: `${dir}: ${files.length} recently changed file(s) with no test naming them`,
        detail: files.slice(0, 20).map((f) => `  ${f}`).join("\n"),
        evidence: { files: files.slice(0, 50), count: files.length, commits: COMMITS, test_files: tests.length },
        fix_hint: "A test named after the file (foo.test.js, test_foo.py, foo_test.go) is what the next scan looks for.",
      }));
    }
    return out;
  },
};
