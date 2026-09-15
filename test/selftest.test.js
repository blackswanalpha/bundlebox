import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
test("bb selftest exits 0 and prints its count", () => {
  const r = spawnSync(process.execPath, [path.join(process.cwd(), "bin/bb.js"), "selftest"], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\d+ checks, 0 failed/);
});

test("no module imports a filesystem path without making it a URL first", async () => {
  // Twice now: the ESM loader refuses a Windows absolute path as an unknown
  // protocol (`Received protocol 'd:'`), so every such import fails there while
  // passing everywhere else. A relative specifier is fine; a path built from
  // PKG_ROOT, ROOT or path.join is not, unless pathToFileURL wraps it.
  const { readdirSync, statSync, readFileSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const src = path.join(process.cwd(), "src");
  const files = [];
  const stack = [src];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  }
  const bad = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const m = /import\(\s*([^)"'`][^)]*)\)/.exec(line);
      if (!m) return;
      if (/pathToFileURL|\bURL\b/.test(m[1])) return;
      if (/PKG_ROOT|\bROOT\b|path\.join|path\.resolve/.test(m[1])) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], "wrap the path in pathToFileURL(...).href");
});
