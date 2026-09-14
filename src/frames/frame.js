// frame.js — a dataframe, in about two hundred lines and no dependency.
//
// It is not pandas and it is not trying to be. Every source in this factory is
// a few thousand rows at most, and the point is not speed: it is that an
// eval — the thing that turns a measurement into a finding — is a JSON file a
// person can read and argue with, rather than a function somebody has to trust.
//
// A column absent on a row is null, never zero: a missing measurement and a
// measurement of nothing are different facts, and an aggregate that conflates
// them is wrong in the direction that looks healthy.
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);

const OPS = {
  "==": (a, b) => a === b || String(a) === String(b),
  "!=": (a, b) => !(a === b || String(a) === String(b)),
  ">": (a, b) => num(a) !== null && num(a) > num(b),
  ">=": (a, b) => num(a) !== null && num(a) >= num(b),
  "<": (a, b) => num(a) !== null && num(a) < num(b),
  "<=": (a, b) => num(a) !== null && num(a) <= num(b),
  in: (a, b) => (Array.isArray(b) ? b.some((x) => String(x) === String(a)) : false),
  "not-in": (a, b) => (Array.isArray(b) ? !b.some((x) => String(x) === String(a)) : true),
  contains: (a, b) => String(a ?? "").includes(String(b)),
  matches: (a, b) => { try { return new RegExp(String(b)).test(String(a ?? "")); } catch { return false; } },
  exists: (a) => a !== null && a !== undefined && a !== "",
};
export const OPERATORS = Object.keys(OPS);

export const AGGS = {
  count: (xs) => xs.length,
  distinct: (xs) => new Set(xs.map((x) => JSON.stringify(x))).size,
  sum: (xs) => xs.reduce((a, x) => a + (num(x) || 0), 0),
  mean: (xs) => { const n = xs.map(num).filter((x) => x !== null); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; },
  median: (xs) => { const n = xs.map(num).filter((x) => x !== null).sort((a, b) => a - b); if (!n.length) return null; const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  min: (xs) => { const n = xs.map(num).filter((x) => x !== null); return n.length ? Math.min(...n) : null; },
  max: (xs) => { const n = xs.map(num).filter((x) => x !== null); return n.length ? Math.max(...n) : null; },
  p95: (xs) => { const n = xs.map(num).filter((x) => x !== null).sort((a, b) => a - b); return n.length ? n[Math.min(n.length - 1, Math.max(0, Math.ceil(0.95 * n.length) - 1))] : null; },
  any: (xs) => xs.some(Boolean),
  first: (xs) => (xs.length ? xs[0] : null),
};
export const AGG_NAMES = Object.keys(AGGS);

export class Frame {
  constructor(rows = [], { name = "" } = {}) { this.rows = rows; this.name = name; }
  get length() { return this.rows.length; }
  columns() { const c = new Set(); for (const r of this.rows) for (const k of Object.keys(r || {})) c.add(k); return [...c]; }
  select(cols) { return new Frame(this.rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), { name: this.name }); }
  /** `[[col, op, value], ...]` — every clause must hold. */
  where(clauses) {
    const cs = (clauses || []).map(([col, op, v]) => [col, OPS[op] || OPS["=="], v]);
    return new Frame(this.rows.filter((r) => cs.every(([col, f, v]) => f(r[col], v))), { name: this.name });
  }
  sort(col, dir = "asc") { const s = [...this.rows].sort((a, b) => cmp(num(a[col]) ?? a[col], num(b[col]) ?? b[col])); return new Frame(dir === "desc" ? s.reverse() : s, { name: this.name }); }
  limit(n) { return new Frame(n > 0 ? this.rows.slice(0, n) : this.rows, { name: this.name }); }
  derive(col, fn) { return new Frame(this.rows.map((r) => ({ ...r, [col]: fn(r) })), { name: this.name }); }
  /** `group("verb", [["n","count","id"], ["saved","sum","turns_saved"]])` */
  group(by, aggs) {
    const keys = Array.isArray(by) ? by : [by];
    const buckets = new Map();
    for (const r of this.rows) {
      const k = JSON.stringify(keys.map((c) => (r[c] === undefined ? null : r[c])));
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const out = [];
    for (const [k, rows] of buckets) {
      const vals = JSON.parse(k);
      const row = Object.fromEntries(keys.map((c, i) => [c, vals[i]]));
      for (const [name, fn, col] of aggs) row[name] = (AGGS[fn] || AGGS.count)(rows.map((r) => r[col]));
      out.push(row);
    }
    return new Frame(out, { name: this.name });
  }
  join(other, on, { prefix = "" } = {}) {
    const idx = new Map(other.rows.map((r) => [String(r[on]), r]));
    return new Frame(this.rows.map((r) => {
      const m = idx.get(String(r[on]));
      if (!m) return r;
      const add = {};
      for (const [k, v] of Object.entries(m)) if (k !== on) add[prefix + k] = v;
      return { ...r, ...add };
    }), { name: this.name });
  }
  describe() {
    return this.columns().map((c) => {
      const vals = this.rows.map((r) => r[c]);
      const n = vals.map(num).filter((x) => x !== null);
      return { column: c, rows: vals.length, nulls: vals.filter((v) => v === null || v === undefined).length,
        numeric: n.length, min: n.length ? Math.min(...n) : null, median: AGGS.median(vals), p95: AGGS.p95(vals),
        max: n.length ? Math.max(...n) : null, distinct: AGGS.distinct(vals) };
    });
  }
  markdown(cols = null) {
    const c = cols || this.columns();
    if (!this.rows.length) return "(no rows)";
    const cell = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "\\|").slice(0, 120);
    return [`| ${c.join(" | ")} |`, `|${c.map(() => "---").join("|")}|`,
      ...this.rows.map((r) => `| ${c.map((k) => cell(r[k])).join(" | ")} |`)].join("\n");
  }
  jsonl() { return this.rows.map((r) => JSON.stringify(r)).join("\n"); }
}
export const frame = (rows, opts) => new Frame(rows, opts);
