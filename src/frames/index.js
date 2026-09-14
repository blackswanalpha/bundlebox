// frames/index.js — frames over the factory's own data, and the evals that read
// them.
//
// An eval is a JSON file: a source, a filter, one metric and one threshold. It
// is deliberately not code. A measurement that becomes a finding has to be
// arguable, and a person can argue with `{"op": "<=", "value": 0.12}` in a way
// they cannot argue with a function they have to read first.
//
// **An eval whose frame is empty is SKIPPED, never green.** Green has to mean
// measured. This is the same rule the boards run under and it is the one that
// keeps a report from getting healthier the less it can see.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import { BB_DIR, PKG_ROOT, rel } from "../core/paths.js";
import { readJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { pad, table, human } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import { AGGS, AGG_NAMES, OPERATORS, Frame } from "./frame.js";
import * as sources from "./sources.js";

export const SHIPPED = () => path.join(PKG_ROOT, "src", "frames", "evals");
export const LOCAL = () => path.join(BB_DIR, "frames", "evals");

const CMP = { "<=": (a, b) => a <= b, "<": (a, b) => a < b, ">=": (a, b) => a >= b, ">": (a, b) => a > b, "==": (a, b) => a === b, "!=": (a, b) => a !== b };

export function evals() {
  const byId = new Map();
  for (const dir of [SHIPPED(), LOCAL()]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { continue; }
    // A local eval with the same id REPLACES the shipped one rather than
    // running beside it: two thresholds for one measurement is two answers.
    for (const f of names) { const v = readJson(path.join(dir, f), null); if (v) byId.set(v.id || f.replace(/\.json$/, ""), { ...v, id: v.id || f.replace(/\.json$/, ""), file: rel(path.join(dir, f)) }); }
  }
  return [...byId.values()];
}

/** Problems with an eval spec. No data is read. */
export function checkOne(e) {
  const bad = [];
  if (!e.id) bad.push("no id");
  if (!sources.SOURCES[e.source]) bad.push(`${e.id}: source \`${e.source}\` does not exist (${sources.names().join(", ")})`);
  const fn = e.metric?.fn;
  if (fn !== "ratio" && !AGG_NAMES.includes(fn)) bad.push(`${e.id}: metric.fn \`${fn}\` is not one of ${AGG_NAMES.join(" ")} or ratio`);
  if (fn === "ratio" && !(e.metric.num && e.metric.den)) bad.push(`${e.id}: a ratio metric needs num and den columns`);
  if (fn && fn !== "ratio" && fn !== "count" && !e.metric?.col) bad.push(`${e.id}: metric.fn \`${fn}\` needs a col`);
  if (!e.threshold || !CMP[e.threshold.op]) bad.push(`${e.id}: threshold.op must be one of ${Object.keys(CMP).join(" ")}`);
  if (typeof e.threshold?.value !== "number") bad.push(`${e.id}: threshold.value must be a number`);
  for (const c of e.where || []) if (!Array.isArray(c) || c.length < 2 || !OPERATORS.includes(c[1])) bad.push(`${e.id}: where clause ${JSON.stringify(c)} is not [col, op, value] with op in ${OPERATORS.join(" ")}`);
  if (!e.why) bad.push(`${e.id}: no \`why\`; an eval that cannot say what it is for is one nobody will fix`);
  if (e.empty && !["zero", "skip"].includes(e.empty)) bad.push(`${e.id}: \`empty\` must be "zero" or "skip"`);
  return bad;
}

export function runOne(e) {
  const f0 = sources.load(e.source);
  if (!f0) return { id: e.id, state: "error", why: `no source ${e.source}` };
  const f = f0.where(e.where || []);
  // Empty means two different things and the spec has to say which. When the
  // filter selects VIOLATIONS, no rows is the measurement: zero of them. When
  // the metric is over a population, no rows means nothing was measured, and
  // reporting that as green is how a report gets healthier the less it can see.
  if (!f.length) {
    const counting = e.metric.fn === "count" || e.metric.fn === "sum";
    if (e.empty === "zero" && counting) {
      return { id: e.id, state: CMP[e.threshold.op](0, e.threshold.value) ? "held" : "red", value: 0, rows: 0,
        threshold: `${e.threshold.op} ${e.threshold.value}`, severity: e.severity || "medium", why: e.why, source: e.source, evidence: [] };
    }
    return { id: e.id, state: "skipped", rows: 0,
      why: `no rows: ${e.source}${(e.where || []).length ? " after the filter" : ""} is empty${counting && e.empty !== "zero" ? '. Set "empty": "zero" if no rows means zero violations' : ". Green has to mean measured"}` };
  }
  let value;
  if (e.metric.fn === "ratio") {
    const den = AGGS.sum(f.rows.map((r) => r[e.metric.den]));
    value = den ? AGGS.sum(f.rows.map((r) => r[e.metric.num])) / den : null;
    if (value === null) return { id: e.id, state: "skipped", why: `the denominator \`${e.metric.den}\` summed to zero`, rows: f.length };
  } else value = AGGS[e.metric.fn](f.rows.map((r) => r[e.metric.col]));
  if (value === null || value === undefined) return { id: e.id, state: "skipped", why: `${e.metric.fn} of \`${e.metric.col}\` is not a number on any row`, rows: f.length };
  const held = CMP[e.threshold.op](value, e.threshold.value);
  const cols = e.evidence_cols?.length ? e.evidence_cols : f.columns().slice(0, 5);
  const worst = (e.metric.fn === "count" || e.metric.fn === "sum" || e.threshold.op.startsWith("<")
    ? f.sort(e.metric.col || cols[0], "desc") : f).limit(5).select(cols.filter((c) => f.columns().includes(c)));
  return { id: e.id, state: held ? "held" : "red", value: Math.round(value * 1e4) / 1e4, rows: f.length,
    threshold: `${e.threshold.op} ${e.threshold.value}`, severity: e.severity || "medium", why: e.why,
    source: e.source, evidence: worst.rows };
}

export function run({ only = "", write = true } = {}) {
  const want = only ? new Set(String(only).split(",").map((s) => s.trim())) : null;
  const rows = evals().filter((e) => !want || want.has(e.id)).map((e) => {
    const bad = checkOne(e);
    return bad.length ? { id: e.id, state: "error", why: bad[0] } : runOne(e);
  });
  const red = rows.filter((r) => r.state === "red");
  if (write) {
    store.mergeFindings(red.map((r) => ({
      detector: "eval", severity: r.severity, precision: "exact",
      title: `${r.id}: ${r.value} is not ${r.threshold}`, path: r.source, files: [], key: `eval/${r.id}`,
      detail: `${r.why}\n\nMeasured over ${r.rows} row(s) of \`${r.source}\`. Worst rows:\n${JSON.stringify(r.evidence, null, 1).slice(0, 900)}`,
      evidence: { value: r.value, threshold: r.threshold, rows: r.rows, source: r.source, worst: r.evidence },
      fix_hint: "The threshold lives in a JSON file next to the eval. If the number is right and the threshold is wrong, change the threshold and say so in `why`.",
      auto_fix: null, kind: "investigate", est_tokens: 350,
    })), { detectors: new Set(["eval"]) });
  }
  episodes.write({ kind: "stage", verb: "frames", stage: "frames:eval",
    features: { evals: rows.length, sources: new Set(rows.map((r) => r.source)).size },
    rc: red.length ? 1 : 0, produced: red.length, produces: ["findings"],
    turns_saved: episodes.turns({ commands: rows.length, rows: rows.reduce((a, r) => a + (r.rows || 0), 0) }) });
  return rows;
}

function show({ source, cols, where, group, agg, sort, limit, describe }) {
  let f = sources.load(source);
  if (!f) return null;
  if (where.length) f = f.where(where);
  if (describe) return new Frame(f.describe());
  if (group) f = f.group(group.split(","), agg.length ? agg : [["n", "count", f.columns()[0]]]);
  if (sort) f = f.sort(sort.replace(/^-/, ""), sort.startsWith("-") ? "desc" : "asc");
  if (cols.length) f = f.select(cols.filter((c) => f.columns().includes(c)));
  return f.limit(limit);
}

// `--where turns:>=:8` and `--where severity:in:["high","critical"]`
const parseWhere = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean).map((s) => {
  const [col, op, ...rest] = String(s).split(":");
  const raw = rest.join(":");
  let val = raw;
  try { val = JSON.parse(raw); } catch { /* a bare string stays a string */ }
  return [col, op || "==", val];
});
const parseAgg = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean).map((s) => { const [name, fn, col] = String(s).split(":"); return [name, fn || "count", col || name]; });

async function cmd({ _, flags }) {
  const sub = _[0] || "sources";

  if (sub === "sources") {
    const rows = sources.names().map((n) => { const f = sources.load(n); return [n, sources.SOURCES[n].row, f.length, f.columns().slice(0, 6).join(" ")]; });
    if (flags.json) { emit({ sources: rows.map(([name, row, n, cols]) => ({ name, row, rows: n, columns: cols.split(" ") })) }); return 0; }
    out(table(rows, { header: ["source", "one row per", "rows", "columns"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "check") {
    const all = evals();
    const bad = all.flatMap(checkOne);
    if (flags.json) { emit({ evals: all.length, errors: bad }); return bad.length ? 1 : 0; }
    out(`  ${all.length} eval(s) — ${bad.length ? "REFUSED" : "ok"} (no data read)`);
    for (const b of bad) out(`    !! ${b}`);
    return bad.length ? 1 : 0;
  }

  if (sub === "eval") {
    const rows = run({ only: String(flags.only || ""), write: flags.write !== false });
    if (flags.json) { emit({ evals: rows }); return rows.some((r) => r.state === "red") ? 1 : 0; }
    for (const r of rows) {
      const mark = r.state === "red" ? "RED  " : r.state === "held" ? "ok   " : r.state === "skipped" ? "SKIP " : "ERR  ";
      out(`  ${mark}${pad(r.id, 26)} ${pad(r.value ?? "—", 10, true)} ${pad(r.threshold || "", 10)} ${r.state === "held" ? `${r.rows} rows` : r.why || ""}`);
    }
    const red = rows.filter((r) => r.state === "red").length, skipped = rows.filter((r) => r.state === "skipped").length;
    out(`\n  ${rows.length - red - skipped} held · ${red} red · ${skipped} skipped. A skipped eval is not a passing one.`);
    return red ? 1 : 0;
  }

  if (sub === "show") {
    const f = show({
      source: String(flags.source || _[1] || "findings"),
      cols: flags.cols ? String(flags.cols).split(",") : [],
      where: parseWhere(flags.where),
      group: flags.group ? String(flags.group) : "",
      agg: parseAgg(flags.agg),
      sort: flags.sort ? String(flags.sort) : "",
      limit: Number(flags.limit) || 20,
      describe: !!flags.describe,
    });
    if (!f) { warn(`no source \`${flags.source || _[1]}\`. bb frames sources`); return 2; }
    if (flags.json) { emit({ rows: f.rows }); return 0; }
    if (flags.markdown) { out(f.markdown()); return 0; }
    if (!f.length) { out("  (no rows)"); return 0; }
    const cols = f.columns();
    out(table(f.rows.map((r) => cols.map((c) => { const v = r[c]; return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 52); })), { header: cols })
      .split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  warn(`unknown frames sub-verb: ${sub}. sources | show | check | eval`);
  return 2;
}

export const commands = {
  frames: {
    help: "a dataframe over the factory's own data, and the evals that turn a measurement into a finding",
    usage: "bb frames [sources|show|check|eval] [--source x] [--where col:op:value] [--group col] [--agg name:fn:col] [--sort -col] [--cols a,b] [--limit n] [--describe] [--markdown] [--json]",
    long: [
      "  bb frames sources",
      "  bb frames show --source sessions --sort -tokens --cols title,turns,tokens,turns_saved",
      "  bb frames show --source episodes --group verb --agg runs:count:id --agg saved:sum:turns_saved --sort -saved",
      "  bb frames show --source board --where state:in:[\"failed\",\"error\"]",
      "  bb frames eval                  run every eval; red ones become findings under detector `eval`",
      "",
      "Evals ship in src/frames/evals/ and are overridden per workspace in .bundlebox/frames/evals/.",
    ].join("\n"),
    run: cmd,
  },
};
export { sources };
