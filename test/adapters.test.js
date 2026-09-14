import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-adapters-")));
process.env.BB_ROOT = tmp;
process.env.HOME = tmp;
const { get, pick, ADAPTERS, ORDER } = await import("../src/adapters/index.js");
const { shellQuote, LaneMeter } = await import("../src/run/runner.js");
const claude = get("claude");

test("file adapter spawns nothing", () => {
  const c = ADAPTERS.file.buildCmd({ promptFile: "/x/p.md" });
  assert.equal(c.argv, null);
  assert.equal(c.stdin, null);
  assert.ok(ADAPTERS.file.detect());
});

test("claude argv carries only verified flags, prompt on stdin, --tools last", () => {
  const c = claude.buildCmd({ promptFile: "/x/p.md", model: "sonnet", maxTurns: 40, permissionMode: "acceptEdits", sessionId: "11111111-2222-5333-8444-555555555555", budgetUsd: 2.5, name: "bb-L01" });
  assert.equal(c.stdin, "prompt");
  assert.equal(c.argv[0], "claude");
  assert.ok(c.argv.includes("-p") && c.argv.includes("stream-json") && c.argv.includes("--verbose"));
  assert.ok(!c.argv.includes("--max-turns"), "max-turns is not in claude --help 2.1.270");
  assert.match(c.note, /max-turns dropped/);
  for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "--exclude-dynamic-system-prompt-sections", "--max-budget-usd", "--session-id", "--permission-mode"]) assert.ok(c.argv.includes(f), f);
  const ti = c.argv.indexOf("--tools");
  assert.deepEqual(c.argv.slice(ti + 1), ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "TodoWrite"]);
  const line = c.argv.map(shellQuote).join(" ");
  assert.ok(!line.includes("'"), "plain argv needs no quoting");
});

test("shellQuote quotes what the shell would split or expand", () => {
  assert.equal(shellQuote("plain-arg_1.2"), "plain-arg_1.2");
  assert.equal(shellQuote("two words"), "'two words'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("$HOME"), "'$HOME'");
});

test("custom adapter substitutes placeholders and keeps {prompt} as one arg", async () => {
  fs.mkdirSync(path.join(tmp, ".bundlebox"), { recursive: true });
  const { save, load } = await import("../src/core/config.js");
  save({ lanes: { custom_command: 'myagent --file {prompt_file} --cwd "{cwd}" --say {prompt}' } });
  load({ fresh: true });
  const c = ADAPTERS.custom.buildCmd({ promptFile: "/x/p.md", prompt: "hello there world", cwd: "/w d", model: "m" });
  assert.deepEqual(c.argv, ["myagent", "--file", "/x/p.md", "--cwd", "/w d", "--say", "hello there world"]);
  save({ lanes: { agent: "file" } });
  assert.equal(pick(load({ fresh: true })).name, "file");
  save({});
  load({ fresh: true });
});

test("gemini and opencode put the prompt text in argv, never a path", () => {
  const g = ADAPTERS.gemini.buildCmd({ prompt: "fix it", model: "gemini-2.5-pro" });
  assert.deepEqual(g.argv.slice(0, 3), ["gemini", "-p", "fix it"]);
  assert.ok(g.argv.includes("--approval-mode") && g.argv.includes("stream-json"));
  assert.equal(g.stdin, null);
  const o = ADAPTERS.opencode.buildCmd({ prompt: "fix it", cwd: "/w" });
  assert.equal(o.argv.at(-1), "fix it");
  assert.ok(o.argv.includes("--format") && o.argv.includes("json"));
  const x = ADAPTERS.codex.buildCmd({ model: "gpt-5-codex", cwd: "/w" });
  assert.deepEqual(x.argv, ["codex", "exec", "--full-auto", "--json", "-m", "gpt-5-codex", "-C", "/w", "-"]);
  assert.equal(x.stdin, "prompt");
});

const usage = (input, cw, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out, output_tokens_details: { thinking_tokens: 0 } });
const assistant = (id, u, content) => JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5", role: "assistant", content, usage: u }, timestamp: "2026-09-13T10:00:00.000Z", sessionId: "s1", cwd: tmp });

test("parseEvent: assistant rows last-wins per message id, result carries the output total", () => {
  const e1 = claude.parseEvent(assistant("msg_1", usage(2, 17570, 30516, 5), [{ type: "text", text: "a" }]));
  const e2 = claude.parseEvent(assistant("msg_1", usage(2, 17570, 30516, 444), [{ type: "tool_use", name: "Bash", input: { command: "ls" } }]));
  const e3 = claude.parseEvent(assistant("msg_2", usage(0, 900, 48086, 20), [{ type: "text", text: "b" }]));
  const res = claude.parseEvent(JSON.stringify({ type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0.12, session_id: "s1", modelUsage: { "claude-sonnet-5": { outputTokens: 4936, thinkingTokens: 100 } } }));
  assert.equal(e1.msgId, "msg_1"); assert.equal(e2.output, 444); assert.equal(res.isResult, true); assert.equal(res.resultUsage.output, 4936);
  assert.equal(claude.parseEvent("not json"), null);
  assert.equal(claude.parseEvent(JSON.stringify({ type: "system", subtype: "init" })), null);
  const m = new LaneMeter("L01", 160000);
  for (const e of [e1, e2, e3, res]) m.feed(e);
  assert.equal(m.turns, 2);
  assert.equal(m.peak, 48986);
  const rows = m.usageRows();
  assert.equal(rows[0].output, 0);
  assert.equal(rows[1].output, 4936);
  assert.equal(m.outTokens, 4936);
});

test("readTranscript groups lines by message id and attaches tool results to the turn before them", () => {
  const file = path.join(tmp, "t.jsonl");
  const lines = [
    assistant("msg_1", usage(2, 100, 0, 5), [{ type: "text", text: "reading" }]),
    assistant("msg_1", usage(2, 100, 0, 30), [{ type: "tool_use", name: "Read", input: { file_path: "a.js" } }]),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(3000) }] }, sessionId: "s1", cwd: tmp }),
    assistant("msg_2", usage(0, 1000, 102, 40), [{ type: "text", text: "done" }]),
    JSON.stringify({ type: "assistant", message: { id: "msg_3", model: "<synthetic>", content: [{ type: "text", text: "interrupted" }], usage: usage(0, 0, 0, 0) }, sessionId: "s1" }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const tr = claude.readTranscript(file);
  assert.equal(tr.sessionId, "s1");
  assert.equal(tr.cwd, tmp);
  assert.equal(tr.turns.length, 2, "synthetic rows are not turns");
  assert.equal(tr.turns[0].output, 30, "last usage wins");
  assert.equal(tr.turns[0].toolUses[0].name, "Read");
  assert.equal(tr.turns[0].toolResults[0].chars, 3000);
  assert.equal(tr.turns[1].text, "done");
  assert.equal(claude.readTranscript(path.join(tmp, "missing.jsonl")), null);
  assert.equal(ADAPTERS.codex.readTranscript(file), null, "not a codex rollout");
});

test("every adapter honours the contract surface", () => {
  for (const n of [...ORDER, "custom", "file"]) {
    const a = ADAPTERS[n];
    for (const k of ["detect", "leanFlags", "buildCmd", "parseEvent", "transcriptDirs", "readTranscript"]) assert.equal(typeof a[k], "function", `${n}.${k}`);
    assert.ok("instructionsFile" in a && "mcpConfig" in a, n);
    const dirs = a.transcriptDirs(tmp, []);
    assert.ok(dirs === null || Array.isArray(dirs), `${n}.transcriptDirs`);
  }
});
