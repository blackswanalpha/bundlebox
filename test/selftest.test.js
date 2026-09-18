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

test("the launcher finds node without one on PATH", { skip: process.platform === "win32" ? "POSIX launcher" : false }, () => {
  // The bug that cost four sessions of accounting: `bin/bb.js` was
  // `#!/usr/bin/env node`, `env` searches PATH, and the PATH a hook, a cron job
  // or a systemd unit inherits is not the interactive one. The failure was
  // `/usr/bin/env: 'node': No such file or directory` on a stderr that hooks
  // redirect, naming env and node and never bundlebox.
  const bb = path.join(process.cwd(), "bin/bb");
  const env = { ...process.env, PATH: "/nonexistent", BB_NODE: process.execPath };
  const r = spawnSync("/bin/sh", [bb, "--version"], { encoding: "utf8", env, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);

  // With nothing on PATH and no home, it either finds node in a standard prefix
  // or names itself on the way out — never the silent 127 that hid this bug.
  // Which of the two depends on the box, so both are accepted and the third
  // outcome is not.
  const none = spawnSync("/bin/sh", [bb, "--version"], { encoding: "utf8", timeout: 60000,
    env: { PATH: "/nonexistent", HOME: "/nonexistent" } });
  assert.ok(none.status === 0 || (none.status === 127 && /^bb: bundlebox needs node/m.test(none.stderr)),
    `status ${none.status}: ${none.stderr}`);
});
