// auditor/index.js — the governance verb: what good looks like here, declared
// before the work, and checked after it.
//
// The factory's other verbs all answer "what is wrong with what was written".
// This one answers the question that comes first — what is in scope, what bar
// does it have to meet, who decides when it does not, and what counts as proof
// — and it answers it while changing the code is still cheap.
//
//   bb auditor areas       the tree's own areas, their size, and what is charted
//   bb auditor standards   the menu, and which rows this tree's signals pull in
//   bb auditor charter <a> derive the scope / standards / governance / assurance contract
//   bb auditor brief <a>   the instruction pack handed over before the first edit
//   bb auditor gate <a>    which standards now have evidence, and which do not
//   bb auditor plan        which areas have no charter, and which reviews have drifted
//   bb auditor pack        one review brief per area and kind, carrying the counted half
//   bb auditor record      ingest a written review as findings
//   bb auditor drift       which charters and reviews describe a tree that has moved
//
// The split that everything here turns on: a CHARTER is living and is
// re-derived when the area moves; a REVIEW is dated and is never edited. Mixing
// those two destroys the only thing a review is for.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as genesis from "../genesis/index.js";
import { walk } from "../core/fs.js";
import { VAR, ROOT, rel, abs } from "../core/paths.js";
import { files as estimateFiles } from "../tokens/estimate.js";
import * as standards from "./standards.js";
import * as charter from "./charter.js";
import * as brief from "./brief.js";
import * as review from "./review.js";

export { standards, charter, brief, review };
export const DIR = charter.DIR;
export const KINDS = review.KINDS;

/** Areas are the tree's own top-level source groupings, joined to the world's
 *  surfaces where the two agree. Nothing is invented: an area with no files is
 *  not an area. */
export function areas() {
  const all = walk(ROOT);
  const groups = new Map();
  for (const f of all) {
    const r = rel(f);
    const parts = r.split("/");
    // src/foo/bar.js -> "foo"; foo/bar.js -> "foo"; bar.js -> "(root)"
    const key = parts.length >= 3 && /^(src|lib|app|packages|apps|internal|pkg)$/.test(parts[0]) ? parts[1]
      : parts.length >= 2 ? parts[0] : "(root)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const w = genesis.world(genesis.current());
  const surfaces = new Set((w?.surfaces || []).map((s) => s.id));
  const open = store.get("findings", []).filter((f) => f.status === "open");
  const rows = [];
  for (const [id, files] of groups) {
    if (files.length < 2) continue;
    const est = estimateFiles(files.map((f) => abs(f)));
    const ch = charter.read(id);
    rows.push({ id, files, count: files.length, tokens: est.total,
      surface: surfaces.has(id) ? id : "",
      findings: open.filter((f) => files.includes(f.path) || (f.files || []).some((x) => files.includes(x))).length,
      charter: ch ? { at: ch.at, adal: ch.adal.level, standards: ch.standards.length,
        drifted: Boolean(ch.fingerprint) && ch.fingerprint !== charter.fingerprintOf(files) } : null,
      reviews: review.reviewsFor(id) });
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

export const areaOf = (id, all = areas()) => all.find((a) => a.id === id) || null;

/** Derive and write a charter. Returns the charter so a caller can render it
 *  without reading the file back. */
export function charterFor(id, { force = [], drop = [], write = true } = {}) {
  const a = areaOf(id);
  if (!a) return { rc: 2, why: `no area \`${id}\`. bb auditor areas` };
  const ch = charter.derive(a, { force, drop });
  const files = write ? charter.write(id, ch) : null;
  return { rc: 0, charter: ch, ...(files || {}) };
}

// ── the gate ────────────────────────────────────────────────────────────────

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

/** Does this area currently have evidence for each standard in force?
 *
 *  Three verdicts and they are deliberately not two. `met` means something on
 *  disk supports it. `failed` means something on disk contradicts it. `unproven`
 *  means nobody looked — and an unproven standard reported as met is the exact
 *  failure this whole tree exists to remove, so it never collapses into `met`.
 */
export function gate(id) {
  const a = areaOf(id);
  if (!a) return { rc: 2, why: `no area \`${id}\`. bb auditor areas` };
  const ch = charter.read(id);
  if (!ch) return { rc: 2, why: `no charter for \`${id}\`. bb auditor charter ${id}` };
  const fp = charter.fingerprintOf(a.files);
  const open = store.get("findings", []).filter((f) => f.status === "open" &&
    (a.files.includes(f.path) || (f.files || []).some((x) => a.files.includes(x))));
  const scannedAt = mtime(path.join(VAR, "findings.json"));
  const scanFresh = scannedAt && (Date.now() - scannedAt) / 3600000 < 24;
  const reviews = review.reviewsFor(id).filter((r) => !r.fingerprint || r.fingerprint === fp);
  const citedStandards = new Set(reviews.flatMap((r) => r.standards || []));
  const gatesDeclared = ch.assurance.gates.length > 0;

  const rows = ch.standards.map((s) => {
    const detectors = (s.detector || "").split(",").filter(Boolean);
    if (detectors.length) {
      if (!scanFresh) return { ...s, state: "unproven", why: scannedAt ? `\`bb scan\` last ran ${Math.round((Date.now() - scannedAt) / 3600000)}h ago; the detector that checks this is describing a tree that has moved` : "`bb scan` has never run here" };
      const hits = open.filter((f) => detectors.includes(f.detector));
      if (hits.length) return { ...s, state: "failed", count: hits.length,
        why: `${hits.length} open finding(s) from ${[...new Set(hits.map((f) => f.detector))].join(", ")}`,
        worst: hits.map((f) => f.title)[0] };
      return { ...s, state: "met", why: `${detectors.join(", ")} ran within 24h and found nothing here` };
    }
    if (s.evidence === "CI artefact" || s.evidence === "test result") {
      if (!gatesDeclared) return { ...s, state: "unproven", why: "no gate is declared in this workspace, so nothing can produce this evidence — `bb init`" };
      return { ...s, state: "unproven", why: `needs a ${s.evidence}: run the declared gate and record it, or write the review that cites ${s.id}` };
    }
    if (citedStandards.has(s.id)) {
      const r = reviews.find((x) => (x.standards || []).includes(s.id));
      const hits = open.filter((f) => f.evidence?.standard === s.id);
      return { ...s, state: hits.length ? "failed" : "met", count: hits.length,
        why: hits.length ? `${hits.length} open finding(s) cite ${s.id}, from ${r.file}` : `reviewed in ${r.file}, current against this tree, nothing open` };
    }
    return { ...s, state: "unproven", why: `no detector computes this and no current review cites it — \`bb auditor pack\` writes the brief that would` };
  });

  const by = { met: 0, failed: 0, unproven: 0 };
  for (const r of rows) by[r.state]++;
  const blocking = rows.filter((r) => r.state === "failed" && ch.governance.blocks_release.includes(r.id));
  return { rc: 0, area: id, adal: ch.adal.level, charter_drifted: ch.fingerprint !== fp,
    standards: rows, counts: by, blocking: blocking.map((r) => r.id),
    verdict: blocking.length ? "BLOCK" : by.failed ? "HOLD" : by.unproven ? "UNPROVEN" : "CLEAR",
    why: blocking.length ? `${blocking.length} release-blocking standard(s) failed: ${blocking.map((r) => r.id).join(", ")}`
      : by.failed ? `${by.failed} standard(s) failed, none of them release-blocking at level ${ch.adal.level}`
      : by.unproven ? `${by.unproven} of ${rows.length} standard(s) have no evidence either way — unproven is not green`
      : `every standard in force has evidence and none of it contradicts the bar` };
}

export { commands } from "./cmd.js";
