// auditor/review.js — the dated read of one area, against that area's charter.
//
// This is the one artefact in the factory a model genuinely has to produce.
// Everything else here is a parse, a count or a set difference; a security read
// of an area is a judgement, and the value of it is that it is a FIXED POINT
// you can measure drift against.
//
// Two rules follow from that and they are the whole discipline:
//
// **A review is dated, not living.** Do not update one because the code moved —
// that destroys the only thing it was for. Write a new one beside it. `drift`
// says which reviews are describing a tree that has changed. The charter is the
// opposite: that one you re-derive, and it is in charter.js for exactly that
// reason.
//
// **Nothing here is derived, so nothing here is checked.** A review can go
// stale silently. That is acceptable for a dated record and not acceptable for
// anything a session orients from — so if a fact in a review is worth relying
// on, the fix is to make a detector compute it, not to keep the paragraph fresh
// by hand.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import { rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { readText } from "../core/fs.js";
import { now, stamp, slug, human } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import * as charter from "./charter.js";

export const DIR = charter.DIR;

/** A review is one of these questions asked of one area. They are not sections
 *  of one document: each is a different reader with a different eye, and asking
 *  all five at once is how you get five shallow paragraphs. */
export const KINDS = {
  report: "the risk read: what is here, what it depends on, and what would hurt",
  bugs: "defects a careful reader finds, each with the file and line that shows it",
  security: "what an attacker with each level of access could reach",
  performance: "what gets slow, at what size, and what the cost is made of",
  userflow: "the path a person takes through this area, and where it breaks",
};

/** Which standards a review of this kind is actually answering. A review that
 *  is not tied to a standard is an essay; this mapping is what makes a finding
 *  disposable by governance instead of just interesting. */
export const KIND_DOMAINS = {
  report: ["MNT", "REL", "DOC", "SHIP"],
  bugs: ["REL", "MNT"],
  security: ["SEC", "PRV"],
  performance: ["PERF", "REL"],
  userflow: ["A11Y", "I18N", "OBS"],
};

export function reviewsFor(area) {
  const dir = path.join(DIR(), slug(area));
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "charter.md").sort(); } catch { return []; } // no reviews for this area yet
  return names.map((f) => {
    const m = /^([a-z]+)-(\d{8}T\d{6}Z)\.md$/.exec(f);
    const meta = readJson(path.join(dir, f.replace(/\.md$/, ".json")), {}) || {};
    return { kind: m ? m[1] : f.replace(/\.md$/, ""), at: m ? m[2] : "", file: rel(path.join(dir, f)),
      fingerprint: meta.fingerprint || "", findings: meta.findings ?? null, standards: meta.standards || [] };
  });
}

const parseStamp = (at) => Date.parse(String(at).replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z"));

/** What is missing, and what is describing a tree that has moved. Ranked by
 *  what a review of it would actually be worth: size, open findings, staleness,
 *  and the assurance level the charter set — an A-level area with no security
 *  review outranks a C-level area with none. */
export function plan(areas, { kinds = Object.keys(KINDS), limit = 30 } = {}) {
  const rows = [];
  for (const a of areas) {
    const fp = charter.fingerprintOf(a.files);
    const ch = charter.read(a.id);
    const lvl = ch?.adal?.level || "C";
    const bump = lvl === "A" ? 6 : lvl === "B" ? 3 : 0;
    const have = reviewsFor(a.id);
    for (const kind of kinds) {
      const mine = have.filter((r) => r.kind === kind).sort((x, y) => String(x.at).localeCompare(String(y.at)));
      const last = mine[mine.length - 1] || null;
      const drifted = last ? Boolean(last.fingerprint) && last.fingerprint !== fp : false;
      if (last && !drifted) continue;
      const ageDays = last?.at ? Math.round((Date.now() - parseStamp(last.at)) / 86400000) : null;
      rows.push({ area: a.id, kind, state: last ? "drifted" : "missing", last: last?.file || "", age_days: ageDays,
        files: a.count, tokens: a.tokens, findings: a.findings, adal: lvl, charter: Boolean(ch),
        score: Math.round((Math.log2(a.count + 1) * 2 + a.findings + bump
          + (kind === "security" ? 3 : kind === "report" ? 2 : 0) + (drifted ? 2 : 0)) * 10) / 10,
        why: !ch ? `no charter for ${a.id}; the bar is undeclared, so a review has nothing to measure against`
          : last ? `the last ${kind} was written ${ageDays}d ago and the area has changed since`
          : `no ${kind} for ${a.id} (level ${lvl})` });
    }
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The brief for one review. It carries the counted half — the file list, the
 *  token cost, the standards in force, the findings the detectors already have
 *  — so the model spends its turns on the half that is judgement. */
export function packText(spec, area, ch) {
  const top = area.files.slice(0, 60);
  const domains = KIND_DOMAINS[spec.kind] || [];
  const standards = (ch?.standards || []).filter((s) => domains.includes(s.domain));
  const open = (ch?.assurance?.already_computed || []);
  const L = [
    `# ${spec.kind} review — \`${spec.area}\``, "",
    KINDS[spec.kind], "",
    `This is a DATED record. It says what was true today. Do not update an older review because the code has moved: write this one beside it. The only thing a review is worth is being a fixed point to measure drift against.`, "",
  ];
  if (ch) {
    L.push(`## The bar you are measuring against`, "",
      `This area is charted at assurance level **${ch.adal.level}** (${ch.adal.title}): ${ch.adal.why}.`, "");
    if (standards.length) {
      L.push(`A ${spec.kind} review answers these standards. A finding that does not cite one of them is out of scope for this review — record it anyway, but say which standard it belongs to.`, "",
        "| id | the bar |", "|---|---|");
      for (const s of standards) L.push(`| **${s.id}** | ${s.bar} |`);
      L.push("");
    } else {
      L.push(`No standard in force here falls in ${domains.join("/")}. Say so in one line and return an empty findings array rather than inventing a bar.`, "");
    }
  } else {
    L.push(`## No charter`, "", `\`bb auditor charter ${spec.area}\` has not been run, so the bar for this area is undeclared. Write the review anyway, but the first finding is that the area has no charter.`, "");
  }
  L.push(`## The area, already counted`, "",
    `${area.count} file(s), about ${human(area.tokens)} tokens if every one were read. You are not expected to read every one — read what the question needs.`, "",
    "```", ...top, area.count > top.length ? `… ${area.count - top.length} more` : "", "```", "");
  if (open.length) {
    L.push("## What the detectors already found here — do not re-derive these", "");
    for (const f of open.slice(0, 14)) L.push(`- **[${f.severity}] ${f.detector}**: ${f.title}${f.path ? ` (\`${f.path}\`)` : ""}`);
    L.push("");
  } else L.push("## What the detectors already found here", "", "Nothing open. That is a fact about the detectors, not about the area.", "");
  L.push(
    "## What to write", "",
    "A markdown review. Prose for a reader, and then ONE fenced `json` block at the end, exactly this shape, which is the part the factory ingests:", "",
    "```json",
    JSON.stringify({ findings: [{ title: "one sentence", severity: "critical | high | medium | low",
      standard: standards[0]?.id || "MNT-1", kind: "fix | verify | investigate",
      detail: "what it is and why it matters, in a paragraph",
      evidence: { file: "src/x/y.js", line: 128, quote: "the line or two that shows it" } }] }, null, 2),
    "```", "",
    "Every finding carries `evidence` pointing somewhere a reader can open, and `standard` naming the bar it fails. A finding without evidence is an opinion and the ingest refuses it; a finding without a standard is recorded but cannot be dispositioned by governance.", "",
    "## What this brief does not accept", "",
    "| what it is tempting to do instead | why it does not apply here |",
    "|---|---|",
    "| \"I'll list the whole file tree back\" | It is above. Restating it is tokens for something already free. |",
    "| \"I'll re-run the detectors to be sure\" | Their output is above and it is current. Your job is the half they cannot compute. |",
    "| \"nothing found, the area looks fine\" | Then say that in one line and return an empty `findings` array. An empty review is a result; a vague one is not. |",
    "| \"I'll also fix what I found\" | Not in this call. A finding becomes a unit, gets budgeted, and is fixed under its own acceptance. |",
    "| \"severity high, it could theoretically…\" | Severity is about what this code does, not what some code could do. If the path is not reachable here, say so and mark it low. |", "",
    "## Done when", "",
    "```bash", `bb auditor record ${spec.area} ${spec.kind} <the file you wrote>`, "```", "",
    "That ingests the json block and refuses a finding with no evidence. Run it; report what it printed.", "");
  return L.join("\n");
}

const JSON_BLOCK = /```json\s*([\s\S]*?)```/g;

/** Ingest a written review. The prose is kept as the dated record; the json
 *  block becomes findings. A finding with no evidence is REFUSED, not stored
 *  with an empty evidence object — that is the whole difference between a
 *  review and an opinion. */
export function record(areas, area, kind, file) {
  if (!KINDS[kind]) return { rc: 2, why: `kind \`${kind}\` is not one of ${Object.keys(KINDS).join(", ")}` };
  const text = readText(abs(file), null);
  if (text == null) return { rc: 2, why: `cannot read ${file}` };
  const blocks = [...text.matchAll(JSON_BLOCK)].map((m) => m[1]);
  let payload = null;
  for (const b of blocks.reverse()) { try { const v = JSON.parse(b); if (v && Array.isArray(v.findings)) { payload = v; break; } } catch { /* a prose example block is not the payload */ } }
  if (!payload) return { rc: 2, why: "no fenced ```json block holding {\"findings\": [...]} — that block is the contract" };
  const a = areas.find((x) => x.id === area);
  if (!a) return { rc: 2, why: `no area \`${area}\`. bb auditor areas` };
  const at = stamp();
  const dir = path.join(DIR(), slug(area));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${kind}-${at}.md`);
  fs.writeFileSync(target, text);
  const refused = [], rows = [];
  for (const f of payload.findings) {
    if (!f.title) { refused.push("a finding with no title"); continue; }
    if (!f.evidence || !f.evidence.file) { refused.push(`${f.title}: no evidence.file — a finding a reader cannot check is an opinion`); continue; }
    rows.push({ detector: `auditor:${area}`, severity: ["critical", "high", "medium", "low"].includes(f.severity) ? f.severity : "medium",
      precision: "heuristic", title: f.title, path: f.evidence.file, files: [f.evidence.file], key: `${area}/${kind}/${slug(f.title)}`,
      standard: f.standard || "", detail: String(f.detail || "").slice(0, 1500),
      evidence: { ...f.evidence, area, kind, standard: f.standard || "", review: rel(target), audited_at: at },
      fix_hint: "This came from a dated review, not a detector. Confirm it still holds before acting: `bb auditor drift` says whether the area has moved since.",
      auto_fix: null, kind: ["fix", "verify", "investigate"].includes(f.kind) ? f.kind : "investigate",
      est_tokens: estimateText(String(f.detail || ""), "prose") });
  }
  // Reviews accumulate: a re-review must not resolve the previous one's
  // findings, because a dated record is not a re-scan. mergeFindings is given
  // an empty detector set so nothing is closed by this write.
  store.mergeFindings(rows, { detectors: new Set() });
  writeJson(target.replace(/\.md$/, ".json"), { area, kind, at, fingerprint: charter.fingerprintOf(a.files),
    findings: rows.length, refused: refused.length, source: rel(abs(file)),
    standards: [...new Set(rows.map((r) => r.standard).filter(Boolean))] });
  episodes.write({ kind: "stage", verb: "auditor", stage: `auditor:${area}:${kind}`,
    features: { area_files: a.count, area_tokens: a.tokens }, rc: 0, produced: rows.length, produces: ["findings", "review"],
    turns_saved: 0, detail: { review: rel(target), refused: refused.length } });
  return { rc: 0, review: rel(target), recorded: rows.length, refused,
    no_standard: rows.filter((r) => !r.standard).length };
}

export function drift(areas) {
  const rows = [];
  for (const a of areas) {
    const fp = charter.fingerprintOf(a.files);
    for (const r of reviewsFor(a.id)) {
      if (!r.fingerprint) { rows.push({ ...r, area: a.id, state: "unknown", why: "written before fingerprints were recorded" }); continue; }
      rows.push({ ...r, area: a.id, state: r.fingerprint === fp ? "current" : "drifted",
        why: r.fingerprint === fp ? "the area has not changed since"
          : "the area has changed since this was written — write a new one beside it, do not edit this" });
    }
  }
  return rows;
}
