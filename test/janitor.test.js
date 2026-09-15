// janitor.test.js — the compiler's invariants, and mostly the ones that are
// about what it must REFUSE to do.
//
// A memory collector that saves tokens is easy and worth nothing on its own:
// deleting everything saves the most. What earns this one its place is the set
// of things it will not do — never rewrite the text of a rule, never delete a
// contradicted claim instead of retracting it, never resolve an anchor from the
// wrong directory, never put the highest-valued content in the middle of the
// window. Those are the assertions here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { make, isLive, value, similarity, HALF_LIFE, POLICY, tombstone } from "../src/janitor/heap.js";
import { classify, anchorOf, blocks, linksOf, frontmatter, isUncheckableClaim } from "../src/janitor/parse.js";
import { resolveAnchor, resolve, resetCache, resetSymbols } from "../src/janitor/resolve.js";
import { mark, graph, rootsFrom } from "../src/janitor/mark.js";
import { sweep, contradicts } from "../src/janitor/sweep.js";
import { compact, pinned } from "../src/janitor/compact.js";
import { place } from "../src/janitor/place.js";
import { sql, CATALOG, QUERIES, survey, shapeOf, viewBody } from "../src/janitor/warehouse.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bb-janitor-"));
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ── classification: the safety property ─────────────────────────────────────

test("a directive at the front of a block is a rule; the same word buried in prose is not", () => {
  assert.equal(classify("Never edit anything under .bundlebox/out/"), "rule");
  assert.equal(classify("Do not add a co-author to a commit message."), "rule");
  const prose = "The pipeline reads the transcript and folds it into the ledger, and the number it "
    + "produces is measured rather than estimated, which is the property the report must preserve.";
  assert.notEqual(classify(prose), "rule", "a paragraph containing 'must' is a paragraph");
});

test("classification order is rule, pointer, fact, episode, note", () => {
  // A rule that also carries a path is still a rule: misfiling it as a fact
  // hands it to a pass that is allowed to rewrite it.
  assert.equal(classify("Never edit src/core/store.js by hand"), "rule");
  assert.equal(classify("the dashboard is at https://example.com/board"), "pointer");
  assert.equal(classify("the grow loop lives in src/pinpoint/grow.js:44"), "fact");
  assert.equal(classify("shipped v0.3.0 on 2026-09-14"), "episode");
  assert.equal(classify("the team prefers short briefs"), "note");
});

test("a URL is never mistaken for a file anchor", () => {
  // `github.com` matched as the file `github.c` before the trailing lookahead.
  assert.equal(anchorOf("see https://github.com/blackswanalpha/bundlebox").file, null);
  assert.equal(anchorOf("see src/janitor/heap.js:12").file, "src/janitor/heap.js");
  assert.equal(anchorOf("see src/janitor/heap.js:12").line, 12);
});

test("a specific number with no anchor is an uncheckable claim", () => {
  assert.ok(isUncheckableClaim(make({ kind: "note", text: "the hook is capped at 600 tokens" })));
  assert.ok(!isUncheckableClaim(make({ kind: "note", text: "the hook is capped", anchor: null })));
});

test("blocks keep a wrapped rule whole and split a table by row", () => {
  const md = "# h\n\n- Never edit\n  the generated tree\n\n| a | b |\n|---|---|\n| one | two |\n";
  const bs = blocks(md);
  assert.ok(bs.some((b) => b.text === "Never edit the generated tree"), "a wrapped bullet is one block");
  assert.ok(bs.some((b) => b.text === "one — two"), "a table row is its own block");
  assert.ok(!bs.some((b) => /^\|?[\s:|-]+$/.test(b.text)), "the separator row carries no claim");
});

test("frontmatter and wiki-links are read without a YAML parser", () => {
  assert.equal(frontmatter("---\nname: a-thing\ntype: project\n---\nbody").name, "a-thing");
  assert.deepEqual(linksOf("see [[other-memory]] and [[third]]"), ["other-memory", "third"]);
});

// ── resolve: the hallucination pass ─────────────────────────────────────────

test("an anchor resolves against the file that wrote it before the workspace root", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "memory"), { recursive: true });
  fs.writeFileSync(path.join(d, "memory", "sibling.md"), "x\n");
  fs.writeFileSync(path.join(d, "memory", "MEMORY.md"), "- [T](sibling.md)\n");
  resetCache(); resetSymbols();
  const rel = resolveAnchor({ file: "sibling.md", line: 0, symbol: null }, { base: path.join(d, "memory") });
  assert.equal(rel.status, "live", "a MEMORY.md index names its siblings, not paths from the root");
  const fromRoot = resolveAnchor({ file: "sibling.md", line: 0, symbol: null }, { base: d });
  assert.equal(fromRoot.status, "dead");
});

test("a live file with a missing symbol is drifted, not dead — and not live", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.js"), "export const kept = 1;\n");
  resetCache(); resetSymbols();
  assert.equal(resolveAnchor({ file: "a.js", symbol: "kept" }, { base: d }).status, "live");
  assert.equal(resolveAnchor({ file: "a.js", symbol: "gone" }, { base: d }).status, "drifted");
  assert.equal(resolveAnchor({ file: "a.js", line: 9000 }, { base: d }).status, "drifted");
  assert.equal(resolveAnchor({ file: "b.js" }, { base: d }).status, "dead");
});

test("a URL is external, and this pass never touches the network", () => {
  assert.equal(resolveAnchor({ url: "https://example.com", file: null, symbol: null }).status, "external");
});

test("a dead anchor on a rule is an error; on a fact it is a warning", () => {
  const d = tmp();
  resetCache(); resetSymbols();
  const objs = [
    make({ kind: "rule", text: "Never touch gone.js", source: path.join(d, "m.md"), anchor: { file: "gone.js" } }),
    make({ kind: "fact", text: "the loop is in gone.js", source: path.join(d, "m.md"), anchor: { file: "gone.js" } }),
  ];
  const { diags } = resolve(objs, { root: d });
  assert.equal(diags.find((x) => x.code === "dead-anchor" && x.id === objs[0].id).severity, "error");
  assert.equal(diags.find((x) => x.code === "dead-anchor" && x.id === objs[1].id).severity, "warning");
});

// ── mark: reachability, not age ─────────────────────────────────────────────

test("reach is traced through wiki-links, and survivors are promoted", () => {
  const a = make({ kind: "note", text: "root note [[leaf]]", source: "a.md", refs: ["leaf"], learned_at: days(400) });
  const b = make({ kind: "note", text: "leaf note", source: "leaf.md", learned_at: days(400) });
  const c = make({ kind: "note", text: "orphan", source: "orphan.md", learned_at: days(400) });
  const r = mark([a, b, c], rootsFrom(["a.md"]));
  assert.ok(a.reached, "a source a session opened is reached");
  assert.ok(b.reached, "a memory reached only through a link is reached");
  assert.equal(b.reached.hops, 1);
  assert.equal(c.reached, null, "nothing links to it and nothing opened it");
  assert.equal(a.gen, "middle", "survival promotes a generation");
  assert.equal(c.gen, "young");
  assert.equal(r.stats.promoted, 2);
});

test("an unreached rule is never reported stale, whatever its age", () => {
  const rule = make({ kind: "rule", text: "Never force-push main", source: "r.md", learned_at: days(900) });
  const note = make({ kind: "note", text: "an old aside", source: "n.md", learned_at: days(900) });
  const { diags } = mark([rule, note], rootsFrom([]));
  assert.ok(!diags.some((d) => d.id === rule.id), "a quiet rule is not a stale rule");
  assert.ok(diags.some((d) => d.id === note.id && d.code === "unreached"));
});

// ── sweep: retract, never delete ────────────────────────────────────────────

test("a contradicted claim is retracted and still on the heap", () => {
  const old = make({ kind: "fact", text: "marketing changes go through a pull request", source: "a.md", learned_at: days(200), valid_from: days(200) });
  const now_ = make({ kind: "fact", text: "marketing changes do not go through a pull request", source: "b.md", learned_at: days(1), valid_from: days(1) });
  const r = sweep([old, now_]);
  const after = r.objects.find((o) => o.id === old.id);
  assert.ok(after, "the retracted object is still present — a deleted fact is re-learned next week");
  assert.ok(after.retracted_at, "and it is out of the live set");
  assert.equal(isLive(after), false);
  assert.ok(String(after.meta.retracted_why).includes(now_.id));
  assert.equal(isLive(r.objects.find((o) => o.id === now_.id)), true);
});

test("two conflicting rules are an error and NEITHER is dropped", () => {
  const a = make({ kind: "rule", text: "always open a pull request for marketing copy", source: "a.md", learned_at: days(200) });
  const b = make({ kind: "rule", text: "never open a pull request for marketing copy", source: "b.md", learned_at: days(1) });
  const r = sweep([a, b]);
  assert.equal(r.stats.retracted, 0, "a safety rule is not overridden by whichever was written last");
  const d = r.diags.find((x) => x.code === "rule-conflict");
  assert.ok(d && d.severity === "error");
});

test("a dead anchor is quarantined, not retracted: uncheckable is not false", () => {
  const o = make({ kind: "fact", text: "the loop is in gone.js", source: "m.md", anchor: { file: "gone.js" } });
  o.resolution = "dead";
  const r = sweep([o]);
  const after = r.objects.find((x) => x.id === o.id);
  assert.equal(after.retracted_at, null, "not known to be false");
  assert.ok(after.meta.quarantined, "known to be uncheckable, so held out of the window");
  assert.equal(r.quarantined.length, 1);
});

test("age-out needs silence AND a kind the policy releases; a rule is never released", () => {
  const stale = make({ kind: "note", text: "a note nothing has touched", source: "n.md", learned_at: days(HALF_LIFE.note * 3 + 10) });
  const rule = make({ kind: "rule", text: "Never force-push main", source: "r.md", learned_at: days(5000) });
  const r = sweep([stale, rule], { ageFactor: 3 });
  assert.ok(r.objects.find((o) => o.id === stale.id).retracted_at);
  assert.equal(r.objects.find((o) => o.id === rule.id).retracted_at, null);
  assert.equal(POLICY.rule.age_out, false);
  assert.equal(HALF_LIFE.rule, Infinity);
});

test("a reached object is not aged out however old it is", () => {
  const o = make({ kind: "note", text: "old but used", source: "n.md", learned_at: days(2000) });
  o.reached = { at: days(2), by: "source", hops: 0 };
  assert.equal(sweep([o]).objects[0].retracted_at, null);
});

// ── compact: the cliff invariant ────────────────────────────────────────────

test("the text of a rule or a fact is NEVER rewritten", () => {
  // The Compaction Cliff result: uniform summarisation keeps 53% of safety
  // rules through one round and 10% through five, because only the rule needs
  // its exact wording to stay enforceable. This is the assertion that stops it.
  const texts = [
    "Never edit anything under .bundlebox/out/: it is generated and fingerprinted",
    "Never edit anything under .bundlebox/out because it is generated and fingerprinted",
    "the grow loop lives in src/pinpoint/grow.js and stops at the first file it cannot afford",
    "the grow loop is in src/pinpoint/grow.js and stops at the first unaffordable file",
  ];
  const objs = [
    make({ kind: "rule", text: texts[0], source: "a.md" }),
    make({ kind: "rule", text: texts[1], source: "b.md" }),
    make({ kind: "fact", text: texts[2], source: "c.md", anchor: { file: "src/pinpoint/grow.js" } }),
    make({ kind: "fact", text: texts[3], source: "d.md", anchor: { file: "src/pinpoint/grow.js" } }),
  ];
  const r = compact(objs);
  for (const o of r.objects.filter((x) => x.kind === "rule" || x.kind === "fact")) {
    assert.ok(texts.includes(o.text), `compaction rewrote a ${o.kind}: ${o.text}`);
  }
  assert.equal(r.stats.rules_rewritten, 0);
  assert.ok(r.diags.some((d) => d.code === "near-duplicate"), "near-duplicates are reported instead");
});

test("an exact duplicate collapses and remembers where else it was written", () => {
  const t = "Never add a co-author to a commit message";
  const r = compact([make({ kind: "rule", text: t, source: "a.md" }), make({ kind: "rule", text: t, source: "b.md" })]);
  const kept = r.objects.filter((o) => o.kind === "rule");
  assert.equal(kept.length, 1);
  assert.ok(kept[0].meta.also_at.some((s) => s.startsWith("b.md") || s.startsWith("a.md")));
  assert.equal(r.stats.exact, 1);
});

test("notes and episodes are foldable; runs of episodes collapse to one counted line", () => {
  assert.equal(POLICY.note.fold, true);
  assert.equal(POLICY.episode.fold, true);
  // Distinct enough that the near-duplicate pass leaves them alone: the fold is
  // about a RUN from one source, not about resemblance.
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
  const eps = words.map((w, i) => make({ kind: "episode", text: `${w} handler wrote ${w}${i} into the store`, source: "var/x.jsonl", learned_at: days(i + 1) }));
  const r = compact(eps, { minRun: 4 });
  const folded = r.objects.find((o) => o.meta && o.meta.folded);
  assert.ok(folded, "a run of unreached episodes from one source folds");
  assert.match(folded.text, /9 episodes from var\/x\.jsonl/);
  assert.equal(r.objects.length, 1);
  assert.equal(r.stats.folded, 8);
});

test("pinned() is the live rules, and nothing else", () => {
  const q = make({ kind: "rule", text: "Never a", source: "a.md" });
  q.meta = { quarantined: "gone" };
  const set = pinned([make({ kind: "rule", text: "Never b", source: "b.md" }), tombstone(make({ kind: "rule", text: "Never c", source: "c.md" }), "x"), q,
    make({ kind: "note", text: "n", source: "n.md" })]);
  assert.equal(set.length, 1);
  assert.equal(set[0].text, "Never b");
});

// ── place: the dumb zone ────────────────────────────────────────────────────

const heapOf = (n) => Array.from({ length: n }, (_, i) => {
  const o = make({ kind: i % 7 === 0 ? "fact" : i % 3 === 0 ? "note" : "episode", text: `object ${i} `.repeat(4), source: `s${i}.md`, tokens: 20, learned_at: days(i) });
  o.resolution = i % 7 === 0 ? "live" : "none";
  if (i < 12) o.reached = { at: days(1), by: "source", hops: 0 };
  return o;
});

test("the highest-valued content lands at the edges and the lowest in the middle", () => {
  const r = place(heapOf(120), { budget: 100000 });
  assert.ok(r.stats.lift > 1.2, `placement must beat a flat order; lift was ${r.stats.lift}`);
  assert.ok(r.stats.edge_value > r.stats.dead_zone_value);
});

test("rules are stated in full at the head and recalled at the tail", () => {
  const objs = [...heapOf(20), make({ kind: "rule", text: "Never force-push main", source: "r.md", tokens: 30 })];
  const r = place(objs, { budget: 100000 });
  assert.equal(r.placed[0].kind, "rule");
  assert.equal(r.placed[0].band, "head");
  const tail = r.placed[r.placed.length - 1];
  assert.equal(tail.band, "tail");
  assert.equal(tail.meta.recalls, r.placed[0].id);
  assert.ok(tail.tokens < r.placed[0].tokens, "the recall is cheaper than the statement");
});

test("the budget is cut from the middle outward, never from the ends", () => {
  const full = place(heapOf(120), { budget: 100000 });
  const cut = place(heapOf(120), { budget: 900 });
  assert.ok(cut.stats.tokens <= 900);
  assert.ok(cut.stats.dropped > 0);
  // The two best objects survive a cut that removed most of the heap.
  const bestIds = full.placed.slice(0, 2).map((o) => o.id);
  const keptIds = new Set(cut.placed.map((o) => o.id));
  for (const id of bestIds) assert.ok(keptIds.has(id), "a cut that loses the top-ranked object cut the wrong end");
});

test("rules that alone overflow the budget are cut loudly, not emitted silently", () => {
  const rules = Array.from({ length: 30 }, (_, i) => make({ kind: "rule", text: `Never do thing ${i}`, source: `r${i}.md`, tokens: 100 }));
  const r = place(rules, { budget: 500 });
  assert.ok(r.stats.tokens <= 500, "an image four times its budget is not an image");
  assert.ok(r.overflow.length > 0, "and the caller is told which rules went");
  assert.equal(r.stats.rules_dropped, r.overflow.length);
});

// ── prune: the only writer, and mostly what it refuses to touch ─────────────

test("prune removes only a retracted single-line bullet, and backs the file up", async () => {
  const { prune } = await import("../src/janitor/index.js");
  const d = tmp();
  const f = path.join(d, "m.md");
  const body = [
    "# notes",
    "",
    "- a stale one-liner",
    "- a stale claim that",
    "  wraps onto a second line",
    "- one that is still true",
    "",
  ].join("\n");
  fs.writeFileSync(f, body);
  const objs = [
    tombstone(make({ kind: "note", text: "a stale one-liner", source: f }), "aged out"),
    tombstone(make({ kind: "note", text: "a stale claim that wraps onto a second line", source: f }), "aged out"),
    make({ kind: "note", text: "one that is still true", source: f }),
  ];

  const dry = prune(objs, { apply: false });
  assert.equal(fs.readFileSync(f, "utf8"), body, "a dry run writes nothing");
  assert.equal(dry[0].cut.length, 1, "only the one-liner is removable");
  assert.equal(dry[0].unremovable.length, 1, "the wrapped one is reported, not guessed at");

  prune(objs, { apply: true });
  const after = fs.readFileSync(f, "utf8");
  assert.ok(!after.includes("a stale one-liner"));
  assert.ok(after.includes("one that is still true"), "a live claim is never touched");
  assert.ok(after.includes("wraps onto a second line"), "a pass that guesses where a block ends eats half a sentence");
  assert.equal(fs.readFileSync(`${f}.bak`, "utf8"), body, "the original is kept beside it");
});

test("prune never touches a retraction it only read back from a tombstone", async () => {
  const { prune } = await import("../src/janitor/index.js");
  const d = tmp();
  const f = path.join(d, "m.md");
  fs.writeFileSync(f, "- already retracted last week\n");
  const o = tombstone(make({ kind: "note", text: "already retracted last week", source: f }), "aged out");
  o.meta = { ...o.meta, from_tombstone: true };
  assert.deepEqual(prune([o], { apply: true }), []);
  assert.equal(fs.readFileSync(f, "utf8"), "- already retracted last week\n");
});

// ── the IR ──────────────────────────────────────────────────────────────────

test("bitemporal: retracting records when, and keeps when it was learned", () => {
  const o = make({ kind: "fact", text: "x", source: "a.md", learned_at: days(100) });
  const t = tombstone(o, "superseded");
  assert.equal(isLive(t), false);
  assert.equal(t.learned_at, o.learned_at, "the retraction does not rewrite when it was believed");
  assert.ok(t.retracted_at);
  assert.equal(t.meta.retracted_why, "superseded");
});

test("value: a live anchor beats a dead one, and a rule does not decay", () => {
  const mk = (res, age) => { const o = make({ kind: "fact", text: "x", source: "a.md", learned_at: days(age), anchor: { file: "a" } }); o.resolution = res; return o; };
  assert.ok(value(mk("live", 1)) > value(mk("drifted", 1)));
  assert.ok(value(mk("drifted", 1)) > value(mk("dead", 1)));
  const rule = (age) => make({ kind: "rule", text: "Never x", source: "a.md", learned_at: days(age) });
  assert.equal(value(rule(1)), value(rule(3000)), "a rule does not get less true with age");
  assert.ok(value(mk("live", 1)) > value(mk("live", 3000)), "a fact does");
});

test("similarity is symmetric, bounded and zero on disjoint text", () => {
  assert.equal(similarity("the grow loop", "the grow loop"), 1);
  assert.equal(similarity("alpha bravo", "charlie delta"), 0);
  assert.equal(similarity("alpha bravo charlie", "bravo charlie"), similarity("bravo charlie", "alpha bravo charlie"));
});

test("contradiction needs opposite polarity or different numbers, not mere resemblance", () => {
  const a = make({ kind: "fact", text: "the ledger folds transcripts into usage rows", source: "a.md" });
  const b = make({ kind: "fact", text: "the ledger folds transcripts into usage records", source: "b.md" });
  assert.equal(contradicts(a, b, 0.9), null, "two ways of saying the same thing is the compactor's business");
  const c = make({ kind: "fact", text: "the ledger does not fold transcripts into usage rows", source: "c.md" });
  assert.ok(contradicts(a, c, 0.8));
});

// ── the warehouse ───────────────────────────────────────────────────────────

test("the schema declares a grain for every catalogued file and never copies data", () => {
  for (const c of CATALOG) {
    assert.ok(c.grain && c.key && c.time, `${c.file} has no declared grain, key or time`);
  }
  const d = tmp();
  fs.writeFileSync(path.join(d, "episodes.jsonl"), '{"id":"x","ts":"2026-01-01"}\n');
  fs.writeFileSync(path.join(d, "findings.json"), '[{"id":"f1"}]');
  const text = sql({ dir: d });
  assert.ok(text.includes("read_json_auto"), "views read the JSON in place");
  assert.ok(!/\bCOPY\b/.test(text), "nothing is copied unless --materialise is asked for");
  assert.ok(sql({ dir: d, materialise: true }).includes("FORMAT parquet"));
  // Every query is accounted for: emitted when its views exist, named in a skip
  // comment when they do not. Silently dropping one is how a schema loses a
  // question nobody notices is missing.
  for (const name of Object.keys(QUERIES)) assert.ok(text.includes(`q_${name}`), `${name} is missing from the schema`);
});

test("a var file with no declared grain is reported, not silently ignored", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "mystery.jsonl"), '{"a":1}\n');
  fs.writeFileSync(path.join(d, "episodes.jsonl"), '{"id":"x","ts":"2026-01-01"}\n');
  const s = survey({ dir: d });
  assert.ok(s.unclassified.some((u) => u.file === "mystery.jsonl"));
  assert.ok(s.present.some((p) => p.table === "episodes" && p.rows === 1));
  assert.ok(sql({ dir: d }).includes("mystery.jsonl"), "and it is named in the schema so somebody classifies it");
});

test("the four physical shapes are detected, not assumed", () => {
  // `format='array'` against a top-level object is a hard DuckDB error, so a
  // schema that guesses is a schema that fails to load. plans.json is a map,
  // rules.json is a single document, findings.json is an array.
  const d = tmp();
  const w = (n, body) => { const f = path.join(d, n); fs.writeFileSync(f, body); return f; };
  assert.equal(shapeOf(w("a.jsonl", '{"id":1}\n')), "jsonl");
  assert.equal(shapeOf(w("arr.json", '[{"id":1},{"id":2}]')), "array");
  assert.equal(shapeOf(w("map.json", '{"r1":{"id":"r1"},"r2":{"id":"r2"}}')), "map");
  assert.equal(shapeOf(w("rec.json", '{"at":"2026-01-01","n":3}')), "record");
  assert.equal(shapeOf(path.join(d, "missing.json")), "record");
});

test("a map-shaped document is unnested by key, never read as one very wide row", () => {
  const body = viewBody("/tmp/plans.json", "map");
  assert.match(body, /json_keys/);
  assert.match(body, /unnest/);
  assert.ok(!body.includes("read_json_auto"), "read_json_auto on a map gives one row per FILE");
  assert.match(viewBody("/tmp/f.json", "array"), /format='array'/);
  assert.match(viewBody("/tmp/f.jsonl", "jsonl"), /format='newline_delimited'/);
  assert.match(viewBody("/tmp/f.json", "record"), /format='auto'/);
});

test("a view is never emitted over a file that does not exist", () => {
  // One missing file is an IO error that stops the whole script, so an empty
  // heap must not take the rest of the schema down with it.
  const text = sql({ dir: tmp() });
  assert.ok(!/CREATE OR REPLACE VIEW heap AS/.test(text), "heap.jsonl has not been compiled in this dir");
  assert.match(text, /not written yet/);
  assert.ok(!/CREATE OR REPLACE VIEW q_rot AS/.test(text), "a query over a missing view is skipped, not emitted broken");
});

test("the graph counts in-degree so a linked memory outranks an isolated one", () => {
  const hub = make({ kind: "note", text: "hub", source: "hub.md" });
  const a = make({ kind: "note", text: "a [[hub]]", source: "a.md", refs: ["hub"] });
  const b = make({ kind: "note", text: "b [[hub]]", source: "b.md", refs: ["hub"] });
  const g = graph([hub, a, b]);
  assert.equal(g.inDegree.get(hub.id), 2);
  assert.ok(value(hub, { inDegree: 2 }) > value(hub, { inDegree: 0 }));
});
