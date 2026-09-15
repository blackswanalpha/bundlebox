// sieve/replay.js — what the sieve WOULD have saved, over sessions that already
// happened, for nothing.
//
// The claim "this compressor saves tokens" is worth exactly as much as the arm
// it is measured against. Here the arm is not a simulation: it is this
// workspace's own transcripts, every tool result an agent was actually billed
// for, pushed through the same pure `transform` the hook runs. Run it twice on
// the same transcripts and the same number comes back, because nothing in the
// path is sampled and nothing calls a model.
//
// Two numbers come out and they are NOT the same kind of number (doctrine 3):
//
//   chars saved     a count. Exact. Nothing to argue with.
//   tokens saved    ESTIMATE by default, from the same estimator the rest of
//                   the box uses. MEASURED when the transcripts contain enough
//                   turns where exactly one tool result arrived, because then
//                   the window growth between two turns IS the token cost of
//                   that result (`ledger.windowDeltas`) and the ratio is read
//                   off the billing rather than modelled.
//
// Both are printed, labelled, and never added together.
import { load } from "../core/config.js";
import { median } from "../core/util.js";
import * as ledger from "../tokens/ledger.js";
import { text as estimateText } from "../tokens/estimate.js";
import { limitsFor, allowed, transform, duplicateMarker, DEDUP_MIN } from "./compress.js";

/** Tokens per char, read off the billing rather than modelled.
 *
 *  Between two API turns the window grows by exactly the first turn's output
 *  plus whatever tool results arrived, so for a turn where exactly one arrived
 *  the difference is that result's real token cost. The median over those is
 *  this workspace's own ratio. Below `min` samples there is no ratio, and the
 *  answer is null — never a plausible default. */
export function measuredRatio(turns, { min = 5 } = {}) {
  const ratios = [];
  for (const d of ledger.windowDeltas(turns)) if (d.chars > 0) ratios.push(d.delta / d.chars);
  if (ratios.length < min) return { ratio: null, samples: ratios.length };
  return { ratio: median(ratios), samples: ratios.length };
}

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return `${h}:${s.length}`; };

/** Push one session's tool results through the compressor. Pure accounting: no
 *  spill callback is passed, so nothing is written and the elide marker says
 *  the middle is unrecoverable — which is what a measurement should say, since
 *  no file was created for this run. */
export function replaySession(turns, limits) {
  const acc = {
    results: 0, chars: 0, named: 0,
    touched: 0, before: 0, after: 0, salvaged: 0,
    dedup: 0, dedup_chars: 0,
    tokens_before: 0, tokens_after: 0,
    by_tool: {}, skipped: {},
  };
  const last = new Map();
  for (const t of turns) {
    for (const r of t.toolResults || []) {
      const text = typeof r.text === "string" ? r.text : "";
      acc.results += 1;
      acc.chars += text.length;
      if (!text) continue;
      const tool = r.tool || "";
      // No name means the adapter could not tell us which tool produced this.
      // That is "could not look", and it is counted apart from "looked and the
      // tool was not on the allowlist" — doctrine 2.
      if (!tool) continue;
      acc.named += 1;
      if (!allowed(tool, limits)) {
        if (estimateText(text, "code") > limits.maxTokens) acc.skipped[tool] = (acc.skipped[tool] || 0) + text.length;
        continue;
      }
      if (text.length >= DEDUP_MIN) {
        const h = hash(text);
        if (last.get(tool) === h) {
          const marker = duplicateMarker(tool, text);
          acc.dedup += 1;
          acc.dedup_chars += text.length - marker.length;
          acc.tokens_before += estimateText(text, "code");
          acc.tokens_after += estimateText(marker, "code");
          const b = (acc.by_tool[tool] ||= { n: 0, before: 0, after: 0, dedup: 0 });
          b.dedup += 1; b.before += text.length; b.after += marker.length;
          continue;
        }
        last.set(tool, h);
      }
      const got = transform(text, limits, { tool });
      if (!got) continue;
      acc.touched += 1;
      acc.before += got.before; acc.after += got.after;
      acc.tokens_before += got.tokens_before; acc.tokens_after += got.tokens_after;
      if (got.text.includes("error-like line(s)")) acc.salvaged += 1;
      const b = (acc.by_tool[tool] ||= { n: 0, before: 0, after: 0, dedup: 0 });
      b.n += 1; b.before += got.before; b.after += got.after;
    }
  }
  return acc;
}

/** Every transcript this workspace owns, folded.
 *
 *  `unseen` carries the adapters that could not be read at all, and `unnamed`
 *  the results whose producing tool this box cannot identify. A replay that
 *  quietly dropped both would report a smaller saving as if it were the whole
 *  picture, which is the one failure mode a measurement verb cannot have. */
export function replay({ cfg = load(), limit = 0 } = {}) {
  const limits = limitsFor(cfg);
  const entries = ledger.transcripts();
  const unseen = entries.unknown || [];
  const sessions = [];
  const totals = {
    results: 0, chars: 0, named: 0, touched: 0, before: 0, after: 0, salvaged: 0,
    dedup: 0, dedup_chars: 0, tokens_before: 0, tokens_after: 0, by_tool: {}, skipped: {},
  };
  const ratios = [];

  const list = limit > 0 ? entries.slice(-limit) : entries;
  for (const e of list) {
    const tr = ledger.read(e);
    if (!tr || !tr.turns?.length) continue;
    const acc = replaySession(tr.turns, limits);
    if (!acc.results) continue;
    const m = measuredRatio(tr.turns);
    if (m.ratio != null) ratios.push(m.ratio);
    sessions.push({ session: tr.sessionId, agent: e.adapter, ...acc, by_tool: undefined, skipped: undefined,
      saved: acc.before - acc.after + acc.dedup_chars });
    for (const k of ["results", "chars", "named", "touched", "before", "after", "salvaged", "dedup", "dedup_chars", "tokens_before", "tokens_after"]) totals[k] += acc[k];
    for (const [tool, b] of Object.entries(acc.by_tool)) {
      const t = (totals.by_tool[tool] ||= { n: 0, before: 0, after: 0, dedup: 0 });
      t.n += b.n; t.before += b.before; t.after += b.after; t.dedup += b.dedup;
    }
    for (const [tool, n] of Object.entries(acc.skipped)) totals.skipped[tool] = (totals.skipped[tool] || 0) + n;
  }

  const savedChars = totals.before - totals.after + totals.dedup_chars;
  const ratio = ratios.length ? median(ratios) : null;
  return {
    limits, sessions: sessions.length, unseen,
    unnamed: totals.results - totals.named,
    scanned: totals.results, chars: totals.chars,
    touched: totals.touched, dedup: totals.dedup, salvaged: totals.salvaged,
    before: totals.before, after: totals.after, dedup_chars: totals.dedup_chars,
    saved_chars: savedChars,
    // ESTIMATE: the estimator, on both sides of every transform, dedup included.
    saved_tokens_estimate: totals.tokens_before - totals.tokens_after,
    // MEASURED: this workspace's own billed tokens-per-char, or null.
    measured_ratio: ratio,
    measured_samples: ratios.length,
    saved_tokens_measured: ratio == null ? null : Math.round(savedChars * ratio),
    by_tool: totals.by_tool, skipped: totals.skipped,
    per_session: sessions.sort((a, b) => b.saved - a.saved),
  };
}
