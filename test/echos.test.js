// echos.test.js — the five agents that watch the work, and the one property
// that keeps two implementations of them honest.
//
// There are two: `arc/src/echos/` in Rust, and `src/echos/fallback.js` in
// JavaScript for a box with no compiled binary. Two implementations of one rule
// is a thing that drifts, so the important test here is not any single echo —
// it is that both answer identically over the same stream. Everything else
// locks down a defect found by running these against this repository's own
// history:
//
//   - `cat` x10 and `ls` x8 reported as spinning, because a recorded shape
//     drops the arguments and ten `cat`s are ten different files;
//   - `import` and `await` reported as commands, from heredoc bodies the shape
//     recorder used to shape before it learned to strip them;
//   - "not one edit" reported for sessions whose transcripts carry no tool call
//     at all, which is a zero for something that was never checked;
//   - "7,685,770 tokens per edit" off a 355-turn session with two edits in it,
//     which is a true number describing drift rather than diminishing returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-echos-")));
process.env.BB_ROOT = root;
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));

const fallback = await import("../src/echos/fallback.js");
const record = await import("../src/lathe/record.js");

const TH = { spin_repeats: 4, oscillate_flips: 3, drift_turns: 12, diminishing_ratio: 1.6, converge_similarity: 0.95, converge_runs: 3 };
const ev = (o) => ({ at: 0, session: "", kind: "", shape: "", file: "", hash: "", tokens: 0, scope: [], ...o });
const byId = (r, id) => r.echos.filter((e) => e.id === id);
const verdict = (r, id) => byId(r, id).map((e) => e.verdict);

/** The Rust binary, when this box has one built. Not a skip-if-missing on the
 *  agreement test alone: every other test here runs against the fallback, so a
 *  box with no cargo still proves the rules. */
const ARC = (() => {
  const p = path.join(process.cwd(), "arc", "target", "release", process.platform === "win32" ? "arc.exe" : "arc");
  return fs.existsSync(p) ? p : "";
})();

function viaArc(payload) {
  const r = spawnSync(ARC, ["echos"], { input: JSON.stringify(payload), encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `arc echos exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("spin: the same shape, four times, with nothing edited between", () => {
  const events = [1, 2, 3, 4].map((at) => ev({ at, session: "s", kind: "shape", shape: "npm test" }));
  const r = fallback.run({ events, thresholds: TH });
  const hits = byId(r, "spin").filter((e) => e.verdict === "hit");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].support, 4);
  assert.match(hits[0].detail, /npm test/);
});

test("spin: an edit between two runs breaks the streak, because that is how work is done", () => {
  const events = [
    ev({ at: 1, session: "s", kind: "shape", shape: "npm test" }),
    ev({ at: 2, session: "s", kind: "shape", shape: "npm test" }),
    ev({ at: 3, session: "s", kind: "edit", file: "a.js", hash: "A" }),
    ev({ at: 4, session: "s", kind: "shape", shape: "npm test" }),
    ev({ at: 5, session: "s", kind: "shape", shape: "npm test" }),
  ];
  const r = fallback.run({ events, thresholds: TH });
  assert.deepEqual(verdict(r, "spin"), ["ok"]);
});

test("record.names: a shape has to name the work, not the tool that carried it", () => {
  // The whole reason `spin` stopped reporting reading as spinning.
  for (const s of ["cat", "ls", "grep", "head", "node", "python3", "timeout", "sudo"]) {
    assert.equal(record.names(s), false, `${s} names a tool, not the work`);
  }
  // Heredoc leftovers from before the shape recorder stripped them.
  for (const s of ["import", "await", "const", "export"]) {
    assert.equal(record.names(s), false, `${s} is a language keyword, not a command`);
  }
  for (const s of ["npm test", "cargo build", "bb scan", "git commit", "make", "pytest"]) {
    assert.equal(record.names(s), true, `${s} names what ran`);
  }
});

test("oscillate: a file coming back to a value it already had", () => {
  const events = ["A", "B", "A", "B", "A"].map((hash, i) => ev({ at: i + 1, session: "s", kind: "edit", file: "a.js", hash }));
  const r = fallback.run({ events, thresholds: TH });
  const hits = byId(r, "oscillate").filter((e) => e.verdict === "hit");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].support, 3);
});

test("oscillate: the same hash twice in a row is one edit reported twice, not a return", () => {
  const events = ["A", "A", "A", "A", "A"].map((hash, i) => ev({ at: i + 1, session: "s", kind: "edit", file: "a.js", hash }));
  const r = fallback.run({ events, thresholds: TH });
  assert.deepEqual(verdict(r, "oscillate"), ["ok"]);
});

test("drift: turns with reads and no edit is a hit; turns with NO tool call at all is unknown", () => {
  const turns = (n, session) => Array.from({ length: n }, (_, i) => ev({ at: i + 1, session, kind: "turn", tokens: 1000 }));
  // A session this box could look inside: it read files and changed nothing.
  const seen = [...turns(14, "seen"), ...[1, 2].map((i) => ev({ at: i, session: "seen", kind: "read", file: "a.js" }))];
  let r = fallback.run({ events: seen, thresholds: TH });
  assert.ok(byId(r, "drift").some((e) => e.verdict === "hit"));

  // A session with turns and nothing else: never checked, so never "ok".
  r = fallback.run({ events: turns(40, "dark"), thresholds: TH });
  assert.deepEqual(verdict(r, "drift"), ["unknown"]);
  assert.match(byId(r, "drift")[0].detail, /tool call/, "the reason has to name what could not be looked at");
});

test("diminishing: a half with fewer than three edits is drift, and is not reported here", () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(ev({ at: i + 1, session: "s", kind: "turn", tokens: 1000 * (i + 1) }));
  // Two edits in each half: below the floor, so no ratio is printed.
  events.push(ev({ at: 2, session: "s", kind: "edit", file: "a.js", hash: "A" }));
  events.push(ev({ at: 3, session: "s", kind: "edit", file: "a.js", hash: "B" }));
  events.push(ev({ at: 9, session: "s", kind: "edit", file: "a.js", hash: "C" }));
  events.push(ev({ at: 10, session: "s", kind: "edit", file: "a.js", hash: "D" }));
  const r = fallback.run({ events, thresholds: TH });
  assert.deepEqual(verdict(r, "diminishing"), ["ok"]);
});

test("diminishing: three edits a half and a rising cost per change is a hit", () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(ev({ at: i + 1, session: "s", kind: "turn", tokens: i < 6 ? 1000 : 9000 }));
  for (const at of [1, 2, 3]) events.push(ev({ at, session: "s", kind: "edit", file: "a.js", hash: `e${at}` }));
  for (const at of [8, 9, 10]) events.push(ev({ at, session: "s", kind: "edit", file: "a.js", hash: `l${at}` }));
  const r = fallback.run({ events, thresholds: TH });
  const hits = byId(r, "diminishing").filter((e) => e.verdict === "hit");
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /9\.0x|[0-9]+\.[0-9]x/);
});

test("converge: the scope settling is a STOP condition, and it needs more than one pair", () => {
  const scope = ["a.js", "b.js"];
  // Three pairs of four briefs: exactly the declared threshold.
  let r = fallback.run({ events: [0, 1, 2, 3].map((at) => ev({ at, session: "s", kind: "brief", scope })), thresholds: TH });
  const hits = byId(r, "converge").filter((e) => e.verdict === "hit");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].support, 3);

  // Two briefs cannot carry three pairs, and the answer is unknown, not ok.
  r = fallback.run({ events: [0, 1].map((at) => ev({ at, session: "s", kind: "brief", scope })), thresholds: TH });
  assert.deepEqual(verdict(r, "converge"), ["unknown"]);
});

test("converge: a scope that keeps moving is `ok`, and says how far it got", () => {
  const events = [
    ev({ at: 1, session: "s", kind: "brief", scope: ["a.js"] }),
    ev({ at: 2, session: "s", kind: "brief", scope: ["b.js"] }),
    ev({ at: 3, session: "s", kind: "brief", scope: ["c.js"] }),
    ev({ at: 4, session: "s", kind: "brief", scope: ["d.js"] }),
  ];
  const r = fallback.run({ events, thresholds: TH });
  assert.deepEqual(verdict(r, "converge"), ["ok"]);
  assert.match(byId(r, "converge")[0].detail, /still moving/);
});

test("similarity is Jaccard, and an identical scope is 1", () => {
  assert.equal(fallback.similarity(["a", "b"], ["a", "b"]), 1);
  assert.equal(fallback.similarity(["a"], ["b"]), 0);
  assert.equal(fallback.similarity([], []), 1);
  assert.equal(Math.round(fallback.similarity(["a", "b", "c"], ["a", "b"]) * 100) / 100, 0.67);
});

test("every threshold is an input, and the result prints the ones that decided it", () => {
  const events = [1, 2].map((at) => ev({ at, session: "s", kind: "shape", shape: "npm test" }));
  const r = fallback.run({ events, thresholds: { ...TH, spin_repeats: 2 } });
  const hits = byId(r, "spin").filter((e) => e.verdict === "hit");
  assert.equal(hits.length, 1, "a lower floor finds it");
  assert.ok(hits[0].evidence.includes("threshold=2"));
  assert.equal(r.thresholds.spin_repeats, 2);
});

test("arc and the fallback agree, event for event", { skip: ARC ? false : "arc is not built (cargo build --release --manifest-path arc/Cargo.toml)" }, () => {
  // One stream carrying every shape all five echos look for, so agreement here
  // is agreement about all of them and not about an empty answer.
  const events = [
    ...[1, 2, 3, 4, 5].map((at) => ev({ at, session: "spin", kind: "shape", shape: "npm test" })),
    ...["A", "B", "A", "B", "A"].map((hash, i) => ev({ at: i + 10, session: "osc", kind: "edit", file: "a.js", hash })),
    ...Array.from({ length: 20 }, (_, i) => ev({ at: i + 20, session: "drift", kind: "turn", tokens: 1234 })),
    ...[20, 21].map((at) => ev({ at, session: "drift", kind: "read", file: "b.js" })),
    ...Array.from({ length: 12 }, (_, i) => ev({ at: i + 50, session: "dim", kind: "turn", tokens: i < 6 ? 1000 : 9000 })),
    ...[50, 51, 52].map((at) => ev({ at, session: "dim", kind: "edit", file: "c.js", hash: `e${at}` })),
    ...[57, 58, 59].map((at) => ev({ at, session: "dim", kind: "edit", file: "c.js", hash: `l${at}` })),
    ...[70, 71, 72, 73].map((at) => ev({ at, session: "conv", kind: "brief", scope: ["x.js", "y.js"] })),
  ];
  const payload = { events, thresholds: TH, only: [] };
  const rust = viaArc(payload);
  const js = fallback.run(payload);

  const shape = (r) => r.echos.map((e) => [e.id, e.verdict, e.session, e.support, e.severity, e.detail, e.evidence.join("|")].join("")).sort();
  assert.deepEqual(shape(js), shape(rust), "the two implementations must return the identical set of findings");
  assert.equal(js.events, rust.events);
  assert.equal(js.sessions, rust.sessions);
  assert.equal(js.hits, rust.hits);
  assert.deepEqual(js.registry, rust.registry);
});

test("`only` narrows both implementations the same way", { skip: ARC ? false : "arc is not built" }, () => {
  const events = [1, 2, 3, 4].map((at) => ev({ at, session: "s", kind: "shape", shape: "npm test" }));
  const payload = { events, thresholds: TH, only: ["spin"] };
  const rust = viaArc(payload);
  const js = fallback.run(payload);
  assert.deepEqual([...new Set(js.echos.map((e) => e.id))], ["spin"]);
  assert.deepEqual([...new Set(rust.echos.map((e) => e.id))], ["spin"]);
});

test("a hit becomes a finding with the evidence that produced it", async () => {
  const echos = await import("../src/echos/index.js");
  const r = { at: new Date().toISOString(), echos: [
    { id: "spin", verdict: "hit", session: "abc", support: 5, severity: "medium", detail: "`npm test` ran 5 times. And more.", evidence: ["shape=npm test", "consecutive=5"] },
    { id: "drift", verdict: "ok", session: "", support: 0, severity: "info", detail: "nothing", evidence: [] },
  ] };
  const f = echos.asFindings(r);
  assert.equal(f.length, 1, "only hits become findings");
  assert.equal(f[0].detector, "echo:spin");
  assert.equal(f[0].evidence.count, 5);
  assert.deepEqual(f[0].evidence.lines, ["shape=npm test", "consecutive=5"]);
  assert.ok(f[0].fix_hint, "a finding with no fix is a complaint");
});
