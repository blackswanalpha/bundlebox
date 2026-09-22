// case/index.js — `bb case`: everything the board knows about one subject.
//
// Six subsystems can each be right and still leave nobody able to say what
// happened. On this tree, at one moment: failsafe said a declared service was
// down, the stage table said the corpus could not run, echos said eleven
// sessions had spun, a frames eval said tokens-per-turn was 2.3x its ceiling,
// and the proofhouse said one detector owned 89% of the queue. Five rows, five
// subsystems, and no verb that put any two of them on the same page.
//
// **Nothing here collects anything.** Every one of those rows was already in
// the findings store, because the store is the one place every writer files to.
// A case is a read.
//
// A case is every open row about ONE SUBJECT, and a subject is something a row
// already names: a real file, or a `service`, `stage`, `session`, `detector`,
// `corpus`, `base`, `url`, `view` or `area` in its evidence. That is the whole
// joining rule, and it is equality on a written-down value.
//
// It is deliberately not a connected component. The first build of this file
// used one and produced a single case of 622 rows: a duplication finding names
// two files, so it bridges them, and enough bridges merge the tree. Every edge
// in that component was correct and the grouping was useless. A subject cannot
// chain — a row about `hooks.js` and a row about `json.rs` are in two cases,
// and a row naming both is in both, which is what is true.
//
// The `why` is two answers, kept apart because they are two questions:
//
//   cause  the failsafe playbook's entry for the root row — a sentence somebody
//          already paid to work out, and the op that closes it. Null when no
//          entry matches. Nothing here writes a cause of its own.
//   kind   `bb intent`: the fitted table decides what shape of work this is and
//          hands back its own derivation. With no table it says so in its own
//          steps and returns the shipped default, which is why every case in a
//          fresh workspace reads `fix (default)` rather than pretending.
//
// What it will not do is invent the edge it cannot see. The service being down
// and the sessions spinning are one story to a reader and share no subject, so
// they stay two cases. Saying how many rows were placed and how many were not
// is the honest half of that, and it is in `blind`.
import { sha1 } from "../core/util.js";
import * as store from "../core/store.js";
import { out, emit, warn } from "../core/log.js";
import { STAGES } from "../pipeline/stages.js";
import { playbook } from "../failsafe/index.js";
import * as intent from "../intent/index.js";
import * as occurred from "./occurred.js";

/** Evidence keys that name a thing a row is ABOUT. Named rather than "every key
 *  two rows share": `count`, `value` and `threshold` collide across unrelated
 *  rows constantly, and a case built on `count=4` is noise with a title. */
export const SUBJECT_KEYS = ["service", "stage", "session", "detector", "corpus", "base", "url", "view", "area"];

/** The repository root is not a subject, for the same reason it is not a scope:
 *  it is every row at once. */
const REAL_PATH = (p) => { const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""); return Boolean(s) && s !== "." && s.includes("."); };

export const stageIndex = new Map(STAGES.map((s, i) => [s.id, i]));

/** How far into a `worst` array a subject is read from. An eval names the rows
 *  that crossed its bar and there can be thousands; the first few are what the
 *  row is about, and the rest is the measurement. */
export const NESTED_AT_MOST = 8;

/** Every subject one row names, as `kind:value`. */
export function subjects(f) {
  const found = new Set();
  for (const p of [f.path, ...(Array.isArray(f.files) ? f.files : [])]) if (REAL_PATH(p)) found.add(`file:${String(p)}`);
  const ev = f.evidence && typeof f.evidence === "object" ? f.evidence : {};
  for (const k of SUBJECT_KEYS) {
    const v = ev[k];
    if (v == null || typeof v === "object") continue;
    const s = String(v).trim();
    if (s && s !== "." && s.length < 200) found.add(`${k}:${s}`);
  }
  // Sources with no file put a stage id in `path`: failsafe, eval and cookbook
  // all do. It is a subject when it names a declared stage and nothing when it
  // does not, rather than a fifth kind of string nobody can join on.
  if (stageIndex.has(String(f.path))) found.add(`stage:${f.path}`);

  // One level down, and only into `worst` — the array every eval and several
  // stage rows carry to name what crossed the bar. Without this the frames eval
  // `pipeline-gaps` and the failsafe row for the same gap share no subject and
  // stay two cases, which is the exact split this verb exists to close. A bare
  // `id` is admitted only when it names a DECLARED stage: `id` is the most
  // overloaded key on the board and anything looser joins rows by coincidence.
  for (const row of (Array.isArray(ev.worst) ? ev.worst : []).slice(0, NESTED_AT_MOST)) {
    if (!row || typeof row !== "object") continue;
    for (const k of SUBJECT_KEYS) {
      const v = row[k];
      if (v == null || typeof v === "object") continue;
      const t = String(v).trim();
      if (t && t !== "." && t.length < 200) found.add(`${k}:${t}`);
    }
    if (stageIndex.has(String(row.id))) found.add(`stage:${row.id}`);
  }
  return found;
}

const SEV = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
/** A row's age, or 0 when it has none.
 *
 *  The `|| 0` inside a Date.parse is the trap: `Date.parse(0)` coerces to the
 *  string "0" and returns 2000-01-01, so a row with neither timestamp dates to
 *  the millennium and every window it lands in reads twenty-six years wide. An
 *  undated row has no age, and 0 here means the callers drop it. */
const when = (f) => { const t = f.first_seen || f.last_seen; return t ? Date.parse(t) || 0 : 0; };
const book = () => { const p = playbook(); return { byId: new Map((p.failures || []).map((f) => [f.id, f])), ops: new Map((p.ops || []).map((o) => [o.id, o])) }; };

/** The row the others are read against.
 *
 *  The order is what a root has to offer, not how loud it is. A row with a
 *  playbook entry carries a cause somebody already worked out; a row about an
 *  early stage is upstream of the rest by declaration; then the row whose thing
 *  HAPPENED first, and only after that the row noticed first. Severity ranks
 *  last on purpose — the loudest row in a case is routinely the symptom of the
 *  quietest one.
 *
 *  Occurrence outranks detection, which is the reason the field exists: two
 *  rows found by the same scan have the same `first_seen` and are five months
 *  apart, and ordering by the scan puts whichever the detector emitted first at
 *  the head of the story. A row with no provable occurrence falls through to
 *  detection rather than to position zero. */
export function rootOf(rows, b = book(), clock = {}) {
  const rank = (f) => {
    const subs = subjects(f);
    let st = STAGES.length;
    for (const s of subs) if (s.startsWith("stage:") && stageIndex.has(s.slice(6))) st = Math.min(st, stageIndex.get(s.slice(6)));
    const o = occurred.occurredAt(f, clock);
    const ot = o.at ? Date.parse(o.at) || 0 : 0;
    return [b.byId.has(String(f.evidence?.playbook_entry || "")) ? 0 : 1, st,
      ot || Number.MAX_SAFE_INTEGER, when(f) || Number.MAX_SAFE_INTEGER, -(SEV[f.severity] || 0)];
  };
  return [...rows].sort((x, y) => { const a = rank(x), c = rank(y); for (let i = 0; i < a.length; i += 1) if (a[i] !== c[i]) return a[i] - c[i]; return 0; })[0];
}

/** One case: one subject, every open row about it, and the two whys. */
export function build(subject, rows, { book: b = book(), head = intent.head(), subjectsWithCases = new Set(), clock = {} } = {}) {
  const at = new Map(rows.map((f) => [f.id, occurred.occurredAt(f, clock)]));
  const root = rootOf(rows, b, clock);
  const entry = b.byId.get(String(root.evidence?.playbook_entry || "")) || null;
  const op = entry ? b.ops.get(entry.op) || null : null;
  const times = rows.map(when).filter(Boolean).sort((x, y) => x - y);

  // A stage subject has a declared position, so the stages before it that also
  // have a case are named. It is an ordering the pipeline already states, never
  // a claim that one caused the other.
  const upstream = subject.startsWith("stage:") && stageIndex.has(subject.slice(6))
    ? STAGES.slice(0, stageIndex.get(subject.slice(6))).map((s) => `stage:${s.id}`).filter((s) => subjectsWithCases.has(s))
    : [];

  // The kind, over what this case IS rather than over any one row in it.
  // `classify` never fails: with no table it returns the shipped default and
  // its own steps say that is what happened.
  const kind = intent.classify([root.title, ...rows.filter((f) => f.id !== root.id).map((f) => f.title)].join(". "), { head });

  return {
    id: `c-${sha1(subject).slice(0, 8)}`, subject,
    title: `${subject} — ${rows.length} row(s) from ${new Set(rows.map((f) => f.detector)).size} source(s)`,
    root: { id: root.id, detector: root.detector, severity: root.severity, title: root.title,
      occurred_at: at.get(root.id).at, occurred_via: at.get(root.id).via, occurred_bound: at.get(root.id).bound || null },
    // Ordered by WHEN, with the undated rows after the dated ones rather than
    // sorted among them at position zero. Severity breaks a tie; it never
    // decides the order, because the point of this list is the sequence.
    rows: rows.filter((f) => f.id !== root.id)
      .sort((x, y) => { const a1 = at.get(x.id).at, b1 = at.get(y.id).at;
        if (a1 && b1 && a1 !== b1) return a1 < b1 ? -1 : 1;
        if (Boolean(a1) !== Boolean(b1)) return a1 ? -1 : 1;
        return (SEV[y.severity] || 0) - (SEV[x.severity] || 0); })
      .map((f) => ({ id: f.id, detector: f.detector, severity: f.severity, title: f.title,
        occurred_at: at.get(f.id).at, occurred_via: at.get(f.id).via, occurred_bound: at.get(f.id).bound || null })),
    sources: [...new Set(rows.map((f) => f.detector))].sort(),
    size: rows.length,
    severity: [...rows].sort((x, y) => (SEV[y.severity] || 0) - (SEV[x.severity] || 0))[0].severity,
    window: times.length ? { first_seen: new Date(times[0]).toISOString(), last_seen: new Date(times[times.length - 1]).toISOString(), days: Math.round(((times[times.length - 1] - times[0]) / 86400000) * 10) / 10 } : null,
    upstream,
    // `window` is when this box NOTICED; `occurred` is when the things
    // happened. Two fields because they are two facts, and ordering a case by
    // the first one orders the scans.
    occurred: (() => {
      const ds = [...at.values()].map((o) => o.at).filter(Boolean).sort();
      return { dated: ds.length, of: rows.length,
        first: ds[0] || null, last: ds[ds.length - 1] || null,
        days: ds.length > 1 ? Math.round(((Date.parse(ds[ds.length - 1]) - Date.parse(ds[0])) / 86400000) * 10) / 10 : 0,
        via: [...new Set([...at.values()].filter((o) => o.at).map((o) => o.via))].sort() };
    })(),
    cause: entry ? { entry: entry.id, why: entry.why, op: op ? op.cmd : "", doc: entry.doc || "" } : null,
    why: { kind: kind.kind, p: kind.p, via: kind.via, steps: kind.steps },
  };
}

/** Every case on the open board, worst first.
 *
 *  `min` is 2 because one row is a finding and `bb findings` already prints
 *  those. `blind` carries what was NOT placed, which is the only thing between
 *  "there is one story here" and "one story is all that could be assembled". */
export function cases({ rows = null, min = 2, book: b = book(), head = intent.head(), clock = null } = {}) {
  const all = (rows || store.get("findings", []) || []).filter((f) => f.status === "open");
  const bySubject = new Map();
  for (const f of all) for (const s of subjects(f)) { if (!bySubject.has(s)) bySubject.set(s, []); bySubject.get(s).push(f); }
  const kept = [...bySubject.entries()].filter(([, rs]) => rs.length >= min);
  const withCases = new Set(kept.map(([s]) => s));
  // One git pass and one read of the event log for the whole board, not one per
  // case: the two sources are the same two sources for every row on it.
  const c = clock || occurred.index();
  const built = kept.map(([s, rs]) => build(s, rs, { book: b, head, subjectsWithCases: withCases, clock: c }))
    .sort((x, y) => (SEV[y.severity] || 0) - (SEV[x.severity] || 0) || y.size - x.size || x.id.localeCompare(y.id));
  const placed = new Set(kept.flatMap(([, rs]) => rs.map((f) => f.id)));
  const undated = built.reduce((n, x) => n + (x.occurred.of - x.occurred.dated), 0);
  return {
    cases: built,
    facts: { open: all.length, placed: placed.size, cases: built.length, subjects: bySubject.size,
      dated: built.reduce((n, x) => n + x.occurred.dated, 0), undated },
    blind: [
      ...(all.length - placed.size ? [`${all.length - placed.size} open row(s) name no subject shared with another row, so they are in no case; \`bb findings\` still lists them`] : []),
      // A table that exists and is not deciding is the failure a boolean hides:
      // every case still reads `fix`, and from outside that is indistinguishable
      // from a table that looked and agreed.
      ...(head && head.useful && !head.drift ? []
        : [`no case kind was decided — ${!head ? "no intent table on disk" : head.drift ? "the table's probes disagree with promptFeatures(), so it was dropped" : `the table is not useful: ${head.why}`}. \`bb intent fit\` after more sessions.`]),
      ...(b.byId.size ? [] : ["no failsafe playbook, so no case can carry a cause"]),
      ...(c.touched.size ? [] : ["git proved no dates, so no row about a file could be placed in time — an untracked tree, or no git on this box"]),
      ...(c.sessions.size ? [] : ["no session events on file, so no row about a session could be placed in time"]),
      ...(undated ? [`${undated} row(s) in a case name neither a tracked file nor a recorded session, so they are in no order`] : []),
    ],
  };
}

export function report(r, { limit = 6, rows = 5 } = {}) {
  const L = [];
  for (const c of r.cases.slice(0, limit)) {
    L.push(`  ${c.id}  ${c.severity.toUpperCase()}  ${c.subject}`);
    L.push(`    ${c.size} row(s) from ${c.sources.join(", ")}${c.window ? `, noticed over ${c.window.days} day(s)` : ""}`);
    L.push(`    when   ${c.occurred.dated ? `${c.occurred.first.slice(0, 16).replace("T", " ")} → ${c.occurred.last.slice(0, 16).replace("T", " ")} (${c.occurred.days} day(s), ${c.occurred.dated} of ${c.occurred.of} placed via ${c.occurred.via.join(", ")})` : `nothing in this case could be placed in time (${c.occurred.of} row(s))`}`);
    L.push(`    root   ${c.root.title.slice(0, 76)}  [${c.root.detector}]${c.root.occurred_at ? ` @ ${c.root.occurred_at.slice(0, 10)}` : ""}`);
    if (c.cause) L.push(`    cause  ${c.cause.why}`, `    op     ${c.cause.op}`);
    if (c.upstream.length) L.push(`    after  ${c.upstream.join(", ")} — the pipeline declares those before this one, and each has a case`);
    // The last step of a fallback is the default; the one before it is why.
    const why = c.why.via === "default" && c.why.steps.length > 1 ? c.why.steps[c.why.steps.length - 2] : c.why.steps[c.why.steps.length - 1];
    L.push(`    kind   ${c.why.kind} (${c.why.via})${c.why.p == null ? "" : ` p=${c.why.p}`} — ${why}`);
    for (const m of c.rows.slice(0, rows)) L.push(`    ${m.occurred_at ? m.occurred_at.slice(0, 10) : "  undated"}  [${m.detector}] ${m.title.slice(0, 64)}`);
    if (c.rows.length > rows) L.push(`    · ${c.rows.length - rows} more`);
    L.push("");
  }
  if (!r.cases.length) L.push("  no case: no subject is named by two open rows.");
  L.push(`  ${r.facts.cases} case(s) over ${r.facts.placed} of ${r.facts.open} open row(s), from ${r.facts.subjects} named subject(s).`);
  for (const b of r.blind) L.push(`  ? ${b}`);
  return L.join("\n");
}

export const commands = {
  case: {
    help: "every open row about one subject, with the cause the playbook names and the kind bb intent decides (no tokens)",
    usage: "bb case [--limit N] [--min N] [--json]\n     bb case <id|subject>   one case, every row",
    run: async ({ _, flags }) => {
      const r = cases({ min: Number(flags.min) || 2 });
      const want = _[0] ? String(_[0]) : "";
      if (want) {
        const c = r.cases.find((x) => x.id === want || x.id.endsWith(want) || x.subject === want || x.subject.endsWith(want));
        if (!c) { warn(`no case \`${want}\`. bb case`); return 2; }
        if (flags.json) { emit(c); return 0; }
        out(report({ ...r, cases: [c] }, { limit: 1, rows: 100 }));
        return 0;
      }
      if (flags.json) { emit(r); return 0; }
      out(report(r, { limit: Number(flags.limit) || 6 }));
      return 0;
    },
  },
};
