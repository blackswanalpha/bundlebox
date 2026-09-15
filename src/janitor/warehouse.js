// janitor/warehouse.js — a schema over the var store, without moving a byte.
//
// The var store is right the way it is: JSON documents for state that gets
// replaced, JSONL for state that accumulates, no database process, no
// dependency, and a cron worker that reads what is on disk or does not run.
// Anything that replaces that with a database inherits a daemon, a migration
// path and a lock, and loses the property that makes it safe — a half-written
// append is one bad line, not a corrupt table.
//
// What the store does not have is a SCHEMA. Sixteen files with different grains
// and no declared keys means every question that spans two of them is a script
// somebody writes once and throws away. "Which memory sources produce the most
// dead anchors, and what did the sessions that trusted them cost" is one join
// and there has never been anywhere to write it.
//
// So: the restructure is LOGICAL, not physical. DuckDB reads JSONL in place
// with `read_json_auto`, so a view per file over the bytes that are already
// there gives the store a catalog — declared grain, declared key, declared
// partition — while the files stay exactly what the lock and the cron expect.
// Nothing is copied unless `--materialise` is asked for, and then it is Parquet
// next to the source, derived and rebuildable like everything else under out/.
//
// DuckDB is not a dependency. It is a binary this file shells to when the box
// has one, and when it does not, the SQL is still written and still correct —
// the artefact is the schema, and running it is an optimisation.
import fs from "node:fs";
import path from "node:path";
import { VAR, OUT, rel } from "../core/paths.js";
import { run, which } from "../core/exec.js";
import { now } from "../core/util.js";

export const DB = () => path.join(VAR, "warehouse.duckdb");
export const SQL = () => path.join(OUT, "janitor", "warehouse.sql");

// The catalog. Each entry declares what one row of that file IS — the grain —
// which is the fact the store never wrote down and every ad-hoc script had to
// guess. `key` is what makes a row unique, `time` is what it is partitioned by.
export const CATALOG = [
  { file: "episodes.jsonl",   table: "episodes",   grain: "one row per recorded episode",              key: "id",                    time: "ts" },
  { file: "usage.jsonl",      table: "usage",      grain: "one row per API turn",                      key: "session_id, msg_id",    time: "ts" },
  { file: "gear_runs.jsonl",  table: "gear_runs",  grain: "one row per pipeline gear execution",       key: "id",                    time: "ts" },
  { file: "bench.jsonl",      table: "bench",      grain: "one row per benchmark measurement",         key: "id",                    time: "ts" },
  { file: "calls.jsonl",      table: "calls",      grain: "one row per model call",                    key: "id",                    time: "ts" },
  { file: "sieve.jsonl",      table: "sieve",      grain: "one row per compression event",             key: "hash",                  time: "ts" },
  { file: "outcomes.jsonl",   table: "outcomes",   grain: "one row per unit outcome",                  key: "id",                    time: "ts" },
  { file: "sessions.jsonl",   table: "sessions",   grain: "one row per session observation",           key: "session_id",            time: "ts" },
  { file: "findings.json",    table: "findings",   grain: "one row per open finding",                  key: "id",                    time: "first_seen" },
  { file: "units.json",       table: "units",      grain: "one row per compiled work unit",            key: "id",                    time: "at" },
  { file: "lanes.json",       table: "lanes",      grain: "one row per routed lane",                    key: "id",                    time: "at" },
  { file: "rules.json",       table: "rules",      grain: "the oversight rule set as one document",     key: "—",                     time: "at" },
  { file: "signals.json",     table: "signals",    grain: "the detector signal set as one document",    key: "—",                     time: "at" },
  { file: "plans.json",       table: "plans",      grain: "one row per plan, keyed by run id",          key: "id",                    time: "created" },
  { file: "memory.json",      table: "memory_doc", grain: "one row per remembered item",                key: "key",                   time: "at" },
];

// The two janitor emits. They join to everything else on source and time, which
// is the whole reason the heap was given one shape in the first place.
const JANITOR = [
  { rel: "out/janitor/heap.jsonl",      table: "heap",       grain: "one row per heap object at last compile", key: "id",  time: "learned_at" },
  { rel: "var/janitor-tombstones.jsonl", table: "tombstones", grain: "one row per retraction, append-only",     key: "id",  time: "retracted_at" },
];

const q = (p) => `'${String(p).replace(/'/g, "''")}'`;

// The var store has four physical shapes and the catalog cannot declare which,
// because the same verb writes an array one release and a map the next. Reading
// the first bytes is cheaper than being wrong: `format='array'` against a
// top-level object is a hard error, and a schema that errors on load is a
// schema nobody runs twice.
//
//   jsonl   one object per line          (append-only logs)
//   array   a top-level JSON array       (findings, units, lanes)
//   map     an object of id -> record    (plans)
//   record  an object that IS the record (rules, signals)
const MAX_SNIFF = 32 * 1024 * 1024;
export function shapeOf(file) {
  if (file.endsWith(".jsonl")) return "jsonl";
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_SNIFF) return "array";       // too big to parse; arrays are the common large shape
    text = fs.readFileSync(file, "utf8");
  } catch { return "record"; }
  const head = text.replace(/^\s+/, "")[0];
  if (head === "[") return "array";
  if (head !== "{") return "record";
  let v; try { v = JSON.parse(text); } catch { return "record"; }
  const vals = Object.values(v || {});
  // A map is an object whose values are ALL records. One scalar field and it is
  // a document with named fields, not a keyed collection.
  return vals.length > 0 && vals.every((x) => x && typeof x === "object") ? "map" : "record";
}

/** The SELECT for one file, given its shape. A map is unnested by its keys
 *  rather than read as one very wide row. */
export function viewBody(file, shape) {
  if (shape === "map") {
    return [
      `  SELECT t.k AS id, json_extract(d.j, '$."' || t.k || '"') AS doc`,
      `  FROM (SELECT CAST(content AS JSON) AS j FROM read_text(${q(file)})) d,`,
      `       unnest(json_keys(d.j)) AS t(k);`,
    ].join("\n");
  }
  const fmt = shape === "jsonl" ? "'newline_delimited'" : shape === "array" ? "'array'" : "'auto'";
  return `  SELECT * FROM read_json_auto(${q(file)}, format=${fmt}, union_by_name=true, ignore_errors=true);`;
}

/** What is on disk, what the catalog knows about, and what it does not. The
 *  unclassified list is the point: a var file with no declared grain is a file
 *  nothing can query, and naming them is the restructure. */
export function survey({ dir = VAR } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") || n.endsWith(".jsonl")); } catch { names = []; }
  const known = new Map(CATALOG.map((c) => [c.file, c]));
  const present = [], unclassified = [], missing = [];
  for (const n of names) {
    const f = path.join(dir, n);
    let st; try { st = fs.statSync(f); } catch { continue; }
    const c = known.get(n);
    const row = { file: n, path: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), rows: 0 };
    if (n.endsWith(".jsonl")) {
      try { row.rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length; } catch { /* size is enough */ }
    }
    if (c) present.push({ ...row, ...c, shape: shapeOf(f) }); else unclassified.push({ ...row, shape: shapeOf(f) });
  }
  for (const c of CATALOG) if (!names.includes(c.file)) missing.push(c);
  return { present, unclassified, missing };
}

/** The schema, as text. Written whether or not a duckdb binary exists, because
 *  the schema is the artefact and running it is the optimisation. */
export function sql({ dir = VAR, root = OUT, materialise = false } = {}) {
  const s = survey({ dir });
  const L = [];
  L.push(`-- bundlebox var store — logical schema over the files as they are.`);
  L.push(`-- Generated ${now()} by \`bb janitor warehouse\`. Do not edit; regenerate.`);
  L.push(`--`);
  L.push(`-- Nothing here copies data. Each view reads the JSON on disk in place, so the`);
  L.push(`-- store keeps the properties it was built for: no daemon, no migration, and a`);
  L.push(`-- half-written append is one bad line instead of a corrupt table.`);
  L.push("");
  L.push("INSTALL json; LOAD json;");
  L.push("");

  for (const c of s.present) {
    L.push(`-- ${c.table}: ${c.grain}`);
    L.push(`--   key ${c.key} · time ${c.time} · shape ${c.shape} · ${c.rows || "?"} rows · ${c.bytes} bytes`);
    L.push(`CREATE OR REPLACE VIEW ${c.table} AS`);
    L.push(viewBody(c.path, c.shape));
    L.push("");
  }
  // A view over a file that does not exist is not an empty view, it is an IO
  // error that stops the whole script — so a heap that has never been compiled,
  // or a tombstone log with nothing in it yet, is skipped and said so. The
  // queries below that need them are written anyway; they are the reason to run
  // `bb janitor compile` before asking.
  const emitted = new Set();
  for (const j of JANITOR) {
    const p = path.join(path.dirname(dir), j.rel);
    L.push(`-- ${j.table}: ${j.grain}`);
    if (!fs.existsSync(p)) { L.push(`--   not written yet (${rel(p)}) — run \`bb janitor compile\` and regenerate`); L.push(""); continue; }
    emitted.add(j.table);
    L.push(`CREATE OR REPLACE VIEW ${j.table} AS`);
    L.push(viewBody(p, "jsonl"));
    L.push("");
  }
  const tables = new Set([...s.present.map((c) => c.table), ...emitted]);
  const runnable = (body) => (body.match(/\bFROM\s+([a-z_]+)/g) || [])
    .map((m) => m.replace(/\bFROM\s+/, "")).every((t) => tables.has(t) || /^\(|^read_|^unnest/.test(t));

  L.push("-- ── automations ─────────────────────────────────────────────────────────");
  L.push("-- Questions that span two files and have never had anywhere to live.");
  L.push("");
  for (const [name, body] of Object.entries(QUERIES)) {
    L.push(`-- ${body.what}`);
    if (!runnable(body.sql)) { L.push(`--   q_${name} needs a view this store does not have yet; skipped`); L.push(""); continue; }
    L.push(`CREATE OR REPLACE VIEW q_${name} AS`);
    L.push(body.sql.trim().replace(/;$/, "") + ";");
    L.push("");
  }

  if (materialise) {
    L.push("-- ── materialise ─────────────────────────────────────────────────────────");
    L.push("-- Parquet next to the source: derived, rebuildable, and never read back by");
    L.push("-- anything in the factory. For a notebook, a dashboard or a cold archive.");
    const dest = path.join(root, "janitor", "warehouse");
    L.push(`-- ${rel(dest)}`);
    for (const c of s.present) L.push(`COPY (SELECT * FROM ${c.table}) TO ${q(path.join(dest, `${c.table}.parquet`))} (FORMAT parquet);`);
    for (const j of JANITOR) if (emitted.has(j.table)) L.push(`COPY (SELECT * FROM ${j.table}) TO ${q(path.join(dest, `${j.table}.parquet`))} (FORMAT parquet);`);
    L.push("");
  }

  if (s.unclassified.length) {
    L.push("-- ── unclassified ────────────────────────────────────────────────────────");
    L.push("-- On disk, no declared grain, therefore not queryable. Add them to CATALOG");
    L.push("-- in src/janitor/warehouse.js, or decide they are scratch and let the");
    L.push("-- sweep have them.");
    for (const u of s.unclassified) L.push(`--   ${u.file}  ${u.shape}  ${u.bytes} bytes  last written ${u.mtime.slice(0, 16)}`);
    L.push("");
  }
  return L.join("\n");
}

// The saved questions. Each one is a join the store could never answer before,
// and each one is the input to an automation rather than a report a human reads.
export const QUERIES = {
  rot: {
    what: "how fast each memory source is rotting: dead and drifted anchors per source",
    sql: `SELECT source,
       count(*)                                        AS objects,
       sum(CASE WHEN resolution='dead'    THEN 1 ELSE 0 END) AS dead,
       sum(CASE WHEN resolution='drifted' THEN 1 ELSE 0 END) AS drifted,
       round(100.0 * sum(CASE WHEN resolution IN ('dead','drifted') THEN 1 ELSE 0 END) / count(*), 1) AS rot_pct,
       sum(tokens)                                     AS tokens
FROM heap WHERE retracted_at IS NULL
GROUP BY source HAVING count(*) > 2 ORDER BY rot_pct DESC, tokens DESC`,
  },
  reclaim: {
    what: "tokens reclaimed per week, by why they were retracted",
    sql: `SELECT date_trunc('week', CAST(retracted_at AS TIMESTAMP)) AS week,
       CASE WHEN why LIKE 'superseded%' THEN 'contradicted'
            WHEN why LIKE 'unreached%'  THEN 'aged out'
            ELSE 'other' END              AS reason,
       count(*)                           AS objects
FROM tombstones GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`,
  },
  half_life: {
    what: "observed half-life per kind: how old things actually are when they get retracted",
    sql: `SELECT kind, count(*) AS retracted,
       round(median(date_diff('day', CAST(learned_at AS TIMESTAMP), CAST(retracted_at AS TIMESTAMP))), 1) AS median_days,
       round(quantile_cont(date_diff('day', CAST(learned_at AS TIMESTAMP), CAST(retracted_at AS TIMESTAMP)), 0.9), 1) AS p90_days
FROM tombstones GROUP BY kind ORDER BY retracted DESC`,
  },
  dead_weight: {
    what: "wiring that is installed, billed on every turn, and never reached",
    sql: `SELECT source, text, tokens
FROM heap
WHERE json_extract_string(meta, '$.store') = 'wiring'
  AND reached IS NULL AND retracted_at IS NULL
ORDER BY tokens DESC LIMIT 50`,
  },
  cost_of_rot: {
    what: "what the sessions spent while a source with dead anchors was in the window",
    sql: `SELECT h.source,
       count(DISTINCT u.session_id) AS sessions,
       sum(u.input + u.output + u.cache_read + u.cache_write) AS tokens
FROM heap h
JOIN usage u ON CAST(u.ts AS TIMESTAMP) BETWEEN CAST(h.learned_at AS TIMESTAMP)
                         AND CAST(h.learned_at AS TIMESTAMP) + INTERVAL 30 DAY
WHERE h.resolution = 'dead' AND h.retracted_at IS NULL
GROUP BY h.source ORDER BY tokens DESC LIMIT 25`,
  },
  growth: {
    what: "var store growth by table and week — which append-only file is running away",
    sql: `SELECT 'episodes' AS tbl, date_trunc('week', CAST(ts AS TIMESTAMP)) AS week, count(*) AS rows FROM episodes GROUP BY 2
UNION ALL SELECT 'usage', date_trunc('week', CAST(ts AS TIMESTAMP)), count(*) FROM usage GROUP BY 2
ORDER BY week DESC, rows DESC`,
  },
};

export const hasDuckdb = () => which("duckdb");

/** Write the schema, and run it when there is a binary to run it with. */
export function build({ dir = VAR, out = SQL(), materialise = false, query = "", db = DB(), timeout = 120000 } = {}) {
  const text = sql({ dir, materialise });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  const bin = hasDuckdb();
  if (!bin) {
    return { ok: false, sql: out, db: null, bin: null, rows: "",
      why: "no duckdb on PATH — the schema is written and correct; install duckdb to run it (`curl https://install.duckdb.org | sh`, or `brew install duckdb`)" };
  }
  const script = query
    ? `${text}\n.mode box\nSELECT * FROM q_${query.replace(/[^a-z_]/g, "")} LIMIT 40;\n`
    : `${text}\n.mode box\nSELECT table_name, estimated_size FROM duckdb_views() WHERE NOT internal ORDER BY table_name;\n`;
  const r = run([bin, db], { input: script, timeout });
  return { ok: r.rc === 0, sql: out, db, bin, rows: r.out || "", why: r.rc === 0 ? "" : (r.err || "").split("\n").slice(0, 4).join(" ") };
}
