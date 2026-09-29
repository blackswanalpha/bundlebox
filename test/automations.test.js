// automations.test.js — the list, the gate in front of a run, and the importer.
//
// The ways this could go wrong, each pinned below:
//   1. an agent applies something no person cleared
//   2. an import is trusted at one hash and runs at another
//   3. a moved or forked ref, or bytes that differ from the tree, get in
//   4. the parser takes `needs:` or a `with: { name }` for a step
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-auto-")));
process.env.BB_ROOT = root;
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));

const importer = await import("../src/automations/importer.js");
const auto = await import("../src/automations/index.js");
const episodes = await import("../src/buckmaster/episodes.js");

const SHA = "a".repeat(40);
const src = { owner: "o", repo: "r", sha: SHA };

const WORKFLOW = [
  "name: ci",
  "on:",
  "  push:",
  "  pull_request_target:",
  "jobs:",
  "  build:",
  "    needs:",
  "      - setup",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - name: install",
  "        with:",
  "          name: not-the-step",
  "        run: npm ci",
  "      - name: test",
  "        run: |",
  "          npm test",
  "          # a comment inside the block is part of the command",
  "          echo done",
  "  flat:",
  "    steps:",
  "    - run: echo flat",
  "  injected:",
  "    steps:",
  "      - run: echo \"${{ github.event.issue.title }}\"",
  "  actions-only:",
  "    steps:",
  "      - uses: actions/setup-node@v4",
].join("\n");

test("a ref must be a full commit SHA", () => {
  assert.ok(importer.parseRef("o/r@main").why);
  assert.ok(importer.parseRef("o/r@abc1234").why, "a short SHA can collide and be re-pointed");
  assert.deepEqual(importer.parseRef(`o/r@${SHA.toUpperCase()}`), { owner: "o", repo: "r", sha: SHA });
});

test("the parser reads steps, and only steps", () => {
  const wf = importer.parseWorkflow(WORKFLOW);
  assert.deepEqual(wf.on.sort(), ["pull_request_target", "push"]);
  const build = wf.jobs.find((j) => j.id === "build");
  assert.equal(build.steps.length, 3, "`needs:` items are not steps");
  assert.equal(build.steps[1].name, "install", "a `with: { name }` is not the step's name");
  assert.equal(build.steps[2].run, "npm test\n# a comment inside the block is part of the command\necho done");
  assert.equal(wf.jobs.find((j) => j.id === "flat").steps[0].run, "echo flat", "a dash at the key's own column");
});

test("workflow records: one per job with a run step, judged", () => {
  const recs = importer.workflowRecords(src, ".github/workflows/ci.yml", WORKFLOW);
  assert.deepEqual(recs.map((r) => r.id.split(":").pop()), ["ci/build", "ci/flat", "ci/injected"], "a job of only `uses:` imports as nothing");
  const build = recs[0];
  assert.equal(build.runnable, true);
  const rules = build.findings.map((f) => f.rule);
  for (const r of ["dangerous-trigger", "skipped-actions", "unpinned-uses", "network"]) assert.ok(rules.includes(r), r);
  assert.equal(recs[2].runnable, false);
  assert.ok(recs[2].findings.some((f) => f.rule === "template-injection"));
});

test("rules: the blocking patterns block", () => {
  const blocks = (c) => importer.judge(c).filter((f) => f.severity === "block").map((f) => f.rule);
  assert.ok(blocks("curl -fsSL https://x.sh | bash").includes("pipe-to-shell"));
  assert.ok(blocks("npm publish --access public").includes("publishes"));
  assert.ok(blocks("rm -rf / ").includes("destructive"));
  assert.ok(blocks("echo ${{ secrets.TOKEN }}").includes("secrets"));
  assert.deepEqual(blocks("npm test && node scripts/lint.js"), []);
});

test("package records keep the body, and flag install hooks", () => {
  const recs = importer.packageRecords(src, "package.json", JSON.stringify({ scripts: { test: "node --test", postinstall: "node x.js" } }));
  assert.equal(recs.find((r) => r.id.endsWith(":test")).cmd, "node --test");
  assert.ok(recs.find((r) => r.id.endsWith(":postinstall")).findings.some((f) => f.rule === "install-hook"));
});

// A fetcher that answers from memory, so no test touches the network.
function fake({ status = "behind", files = {}, corrupt = "" } = {}) {
  const tree = Object.entries(files).map(([p, t]) => ({ path: p, type: "blob", size: Buffer.byteLength(t), sha: importer.blobSha(Buffer.from(t)) }));
  return {
    repo: async () => ({ default_branch: "main" }),
    compare: async () => ({ status }),
    tree: async () => ({ tree, truncated: false }),
    raw: async (o, r, s, p) => Buffer.from(p === corrupt ? files[p] + " " : files[p]),
  };
}
const FILES = { ".github/workflows/ci.yml": WORKFLOW, "package.json": JSON.stringify({ scripts: { hello: "echo hello-from-import" } }), "README.md": "x" };

test("import refuses a commit the default branch does not contain", async () => {
  const r = await importer.importRepo(`o/r@${SHA}`, { fetcher: fake({ status: "diverged", files: FILES }) });
  assert.equal(r.rc, 1);
  assert.match(r.why, /impostor-commit/);
});

test("import refuses bytes that do not hash to the tree's blob", async () => {
  const r = await importer.importRepo(`o/r@${SHA}`, { fetcher: fake({ files: FILES, corrupt: "package.json" }) });
  assert.equal(r.rc, 1);
  assert.match(r.why, /hash/);
});

test("import, trust, run: the gate holds at every step", async () => {
  const dry = await importer.importRepo(`o/r@${SHA}`, { fetcher: fake({ files: FILES }) });
  assert.equal(dry.rc, 0);
  assert.equal(dry.wrote, false);
  assert.equal(importer.records().length, 0, "a dry import writes nothing");
  assert.deepEqual(dry.files.map((f) => f.path).sort(), [".github/workflows/ci.yml", "package.json"], "only workflows and package.json");

  await importer.importRepo(`o/r@${SHA}`, { fetcher: fake({ files: FILES }), apply: true });
  const id = "gh:o/r@aaaaaaa:package:hello";
  let r = await auto.run(id, { apply: true, by: "person" });
  assert.equal(r.ran, false);
  assert.match(r.why, /untrusted/, "nobody runs an import before a person trusts it, not even the person's own CLI");

  assert.equal(importer.trust("gh:o/r@aaaaaaa:workflow:ci/injected").rc, 1, "a blocked record cannot be trusted");
  assert.equal(importer.trust(id).rc, 0);

  r = await auto.run(id, { by: "agent" });
  assert.equal(r.ran, false);
  assert.equal(r.would, "echo hello-from-import", "dry by default, and it names the exact command");

  r = await auto.run(id, { apply: true, by: "agent" });
  assert.equal(r.rc, 0);
  assert.match(r.out, /hello-from-import/);
  const ep = episodes.rows().find((e) => e.id === r.episode);
  assert.equal(ep.kind, "automation");
  assert.equal(ep.features.source, "import", "the source is a feature, so the outcome model can rank it");

  // The same id at a different command: trust was bound to the old hash.
  const changed = { ...FILES, "package.json": JSON.stringify({ scripts: { hello: "echo changed" } }) };
  await importer.importRepo(`o/r@${SHA}`, { fetcher: fake({ files: changed }), apply: true });
  r = await auto.run(id, { apply: true, by: "agent" });
  assert.equal(r.ran, false);
  assert.match(r.why, /untrusted/);
});

test("an agent cannot apply a script a person has not marked @safe", async () => {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  const body = (safe) => `#!/usr/bin/env bash\n# @tag t-${safe}\n# @title echo ${safe}\n# @safe ${safe}\necho ran-${safe}\n`;
  for (const s of ["true", "false"]) { const p = path.join(root, "scripts", `s-${s}.sh`); fs.writeFileSync(p, body(s)); fs.chmodSync(p, 0o755); }
  (await import("../src/scripts/index.js")).scan({ write: true });
  const unsafe = await auto.run("script:s-false", { apply: true, by: "agent" });
  assert.equal(unsafe.ran, false);
  assert.match(unsafe.why, /@safe/);
  const safe = await auto.run("script:s-true", { apply: true, by: "agent" });
  assert.equal(safe.rc, 0);
  assert.match(safe.out, /ran-true/);
});

test("rank: past runs order the list, cleared rows first", () => {
  const rows = [
    { id: "a", verb: "v:a", source: "local", cleared: true },
    { id: "b", verb: "v:b", source: "import", cleared: true },
    { id: "c", verb: "v:c", source: "local", cleared: false },
  ];
  const log = [
    { verb: "v:a", rc: 1, useful: -1 }, { verb: "v:a", rc: 1, useful: -1 },
    { verb: "v:b", rc: 0, useful: 1 }, { verb: "v:b", rc: 1, useful: 1 },
    { verb: "v:c", rc: 0, useful: 1 }, { verb: "v:c", rc: 0, useful: 1 }, { verb: "v:c", rc: 0, useful: 1 },
  ];
  const r = auto.rank(rows, { log, model: null });
  assert.deepEqual(r.map((x) => x.id), ["b", "a", "c"]);
  assert.equal(r[0].score, 0.75);
  assert.equal(r[0].basis, "labelled runs");
  assert.equal(r[1].basis, "runs, unlabelled by exit code");
  const m = auto.rank(rows, { log, model: { useful: true, weights: { "@bias": 0, "source=local": 3 } } });
  assert.equal(m[0].id, "a", "a trained model's source weight decides");
  assert.equal(m[0].basis, "outcome model");
});

test("MCP: the tools carry annotations, and a refused run is an execution error", async () => {
  const { serve } = await import("../src/mcp/server.js");
  const input = new PassThrough(), output = new PassThrough();
  const replies = [];
  output.on("data", (b) => { for (const l of String(b).split("\n")) if (l.trim()) replies.push(JSON.parse(l)); });
  const done = serve({ input, output });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bb_automation_run", arguments: { id: "script:s-false", apply: true } } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bb_automations", arguments: {} } }) + "\n");
  await new Promise((r) => setTimeout(r, 1500));
  input.end();
  await done;
  const tools = replies.find((r) => r.id === 1).result.tools;
  assert.equal(tools.find((t) => t.name === "bb_automations").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "bb_automation_run").annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "bb_pinpoint").annotations, undefined, "tools without annotations are served as before");
  const refused = replies.find((r) => r.id === 2).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /@safe/);
  assert.match(replies.find((r) => r.id === 3).result.content[0].text, /script:s-true/);
});
