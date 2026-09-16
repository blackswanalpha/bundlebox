// runjson.test.js — a `run` step whose stdout is JSON is assertable like a
// response, and BOTH engines must agree about it.
//
// This is the test that matters more than the feature. The kernel implements
// `run` steps too; a body key it did not understand would be a step it ran and
// silently did not check, and the board would be green for the worst possible
// reason. So every assertion here is made twice — once through the JS engine,
// once through the kernel — and compared.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCmd, stdoutBody, BODY_KEYS } from "../src/cookbook/expect.js";
import { shellCmd, pipedOn } from "../src/core/exec.js";

const PAYLOAD = JSON.stringify({
  label: "catalogue", blank: false, nodes: 3,
  screen: [
    { role: "searchbox", name: "Search the catalogue" },
    { role: "button", name: "Add to cart" },
    { role: "button", name: "Add to cart", disabled: true },
  ],
});

test("stdout is a body only when it is an object or an array", () => {
  assert.deepEqual(stdoutBody('{"a":1}'), { a: 1 });
  assert.deepEqual(stdoutBody("[1,2]"), [1, 2]);
  // A command printing a bare scalar has not returned a body. Treating `true`
  // as one would make a `json` assertion pass against nothing.
  assert.equal(stdoutBody("true"), null);
  assert.equal(stdoutBody("42"), null);
  assert.equal(stdoutBody("ok"), null);
  assert.equal(stdoutBody(""), null);
  assert.equal(stdoutBody("{not json"), null);
});

test("a body key asserts against stdout, and counts as an assertion", () => {
  const r = checkCmd({ rc: 0, json: { "screen.0.role": "searchbox" } }, { rc: 0, stdout: PAYLOAD, stderr: "", ms: 5 });
  assert.deepEqual(r.why, []);
  assert.equal(r.n, 2, "the rc and the json both count, so the step is not `empty`");
});

test("a body key that does not hold fails, and says what it got", () => {
  const r = checkCmd({ json: { "screen.0.role": "button" } }, { rc: 0, stdout: PAYLOAD, stderr: "", ms: 5 });
  assert.equal(r.why.length, 1);
  assert.match(r.why[0], /screen\.0\.role/);
});

test("a body key against stdout that is not JSON is a failure, not a pass", () => {
  // The dangerous case. Silently skipping would make a step that asserts
  // nothing look like a step that held.
  const r = checkCmd({ json_present: ["screen"] }, { rc: 0, stdout: "some human output", stderr: "", ms: 5 });
  assert.ok(r.why.length, "it must fail");
  assert.match(r.why[0], /not a JSON object or array/);
  assert.ok(r.n > 0, "and it must count as asserted, or the step reads as empty");
});

test("rc and max_ms stay the command's own and are not double-counted", () => {
  const r = checkCmd({ rc: 1, max_ms: 1, json: { blank: false } }, { rc: 0, stdout: PAYLOAD, stderr: "", ms: 999 });
  assert.equal(r.why.length, 2, "rc and max_ms, once each; the json held");
  assert.ok(r.why.some((w) => /^rc 0/.test(w)));
  assert.ok(r.why.some((w) => /budget 1ms/.test(w)));
});

test("counting and set membership work against stdout", () => {
  const r = checkCmd({
    json_len_at_least: { screen: 3 },
    json_type: { "screen.1.name": "str" },
    json_in: { "screen.2.disabled": [true] },
  }, { rc: 0, stdout: PAYLOAD, stderr: "", ms: 1 });
  assert.deepEqual(r.why, []);
  assert.equal(r.n, 3);
});

test("the kernel and the JS engine agree about a run step with body keys", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary on this box");

  const { run } = await import("../src/cookbook/engine.js");
  // A script FILE, not an inline `node -p "...JSON..."`. The payload is full of
  // double quotes, and bash and cmd.exe disagree about `\"` — so an inline
  // command made this test a probe of shell quoting, and it failed on Windows
  // for a reason that has nothing to do with what it is asserting. The contract
  // under test is "both engines read a body key out of stdout"; the command
  // that produces that stdout should be the least interesting part of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-runjson-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp is tmp */ } });
  fs.writeFileSync(path.join(dir, "emit.js"), `process.stdout.write(${JSON.stringify(PAYLOAD)});\n`);
  const emit = "node emit.js";
  const spec = {
    base: "http://127.0.0.1:1", rpm: 0, parallel: 1, timeout_ms: 20000,
    timezone: "UTC", tz_offset_minutes: 0, headers: {}, vars: {}, actors: {}, setup: [],
    root: dir, cap_bytes: 1200, max_429: 0,
    scenarios: [{
      id: "screen", surface: "ui", severity: "low", title: "the screen has what it should",
      steps: [
        { name: "it holds", run: emit, expect: { rc: 0, json: { "screen.0.role": "searchbox" }, json_len_at_least: { screen: 3 } } },
        { name: "it does not", run: emit, expect: { json: { "screen.0.role": "button" } } },
        { name: "stdout is not a body", run: "echo plain", expect: { json_present: ["screen"] } },
      ],
    }],
  };

  const js = await run(spec, { engine: "js" });
  const k = await run(spec, { engine: "kernel" });
  assert.equal(js.engine ?? "js", "js");

  const shape = (board) => (board.scenarios[0].steps || []).map((s) => ({ state: s.state, whys: s.why.length }));
  assert.deepEqual(shape(k), shape(js), "one contract, two implementations");
  assert.deepEqual(shape(js), [
    { state: "passed", whys: 0 },
    { state: "failed", whys: 1 },
    { state: "failed", whys: 1 },
  ]);
});

test("every body key is one the kernel also knows", async (t) => {
  const kernel = await import("../src/core/kernel.js");
  if (!kernel.available()) return t.skip("no kernel binary");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const rs = fs.readFileSync(path.join(process.cwd(), "kernel", "src", "scenario", "expect.rs"), "utf8");
  const m = /pub const BODY_KEYS: &\[&str\] = &\[([^\]]*)\]/s.exec(rs);
  assert.ok(m, "the kernel declares BODY_KEYS");
  const theirs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  // Two lists that drifted would be one engine checking a key the other
  // ignored, which is exactly the silent divergence this feature could cause.
  assert.deepEqual([...theirs].sort(), [...BODY_KEYS].sort());
});

test("both engines choose the same shell, and a pipe reports the right exit code wherever one exists", () => {
  // Two defects, one rule. The first: `src/cookbook/engine.js` hard-coded
  // `bash -lc` while the kernel had already decided on cmd.exe for Windows, so
  // on a Windows box WITH git-bash both engines ran under DIFFERENT shells and
  // disagreed about the same corpus.
  //
  // The second is why the Windows branch is now a fallback rather than the
  // rule. cmd.exe has no `pipefail` and no equivalent, so `npm test | tee log`
  // reported `tee`'s exit code and a gate that should have failed came back
  // `ok`. A gate that cannot fail is worse than no gate. Git for Windows ships
  // a bash and puts it on PATH, so the POSIX branch is taken there too when one
  // is reachable, and only a box with none at all falls back — where `pipedOn`
  // reports the remaining gap instead of hiding it.
  const posix = shellCmd("a | b", { win: false, bash: "bash" });
  assert.deepEqual(posix, ["bash", "-lc", "set -o pipefail; { a | b ; }"]);
  assert.deepEqual(shellCmd("a | b", { win: false, merge: true, bash: "bash" }),
    ["bash", "-lc", "set -o pipefail; { a | b ; } 2>&1"]);

  // Windows WITH a bash: the same shell, the same pipefail, the same code.
  const winBash = shellCmd("a | b", { win: true, bash: "C:\\Program Files\\Git\\bin\\bash.exe" });
  assert.deepEqual(winBash, ["C:\\Program Files\\Git\\bin\\bash.exe", "-lc", "set -o pipefail; { a | b ; }"]);
  assert.equal(pipedOn({ win: true, bash: "C:\\bash.exe" }), true);

  // Windows with NO bash anywhere: cmd.exe, and the gap is reported.
  const win = shellCmd("a | b", { win: true, bash: null });
  assert.equal(win[0], process.env.ComSpec || "cmd.exe");
  assert.deepEqual(win.slice(1), ["/d", "/s", "/c", "a | b"]);
  assert.deepEqual(shellCmd("a | b", { win: true, merge: true, bash: null }).slice(1), ["/d", "/s", "/c", "a | b 2>&1"]);
  assert.ok(!win.includes("bash"), "there is none to run, and a spawn error is not a verdict");
  assert.equal(pipedOn({ win: true, bash: null }), false, "the remaining gap is named, not hidden");
  assert.equal(pipedOn({ win: false, bash: "bash" }), true);

  // And it still mirrors the Rust. Coarse on purpose — it catches the flags
  // moving apart, which is what actually happened, without pinning formatting.
  const rust = fs.readFileSync(path.join(process.cwd(), "kernel", "src", "gate.rs"), "utf8");
  const shell = rust.slice(rust.indexOf("pub fn bash_path"), rust.indexOf("pub fn op_gate"));
  for (const token of ['"/d"', '"/s"', '"/c"', '"bash"', '"-lc"', "set -o pipefail", "piped_ok"]) {
    assert.ok(shell.includes(token), `kernel/src/gate.rs::shell no longer carries ${token}; the two engines have drifted`);
  }
});

test("nothing in src/ hard-codes a shell except the one branch that may", () => {
  // The defect came back three times before it was noticed, because each caller
  // reached for `bash -lc` on its own and nothing was watching. This is the
  // watch: one allowlisted hit, with the reason it is allowed.
  //
  // `src/runbook/lifecycle.js` passes `bash -lc` to systemd-run, which is
  // Linux-only and gated on `useSystemd()`, so a box that reaches that line has
  // a bash by construction. Every other caller must go through `shellCmd`.
  const ALLOWED = new Map([
    ["src/core/exec.js", "this IS shellCmd — the one implementation everything else must call"],
    ["src/runbook/lifecycle.js", "systemd-run is Linux-only and gated on useSystemd()"],
  ]);
  const root = path.join(process.cwd(), "src");
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!f.endsWith(".js")) continue;
      const text = fs.readFileSync(f, "utf8");
      // The literal argv form, however it is quoted or spaced.
      if (/["'`]bash["'`]\s*,\s*\[?\s*["'`]-lc["'`]/.test(text)) hits.push(path.relative(process.cwd(), f).split(path.sep).join("/"));
    }
  };
  walk(root);
  const unexpected = hits.filter((h) => !ALLOWED.has(h));
  assert.deepEqual(unexpected, [],
    `these hard-code a shell instead of calling exec.shellCmd, and will fail to spawn on a stock Windows box: ${unexpected.join(", ")}`);
  // And the allowlist is not allowed to rot: an entry that no longer matches is
  // an entry that is silently permitting nothing.
  for (const [file, why] of ALLOWED) assert.ok(hits.includes(file), `${file} no longer hard-codes bash (${why}); drop it from the allowlist`);
});
