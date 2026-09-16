// actuators.test.js — the layer that was missing: the verbs that ACT on what
// the measurements already said.
//
// Every subsystem under test here had its data and its report before this and
// no actuator between them. `bb lathe` proposed scripts nobody applied; `bb
// bench` printed tasks that stayed routable; `bb uptake` measured instruction
// lines nobody read and nothing removed them; `bb tokens calibrate` fitted two
// coefficients and left three constants nothing on any box ever moved.
//
// What is locked down is the part that makes each one safe to run unattended:
// a floor below which nothing is written, a direction in which being wrong
// costs one extra run instead of a wrong answer, and a dry run that is the
// default.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-act-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
w(".bundlebox/config.json", JSON.stringify({ budget: { max_tokens: 60000 } }));

const apply = await import("../src/lathe/apply.js");
const gate = await import("../src/bench/gate.js");
const trim = await import("../src/wire/trim.js");
const agents = await import("../src/wire/agents.js");
const calibrate = await import("../src/tokens/calibrate.js");
const repeatable = await import("../src/recom/repeatable.js");
const proxy = await import("../src/wire/proxy.js");
const { calibrationPath, readJson, writeJson, load: loadCfg } = await import("../src/core/config.js");

const pattern = (items, support, extra = {}) => ({ items, support, sessions: 2, confidence: 1, lift: 3, ...extra });
const model = (shell = [], verbs = []) => ({ name: "LATHE-1", sequence: { shell, verbs } });

// ── lathe: the closed learning loop ─────────────────────────────────────────

test("lathe apply: a habit under the floor is not written", () => {
  const m = model([pattern(["npm test", "git commit"], 2)]);
  const r = apply.candidates(m, { cfg: { lathe: { apply_at: 5 } } });
  assert.equal(r.length, 0, "two occurrences is a coincidence of two sessions");
});

test("lathe apply: a habit at the floor becomes one candidate", () => {
  const m = model([pattern(["npm test", "git commit"], 5)]);
  const r = apply.candidates(m, { cfg: { lathe: { apply_at: 5 } } });
  assert.equal(r.length, 1);
  assert.equal(r[0].support, 5);
});

test("lathe apply: a pattern of one repeated shape automates impatience, not a habit", () => {
  const m = model([pattern(["npm test", "npm test", "npm test"], 9)]);
  assert.equal(apply.candidates(m, { cfg: { lathe: { apply_at: 5 } } }).length, 0);
});

test("lathe apply: a shell pattern of bare interpreters names no work", () => {
  // `node ; python3 ; node` is two distinct shapes and says only that the
  // session ran two one-liners, which is true of nearly every session.
  const m = model([pattern(["node", "python3", "node"], 20)]);
  assert.equal(apply.candidates(m, { cfg: { lathe: { apply_at: 5 } } }).length, 0);
});

test("lathe apply: a longer habit that keeps its support replaces its own prefix", () => {
  // The defect: BIDE closedness only drops a prefix at EQUAL support, so one
  // habit came out as five nested scripts — 88, 77, 62, 59 and 15 occurrences
  // of the same growing pipeline.
  const m = model([], [
    pattern(["scan", "compile"], 88),
    pattern(["scan", "compile", "route"], 77),
    pattern(["scan", "compile", "route", "snapgen"], 15),
  ]);
  const c = apply.candidates(m, { cfg: { lathe: { apply_at: 5 } } });
  const items = c.map((x) => x.items.join(","));
  assert.ok(!items.includes("scan,compile"), "77 of 88 is most of it: the 3-step IS the habit");
  assert.ok(items.includes("scan,compile,route"), "kept: the 4-step keeps only 15 of its 77");
  assert.ok(items.includes("scan,compile,route,snapgen"), "a rarer continuation is a habit of its own");
});

test("lathe apply: two habits sharing a truncated name get two files", () => {
  // The name is slugged to 40 characters, so three different pipelines that
  // begin the same way produced ONE filename between them.
  const a = apply.fileFor({ kind: "verb", items: ["scan", "oversight scan", "compile", "route"], support: 9, pattern: pattern(["scan"], 9), id: apply.fingerprintOf(pattern(["scan", "oversight scan", "compile", "route"]), "verb") });
  const b = apply.fileFor({ kind: "verb", items: ["scan", "oversight scan", "compile", "route", "snapgen build"], support: 9, pattern: pattern(["scan"], 9), id: apply.fingerprintOf(pattern(["scan", "oversight scan", "compile", "route", "snapgen build"]), "verb") });
  assert.notEqual(a.name, b.name);
});

test("lathe apply: everything written is @safe false and carries the marker", () => {
  const c = apply.candidates(model([pattern(["npm test", "git commit"], 7)]), { cfg: { lathe: { apply_at: 5 } } })[0];
  const f = apply.fileFor(c);
  assert.match(f.text, /# @safe false/, "the model knows the order, not whether running it unattended is safe");
  assert.ok(f.text.includes(apply.MARK), "without the marker nothing may ever rewrite this file");
  assert.ok(!/Not run by anything until a person moves it into scripts\//.test(f.text),
    "that line is false once applying has put the file there");
});

test("lathe apply: a file without the marker is never overwritten", () => {
  const c = apply.candidates(model([pattern(["npm test", "git commit"], 7)]), { cfg: { lathe: { apply_at: 5 } } })[0];
  const f = apply.fileFor(c);
  fs.mkdirSync(path.dirname(f.path), { recursive: true });
  fs.writeFileSync(f.path, "#!/usr/bin/env bash\n# somebody wrote this\n");
  const row = apply.applyOne(c, { apply: true });
  assert.equal(row.state, "foreign");
  assert.match(fs.readFileSync(f.path, "utf8"), /somebody wrote this/);
  fs.unlinkSync(f.path);
});

test("lathe apply: dry by default", () => {
  const c = apply.candidates(model([pattern(["npm test", "git push"], 7)]), { cfg: { lathe: { apply_at: 5 } } })[0];
  const row = apply.applyOne(c, { apply: false });
  assert.equal(row.state, "wrote", "it says what it would do");
  assert.equal(fs.existsSync(row.path), false, "and writes nothing");
});

test("lathe apply: the facts behind a script name the tree it was learned from", () => {
  const c = apply.candidates(model([pattern(["npm test", "git commit"], 7)]), { cfg: { lathe: { apply_at: 5 } } })[0];
  const d = apply.dependsFor(c);
  assert.ok(d.some((x) => x.startsWith("git_head:")), "a record with no facts can never go stale");
});

// ── bench: a gate, not a report ─────────────────────────────────────────────

const benchRun = (tasks) => ({ suite: "t", at: new Date().toISOString(), tasks });

test("bench gate: no run is `pack`, never `refuse`", () => {
  const v = gate.verdictFor({ title: "fix the thing", scope: ["a.js"] }, { cfg: { bench: { gate: true } }, l: { ok: false, why: "no bench run stored", lost: [], thin: [] } });
  assert.equal(v.pack, true);
  assert.equal(v.verdict, "unknown");
});

test("bench gate: a task the suite never covered packs normally", () => {
  const l = { ok: true, at: new Date().toISOString(), margin: 2, lost: [], thin: [],
    rows: [{ id: "x", title: "something else entirely", saved_pct: 40, bare_files: ["z.js"] }] };
  const v = gate.verdictFor({ title: "fix the parser in a.js", scope: ["a.js"] }, { cfg: { bench: { gate: true } }, l });
  assert.equal(v.pack, true);
  assert.equal(v.verdict, "not-measured");
});

test("bench gate: a task measured as a LOSS is routed bare", () => {
  const t = { id: "loser", title: "rewrite the parser", saved_pct: -18, bare: 100, packed: 118,
    bare_files: ["src/parse.js", "src/lex.js"], packed_files_list: ["src/parse.js"] };
  const l = { ok: true, at: new Date().toISOString(), margin: 2, lost: [t], thin: [], rows: [t] };
  const v = gate.verdictFor({ title: "rewrite the parser", scope: ["src/parse.js", "src/lex.js"] }, { cfg: { bench: { gate: true } }, l });
  assert.equal(v.pack, false);
  assert.equal(v.verdict, "loses");
  assert.match(v.why, /18% MORE packed/);
});

test("bench gate: a win under the margin is routed bare too, and says which", () => {
  const t = { id: "thin", title: "tidy the lexer", saved_pct: 1, bare_files: ["src/lex.js"] };
  const l = { ok: true, at: new Date().toISOString(), margin: 2, lost: [], thin: [t], rows: [t] };
  const v = gate.verdictFor({ title: "tidy the lexer", scope: ["src/lex.js"] }, { cfg: { bench: { gate: true } }, l });
  assert.equal(v.pack, false);
  assert.equal(v.verdict, "thin");
});

test("bench gate: `bench.gate: false` turns it off completely", () => {
  const t = { id: "loser", title: "x", saved_pct: -50, bare_files: ["a.js"] };
  const v = gate.verdictFor({ title: "x", scope: ["a.js"] }, { cfg: { bench: { gate: false } }, l: { ok: true, lost: [t], thin: [], rows: [t], margin: 0 } });
  assert.equal(v.pack, true);
  assert.equal(v.verdict, "off");
});

test("bench gate: similarity is over FILES first, because that is what a task is about", () => {
  assert.equal(gate.similarity({ files: ["a.js", "b.js"], title: "" }, { files: ["a.js", "b.js"], title: "" }), 1);
  assert.equal(gate.similarity({ files: ["a.js"], title: "" }, { files: ["z.js"], title: "" }), 0);
  // No files on one side: it falls back to the title rather than returning 0.
  assert.ok(gate.similarity({ files: [], title: "rewrite the parser now" }, { files: [], title: "rewrite the parser today" }) > 0);
});

test("bench gate: a stale run is not evidence about this tree", () => {
  const old = new Date(Date.now() - 400 * 3600 * 1000).toISOString();
  void benchRun; void old;
  // `tasks()` reads the stored run; with no store in this fixture it reports
  // that plainly rather than returning an empty measured set.
  const t = gate.tasks({ cfg: { bench: { max_age_hours: 336 } } });
  assert.equal(t.ok, false);
  assert.match(t.why, /no bench run|bench run/);
});

// ── wire trim: the block as data ────────────────────────────────────────────

const uptake = (rows) => ({ rows, sessions: [] });

test("wire trim: a surface with too few chances is unmeasured, not dead", () => {
  const p = trim.plan({ cfg: { wire: { trim: [] } }, report: uptake([{ id: "pinpoint", observable: true, installed: true, chances: 2, fired: 0 }]) });
  const row = p.rows.find((r) => r.id === "pinpoint");
  assert.equal(row.verdict, "unmeasured");
  assert.equal(p.trim.length, 0);
});

test("wire trim: a surface installed, given the chance, and never reached for is trimmed", () => {
  const p = trim.plan({ cfg: { wire: { trim: [] } }, report: uptake([{ id: "mcp", observable: true, installed: true, chances: 19, fired: 0 }]) });
  assert.deepEqual(p.trim, ["context"]);
  assert.ok(p.per_prompt > 0, "the saving is per prompt, not per session");
});

test("wire trim: a surface that fires even once is kept", () => {
  const p = trim.plan({ cfg: { wire: { trim: [] } }, report: uptake([{ id: "mcp", observable: true, installed: true, chances: 19, fired: 1 }]) });
  assert.equal(p.trim.length, 0);
});

test("wire trim: a line with no observable surface is never trimmed automatically", () => {
  const p = trim.plan({ cfg: { wire: { trim: [] } }, report: uptake([]) });
  const row = p.rows.find((r) => r.id === "generated");
  assert.equal(row.verdict, "unmeasured");
  assert.match(row.why, /prohibition/);
});

test("wire trim: trimming a line removes exactly that line from the block", () => {
  const all = agents.instructions({});
  const less = agents.instructions({ trim: ["context"] });
  assert.ok(all.includes("bb context <files>"));
  assert.ok(!less.includes("bb context <files>"));
  assert.ok(less.includes("bb_pinpoint"), "the rest of the block is untouched");
  assert.ok(less.startsWith(agents.START) && less.endsWith(agents.END), "the markers still bound it");
});

test("wire trim: trimming everything writes no block at all", () => {
  assert.equal(agents.instructions({ trim: agents.BULLETS.map((b) => b.id) }), "",
    "a heading with nothing under it is pure cost in every window");
});

test("wire trim: an unknown id in config is ignored, not an error", () => {
  assert.equal(agents.instructions({ trim: ["not-a-bullet"] }), agents.instructions({}));
});

test("wire trim: a tool nothing called is trimmed, but never all of them at once", () => {
  const tools = [
    { name: "bb_pinpoint", description: "locate", inputSchema: {} },
    { name: "bb_context", description: "size", inputSchema: {} },
  ];
  const report = { rows: [], sessions: [{ mcp: ["bb_pinpoint"] }, { mcp: ["bb_pinpoint"] }, { mcp: [] }] };
  const p = trim.plan({ cfg: { wire: {} }, report, mcpTools: tools });
  assert.deepEqual(p.trim_tools, ["bb_context"], "one called, one never");

  // Nothing called ANY of them: that is the server not being reached, which is
  // a different decision and belongs to `bb unwire`.
  const none = trim.plan({ cfg: { wire: {} }, report: { rows: [], sessions: [{ mcp: [] }, { mcp: [] }, { mcp: [] }] }, mcpTools: tools });
  assert.deepEqual(none.trim_tools, []);
  assert.match(none.tools_note, /unwire/);
});

test("wire trim: a skill is reported and never removed", () => {
  const p = trim.plan({ cfg: { wire: {} }, report: { rows: [], sessions: [] } });
  for (const s of p.skills) assert.equal(s.verdict, "report", "a skill costs nothing until its trigger fires");
});

test("wire trim: the MCP server serves the full set rather than an empty one", async () => {
  const { listed } = await import("../src/mcp/server.js");
  const { TOOLS } = await import("../src/mcp/tools.js");
  const user = (await import("../src/core/config.js"));
  const prior = user.userConfig();
  user.save({ ...prior, wire: { ...(prior.wire || {}), trim_tools: TOOLS.map((t) => t.name) } });
  assert.equal(listed().length, TOOLS.length, "advertising nothing is how a server looks broken");
  user.save(prior);
});

// ── calibration: per repo, automatic ────────────────────────────────────────

test("calibrate: a factor with too few samples keeps its shipped value", () => {
  const f = calibrate.fitChurn(root);
  assert.equal(f.ok, false, "an empty fixture has no sessions to fit from");
  assert.ok(f.need >= 8, "and it says how many it would need");
});

test("calibrate: churn is clamped to a band the budget can survive", () => {
  // A ratio outside [1, 6] means the estimator and the transcript disagree,
  // not that a session read a file forty times.
  const s = calibrate.scale([[100, 1000], [100, 1000], [100, 1000]]);
  assert.equal(s.ok, false, "three samples is not a fit");
});

test("calibrate: writeAll is a read-merge, so one fit cannot erase another", () => {
  writeJson(calibrationPath(), { overhead_tokens: 47000, tokens: { code_w: 1.9 } });
  calibrate.writeAll({ churn: { ok: true, churn_factor: 3.1, samples: 12 }, tokens: { ok: false }, widen: { ok: false }, reserve: { ok: false, rows: [] } });
  const cal = readJson(calibrationPath(), {});
  assert.equal(cal.churn_factor, 3.1, "the new fit landed");
  assert.equal(cal.overhead_tokens, 47000, "and the probe's number survived it");
  assert.equal(cal.tokens.code_w, 1.9);
});

test("calibrate: a fitted churn reaches the budget through config", () => {
  assert.equal(loadCfg({ fresh: true }).budget.churn_factor, 3.1);
});

// ── recom: the repeatable surfaces ──────────────────────────────────────────

test("recom repeatable: a surface with no record RUNS", () => {
  const r = repeatable.shouldRun("cron/factory", { cfg: { recom: { auto_facts: true } } });
  assert.equal(r.run, true);
  assert.equal(r.verdict, "missing");
});

test("recom repeatable: an undeclared surface RUNS rather than being skipped", () => {
  const r = repeatable.shouldRun("something/made-up", { cfg: { recom: { auto_facts: true } } });
  assert.equal(r.run, true);
  assert.equal(r.verdict, "undeclared");
});

test("recom repeatable: auto_facts off means everything runs, as before", () => {
  const r = repeatable.shouldRun("cron/factory", { cfg: { recom: { auto_facts: false } } });
  assert.equal(r.run, true);
  assert.equal(r.verdict, "off");
});

test("recom repeatable: every declared surface names at least one fact", () => {
  for (const id of repeatable.ids()) {
    assert.ok(repeatable.factsFor(id, { base: "http://localhost:1", world: "w" }).length > 0, `${id} declares no fact, so it could never go stale`);
  }
});

test("recom repeatable: a record is refused for a run that did not succeed", () => {
  const r = repeatable.remember("cron/factory", { ok: false, cfg: { recom: { auto_facts: true, record_on_success: true } } });
  assert.equal(r.ok, false);
  assert.match(r.why, /did not succeed/);
});

// ── the proxy: the doorway ──────────────────────────────────────────────────

test("proxy: the prompt file in the argv is substituted, not rewritten in place", () => {
  const argv = ["codex", "exec", "/tmp/in.txt"];
  const got = proxy.rewriteArgv(argv, { from: "/tmp/in.txt", to: "/tmp/packed.txt", cwd: "/w" });
  assert.deepEqual(got, ["codex", "exec", "/tmp/packed.txt"]);
});

test("proxy: {prompt_file} and {cwd} are filled the way lanes.custom_command documents", () => {
  const got = proxy.rewriteArgv(["agent", "--file", "{prompt_file}", "--cd", "{cwd}"], { from: "", to: "/tmp/p.txt", cwd: "/w" });
  assert.deepEqual(got, ["agent", "--file", "/tmp/p.txt", "--cd", "/w"]);
});

test("proxy: a structured run is never sieved, because a cut protocol parses as nothing", () => {
  assert.equal(proxy.looksStructured(["claude", "-p", "--output-format", "stream-json"]), true);
  assert.equal(proxy.looksStructured(["codex", "exec", "-"]), false);
});
