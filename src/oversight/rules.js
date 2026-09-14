// rules.js — what the measurements mean, as findings a session can act on.
//
// A rule reads metrics and, when a bar is crossed, files a finding whose
// headline quotes the numbers that crossed it for THAT file: "1450 lines, 4.1x
// this tree's median of 350" is checkable, "too large" is not. Every bar except
// the window facts (payload share) is relative to the tree's own median with an
// absolute floor: 3x the median in a tree of 20-line files is 60 lines, which
// is not a god file, and the floor says so (doctrine 9). Duplication is the
// kernel's sliding-window pass when the binary is on the box and the same
// algorithm in JS otherwise; both report `via` so doctor can say which ran.
import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT, rel, abs } from "../core/paths.js";
import { readText, walk } from "../core/fs.js";
import { load, readJson, writeJson } from "../core/config.js";
import { human, median, now, stamp, sha1 } from "../core/util.js";
import * as store from "../core/store.js";
import { capacity } from "../compile/context.js";
import { normalise } from "../detectors/duplicate-blocks.js";
import { kcall } from "../snapgen/tables.js";
import * as metrics from "./metrics.js";

export const DIR = path.join(OUT, "oversight");
export const latestPath = () => path.join(DIR, "latest.json");
export const RULES = ["god-file", "bloat", "duplication", "vibe-coded", "suppression", "swallowed-errors", "commented-code", "comment-poor"];
export const DETECTORS = new Set(RULES.map((r) => `oversight:${r}`));

/** Thresholds as data. `*_x_median` multiplies the tree's own median; `*_floor`
 *  is the absolute minimum the bar can be. Window facts (`god_payload_share`)
 *  are fractions of one session's payload and have no median. */
export const DEFAULT_THRESHOLDS = {
  god_lines_x_median: 3, god_lines_floor: 400, god_functions: 12, god_payload_share: 0.35,
  long_function_x_median: 3, long_function_floor: 60, nesting_x_median: 2, nesting_floor: 5,
  dupe_window: 8, dupe_pair_lines: 24, dupe_min_distinct_ratio: 0.25,
  vibe_density_x_median: 3, vibe_density_floor: 3, vibe_min_code_lines: 60, vibe_ratio_cap: 20,
  suppressions_x_median: 3, suppressions_floor: 6,
  swallows_x_median: 3, swallows_floor: 4,
  commented_code_x_median: 3, commented_code_floor: 12,
  comment_poor_lines: 300, comment_ratio_floor: 0.05, comment_ratio_x_median: 0.5,
};
export function thresholds(cfg = load()) {
  const o = cfg.oversight || {};
  const over = { ...(o.thresholds || {}), ...Object.fromEntries(Object.entries(o).filter(([k]) => k in DEFAULT_THRESHOLDS)) };
  return { ...DEFAULT_THRESHOLDS, ...over };
}
const bar = (t, name, med) => Math.max(t[`${name}_floor`], t[`${name}_x_median`] * (med || 0));
const x = (v, med) => (med > 0 ? Math.round((v / med) * 10) / 10 : null);
const xs = (v, med) => (med > 0 ? `${x(v, med)}x this tree's median of ${fmt(med)}` : `tree median ${fmt(med)}`);
const fmt = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(n < 1 ? 3 : 1).replace(/\.?0+$/, ""));
const pct = (r) => `${Math.round(r * 100)}%`;

// ── duplication ──────────────────────────────────────────────────────────────

/** The kernel's `dupes` contract in JS: pairs of files with the union of lines
 *  their shared W-line windows cover. Same normalisation as duplicate-blocks. */
export function dupesJs(paths, { window = 8, min_shared_lines = 24, min_distinct_ratio = 0.25 } = {}) {
  const W = window;
  const locs = new Map();
  const rows = new Map();
  for (const p of paths) {
    const r = rel(p);
    const norm = normalise(r, readText(p));
    rows.set(p, norm);
    if (norm.length < W) continue;
    if (new Set(norm.map((n) => n.text)).size / norm.length < min_distinct_ratio) continue;
    for (let i = 0; i + W <= norm.length; i++) {
      const h = sha1(norm.slice(i, i + W).map((n) => n.text).join("\n")).slice(0, 16);
      if (!locs.has(h)) locs.set(h, []);
      locs.get(h).push({ p, i });
    }
  }
  const pairs = new Map();
  for (const ls of locs.values()) {
    if (ls.length < 2 || ls.length > 50) continue;
    for (let a = 0; a < ls.length; a++) for (let b = a + 1; b < ls.length; b++) {
      if (ls[a].p === ls[b].p) continue;
      const [A, B] = ls[a].p < ls[b].p ? [ls[a], ls[b]] : [ls[b], ls[a]];
      const k = `${A.p}|${B.p}`;
      if (!pairs.has(k)) pairs.set(k, { a: A.p, b: B.p, la: new Set(), lb: new Set(), first: { ia: A.i, ib: B.i } });
      const pr = pairs.get(k);
      for (let d = 0; d < W; d++) { pr.la.add(A.i + d); pr.lb.add(B.i + d); }
      if (A.i < pr.first.ia) pr.first = { ia: A.i, ib: B.i };
    }
  }
  const out = [];
  for (const pr of pairs.values()) {
    const shared = pr.la.size + pr.lb.size;
    if (shared < min_shared_lines) continue;
    const na = rows.get(pr.a), nb = rows.get(pr.b);
    out.push({ a: pr.a, b: pr.b, shared_lines: shared, a_line: na[pr.first.ia].line, b_line: nb[pr.first.ib].line,
      a_end: na[Math.min(pr.first.ia + W - 1, na.length - 1)].line, window: na.slice(pr.first.ia, pr.first.ia + W).map((n) => n.text) });
  }
  return { pairs: out.sort((p, q) => q.shared_lines - p.shared_lines), files_considered: paths.length };
}
export function dupes(paths, t = thresholds()) {
  const payload = { paths, window: t.dupe_window, min_shared_lines: t.dupe_pair_lines, min_distinct_ratio: t.dupe_min_distinct_ratio };
  const k = paths.length ? kcall("dupes", payload) : null;
  if (k && Array.isArray(k.pairs)) return { ...k, via: "kernel" };
  return { ...dupesJs(paths, payload), via: "js" };
}

// ── the findings ─────────────────────────────────────────────────────────────

const F = (rule, o) => ({ detector: `oversight:${rule}`, precision: "exact", auto_fix: null, kind: "fix", status: "open", ...o, files: o.files || [o.path], key: o.key || o.path });

function baseOf(ms) {
  const code = ms.filter((m) => !m.is_data);
  return {
    files: ms.length,
    code_lines: ms.reduce((s, m) => s + m.code_lines, 0),
    tokens: ms.reduce((s, m) => s + m.tokens, 0),
    median_lines: median(ms.map((m) => m.lines)),
    median_functions: median(ms.map((m) => m.functions)),
    median_fn_max: median(code.filter((m) => m.functions).map((m) => m.fn_max)),
    median_depth: median(code.filter((m) => m.functions).map((m) => m.max_depth)),
    // Short files inflate density (two TODOs in 20 lines is 10/100), so the
    // median is over files past 40 code lines; a tree with fewer than five of
    // those has no such population and falls back to every code file.
    median_mark_density: median((code.filter((m) => m.code_lines > 40).length >= 5 ? code.filter((m) => m.code_lines > 40) : code).map((m) => m.mark_density)),
    median_suppressions: median(code.map((m) => m.suppressions)),
    median_swallows: median(code.map((m) => m.swallows)),
    median_commented_code: median(code.map((m) => m.commented_code)),
    median_comment_ratio: median(ms.map((m) => m.comment_ratio)),
  };
}

/** Findings from measured files. `a` is {files:[metrics with .tree], base:{tree:medians}, dupes, capacity, thresholds}. */
export function decide(a) {
  const t = a.thresholds || thresholds();
  const out = [];
  const marksOf = (m, kinds) => m.marks.filter((k) => kinds.includes(k.kind)).slice(0, 8);
  for (const m of a.files) {
    const b = a.base[m.tree] || baseOf([m]);
    const share = a.capacity ? m.tokens / a.capacity : 0;
    const lineBar = bar(t, "god_lines", b.median_lines);
    const big = m.lines >= lineBar && m.functions >= t.god_functions;
    if (big || share >= t.god_payload_share) {
      out.push(F("god-file", {
        severity: share >= t.god_payload_share ? "high" : "medium", path: m.path,
        title: `\`${m.path}\` is ${m.lines} lines, ${xs(m.lines, b.median_lines)}, with ${m.functions} functions and ${human(m.tokens)} tokens (${pct(share)} of one payload)`,
        detail: `${m.lines} lines against a bar of ${fmt(lineBar)} (${t.god_lines_x_median}x the tree median ${fmt(b.median_lines)}, floor ${t.god_lines_floor}); ${m.functions} functions (bar ${t.god_functions}); ${m.tokens} tokens = ${pct(share)} of a ${human(a.capacity)}-token payload (bar ${pct(t.god_payload_share)}).`,
        evidence: { lines: m.lines, median_lines: b.median_lines, ratio: x(m.lines, b.median_lines), functions: m.functions, tokens: m.tokens, share: Math.round(share * 100) / 100, capacity: a.capacity, bar: lineBar },
        fix_hint: "Read the region, not the file: locate the symbol and read its range. Split along the seams the declarations already show.", est_tokens: m.tokens,
      }));
    }
    if (m.is_data) continue;
    const fnBar = bar(t, "long_function", b.median_fn_max), depthBar = bar(t, "nesting", b.median_depth);
    if (m.functions && (m.fn_max > fnBar || m.max_depth > depthBar)) {
      const why = [];
      if (m.fn_max > fnBar) why.push(`longest function ${m.fn_max} lines (${xs(m.fn_max, b.median_fn_max)}, bar ${fmt(fnBar)})`);
      if (m.max_depth > depthBar) why.push(`nesting depth ${m.max_depth} (${xs(m.max_depth, b.median_depth)}, bar ${fmt(depthBar)})`);
      out.push(F("bloat", {
        severity: "medium", path: m.path, title: `\`${m.path}\`: ${why.join(" and ")}`,
        detail: why.join("; ") + ".", evidence: { fn_max: m.fn_max, median_fn_max: b.median_fn_max, fn_bar: fnBar, max_depth: m.max_depth, median_depth: b.median_depth, depth_bar: depthBar, functions: m.functions },
        fix_hint: "Split the function at the blank lines already in it; past the nesting bar, invert a condition and return early.", est_tokens: m.tokens,
      }));
    }
    const med = Math.max(b.median_mark_density || 0, 0.5);
    if (m.code_lines > t.vibe_min_code_lines && m.mark_density >= t.vibe_density_floor && m.mark_density >= med * t.vibe_density_x_median) {
      const raw = m.mark_density / med;
      const ratio = Math.min(raw, t.vibe_ratio_cap);
      const ratioText = raw > t.vibe_ratio_cap ? `>${t.vibe_ratio_cap}x` : `${Math.round(ratio * 10) / 10}x`;
      const parts = [["narration", m.narration], ["commented-out", m.commented_code], ["deferred", m.deferred], ["twin", m.twins], ["suppression", m.suppressions], ["swallowed", m.swallows], ["magic-number", m.magic]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
      out.push(F("vibe-coded", {
        severity: "medium", path: m.path,
        title: `\`${m.path}\`: ${m.mark_density} marks per 100 code lines, ${ratioText} this tree's median of ${fmt(med)} (${parts.join(", ")})`,
        detail: `${m.mark_total} marks over ${m.code_lines} code lines. Bar: density >= ${t.vibe_density_floor} and >= ${t.vibe_density_x_median}x the tree median (${fmt(med)}, floored at 0.5).\n` + marksOf(m, ["narration", "commented-out-code", "twin-symbol", "deferred", "magic-number"]).map((k) => `  :${k.line} ${k.kind} ${k.text}`).join("\n"),
        evidence: { density: m.mark_density, tree_median: med, ratio: Math.round(ratio * 10) / 10, ratio_capped: raw > t.vibe_ratio_cap, mark_total: m.mark_total, code_lines: m.code_lines, narration: m.narration, commented_code: m.commented_code, deferred: m.deferred, twins: m.twins, magic: m.magic, marks: marksOf(m, ["narration", "commented-out-code", "twin-symbol", "deferred", "magic-number"]) },
        fix_hint: "Delete comments that restate the line below, delete commented-out code (git has it), name the numbers, replace the V2 or say why both exist.", est_tokens: m.tokens,
      }));
    }
    const sBar = bar(t, "suppressions", b.median_suppressions);
    if (m.suppressions >= sBar) out.push(F("suppression", {
      severity: "medium", path: m.path, title: `\`${m.path}\`: ${m.suppressions} lint/type suppressions (bar ${fmt(sBar)}, tree median ${fmt(b.median_suppressions)})`,
      detail: marksOf(m, ["suppression"]).map((k) => `  :${k.line} ${k.text}`).join("\n"), evidence: { suppressions: m.suppressions, bar: sBar, median: b.median_suppressions, marks: marksOf(m, ["suppression"]) },
      fix_hint: "Satisfy the check or state on the same line why it is wrong here. A bare suppression gets copied.", est_tokens: m.tokens,
    }));
    const wBar = bar(t, "swallows", b.median_swallows);
    if (m.swallows >= wBar) out.push(F("swallowed-errors", {
      severity: "high", path: m.path, title: `\`${m.path}\`: ${m.swallows} errors caught and dropped (bar ${fmt(wBar)}, tree median ${fmt(b.median_swallows)})`,
      detail: marksOf(m, ["swallowed-error"]).map((k) => `  :${k.line} ${k.text}`).join("\n"), evidence: { swallows: m.swallows, bar: wBar, median: b.median_swallows, marks: marksOf(m, ["swallowed-error"]) },
      fix_hint: "Record, degrade or rethrow in every catch body; an empty one hides the failure from everyone after you.", est_tokens: m.tokens,
    }));
    const cBar = bar(t, "commented_code", b.median_commented_code);
    if (m.commented_code >= cBar) out.push(F("commented-code", {
      severity: "low", path: m.path, title: `\`${m.path}\`: ${m.commented_code} lines of commented-out code (bar ${fmt(cBar)}, tree median ${fmt(b.median_commented_code)})`,
      detail: marksOf(m, ["commented-out-code"]).map((k) => `  :${k.line} ${k.text}`).join("\n"), evidence: { commented_code: m.commented_code, bar: cBar, median: b.median_commented_code, marks: marksOf(m, ["commented-out-code"]) },
      fix_hint: "Delete it; git has it. A commented block reads as live on every search.", est_tokens: m.tokens,
    }));
    const rBar = Math.min(t.comment_ratio_floor, t.comment_ratio_x_median * (b.median_comment_ratio || 0));
    if (m.lines > t.comment_poor_lines && m.comment_ratio < rBar) out.push(F("comment-poor", {
      severity: "low", path: m.path, title: `\`${m.path}\`: ${pct(m.comment_ratio)} comment lines over ${m.lines} lines (tree median ${pct(b.median_comment_ratio)}, bar ${pct(rBar)})`,
      detail: `${m.comment_lines} comment lines of ${m.lines}. Bar is the lower of ${pct(t.comment_ratio_floor)} and ${t.comment_ratio_x_median}x the tree median.`, evidence: { comment_ratio: m.comment_ratio, comment_lines: m.comment_lines, lines: m.lines, median: b.median_comment_ratio, bar: rBar },
      fix_hint: "Write down the decisions, not the steps: one line per non-obvious choice.", est_tokens: m.tokens,
    }));
  }
  for (const p of a.dupes?.pairs || []) {
    if (p.shared_lines < t.dupe_pair_lines) continue;
    const A = rel(p.a), B = rel(p.b);
    out.push(F("duplication", {
      severity: p.shared_lines >= t.dupe_pair_lines * 4 ? "high" : "medium", path: A, files: [A, B], key: `${A}|${B}`,
      title: `\`${A}\` and \`${B}\` share ${p.shared_lines} normalised lines in ${t.dupe_window}-line windows (from ${A}:${p.a_line} and ${B}:${p.b_line})`,
      detail: `  ${A}:${p.a_line}-${p.a_end ?? p.a_line}\n  ${B}:${p.b_line}\n  ${(p.window || [])[0] || ""}`.slice(0, 1500),
      evidence: { shared_lines: p.shared_lines, a: `${A}:${p.a_line}`, b: `${B}:${p.b_line}`, window: (p.window || []).slice(0, 8), bar: t.dupe_pair_lines, via: a.dupes.via },
      fix_hint: "Lift the shared block into one place. If the two copies are meant to diverge, say so in a comment at each.", est_tokens: p.shared_lines * 12,
    }));
  }
  return out;
}

// ── scan ─────────────────────────────────────────────────────────────────────

/** Trees are the units a median is taken over: the configured subrepos, else
 *  the root as one tree. A file's tree is the one it was walked under. */
export function defaultTrees(cfg = load()) {
  const subs = (cfg.workspace.subrepos || []).filter((s) => fs.existsSync(path.join(ROOT, s)));
  return subs.length ? subs : ["."];
}
export function treeFiles(trees) {
  const out = [];
  for (const t of trees) for (const p of walk(abs(t))) if (metrics.measurable(p)) out.push({ path: p, tree: t });
  return out;
}

/** Measure, compare, decide, write. Returns the scan document; findings are
 *  merged into the store only with `write`. */
export function scan({ trees = null, write = false, cfg = load() } = {}) {
  trees = trees && trees.length ? trees : defaultTrees(cfg);
  const t = thresholds(cfg);
  const cap = capacity("fix", { cfg });
  const files = [];
  const perTree = new Map(trees.map((x) => [x, []]));
  for (const { path: p, tree } of treeFiles(trees)) {
    const m = metrics.measureCached(p);
    if (!m) continue;
    const row = { ...m, tree };
    files.push(row);
    perTree.get(tree).push(row);
  }
  metrics.flushCache();
  const base = {};
  for (const [tree, ms] of perTree) if (ms.length) base[tree] = baseOf(ms);
  const codePaths = files.filter((m) => !m.is_data && !m.is_test).map((m) => abs(m.path));
  const d = dupes(codePaths, t);
  const a = { at: now(), trees, capacity: cap, thresholds: t, base, files, dupes: { via: d.via, pairs: (d.pairs || []).slice(0, 200), files_considered: d.files_considered ?? codePaths.length } };
  const findings = decide(a);
  const doc = {
    at: a.at, trees, via: { symbols: null, dupes: d.via }, capacity: cap, thresholds: t, base,
    totals: { files: files.length, code_lines: files.reduce((s, m) => s + m.code_lines, 0), tokens: files.reduce((s, m) => s + m.tokens, 0), findings: findings.length,
      by_rule: Object.fromEntries(RULES.map((r) => [r, findings.filter((f) => f.detector === `oversight:${r}`).length])) },
    files: files.map(({ marks, ...m }) => ({ ...m, marks: marks.slice(0, 12) })),
    dupes: a.dupes,
    findings: findings.map((f) => ({ ...f, id: store.findingId(f) })),
  };
  fs.mkdirSync(DIR, { recursive: true });
  const p = path.join(DIR, `${stamp()}.json`);
  writeJson(p, doc);
  writeJson(latestPath(), { ...doc, file: rel(p) });
  if (write) store.mergeFindings(findings, { detectors: DETECTORS });
  return { ...doc, file: rel(p), written: write };
}

/** The stored scan, never recomputed here: pinpoint must stay instant. */
export function latest() { return readJson(latestPath(), null); }

export function report(doc, { top = 6 } = {}) {
  const L = [`  ${doc.totals.files} files · ${human(doc.totals.code_lines)} code lines · ${human(doc.totals.tokens)} tokens · payload cap ${human(doc.capacity)} · dupes via ${doc.via?.dupes || doc.dupes?.via}`, ""];
  for (const [tree, b] of Object.entries(doc.base || {})) L.push(`  ${tree}: median ${fmt(b.median_lines)} lines, longest function ${fmt(b.median_fn_max)}, depth ${fmt(b.median_depth)}, ${fmt(b.median_mark_density)} marks/100 lines, ${pct(b.median_comment_ratio)} comments`);
  L.push("");
  for (const r of RULES) {
    const fs_ = doc.findings.filter((f) => f.detector === `oversight:${r}`);
    L.push(`  ${r} — ${fs_.length}`);
    for (const f of fs_.slice(0, top)) L.push(`      ${f.title}`);
    if (fs_.length > top) L.push(`      … ${fs_.length - top} more`);
  }
  return L.join("\n");
}
