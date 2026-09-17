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

const TH = { spin_repeats: 4, oscillate_flips: 3, drift_turns: 12, diminishing_ratio: 1.6, converge_similarity: 0.95, converge_runs: 3,
  stray_share: 0.5, stray_edits: 4, stray_briefs: 2, batching_ratio: 1.5, batching_calls: 20, batching_sessions: 3 };
const ev = (o) => ({ at: 0, session: "", kind: "", shape: "", file: "", hash: "", tokens: 0, tools: 0, scope: [], polls: false, ...o });
const byId = (r, id) => r.echos.filter((e) => e.id === id);
const verdict = (r, id) => byId(r, id).map((e) => e.verdict);

/** The Rust binary, when this box has one built FROM THIS SOURCE.
 *
 *  Existence is not enough, and the day this check was written is why. The
 *  binary on the box had been compiled before `arc/src/echos/diminishing.rs`
 *  last changed, so it answered with a minimum-sessions rule that no longer
 *  exists in any source file — and the agreement test below reported a
 *  divergence between the JS and a revision nobody was running. It had been
 *  reporting a PASS for as long as the stale rule happened to agree, which is
 *  the worse half: a verdict about two implementations, one of which was never
 *  the one on disk.
 *
 *  So a binary older than its sources is neither a pass nor a failure. It is a
 *  skip that names the command, because "the two agree" and "I could not check
 *  whether they agree" are different answers.
 *
 *  mtime, not a content hash: cargo's own freshness check is mtime-based, and
 *  being wrong here costs one skip and a rebuild rather than a false verdict.
 *  A `git checkout` restamps the sources it touches, so this skips after a
 *  branch switch until `npm run arc` runs. That is the safe direction. */
const ARC = (() => {
  const p = path.join(process.cwd(), "arc", "target", "release", process.platform === "win32" ? "arc.exe" : "arc");
  if (!fs.existsSync(p)) return { path: "", why: "arc is not built (npm run arc)" };
  const built = fs.statSync(p).mtimeMs;
  const newer = [];
  const stack = [path.join(process.cwd(), "arc", "src")];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }   // no arc/src on a packed install
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(f); continue; }
      try { if (fs.statSync(f).mtimeMs > built) newer.push(path.relative(process.cwd(), f)); } catch { /* raced with a checkout */ }
    }
  }
  const manifest = path.join(process.cwd(), "arc", "Cargo.toml");
  try { if (fs.statSync(manifest).mtimeMs > built) newer.push("arc/Cargo.toml"); } catch { /* absent */ }
  if (newer.length) {
    return { path: "", why: `arc is older than ${newer.length} of its source file(s) — ${newer.sort().slice(0, 3).join(", ")}${newer.length > 3 ? ", …" : ""}; run \`npm run arc\`` };
  }
  return { path: p, why: "" };
})();

function viaArc(payload) {
  const r = spawnSync(ARC.path, ["echos"], { input: JSON.stringify(payload), encoding: "utf8", timeout: 60000 });
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

// ── stray ───────────────────────────────────────────────────────────────────
// `converge` can settle on the wrong files and report convergence with total
// confidence. These pin the question it cannot ask: was the located scope where
// the work actually happened?

const brief = (at, session, scope) => ev({ at, session, kind: "brief", scope });
const edit = (at, session, file) => ev({ at, session, kind: "edit", file, hash: `${session}${at}` });

test("stray is unknown until enough briefs were followed by enough named edits", () => {
  const events = [brief(1, "s", ["a.js"]), edit(2, "s", "a.js"), edit(3, "s", "b.js")];
  const r = fallback.run({ events, thresholds: TH, only: ["stray"] });
  assert.deepEqual(verdict(r, "stray"), ["unknown"]);
  assert.match(byId(r, "stray")[0].detail, /2 are needed/);
});

test("stray is ok when the work lands inside the scope that was handed over", () => {
  const events = [
    brief(1, "s", ["a.js", "b.js"]),
    ...["a.js", "b.js", "a.js", "c.js"].map((f, i) => edit(2 + i, "s", f)),
    brief(10, "s", ["d.js"]),
    ...["d.js", "d.js", "d.js", "e.js"].map((f, i) => edit(11 + i, "s", f)),
  ];
  const r = fallback.run({ events, thresholds: TH, only: ["stray"] });
  assert.deepEqual(verdict(r, "stray"), ["ok"]);
  assert.match(byId(r, "stray")[0].detail, /2 of 8/);
});

test("stray reports the brief whose scope missed the work, and names the files", () => {
  const events = [
    brief(1, "s", ["a.js"]),
    ...["a.js", "x.js", "y.js", "z.js"].map((f, i) => edit(2 + i, "s", f)),
    brief(10, "s", ["b.js"]),
    ...["q.js", "r.js", "s.js", "t.js"].map((f, i) => edit(11 + i, "s", f)),
  ];
  const r = fallback.run({ events, thresholds: TH, only: ["stray"] });
  const hit = byId(r, "stray")[0];
  assert.equal(hit.verdict, "hit");
  assert.equal(hit.support, 2);
  // The second brief missed all four; the first missed three.
  assert.match(hit.detail, /q\.js, r\.js, s\.js, t\.js/);
  assert.ok(hit.evidence.includes("in_scope=1"));
  assert.ok(hit.evidence.includes("strayed=7"));
});

test("a shell write carries no path and is counted on neither side", () => {
  // Four named edits and four pathless ones. If the pathless writes counted as
  // strayed the share would be 0.75 and this would report a hit about writes
  // the box cannot name.
  const events = [
    brief(1, "s", ["a.js"]),
    ...["a.js", "a.js", "a.js", "b.js"].map((f, i) => edit(2 + i, "s", f)),
    ...[6, 7, 8, 9].map((at) => ev({ at, session: "s", kind: "edit", file: "", hash: "" })),
    brief(20, "s", ["c.js"]),
    ...["c.js", "c.js", "c.js", "d.js"].map((f, i) => edit(21 + i, "s", f)),
  ];
  const r = fallback.run({ events, thresholds: TH, only: ["stray"] });
  const e = byId(r, "stray")[0];
  assert.equal(e.verdict, "ok");
  assert.match(e.detail, /2 of 8/);
});

test("edits before the first brief have nothing to have strayed from", () => {
  const events = [
    ...["early1.js", "early2.js", "early3.js"].map((f, i) => edit(1 + i, "s", f)),
    brief(10, "s", ["a.js"]),
    ...["a.js", "a.js", "a.js", "a.js"].map((f, i) => edit(11 + i, "s", f)),
    brief(20, "s", ["b.js"]),
    ...["b.js", "b.js", "b.js", "b.js"].map((f, i) => edit(21 + i, "s", f)),
  ];
  const r = fallback.run({ events, thresholds: TH, only: ["stray"] });
  const e = byId(r, "stray")[0];
  assert.equal(e.verdict, "ok");
  assert.match(e.detail, /0 of 8/);
});

// ── batching ───────────────────────────────────────────────────────────────
// The attempts-per-round term. What a turn costs is the window, not the call.

const turnsWith = (n, session, tools) => Array.from({ length: n }, (_, i) => ev({ at: i + 1, session, kind: "turn", tokens: 100, tools }));

test("batching: one call per turn, pooled over enough sessions, is ONE hit", () => {
  const events = ["a", "b", "c"].flatMap((sx) => turnsWith(24, sx, 1));
  const r = fallback.run({ events, thresholds: TH, only: ["batching"] });
  const hits = byId(r, "batching");
  assert.equal(hits.length, 1, "a habit is one finding, not one per session");
  assert.equal(hits[0].verdict, "hit");
  assert.equal(hits[0].support, 72);
  assert.ok(hits[0].evidence.includes("sessions=3"));
  assert.ok(hits[0].evidence.includes("ratio=1.00"));
});

test("batching: a workspace that batches is ok, and says what it pooled", () => {
  const events = ["a", "b", "c"].flatMap((sx) => turnsWith(12, sx, 3));
  const r = fallback.run({ events, thresholds: TH, only: ["batching"] });
  assert.deepEqual(verdict(r, "batching"), ["ok"]);
  assert.match(byId(r, "batching")[0].detail, /108 tool call\(s\) over 36 turn\(s\) across 3 session\(s\)/);
});

test("batching: below the session floor there is no habit to report", () => {
  const r = fallback.run({ events: turnsWith(24, "s", 1), thresholds: TH, only: ["batching"] });
  assert.deepEqual(verdict(r, "batching"), ["unknown"]);
  assert.match(byId(r, "batching")[0].detail, /3 are needed/);
});

test("batching: a turn that called no tool is thinking, not a failure to batch", () => {
  // 20 calls over 20 calling turns is 1.0. The 40 silent turns must not drag it
  // to 0.33 — that would be a larger claim, about a session that answered a lot.
  const events = ["a", "b", "c"].flatMap((sx) => [
    ...turnsWith(20, sx, 1),
    ...turnsWith(40, sx, 0).map((e, i) => ({ ...e, at: 100 + i })),
  ]);
  const e = byId(fallback.run({ events, thresholds: TH, only: ["batching"] }), "batching")[0];
  assert.equal(e.verdict, "hit");
  assert.ok(e.evidence.includes("turns=60"));
  assert.ok(e.evidence.includes("ratio=1.00"));
});

test("batching: the worst session is named, and it is the lowest ratio", () => {
  const events = [
    ...turnsWith(30, "batches", 3),        // 90 calls / 30 turns = 3.00
    ...turnsWith(24, "serial", 1),         // 24 / 24 = 1.00
    ...turnsWith(20, "middling", 2),       // 40 / 20 = 2.00
  ];
  const r = fallback.run({ events, thresholds: { ...TH, batching_ratio: 3 }, only: ["batching"] });
  const e = byId(r, "batching")[0];
  assert.equal(e.verdict, "hit");
  assert.equal(e.session, "serial");
  assert.ok(e.evidence.includes("worst=1.00"));
});

test("batching: every threshold that decided it is printed back", () => {
  const events = ["a", "b", "c"].flatMap((sx) => turnsWith(24, sx, 1));
  const r = fallback.run({ events, thresholds: { ...TH, batching_ratio: 2, batching_calls: 5 }, only: ["batching"] });
  assert.equal(r.thresholds.batching_ratio, 2);
  assert.equal(r.thresholds.batching_calls, 5);
  assert.ok(byId(r, "batching")[0].evidence.includes("threshold=2"));
});

test("arc and the fallback agree, event for event", { skip: ARC.path ? false : ARC.why }, () => {
  // One stream carrying every shape all seven echos look for, so agreement here
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
    // Two briefs, each followed by edits that mostly miss, so `stray` reports a
    // hit on both sides rather than agreeing about an empty answer.
    ev({ at: 80, session: "aim", kind: "brief", scope: ["in.js"] }),
    ...["in.js", "off1.js", "off2.js", "off3.js"].map((file, i) => ev({ at: 81 + i, session: "aim", kind: "edit", file, hash: `h${i}` })),
    ev({ at: 90, session: "aim", kind: "brief", scope: ["in.js", "also.js"] }),
    ...["off4.js", "off5.js", "also.js", "off6.js"].map((file, i) => ev({ at: 91 + i, session: "aim", kind: "edit", file, hash: `g${i}` })),
    // Three serial sessions, so `batching` clears its session floor and hits on
    // both sides rather than agreeing about an `unknown`.
    ...["ser1", "ser2", "ser3"].flatMap((sx) => Array.from({ length: 24 }, (_, i) => ev({ at: 200 + i, session: sx, kind: "turn", tokens: 100, tools: 1 }))),
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

test("`only` narrows both implementations the same way", { skip: ARC.path ? false : ARC.why }, () => {
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
