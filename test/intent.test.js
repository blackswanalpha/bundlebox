// intent.test.js — the kind of a prompt is a budget decision, so these tests
// are about the two ways it can go wrong quietly: a table that decides on
// evidence it does not have, and a label that describes a session rather than
// the prompt inside it.
import { test } from "node:test";
import assert from "node:assert/strict";

const intent = await import("../src/intent/index.js");

test("behaviourLabel: four kinds the transcript can prove, and the one it cannot", () => {
  const read = (file, at) => ({ kind: "read", file, at });
  const edit = (file, at) => ({ kind: "edit", file, at });

  assert.equal(intent.behaviourLabel([read("a.js", 1), read("b.js", 2)]).kind, "investigate");
  assert.equal(intent.behaviourLabel([read("a.js", 1), edit("a.js", 2)]).kind, "fix");
  assert.equal(intent.behaviourLabel([edit("new.js", 2)]).kind, "build", "a file written without being read did not exist");
  assert.equal(intent.behaviourLabel([read("docs/x.md", 1), edit("docs/x.md", 2)]).kind, "write");
  // A shell write carries no path, so it cannot be told from a fix. Stated
  // here because it is a limit of the stream, not of this function.
  assert.equal(intent.behaviourLabel([{ kind: "edit", file: "", at: 1 }]).kind, "fix");
  // Nothing in the stream says a suite ran, so `verify` is never a behaviour
  // label. If this ever fails, echos grew an event and splitVerify is obsolete.
  assert.ok(!["verify"].includes(intent.behaviourLabel([read("a.js", 1)]).kind));
});

test("classify: every fallback path returns the shipped default and says why", () => {
  const steps = (r) => r.steps.join(" ");
  const none = intent.classify("anything", { head: null });
  assert.equal(none.kind, intent.FALLBACK);
  assert.equal(none.via, "default");
  assert.match(steps(none), /no table on disk/);

  assert.match(steps(intent.classify("x", { head: { drift: true, useful: true, kinds: {} } })), /probes disagree/);
  assert.match(steps(intent.classify("x", { head: { useful: false, why: "n=3" } })), /n=3/);
  assert.equal(intent.classify("x", { head: { useful: true, kinds: { fix: { useful: false } } } }).kind, intent.FALLBACK);
});

test("classify: a one-vs-rest head that says no is not a vote for itself", () => {
  // One useful head. Argmax alone would hand it every prompt; the gate is what
  // stops the only fitted kind becoming the answer to everything.
  const head = { useful: true, n: 40, by_kind: { investigate: 20 }, by_via: {},
    kinds: { investigate: { useful: true, accuracy: 0.9, base_accuracy: 0.6, weights: { "@bias": -1, question: 4, task_shaped: -3 } } } };
  const q = intent.classify("what does this design imply for the similarity() in heap.js?", { head });
  const t = intent.classify("fix the pre-read guard in src/wire/hooks.js", { head });
  assert.equal(q.kind, "investigate");
  assert.equal(q.via, "table");
  assert.ok(q.p >= intent.DECIDE_AT);
  assert.equal(t.kind, intent.FALLBACK, "below the gate the head is saying `not mine`");
  assert.match(t.steps.join(" "), /no kind claims this prompt/);
});

test("classify: the derivation names the rows the table rests on, including the borrowed ones", () => {
  const head = { useful: true, n: 40, by_kind: { investigate: 20 }, by_via: { behaviour: 31, jev: 9 },
    kinds: { investigate: { useful: true, accuracy: 0.9, base_accuracy: 0.6, weights: { "@bias": 4 } } } };
  const r = intent.classify("anything at all", { head });
  assert.equal(r.kind, "investigate");
  assert.match(r.steps.join(" "), /fitted on 20 rows, holdout accuracy 0\.9 against base 0\.6/);
  assert.match(r.steps.join(" "), /9 of 40 rows in this table were split by Jev/);
});

test("classify is deterministic: same table, same prompt, same kind", () => {
  const head = { useful: true, n: 40, by_kind: {}, by_via: {},
    kinds: { build: { useful: true, weights: { "@bias": 2, "len~log": -1 } } } };
  const runs = new Set();
  for (let i = 0; i < 25; i++) runs.add(JSON.stringify(intent.classify("wire the lathe into the runner", { head })));
  assert.equal(runs.size, 1);
});

test("splitVerify: Jev moves only the rows behaviour could not split, and only above the threshold", () => {
  const rows = [
    { prompt: "run the suite and tell me it still passes", kind: "investigate", via: "behaviour" },
    { prompt: "why does capacity subtract the reserve", kind: "investigate", via: "behaviour" },
    { prompt: "wire the lathe in", kind: "fix", via: "behaviour" },
  ];
  const ask = (state, questions) => {
    assert.equal(Object.keys(questions).length, 2, "only the investigate rows are asked about");
    assert.ok(state.includes("run the suite"));
    return { by: { p0: 0.91, p1: 0.12 }, ms: 3 };
  };
  const r = intent.splitVerify(rows, { ask });
  assert.equal(r.moved, 1);
  assert.equal(rows[0].kind, "verify");
  assert.equal(rows[0].via, "jev", "a borrowed label is stamped as one");
  assert.equal(rows[1].kind, "investigate", "below the threshold the behaviour label stands");
  assert.equal(rows[2].kind, "fix", "a row behaviour could split is never asked about");
});

test("splitVerify: a silent Jev leaves every behaviour label exactly as it was", () => {
  const rows = [{ prompt: "why does capacity subtract the reserve", kind: "investigate", via: "behaviour" }];
  const r = intent.splitVerify(rows, { ask: () => null });
  assert.equal(r.moved, 0);
  assert.equal(r.answered, 0);
  assert.equal(rows[0].kind, "investigate");
  assert.equal(rows[0].via, "behaviour");
});

test("signals: the medians split by kind, and one kind is not a split", async () => {
  // The Python side owns the grouping; this pins the contract the report reads.
  const { spawnSync } = await import("node:child_process");
  const run = (rows) => JSON.parse(spawnSync("python3", ["-c",
    "import sys,json;sys.path.insert(0,'expert');from bundlebox_expert import signals;print(json.dumps(signals.aggregate(json.load(sys.stdin))))"],
    { input: JSON.stringify(rows), encoding: "utf8" }).stdout);

  const two = run([{ kind: "fix", reread_ratio: 0.8 }, { kind: "investigate", reread_ratio: 0.2 }]);
  assert.deepEqual(two.kinds_seen, ["fix", "investigate"]);
  assert.equal(two.by_kind.fix.reread_ratio, 0.8);
  assert.equal(two.by_kind.investigate.reread_ratio, 0.2);

  const one = run([{ kind: "fix", reread_ratio: 0.8 }, { kind: "fix", reread_ratio: 0.6 }]);
  assert.deepEqual(one.by_kind, {}, "one kind is the aggregate printed twice, not a comparison");
  assert.deepEqual(one.kinds_seen, ["fix"]);

  const none = run([{ reread_ratio: 0.8 }]);
  assert.deepEqual(none.kinds_seen, [], "an unlabelled session is not a `fix`");
});
