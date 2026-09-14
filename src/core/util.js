// util.js — small, shared, dependency-free helpers. One copy of each.
import { createHash, randomBytes } from "node:crypto";

export const now = () => new Date().toISOString();
export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const sha1 = (s) => createHash("sha1").update(s).digest("hex");
export const shortId = (n = 6) => randomBytes(n).toString("hex").slice(0, n);
export const human = (n) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};
export const usd = (n) => (n == null ? "—" : "$" + (Number(n) || 0).toFixed(n >= 10 ? 2 : 3));
export const pad = (s, w, right = false) => {
  s = String(s ?? "");
  return s.length >= w ? s : right ? " ".repeat(w - s.length) + s : s + " ".repeat(w - s.length);
};
export const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
export const uniq = (xs) => [...new Set(xs)];
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
export const deepMerge = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) return b === undefined ? a : b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  return out;
};
export const table = (rows, { header = null, gap = 2 } = {}) => {
  const all = header ? [header, ...rows] : rows;
  const widths = [];
  for (const r of all) r.forEach((c, i) => (widths[i] = Math.max(widths[i] || 0, String(c ?? "").length)));
  const line = (r) => r.map((c, i) => pad(c, widths[i], typeof c === "number")).join(" ".repeat(gap)).trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => "-".repeat(w)).join(" ".repeat(gap)));
  return out.join("\n");
};
