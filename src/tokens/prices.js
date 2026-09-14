// prices.js — what a token costs, so a cost line is arithmetic. Every row is a
// published first-party API rate with a source and date. A model this table
// does not know is reported with its counts and NO cost, never a guessed rate.
export const SOURCE = "vendor pricing pages (Anthropic, OpenAI, Google), see docs/prices.md";
export const AS_OF = "2026-09-13";

/** $ per million tokens: [input, output, cache_read_multiplier?, cache_write_multiplier?] */
export const PER_MTOK = {
  // Anthropic — cache write 1.25x (5m) / 2x (1h); cache read 0.1x (0.025x on Fable).
  "claude-fable-5-1": [10.0, 50.0, 0.025, 2.0],
  "claude-mythos-5-1": [10.0, 50.0, 0.025, 2.0],
  "claude-opus-5": [5.0, 25.0, 0.1, 2.0],
  "claude-opus-4-8": [5.0, 25.0, 0.1, 2.0],
  "claude-opus-4-7": [5.0, 25.0, 0.1, 2.0],
  "claude-opus-4-6": [5.0, 25.0, 0.1, 2.0],
  "claude-sonnet-5": [2.0, 10.0, 0.1, 2.0],
  "claude-sonnet-4-6": [3.0, 15.0, 0.1, 2.0],
  "claude-haiku-4-5": [1.0, 5.0, 0.1, 2.0],
  // OpenAI — cached input 0.1x, no write charge.
  "gpt-5": [1.25, 10.0, 0.1, 1.0],
  "gpt-5-mini": [0.25, 2.0, 0.1, 1.0],
  "gpt-5-codex": [1.25, 10.0, 0.1, 1.0],
  "gpt-5.1": [1.25, 10.0, 0.1, 1.0],
  "gpt-5.1-codex": [1.25, 10.0, 0.1, 1.0],
  // Google — implicit caching 0.25x on 2.5, no write charge.
  "gemini-2.5-pro": [1.25, 10.0, 0.25, 1.0],
  "gemini-2.5-flash": [0.30, 2.5, 0.25, 1.0],
  "gemini-3-pro": [2.0, 12.0, 0.1, 1.0],
  "gemini-3-flash": [0.5, 3.0, 0.1, 1.0],
};
export const ALIASES = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5", fable: "claude-fable-5-1" };

export function normalise(model) {
  let m = String(model || "").trim().toLowerCase();
  if (!m) return "";
  m = m.split("[")[0];
  if (ALIASES[m]) return ALIASES[m];
  if (PER_MTOK[m]) return m;
  const parts = m.split("-");
  if (/^\d{8}$/.test(parts[parts.length - 1])) m = parts.slice(0, -1).join("-");
  if (PER_MTOK[m]) return m;
  // `models/gemini-2.5-pro`, `gpt-5-codex-2026-..`
  m = m.replace(/^models\//, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return PER_MTOK[m] ? m : "";
}
export const known = (m) => Boolean(normalise(m));
export function cost(model, { inp = 0, out = 0, cache_write = 0, cache_read = 0 } = {}) {
  const key = normalise(model);
  if (!key) return null;
  const [i, o, r, w] = PER_MTOK[key];
  const per = 1e-6;
  const d = { input: inp * i * per, cache_write: cache_write * i * w * per, cache_read: cache_read * i * r * per, output: out * o * per };
  d.total = d.input + d.cache_write + d.cache_read + d.output;
  // Measured saving: those exact tokens billed at that exact discount.
  d.cache_saved = cache_read * i * (1 - r) * per;
  return d;
}
export function table() {
  const lines = [`  PRICES — ${SOURCE}, as of ${AS_OF}`, "", `    ${"model".padEnd(20)} ${"in $/M".padStart(8)} ${"out $/M".padStart(8)} ${"cache rd".padStart(9)} ${"cache wr".padStart(9)}`];
  for (const [k, [i, o, r, w]] of Object.entries(PER_MTOK)) lines.push(`    ${k.padEnd(20)} ${i.toFixed(2).padStart(8)} ${o.toFixed(2).padStart(8)} ${(i * r).toFixed(3).padStart(9)} ${(i * w).toFixed(2).padStart(9)}`);
  lines.push("", "    A model not in this table is reported with its tokens and no cost.");
  return lines.join("\n");
}
