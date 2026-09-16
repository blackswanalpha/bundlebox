// finish.test.js — the acceptance ledger. What is checked here is the join:
// that `bb finish init` derives a ledger from what the workspace already
// measured, and that the ledger it derives is one the VENDORED checker accepts.
//
// That second half is the point. The first version left every EXPECT: blank on
// the reasoning that a guessed success marker is an oracle that cannot fail —
// correct about the risk, and it produced a ledger the checker refused to
// parse, which buried the instruction under three parse errors. The
// placeholder is the resolution: it parses, and no command prints it, so the
// gate fails until somebody fills it in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-finish-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test", lint: "eslint ." } }));
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 } }));
w("src/token.js", "export function loginToken(id) {\n  return `tok-${id}`;\n}\n");

const finish = await import("../src/finish/index.js");

test("derive: the detected gates become runnable rows, the rest are honest manual ones", () => {
  const text = finish.derive({ gates: { quick: "npm run lint", full: "npm test", scope: "." }, scope: ["src/token.js"] });
  assert.match(text, /^# Gates: /m);
  assert.match(text, /^OWNS: src\/token\.js$/m);
  assert.match(text, /^ {2}CHECK: npm run lint$/m);
  assert.match(text, /^ {2}CHECK: npm test$/m);
  assert.match(text, /MANUAL: nothing outside the declared scope was changed/);
  assert.equal((text.match(/^- \[ \] /gm) || []).length, 4);
});

test("every runnable row carries an EXPECT no command prints", () => {
  const text = finish.derive({ gates: { quick: "npm test", scope: "." } });
  const checks = (text.match(/^ {2}CHECK: /gm) || []).length;
  const expects = (text.match(new RegExp(`^ {2}EXPECT: ${finish.PLACEHOLDER}$`, "gm")) || []).length;
  assert.equal(checks, expects, "a runnable gate with a blank EXPECT is one the checker refuses to parse");
  assert.ok(checks > 0);
});

test("a workspace with no gate says so instead of inventing one", () => {
  const text = finish.derive({ gates: { quick: "", full: "", scope: "." } });
  assert.match(text, /MANUAL: no gate is declared in this workspace/);
  assert.ok(!/^ {2}CHECK:/m.test(text), "nothing runnable is invented");
});

test("a manual gate has neither CHECK nor EXPECT", () => {
  const text = finish.derive({ gates: { quick: "", full: "", scope: "." } });
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.includes("MANUAL: no gate is declared"));
  assert.match(lines[i + 1], /^ {2}EVIDENCE: pending$/, "the row after a manual gate's title is its evidence, not a command");
});

test("the vendored checker parses a derived ledger and reports every gate unmet", () => {
  const file = path.join(root, "GATES.md");
  fs.writeFileSync(file, finish.derive({ gates: { quick: "npm run lint", full: "npm test", scope: "." }, scope: ["src/token.js"] }));
  const lint = finish.linter(file);
  assert.equal(lint.rc, 0, `lint rejected the derived ledger:\n${lint.out}${lint.err}`);
  const status = finish.checker(["--status", file]);
  assert.match(status.out, /UNMET: 4 \(met: 0\)/, status.out + status.err);
  assert.ok(!/executed|EXECUTING/i.test(status.out), "--status never runs a CHECK");
});

test("init is a dry run until --apply", async () => {
  const file = path.join(root, "GATES.md");
  fs.rmSync(file, { force: true });
  const { commands } = finish;
  await commands.finish.run({ _: ["init"], flags: {} });
  assert.equal(fs.existsSync(file), false, "a verb that writes a file a person edits waits for --apply");
  await commands.finish.run({ _: ["init"], flags: { apply: true } });
  assert.equal(fs.existsSync(file), true);
});
