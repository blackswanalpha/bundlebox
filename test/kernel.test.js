// The kernel and the JS fallbacks must give the SAME answers, or which one is
// installed silently changes every number downstream. Skips when no kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-kernel-"));
process.env.BB_ROOT = root;
fs.mkdirSync(path.join(root, "src"), { recursive: true });
const block = Array.from({ length: 14 }, (_, i) => `  const value${i} = compute(${i}, "str ${i}"); // c`).join("\n");
fs.writeFileSync(path.join(root, "src", "a.js"), `export function alpha() {\n${block}\n  return 1;\n}\n`);
fs.writeFileSync(path.join(root, "src", "b.js"), `export function beta() {\n${block}\n  return 2;\n}\nexport function gamma() { return 3; }\n`);
fs.writeFileSync(path.join(root, "src", "c.py"), `class Thing:\n    def run(self):\n        return 1  # done\n\ndef helper():\n    pass\n`);
fs.writeFileSync(path.join(root, "README.md"), "# T\n\nsome prose here, with punctuation; and more.\n");

const kernel = await import("../src/core/kernel.js");
const have = kernel.available();
const est = await import("../src/tokens/estimate.js");
const cache = await import("../src/kit/cache.js");
const dupes = (await import("../src/detectors/duplicate-blocks.js")).default;
const files = ["src/a.js", "src/b.js", "src/c.py", "README.md"].map((p) => path.join(root, p));

test("kernel present on this box (informational)", () => { console.log(`  kernel: ${have ? kernel.version() : "absent — parity tests skipped"}`); });

test("estimate: kernel == js per file", { skip: !have }, () => {
  const js = est.filesJs(files);
  const cfg = cfgMod.load().tokens;
  const k = kernel.call("estimate", { paths: files, ...cfg });
  for (const f of files) assert.equal(k.files[f], js.files[path.relative(root, f)], f);
  assert.equal(k.total, js.total);
});
const cfgMod = await import("../src/core/config.js");

test("fingerprint: kernel == js, count prefix counts only existing inputs", { skip: !have }, () => {
  const inputs = [...files, path.join(root, "missing.js")];
  const k = kernel.call("fingerprint", { root, inputs });
  assert.equal(k.fingerprint, cache.fingerprintJs(inputs));
  assert.ok(k.fingerprint.startsWith("4:"));
});

test("sha1: kernel == node crypto", { skip: !have }, async () => {
  const { sha1 } = await import("../src/core/util.js");
  assert.equal(kernel.call("sha1", { text: "bundlebox" }).sha1, sha1("bundlebox"));
});

test("dupes: kernel finds the same pair with the same shared line count as js", { skip: !have }, async () => {
  const { runAll } = await import("../src/detectors/index.js");
  process.env.BB_KERNEL = "/nonexistent/bbk";
  const jsFindings = runAll({ only: ["duplicate-blocks"] }).findings;
  delete process.env.BB_KERNEL;
  const k = kernel.call("dupes", { paths: [path.join(root, "src/a.js"), path.join(root, "src/b.js")], window: 8, min_shared_lines: 24, min_distinct_ratio: 0.25, hash_comment_paths: [] });
  assert.equal(k.pairs.length, 1);
  assert.equal(jsFindings.length, 1);
  assert.equal(k.pairs[0].shared_lines, jsFindings[0].evidence.shared_lines);
});

test("symbols: kernel indexes a JS function and a Python class", { skip: !have }, () => {
  const k = kernel.call("symbols", { paths: files });
  const names = k.symbols.map((s) => s.name);
  for (const n of ["alpha", "beta", "gamma", "Thing", "helper"]) assert.ok(names.includes(n), n);
  assert.equal(k.symbols.find((s) => s.name === "Thing").line, 1);
});

test("anchor: kernel locates a brace-matched region and returns null for a missing symbol", { skip: !have }, () => {
  const a = kernel.call("anchor", { path: path.join(root, "src/b.js"), symbol: "gamma" });
  assert.equal(a.line_start, a.line_end);
  const b = kernel.call("anchor", { path: path.join(root, "src/b.js"), symbol: "beta" });
  assert.equal(b.line_start, 1); assert.equal(b.line_end, 17);
  assert.equal(kernel.call("anchor", { path: path.join(root, "src/b.js"), symbol: "nope" }), null);
});

test("gate: exit code is the verdict, pipefail holds, timeout kills, output is capped", { skip: !have || process.platform === "win32" }, () => {
  assert.equal(kernel.call("gate", { cmd: "true", cwd: root }).verdict, "passed");
  assert.equal(kernel.call("gate", { cmd: "false | cat", cwd: root }).verdict, "failed");
  const t = kernel.call("gate", { cmd: "sleep 5", cwd: root, timeout: 1 });
  assert.equal(t.verdict, "timeout"); assert.equal(t.timed_out, true);
  const big = kernel.call("gate", { cmd: "seq 1 100000", cwd: root, cap_bytes: 500 });
  assert.ok(big.output_tail.length <= 500 && big.output_bytes > 500);
  assert.equal(kernel.call("gate", { cmd: "", cwd: root }).verdict, "unproven");
});
