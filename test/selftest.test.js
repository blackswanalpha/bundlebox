import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
test("bb selftest exits 0 and prints its count", () => {
  const r = spawnSync(process.execPath, [path.join(process.cwd(), "bin/bb.js"), "selftest"], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\d+ checks, 0 failed/);
});
