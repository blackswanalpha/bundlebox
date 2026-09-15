// designlabs.test.js — the gate against a fixture studio in tmpdir, and the
// ui-generic detector against two trees: one assembled from framework defaults
// and one that made its decisions. BB_ROOT is set before any src module loads
// because paths.js fixes ROOT at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-designlabs-"));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), typeof s === "string" ? s : JSON.stringify(s, null, 2)); };

const { cards, sources, parseCard } = await import("../src/designlabs/library.js");
const { contrast, luminance, loadStudio, runRules, tally, VERDICT } = await import("../src/designlabs/check.js");
const scaffold = await import("../src/designlabs/scaffold.js");
const research = await import("../src/designlabs/research.js");
const uiGeneric = (await import("../src/detectors/ui-generic.js")).default;
const { makeCtx } = await import("../src/detectors/index.js");
const { walk } = await import("../src/core/fs.js");

// ── the library ────────────────────────────────────────────────────────────
test("every doctrine card parses and declares a rule", () => {
  const all = cards();
  assert.ok(all.length >= 15, `${all.length} cards`);
  for (const c of all) {
    assert.ok(c.id && c.title && c.severity, `${c.file} has id, title, severity`);
    assert.ok(c.rule, `${c.id} declares a rule`);
    assert.ok(c.body.length > 200, `${c.id} has a body`);
  }
  assert.equal(new Set(all.map((c) => c.rule)).size, all.length, "one rule per card");
});

test("a card header survives a round trip", () => {
  const c = parseCard("# T\n- id: t\n- rule: r.x\n- severity: high\n\nbody text here.\n", "/tmp/t.md");
  assert.deepEqual([c.id, c.rule, c.severity, c.body], ["t", "r.x", "high", "body text here."]);
});

test("every source declares reach, licence and a beware", () => {
  for (const p of sources().providers) {
    assert.ok(["web", "http", "manual"].includes(p.reach), `${p.id} reach`);
    assert.ok(p.license, `${p.id} licence`);
    assert.ok(p.beware, `${p.id} beware`);
  }
});

// ── the contrast maths ─────────────────────────────────────────────────────
test("contrast matches the WCAG reference values", () => {
  assert.equal(contrast("#ffffff", "#000000"), 21);
  assert.equal(contrast("#ffffff", "#ffffff"), 1);
  assert.equal(contrast("#8a8a8a", "#ffffff"), 3.45);
  assert.equal(contrast("#777777", "#ffffff"), 4.48);   // just under the 4.5 floor
  assert.equal(contrast("#767676", "#ffffff"), 4.54);   // the canonical first pass
  assert.equal(contrast("#fff", "#000"), 21, "three-digit hex");
  assert.equal(contrast("var(--x)", "#000"), null, "a non-literal is unknown, not a pass");
  assert.equal(luminance("nope"), null);
});

// ── the gate ───────────────────────────────────────────────────────────────
test("the scaffold passes its own gate", async () => {
  const dir = path.join(root, "designlabs");
  scaffold.write(dir, cards());
  const st = loadStudio(dir);
  assert.equal(st.errors.length, 0, st.errors.join("; "));
  assert.equal(st.screens.length, 1, "screens/index.json is load order, not a screen");
  const cfg = { min_target_px: 44, max_motion_ms: 400, required_states: ["rest", "loading", "empty", "error", "partial", "offline"] };
  const rows = runRules(st, cfg);
  const fails = rows.filter((r) => r.verdict === VERDICT.fail);
  assert.equal(fails.length, 0, fails.map((f) => `${f.rule}: ${f.summary}`).join("; "));
  assert.ok(tally(rows)[VERDICT.unknown] >= 1, "what a browser must answer is UNKNOWN, never PASS");
});

test("the gate fails a system that breaks the floors", () => {
  const dir = path.join(root, "bad-labs");
  w("bad-labs/system.json", {
    name: "bad",
    color: { tokens: { bg: "#ffffff", fg: "#aaaaaa", accent: "#dddddd" },
      pairs: [{ fg: "fg", bg: "bg", use: "body", size: "text" }, { fg: "accent", bg: "bg", use: "hero", over: "gradient" }] },
    motion: { slide: "900ms", fade: "120ms" },
    targets: { chip: "28px", row: "56px" },
    type: { display: { family: "X" }, text: { family: "Y" }, scale: {} },
    space: [8], radius: {}, easing: {}, elevation: {},
  });
  w("bad-labs/screens/one.json", { id: "one", states: { rest: { label: "Rest", note: "n" } }, secondary: ["a", "b", "c", "d", "e", "f"], accents: 3,
    groups: [{ name: "g", inner: 24, outer: 12, items: 9 }], destructive: [{ action: "wipe" }], audit: { budget: 4, elements: 20 },
    flow: [{ node: "a", to: ["b"] }, { node: "b" }] });
  const st = loadStudio(dir);
  const cfg = { min_target_px: 44, max_motion_ms: 400, required_states: ["rest", "loading", "empty", "error", "partial", "offline"] };
  const rows = runRules(st, cfg);
  const failing = new Set(rows.filter((r) => r.verdict === VERDICT.fail).map((r) => r.rule));
  for (const rule of ["access.floor", "state.coverage", "motion.duration", "target.min-size",
    "accent.scarcity", "error.recoverable", "group.by-space", "choice.count", "flow.ending",
    "complexity.owner", "chrome.budget", "group.size"]) {
    assert.ok(failing.has(rule), `${rule} should fail`);
  }
});

test("a colour pair over a gradient is unknown, never a pass", () => {
  const dir = path.join(root, "grad-labs");
  w("grad-labs/system.json", { name: "g", color: { tokens: { a: "#000000", b: "#ffffff" },
    pairs: [{ fg: "a", bg: "b", use: "ok", size: "text" }, { fg: "a", bg: "b", use: "over art", over: "image" }] },
    motion: {}, targets: {}, type: { display: {}, text: {}, scale: {} }, space: [], radius: {}, easing: {}, elevation: {} });
  w("grad-labs/screens/x.json", { id: "x", states: {}, audit: {} });
  const rows = runRules(loadStudio(dir), { min_target_px: 44, max_motion_ms: 400, required_states: [] });
  const access = rows.find((r) => r.rule === "access.floor");
  assert.equal(access.verdict, VERDICT.unknown);
});

// ── the detector ───────────────────────────────────────────────────────────
const run = (files) => uiGeneric.run(makeCtx({ files, cfg: { designlabs: { generic_min: { palette: 6, radius: 5, shadow: 5, space: 20 } } } }));

test("ui-generic finds the tells, per area, and spares the tree that made its decisions", () => {
  w("generic/app.css", `:root{--r:12px}
body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a}
.hero{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#f8fafc}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.card{border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);background:#ffffff;padding:24px}
.card:hover{box-shadow:0 4px 6px -1px rgba(0,0,0,.1)}
.btn{border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);background:#3b82f6;color:#f8fafc;padding:16px}
.btn:hover{background:#2563eb}
.row{border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);padding:16px;margin:8px}
.row:hover{background:#f1f5f9}
.chip{border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);padding:8px;margin:8px}
.chip:hover{background:#94a3b8}
.panel{border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);padding:24px;margin:24px}
.panel:hover{background:#e2e8f0}
.tag{padding:8px;margin:8px;gap:8px}
.list{gap:16px;padding:24px;margin:16px}
.foot{padding:24px;margin:24px;gap:24px}
`);
  w("generic/index.html", `<h1 class="hero">Elevate your workflow</h1>
<p>Seamlessly unlock the power of your blazing-fast team.</p>
<div class="card"><div>\u{1F680}</div><h3>Fast</h3></div>
<div class="card"><div>\u{1F512}</div><h3>Secure</h3></div>`);
  w("decided/app.css", `body{font-family:"Fraunces",Georgia,serif;background:#FAF8F3;color:#14170F}
.text{font-family:"Public Sans",Helvetica,sans-serif}
.row{border-radius:6px;padding:12px;gap:4px;margin:20px}
.card{border-radius:18px;padding:32px;gap:12px;margin:52px}
.pill{border-radius:999px;padding:4px;gap:8px}
.row:hover{background:#F1EEE5}
.row:focus-visible{outline:2px solid #2F5D50}
.card:hover{background:#F1EEE5}
.card:focus-visible{outline:2px solid #2F5D50}
`);

  const rows = run(walk(root));
  const tells = (area) => rows.filter((r) => r.evidence.area === area && r.evidence.tell !== "count").map((r) => r.evidence.tell).sort();
  const got = tells("generic");
  for (const t of ["default-palette", "no-typeface", "uniform-radius", "framework-gradient",
    "shadow-monotony", "emoji-icons", "template-copy", "hero-three-cards", "happy-path-only"]) {
    assert.ok(got.includes(t), `generic/ should show ${t}; got ${got.join(", ")}`);
  }
  assert.deepEqual(tells("decided"), [], "a tree that made its decisions has no tells");
  const count = rows.find((r) => r.evidence.area === "generic" && r.evidence.tell === "count");
  assert.equal(count.severity, "high");
  assert.ok(count.key.startsWith("ui-generic:generic:"), "keys are per area, so two trees never share a verdict");
});

test("a brief's evidence never repeats what the detail already rendered", async () => {
  const { evidenceBlock } = await import("../src/compile/brief.js");
  const text = evidenceBlock([{
    title: "t", detail: "  app.css:3  background:#6366f1", fix_hint: "",
    evidence: { hits: [{ file: "app.css", line: 3, text: "background:#6366f1" }], count: 1, own: ["#ffffff"] },
  }]);
  assert.ok(!text.includes("hits:"), "a row already printed is not printed again");
  assert.ok(text.includes("count: 1"), "a count is not a restatement of the line it counted");
  assert.ok(text.includes("#ffffff"), "evidence the detail does not carry survives");
});

// ── research ───────────────────────────────────────────────────────────────
test("a research plan names a real source, a query and what to refuse", () => {
  const rows = research.plan("task inbox", { kinds: ["flows", "type"] });
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.ok(r.queries.length && r.queries[0].includes("task inbox"));
    assert.ok(r.license && r.beware);
  }
  const text = research.brief("task inbox", rows);
  assert.ok(text.includes("refused"), "the brief demands what was refused");
  assert.ok(text.includes("4.5:1"), "the normative floors lead the brief");
});

test("intake rejects a bookmark and accepts research", () => {
  const dir = path.join(root, "intake-labs");
  w("intake-labs/corpus/good.json", { id: "a", source: "mobbin", url: "u", captured: "2026-01-01", kind: "flows",
    observed: ["56px rows"], taken: ["the gap ratio"], refused: ["their second accent"], license: "reference only" });
  w("intake-labs/corpus/bookmark.json", { id: "b", source: "dribbble", url: "u", captured: "2026-01-01", kind: "shots",
    observed: ["nice"], taken: ["the palette"], refused: [], license: "reference only" });
  w("intake-labs/corpus/thin.json", { id: "c", source: "godly", url: "u", captured: "2026-01-01", kind: "sites",
    observed: [], taken: [], refused: [], license: "x" });
  const rows = research.intake(dir);
  assert.equal(rows.find((r) => r.file === "good.json").ok, true);
  assert.equal(rows.find((r) => r.file === "bookmark.json").ok, false);
  assert.match(rows.find((r) => r.file === "bookmark.json").problems[0], /bookmark/);
  assert.equal(rows.find((r) => r.file === "thin.json").ok, false);
});

test("collect is a dry run until --apply and never reaches a source it is not allowed", async () => {
  const rows = await research.collect(path.join(root, "designlabs"), { allow: ["fontsource", "dribbble"] });
  assert.equal(rows.find((r) => r.id === "fontsource").state, "dry");
  assert.equal(rows.find((r) => r.id === "dribbble").state, "skip", "a web-only source is never fetched by bb");
});
