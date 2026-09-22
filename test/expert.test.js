// The Python expert system and the JS fast path must agree on triage, or the
// decision a finding gets depends on whether python3 is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BB_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-expert-")));
const expert = await import("../src/core/expert.js");
const have = expert.available();
const { triage } = await import("../src/detectors/index.js");
const cfg = { detectors: { promote_at: "medium" } };

const findings = [
  { detector: "doc-links", severity: "low", precision: "exact", est_tokens: 500, auto_fix: "fix-doc-links" },
  { detector: "doc-links", severity: "medium", precision: "exact", est_tokens: 800 },
  { detector: "secret-scan", severity: "critical", precision: "probe", est_tokens: 3000 },
  { detector: "big-file", severity: "critical", precision: "exact", est_tokens: 90000 },
  { detector: "todo-census", severity: "info", precision: "exact", est_tokens: 100 },
  { detector: "dead-exports", severity: "low", precision: "heuristic", est_tokens: 40000 },
  { detector: "god-file", severity: "medium", precision: "exact", est_tokens: 120000 },
  { detector: "duplicate-blocks", severity: "medium", precision: "exact", est_tokens: 6000, evidence: { count: 3 } },
  // The jev prior is the one term both sides compute rather than look up, so
  // it is the one most likely to drift. Both directions, appended so the
  // index-keyed assertions below keep pointing at the same findings.
  { detector: "swallowed-errors", severity: "medium", precision: "heuristic", est_tokens: 150000, jev: { p: 0.98, n: 3 } },
  { detector: "silent-fallback", severity: "medium", precision: "heuristic", est_tokens: 150000, jev: { p: 0.05, n: 3 } },
  { detector: "quiet-degrade", severity: "high", precision: "heuristic", est_tokens: 20000, jev: { p: 0.5, n: 1 } },
];

test("expert present on this box (informational)", () => { console.log(`  expert: ${have ? "python " + expert.version() : "absent — parity skipped"}`); });

test("triage: python == js on promote, model and ev for every case", { skip: !have }, () => {
  const py = expert.call("triage", { findings, cfg });
  assert.equal(py.length, findings.length);
  findings.forEach((f, i) => {
    const js = triage(f, cfg);
    assert.equal(py[i].promote, js.promote, `${f.detector}/${f.severity}: promote js=${js.promote} py=${py[i].promote} (${py[i].reason} | ${js.reason})`);
    assert.equal(py[i].ev, js.ev, `${f.detector}: ev`);
    if (js.promote) assert.equal(py[i].model, js.model, `${f.detector}: model`);
  });
  assert.equal(py[3].promote, false, "critical never overrides judgement");
});

test("rules: every threshold is read by a rule and the verdict scales with fired rules", { skip: !have }, () => {
  const t = expert.call("thresholds", {}).defaults;
  const hot = expert.call("rules", { signals: { reread_ratio: 0.4, top_reread_files: [["a.js", 4]], singleton_turn_ratio: 0.9, searches_per_session: 20, ctx_slope_median: 100, long_session_share: 0 } });
  assert.equal(hot.verdict, "compounding");
  assert.ok(hot.recommendations.length >= 3);
  const quiet = expert.call("rules", { signals: {} });
  assert.equal(quiet.verdict, "lean");
  assert.ok(Object.keys(t).length >= 11);
});

test("model: refuses with the base rate on tiny data and reports collinearity when features are one column", { skip: !have }, () => {
  const tiny = expert.call("model-train", { episodes: [{ verb: "scan", useful: 1, at: "2026-01-01" }] });
  assert.equal(tiny.useful, false);
  const p = expert.call("model-predict", { model: tiny, episode: { verb: "scan" } });
  assert.equal(p.source, "base-rate");
});

test("memory: a claim about a missing file is refused; last_seen moves only on re-derivation", { skip: !have }, () => {
  const root = process.env.BB_ROOT;
  fs.writeFileSync(path.join(root, "hot.js"), "x");
  const a = expert.call("memory-derive", { old: [], episodes: [], scripts: [], root, signals: { top_reread_files: [["hot.js", 5], ["gone.js", 9]] } });
  assert.equal(a.claims.length, 1);
  assert.equal(a.claims[0].key, "file/hot.js");
  const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 19);
  const old = a.claims.map((c) => ({ ...c, last_seen: recent }));
  const b = expert.call("memory-derive", { old, episodes: [], scripts: [], root, signals: { top_reread_files: [] } });
  // not re-derived: contra 1, last_seen untouched (so decay measures real age)
  assert.equal(b.claims.length, 1); assert.equal(b.claims[0].contra, 1); assert.equal(b.claims[0].last_seen, recent);
  const c = expert.call("memory-derive", { old: b.claims, episodes: [], scripts: [], root, signals: { top_reread_files: [] } });
  assert.equal(c.claims.length, 0, "dropped at contra >= 2");
});
