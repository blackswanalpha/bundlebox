// calibrate.js — correct the estimator with the thing it estimates.
//
// Two independent measurements, each the one place a transcript states
// "this exact string cost this many tokens":
//
//   prose   assistant turns that are ONLY text (no tools, no thinking): their
//           `output_tokens` is the true count of that text.
//   code    the window delta across a single large tool result (see
//           ledger.windowDeltas): the true count of a code payload.
//
// The scale is the MEDIAN of per-sample ratios against the SHIPPED base
// coefficients, never against the current fitted ones: scaling a scale is how
// a refit drifts a little further every time it runs. Least squares is not
// used because a handful of very large samples would decide it and make the
// estimate worse for the thousands of small ones that fill a window.
import { DEFAULTS, readJson, writeJson, calibrationPath } from "../core/config.js";
import { ROOT } from "../core/paths.js";
import { now, human } from "../core/util.js";
import * as estimate from "./estimate.js";
import { transcripts, read, windowDeltas } from "./ledger.js";

const MIN_SAMPLES = 30;

export function proseSamples(root = ROOT, cap = 4000) {
  const out = [];
  for (const t of transcripts(root)) {
    const tr = read(t);
    if (!tr) continue;
    for (const u of tr.turns) {
      if (u.thinking || u.toolUses.length || !u.text || u.output < 20) continue;
      const pred = estimate.text(u.text, "prose", true);
      if (pred) out.push([pred, u.output]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export function codeSamples(root = ROOT, cap = 4000) {
  const out = [];
  for (const t of transcripts(root)) {
    const tr = read(t);
    if (!tr) continue;
    for (const d of windowDeltas(tr.turns)) {
      if (d.text == null) continue;
      const pred = estimate.text(d.text, "code", true);
      if (pred >= 100) out.push([pred, d.delta]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Median ratio, clamped to [0.4, 2.5]: outside that the samples are not
 *  measuring what the estimator estimates. */
export function scale(samples) {
  if (samples.length < MIN_SAMPLES) return { ok: false, samples: samples.length };
  const ratios = samples.filter(([p]) => p).map(([p, y]) => y / p).sort((a, b) => a - b);
  const m = Math.min(Math.max(ratios[ratios.length >> 1], 0.4), 2.5);
  const errs = (f) => samples.map(([p, y]) => Math.abs(f * p - y) / y).sort((a, b) => a - b);
  const before = errs(1), after = errs(m);
  return { ok: true, samples: samples.length, scale: Math.round(m * 1e4) / 1e4,
    p25: Math.round(ratios[ratios.length >> 2] * 1e3) / 1e3, p75: Math.round(ratios[(3 * ratios.length) >> 2] * 1e3) / 1e3,
    err_before: Math.round(before[before.length >> 1] * 1000) / 10, err_after: Math.round(after[after.length >> 1] * 1000) / 10 };
}

export function fit({ root = ROOT, sample = 4000 } = {}) {
  const prose = scale(proseSamples(root, sample));
  const code = scale(codeSamples(root, sample));
  if (!prose.ok && !code.ok) return { ok: false, why: "no clean samples", prose, code };
  const base = DEFAULTS.tokens;
  const tokens = { ...base };
  if (prose.ok) for (const k of ["prose_w", "prose_p", "prose_s"]) tokens[k] = Math.round(base[k] * prose.scale * 1e4) / 1e4;
  if (code.ok) for (const k of ["code_w", "code_p", "code_s"]) tokens[k] = Math.round(base[k] * code.scale * 1e4) / 1e4;
  return { ok: true, prose, code, tokens, samples: (prose.samples || 0) + (code.samples || 0) };
}

/** READ-MERGE into var/calibration.json: the probe and the churn fit live in
 *  the same file and must not erase each other. */
export function write(f) {
  const p = calibrationPath();
  const cal = readJson(p, {}) || {};
  cal.tokens = f.tokens;
  cal.calibrated_at = now();
  cal.fit = { prose: f.prose, code: f.code };
  writeJson(p, cal);
  return p;
}

export function report(f) {
  if (!f.ok) return `  calibration: ${f.why} (prose ${f.prose?.samples || 0}, code ${f.code?.samples || 0} samples; need ${MIN_SAMPLES} of either)`;
  const row = (name, s) => (s.ok
    ? `  ${name.padEnd(6)} ${String(s.samples).padStart(5)} samples   scale ${s.scale}   p25-p75 ${s.p25}-${s.p75}   median err ${s.err_before}% -> ${s.err_after}%`
    : `  ${name.padEnd(6)} ${String(s.samples).padStart(5)} samples   too few to fit`);
  const t = f.tokens;
  return [row("prose", f.prose), row("code", f.code), `  coefficients  code ${t.code_w}/${t.code_p}/${t.code_s}   prose ${t.prose_w}/${t.prose_p}/${t.prose_s}   (${human(f.samples)} samples, MEASURED against shipped base)`].join("\n");
}
