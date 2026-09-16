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
const ev = (o) => ({ at: 0, session: "", kind: "", shape: "", file: "", hash: "", tokens: 0, scope: [], polls: false, ...o });
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

test("spin: a command whose answer this box does not control is polling, not spinning", async () => {
  const echos = await import("../src/echos/index.js");
  // Every `spin` hit on this workspace's first run was one of these.
  for (const s of ["gh pr", "curl", "git fetch", "git show", "npm run", "make", "kubectl"]) {
    assert.equal(echos.polls(s), true, `${s} is waiting on something outside this tree, or its argument picks the command`);
  }
  for (const s of ["npm test", "cargo build", "bb scan", "git branch", "pytest"]) {
    assert.equal(echos.polls(s), false, `${s} asks the same question every time`);
  }

  const events = [1, 2, 3, 4, 5].map((at) => ev({ at, session: "s", kind: "shape", shape: "gh pr", polls: true }));
  const r = fallback.run({ events, thresholds: TH });
  assert.deepEqual(verdict(r, "spin"), ["ok"], "six `gh pr` calls is a session watching CI, not one spinning");
});

test("writesFiles: a write through the shell is a write", async () => {
  const echos = await import("../src/echos/index.js");
  // `drift` reported four sessions as having changed nothing; one had 217 Bash
  // calls carrying 59 redirects, 42 heredocs, 11 git writes and 4 `sed -i`.
  for (const c of ["sed -i 's/a/b/' f.js", "node x.js > out.txt", "cat <<EOF > f.py\nx\nEOF",
    "git checkout main", "git commit -m x", "mv a.js b.js", "npm test | tee log.txt"]) {
    assert.equal(echos.writesFiles(c), true, `${c} changes something`);
  }
  for (const c of ["npm test", "grep -rn x src | head -20", "ls -la", "node -e 1 2>&1", "curl -s u > /dev/null"]) {
    assert.equal(echos.writesFiles(c), false, `${c} changes nothing`);
  }
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

/** One session of 12 turns, `lateCost`x dearer in its late half, with three
 *  edits a side so it is eligible for the ratio at all. `t0` spaces sessions
 *  apart so their events never interleave. */
function costlySession(session, lateCost, t0 = 0) {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(ev({ at: t0 + i + 1, session, kind: "turn", tokens: i < 6 ? 1000 : lateCost }));
  for (const d of [1, 2, 3]) events.push(ev({ at: t0 + d, session, kind: "edit", file: "a.js", hash: `e${d}` }));
  for (const d of [8, 9, 10]) events.push(ev({ at: t0 + d, session, kind: "edit", file: "a.js", hash: `l${d}` }));
  return events;
}

test("diminishing: a half with fewer than three edits is drift, and is not counted here", () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(ev({ at: i + 1, session: "s", kind: "turn", tokens: 1000 * (i + 1) }));
  // Two edits in each half: below the floor, so this session carries no ratio.
  events.push(ev({ at: 2, session: "s", kind: "edit", file: "a.js", hash: "A" }));
  events.push(ev({ at: 3, session: "s", kind: "edit", file: "a.js", hash: "B" }));
  events.push(ev({ at: 9, session: "s", kind: "edit", file: "a.js", hash: "C" }));
  events.push(ev({ at: 10, session: "s", kind: "edit", file: "a.js", hash: "D" }));
  const r = fallback.run({ events, thresholds: TH });
  // No eligible session at all, so there is no median and the answer is
  // `unknown` — never `ok`, which would say nothing was wrong when nothing was
  // checked.
  assert.deepEqual(verdict(r, "diminishing"), ["unknown"]);
});

test("diminishing: below five eligible sessions there is no typical ratio, so the answer is unknown", () => {
  const events = [];
  for (let i = 0; i < 4; i++) events.push(...costlySession(`s${i}`, 9000, i * 100));
  const r = fallback.run({ events, thresholds: TH });
  assert.deepEqual(verdict(r, "diminishing"), ["unknown"]);
  assert.match(byId(r, "diminishing")[0].detail, /typical cost per change/);
});

test("diminishing: the bar is a MULTIPLE OF THIS WORKSPACE'S MEDIAN, not an absolute ratio", () => {
  // The defect: an absolute 1.6 fired on 15 of 15 eligible sessions here,
  // because a long session always costs more per change — the window is re-sent
  // every turn. A rule that fires on the middle of a distribution describes the
  // distribution. Six sessions all equally dear: none of them is unusual.
  const flat = [];
  for (let i = 0; i < 6; i++) flat.push(...costlySession(`s${i}`, 9000, i * 100));
  let r = fallback.run({ events: flat, thresholds: TH });
  assert.deepEqual(verdict(r, "diminishing"), ["ok"], "everything at the median is nobody's outlier");
  assert.match(byId(r, "diminishing")[0].detail, /median cost per change/);

  // The same six, plus one far dearer than the rest. That one is the finding.
  const withOutlier = [...flat, ...costlySession("outlier", 90000, 900)];
  r = fallback.run({ events: withOutlier, thresholds: TH });
  const hits = byId(r, "diminishing").filter((e) => e.verdict === "hit");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session, "outlier");
  assert.ok(hits[0].evidence.some((x) => x.startsWith("workspace_median=")), "the median it was judged against is on the finding");
  assert.ok(hits[0].evidence.some((x) => x.startsWith("bar=")));
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
    // Six eligible sessions plus a dearer one, so `diminishing` has a median to
    // judge against and something to judge.
    ...Array.from({ length: 6 }, (_, i) => costlySession(`dim${i}`, 9000, 200 + i * 100)).flat(),
    ...costlySession("dimOutlier", 90000, 1000),
    // A polling command, so `spin`'s `polls` rule is exercised on both sides.
    ...[1, 2, 3, 4, 5].map((at) => ev({ at, session: "poll", kind: "shape", shape: "gh pr", polls: true })),
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
