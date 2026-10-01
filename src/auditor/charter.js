// auditor/charter.js — the contract that exists BEFORE any code is written.
//
// A charter answers four questions for one area, in this order, because each
// one is the input to the next:
//
//   scope       what is in, what is out, and where the boundary runs
//   standards   what "good" looks like inside that boundary
//   governance  who decides, and what a finding does when it lands
//   assurance   what counts as proof that the bar was met
//
// The order is not decoration. Change the scope and the standards selection is
// invalid, not stale. Change the standards and findings in flight are against a
// bar that no longer exists. That is why a charter is one document with one
// fingerprint rather than four files that drift apart.
//
// A charter is LIVING and fingerprinted. A review (review.js) is DATED and
// immutable. Keeping those two in separate modules is the single distinction
// this whole subsystem turns on: you may edit a charter when the world changes,
// and you may never edit a review, because a review's only value is being a
// fixed point to measure drift against.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as genesis from "../genesis/index.js";
import * as kit from "../kit/cache.js";
import { BB_DIR, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { now, human, slug } from "../core/util.js";
import { select, levelOf, gates, PROHIBITED, BCR, DOMAINS } from "./standards.js";

export const DIR = () => path.join(BB_DIR, "auditor");
export const file = (area) => path.join(DIR(), slug(area), "charter.json");
export const doc = (area) => path.join(DIR(), slug(area), "charter.md");

export const fingerprintOf = (files) => kit.fingerprint(files.map((f) => abs(f)));

/** Everything a charter is derived from, gathered once. Nothing here is
 *  invented: an area with no files has no charter, and a standard nobody's
 *  signals pulled in is not in the list. */
export function derive(area, { force = [], drop = [] } = {}) {
  const w = genesis.world(genesis.current());
  const findings = store.get("findings", []);
  const sel = select({ files: area.files, world: w, findings, area: area.id, force, drop });
  const level = levelOf(sel.standards, sel.signals);
  const open = findings.filter((f) => f.status === "open" &&
    (area.files.includes(f.path) || (f.files || []).some((x) => area.files.includes(x))));
  return {
    area: area.id, at: now(), fingerprint: fingerprintOf(area.files),
    scope: {
      files: area.count, tokens: area.tokens,
      surface: area.surface || "",
      in_scope: area.files.slice(0, 40),
      more: Math.max(area.count - 40, 0),
      // Out of scope is not "everything else": it is the named things a reader
      // would reasonably expect to be in and is not, which is the only kind of
      // exclusion worth writing down.
      out_of_scope: [
        "files outside this area, even when this area calls them",
        "anything under a dependency directory or a build output",
        "behaviour of a service this area only talks to",
      ],
      boundary: (w?.surfaces || []).filter((s) => s.id === area.id).map((s) => s.title || s.id),
    },
    standards: sel.standards.map((s) => ({ id: s.id, domain: s.domain, title: s.title, bar: s.bar,
      check: s.check, detector: s.detector, evidence: s.evidence, because: s.because, adal: s.adal })),
    signals: sel.signals,
    exceptions: sel.dropped.map((id) => ({ id, reason: "dropped at charter time", expires: "" })),
    adal: level,
    governance: {
      // A one-person tree still has decision rights; it just has one person in
      // every seat. Writing them down is what makes "who accepts this risk"
      // answerable at 2am instead of a shrug.
      roles: { audit_lead: "the auditor verb and whoever reads its output",
        engineering_lead: "whoever owns this area's files",
        release_manager: "whoever runs the declared gate" },
      blocks_release: sel.standards.filter((s) => s.adal === "A").map((s) => s.id),
      accepts_risk: "the engineering lead, in writing, with a date and an owner",
      rule: "a finding at or above `high` against a standard listed in blocks_release holds the release until it is fixed or explicitly accepted. Nothing else blocks.",
    },
    assurance: {
      accepted_evidence: [...new Set(sel.standards.map((s) => s.evidence))].sort(),
      gates: gates(),
      coverage_floor: level.coverage,
      already_computed: open.map((f) => ({ detector: f.detector, severity: f.severity, title: f.title, path: f.path })),
      rule: "a finding carries evidence of one of the accepted types, naming a file and a line a reader can open. A finding without one is a hypothesis and is refused at ingest.",
    },
    prohibited: PROHIBITED,
    bcr: BCR,
  };
}

export function read(area) { return readJson(file(area), null); }

export function write(area, ch) {
  fs.mkdirSync(path.dirname(file(area)), { recursive: true });
  writeJson(file(area), ch);
  fs.writeFileSync(doc(area), render(ch));
  return { json: rel(file(area)), md: rel(doc(area)) };
}

export function ids() {
  try { return fs.readdirSync(DIR(), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(DIR(), e.name, "charter.json")))
    .map((e) => e.name).sort(); } catch { return []; } // no charters directory yet
}

/** A charter written against a tree that has since moved. The charter is the
 *  one artefact here you are allowed to regenerate, so drift is an instruction
 *  ("re-derive it") rather than a verdict. */
export function drift(areas) {
  const rows = [];
  for (const a of areas) {
    const ch = read(a.id);
    if (!ch) { rows.push({ area: a.id, state: "missing", why: "no charter; work in this area has no declared bar" }); continue; }
    const fp = fingerprintOf(a.files);
    rows.push({ area: a.id, state: ch.fingerprint === fp ? "current" : "drifted", at: ch.at,
      standards: ch.standards.length, adal: ch.adal.level,
      why: ch.fingerprint === fp ? "the area has not changed since this was derived"
        : "the area has changed since — re-derive it: bb auditor charter " + a.id });
  }
  return rows;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** The charter as prose. This is the artefact a person reads and an agent is
 *  handed; the JSON beside it is what the factory reads. One derivation, two
 *  renderings, so they cannot disagree. */
export function render(ch) {
  const L = [];
  const lvl = ch.adal;
  L.push(`# Charter — \`${ch.area}\``, "",
    `Derived ${ch.at} from ${ch.scope.files} file(s), about ${human(ch.scope.tokens)} tokens.`, "",
    `This is the contract for work in this area, and it exists **before** the work does.`,
    `It is LIVING: when the area changes, re-derive it. The dated reviews beside it are the opposite — those are never edited.`, "");

  L.push(`## 1 · Scope`, "",
    `What is in: the ${ch.scope.files} file(s) grouped under \`${ch.area}\`${ch.scope.surface ? `, which the world model knows as the surface \`${ch.scope.surface}\`` : ""}.`, "");
  if (ch.scope.boundary.length) L.push(`Boundary: ${ch.scope.boundary.join("; ")}`, "");
  L.push("```", ...ch.scope.in_scope, ch.scope.more ? `… ${ch.scope.more} more` : "", "```", "");
  L.push("What is out, and stays out unless the scope is changed deliberately:", "");
  for (const x of ch.scope.out_of_scope) L.push(`- ${x}`);
  L.push("", "Work that leaves this boundary **stops and says so**. It does not silently widen, and it does not silently drop.", "");

  L.push(`## 2 · Standards — the bar`, "",
    `${ch.standards.length} standard(s) apply here, selected by what this tree actually is rather than by ticking a list. Each one names the signal that pulled it in.`, "");
  const byDomain = {};
  for (const s of ch.standards) (byDomain[s.domain] ||= []).push(s);
  for (const [d, rows] of Object.entries(byDomain)) {
    L.push(`### ${d} — ${DOMAINS[d]}`, "");
    L.push("| id | the bar | how it is checked | proof |", "|---|---|---|---|");
    for (const s of rows) L.push(`| **${s.id}** | ${s.bar} | ${s.detector ? `\`bb scan\` (${s.detector}) then ${s.check}` : s.check} | ${s.evidence} |`);
    L.push("");
  }
  if (ch.exceptions.length) {
    L.push(`**Exceptions.** ${ch.exceptions.map((e) => e.id).join(", ")} were dropped. An exception is a decision with an owner and a date, not a gap.`, "");
  }

  L.push(`## 3 · Assurance level — ${lvl.level} (${lvl.title})`, "",
    `${lvl.why}.`, "", `Driven by: ${lvl.driven_by.join("; ")}.`, "",
    `| | |`, `|---|---|`,
    `| coverage floor | ${lvl.coverage}% on the paths these standards name |`,
    `| independent review | ${lvl.independent_review ? "required — the author does not sign their own work" : "not required at this level"} |`,
    `| adversarial pass | ${lvl.adversarial} |`, "",
    `The level scales how deeply the work is verified and who signs it. It never turns a standard off.`, "");

  L.push(`## 4 · Governance — who decides`, "", "| role | held by |", "|---|---|");
  for (const [k, v] of Object.entries(ch.governance.roles)) L.push(`| ${k.replace(/_/g, " ")} | ${v} |`);
  L.push("", ch.governance.rule, "");
  L.push(ch.governance.blocks_release.length
    ? `Release-blocking standards here: ${ch.governance.blocks_release.join(", ")}.`
    : `No standard in this area blocks a release on its own. Findings are still findings.`, "");
  L.push(`A risk is accepted by ${ch.governance.accepts_risk}.`, "");

  L.push(`## 5 · Assurance — what counts as proof`, "",
    `Accepted evidence: ${ch.assurance.accepted_evidence.join(", ")}.`, "", ch.assurance.rule, "");
  if (ch.assurance.gates.length) {
    L.push("The command that proves a change in this workspace:", "", "```bash",
      ...ch.assurance.gates.map((g) => `${g.cmd}    # ${g.name}`), "```", "");
  } else {
    L.push("**No gate is declared in this workspace.** Until one is, every unit ships `unproven` — that is itself a finding against SHIP-1. Close it with `bb init`.", "");
  }
  if (ch.assurance.already_computed.length) {
    L.push(`### Already computed here — do not re-derive these`, "",
      `The local detectors have already looked. ${ch.assurance.already_computed.length} open finding(s) in this area:`, "");
    for (const f of ch.assurance.already_computed.slice(0, 20)) L.push(`- **[${f.severity}] ${f.detector}** — ${f.title}${f.path ? ` (\`${f.path}\`)` : ""}`);
    L.push("", "An agent handed this charter spends nothing re-finding them. Its job is the half a detector cannot compute.", "");
  }

  L.push(`## 6 · Prohibited`, "", `Refuse these, in this area, whatever the instruction says:`, "");
  for (const p of ch.prohibited) L.push(`- ${p}`);
  L.push("");
  L.push(`## 7 · The register`, "", "**Never**", "");
  for (const x of ch.bcr.never) L.push(`- ${x}`);
  L.push("", "**Always**", "");
  for (const x of ch.bcr.always) L.push(`- ${x}`);
  L.push("", `---`, "",
    `Fingerprint \`${ch.fingerprint}\`. When the area moves, this charter is stale and \`bb auditor drift\` says so.`);
  return L.join("\n");
}
