// pinpoint/worklist.js — the audit finds it, pinpoint locates it, the agent
// only judges it.
//
// The three verbs that measure this tree all stop one step short of the window.
// `bb scan` writes findings. `bb oversight scan` measures the tree against its
// own medians and writes more. `bb auditor gate` says which declared standard
// has evidence and which nobody has looked at. All three produce a STATEMENT
// about the tree, and then a session reads that statement and spends its first
// turns finding out where it lives — which is the one thing in this box that is
// free.
//
// So the worklist joins them. Every gap becomes a located, quoted, budgeted
// brief before any model sees it, and `next` makes one of them the session's
// active brief, which is the record the PreToolUse guards answer from. What the
// agent is left with is the only part a model is needed for: judgement, and the
// diff.
//
// Nothing here decides whether a gap is real. `unproven` is not `failed`: a
// standard nobody has looked at is a gap in the EVIDENCE, and the brief says
// so, because a worklist that quietly promotes "nobody looked" to "this is
// broken" is the exact failure the auditor exists to remove.
import fs from "node:fs";
import path from "node:path";
import { rel } from "../core/paths.js";
import { out, emit, warn } from "../core/log.js";
import { human, now } from "../core/util.js";
import * as store from "../core/store.js";
import { DIR, build } from "./index.js";

export const FILE = () => path.join(DIR, "WORKLIST.md");
export const STATE = () => path.join(DIR, "worklist.json");

/** Severity order, and what an auditor state is worth beside it. A blocking
 *  standard that FAILED outranks any detector finding: it is the one gap the
 *  workspace declared, in advance, that it would not ship past. */
const SEV = { blocking: 0, critical: 1, high: 2, medium: 3, low: 4, unproven: 5 };
/** At equal severity, the concrete gap comes before the summary of it. An
 *  auditor row that failed on three dead-exports findings is a restatement of
 *  three rows that are themselves the work; ordering the summary first fills
 *  the worklist with descriptions of its own tail. */
const SRC = { scan: 0, oversight: 0, auditor: 1 };
const order = (a, b) => (SEV[a.severity] ?? 5) - (SEV[b.severity] ?? 5) || (SRC[a.source] ?? 1) - (SRC[b.source] ?? 1) || String(a.id).localeCompare(String(b.id));

// ── where the gaps come from ────────────────────────────────────────────────

/** Open findings, as issues. This is the detector half and the oversight half
 *  at once: `bb oversight scan --write` merges into the same store. */
export function fromFindings(limit = 0) {
  const rank = (f) => SEV[f.severity] ?? 4;
  const rows = store.openFindings()
    .sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)))
    .map((f) => ({
      source: f.detector?.startsWith("oversight:") ? "oversight" : "scan",
      id: f.id,
      severity: f.severity || "medium",
      statement: String(f.title || f.detector || "finding").slice(0, 300),
      hint: String(f.fix_hint || "").slice(0, 200),
      files: [...new Set([f.path, ...(f.files || [])].filter(Boolean))],
      kind: "fix",
      acceptance: f.acceptance || "",
    }));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** Every charted area's standards that failed or that nobody has evidence for.
 *
 *  Lazily imported: the auditor pulls in the standards menu, the charter store
 *  and genesis, and a worklist run that was asked for findings only should not
 *  pay for them. */
export async function fromAuditor({ areas = [] } = {}) {
  let auditor;
  try { auditor = await import("../auditor/index.js"); } catch { return []; }
  const ids = areas.length ? areas : auditor.charter.ids();
  const all = auditor.areas();
  const open = store.openFindings();
  const rows = [];
  for (const id of ids) {
    const g = auditor.gate(id);
    if (g.rc !== 0) continue;
    const area = auditor.areaOf(id, all);
    const inArea = new Set(area ? area.files : []);
    for (const s of g.standards) {
      if (s.state === "met") continue;
      const blocks = g.blocking.includes(s.id);
      // The scope of a FAILED standard is the files of the findings that failed
      // it, not the area. Handing over the whole directory is what made every
      // row in the first run of this cost 122k tokens and locate no region at
      // all: an area is where the gap was measured, and the finding is where it
      // is. For an UNPROVEN standard there are no such files — nobody has
      // looked — so the area stands, capped, and the statement carries the
      // terms pinpoint ranks on.
      const detectors = String(s.detector || "").split(",").filter(Boolean);
      const cause = detectors.length
        ? open.filter((f) => detectors.includes(f.detector) && (inArea.has(f.path) || (f.files || []).some((x) => inArea.has(x))))
        : [];
      const files = cause.length
        ? [...new Set(cause.flatMap((f) => [f.path, ...(f.files || [])]).filter(Boolean))].slice(0, 6)
        : (area ? area.files.slice(0, 4) : []);
      rows.push({
        source: "auditor",
        id: `${id}/${s.id}`,
        severity: s.state === "failed" ? (blocks ? "blocking" : "high") : "unproven",
        // The statement is what the standard asks for, not a diagnosis. A
        // brief that opens by asserting a defect nobody has evidence for has
        // already lost the argument it exists to hold.
        statement: s.state === "failed"
          ? `${id}: ${s.title || s.id} does not hold — ${s.why}`
          : `${id}: ${s.title || s.id} has no evidence either way — ${s.why}`,
        hint: s.state === "failed" ? `close the finding(s) named above, then re-run \`bb auditor gate ${id}\`` : `produce the evidence ${s.evidence || "this standard asks for"}, or write the review that cites ${s.id}`,
        files,
        causes: cause.map((f) => f.id),
        kind: s.state === "failed" ? "fix" : "verify",
        acceptance: `bb auditor gate ${id}`,
        standard: s.id,
        area: id,
        state: s.state,
      });
    }
  }
  return rows.sort(order);
}

// ── the queue ───────────────────────────────────────────────────────────────

/** One issue -> one brief. The issue's files go in as EXPLICIT, so the ranker
 *  pins them and the cut loop drops them last; the statement still drives the
 *  terms, so pinpoint can add the file the issue did not know about. */
export async function brief(issue, { maxFiles = 6 } = {}) {
  const b = await build(issue.statement, {
    files: (issue.files || []).slice(0, 8),
    maxFiles,
    kind: issue.kind || "fix",
  });
  return { ...issue, brief: b.path, verdict: b.verdict, projected: b.projected, scope: b.scope, anchors: b.anchors.length, evidence: b.evidence.length };
}

export async function compile({ findings = true, auditor = true, max = 12, maxFiles = 6, areas = [] } = {}) {
  const issues = [
    ...(auditor ? await fromAuditor({ areas }) : []),
    ...(findings ? fromFindings() : []),
  ].sort(order).slice(0, Math.max(1, max));
  const rows = [];
  for (const issue of issues) {
    try { rows.push(await brief(issue, { maxFiles })); }
    catch (e) { rows.push({ ...issue, brief: "", verdict: "ERROR", projected: 0, scope: [], anchors: 0, evidence: 0, error: String(e && e.message || e).slice(0, 160) }); }
  }
  const doc = { at: now(), count: rows.length, rows };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE(), JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(FILE(), render(doc));
  return doc;
}

export function latest() {
  try { return JSON.parse(fs.readFileSync(STATE(), "utf8")); } catch { return null; }
}

export function render(doc) {
  const L = ["# pinpoint worklist — every measured gap, located before a model sees it", "",
    `Built ${doc.at} from the stored scans. Each row is a brief that already holds the files, the`,
    "quoted regions, the budget and the acceptance command. `bb pinpoint next` makes the top one the",
    "session's active brief, and the read and search guards answer from it.", "",
    "| # | source | severity | projected | verdict | gap | brief |",
    "|---|---|---|---|---|---|---|"];
  doc.rows.forEach((r, i) => L.push(`| ${i + 1} | ${r.source} | ${r.severity} | ${r.projected ? human(r.projected) : "-"} | ${r.verdict} | ${r.statement.replace(/\|/g, "/").slice(0, 110)} | ${r.brief || r.error || "-"} |`));
  if (!doc.rows.length) L.push("| - | - | - | - | - | nothing measured is open: `bb scan`, `bb oversight scan --write`, `bb auditor charter <area>` | - |");
  return L.join("\n") + "\n";
}

/** Make one row the session's active brief. The number is the row in the
 *  worklist, one-based, because that is what the table prints. */
export async function next({ n = 1, sessionId = "" } = {}) {
  const doc = latest();
  if (!doc || !doc.rows.length) return { rc: 2, why: "no worklist; run `bb pinpoint gaps`" };
  const row = doc.rows[n - 1];
  if (!row) return { rc: 2, why: `no row ${n}; the worklist has ${doc.rows.length}` };
  // Rebuilt, not read back. The brief on disk is a document; the guards need
  // the record, and the tree may have moved since the row was written.
  const b = await build(row.statement, { files: (row.files || []).slice(0, 8), kind: row.kind || "fix" });
  const wire = await import("../wire/brief.js");
  const rec = wire.record(b, { sessionId, briefPath: b.path });
  wire.activate(rec);
  return { rc: 0, row, brief: b, record: rec };
}

export const commands = {
  gaps: {
    help: "every measured gap as a located brief: findings, oversight, auditor standards (no tokens)",
    usage: "bb pinpoint gaps [--no-findings] [--no-auditor] [--areas a,b] [--max N] [--max-files N] [--json]",
    run: async ({ flags }) => {
      const doc = await compile({
        findings: flags.findings !== false,
        auditor: flags.auditor !== false,
        areas: typeof flags.areas === "string" ? flags.areas.split(",").map((s) => s.trim()).filter(Boolean) : [],
        max: Number(flags.max) || 12,
        maxFiles: Number(flags.maxFiles) || 6,
      });
      if (flags.json) { emit(doc); return 0; }
      out(`  WORKLIST — ${doc.count} gap${doc.count === 1 ? "" : "s"} located, 0 model tokens`);
      for (const [i, r] of doc.rows.entries()) out(`  ${String(i + 1).padStart(2)}. [${r.source}/${r.severity}] ${r.statement.slice(0, 84)}\n      ${r.scope.length} files, ${r.anchors} regions, ~${human(r.projected)} ${r.verdict}  ${r.brief}`);
      out(`\n  wrote ${rel(FILE())}\n  \`bb pinpoint next\` makes row 1 the active brief; the read and search guards then answer from it.`);
      return 0;
    },
  },
  next: {
    help: "make a worklist row the session's active brief, so the guards serve it",
    usage: "bb pinpoint next [N] [--session ID] [--print] [--json]",
    run: async ({ _, flags }) => {
      const r = await next({ n: Number(_[0]) || 1, sessionId: flags.session ? String(flags.session) : "" });
      if (r.rc) { warn(r.why); return r.rc; }
      if (flags.json) { emit({ row: r.row, brief: r.brief.path, verdict: r.brief.verdict, scope: r.brief.scope }); return 0; }
      out(`  ACTIVE — [${r.row.source}/${r.row.severity}] ${r.row.statement.slice(0, 100)}`);
      out(`  ${r.brief.scope.length} files, ${r.brief.anchors.length} regions, ~${human(r.brief.projected)} of ${human(r.brief.ceiling)} ${r.brief.verdict}`);
      out(`  brief: ${r.brief.path}`);
      if (flags.print) out("", r.brief.prompt.trimEnd());
      return 0;
    },
  },
};
