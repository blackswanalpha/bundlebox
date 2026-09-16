// _plan.js — the artefact an actuator writes when the edit is a decision but
// the ANALYSIS behind it is not.
//
// Seven of the eleven detectors this serves report something no machine may
// edit: split this file, lift this block, delete this orphan, write this test.
// The split is a decision. Which symbols the two halves would take with them,
// computed from the import graph, is a set difference, and a session that has
// to derive it pays for every file it opens to do so. So the actuator computes
// the derivable half at zero tokens, writes it where the session will find it,
// and leaves the finding open, because nothing was fixed.
//
// A plan is never a patch. `bb fix` renders the two differently and closes a
// finding for neither, and the result carries `planned` rather than `changed`
// so no caller can mistake one for the other.
import fs from "node:fs";
import path from "node:path";
import { VAR, rel } from "../core/paths.js";
import { slug } from "../core/util.js";

const PLAN_DIR = path.join(VAR, "plans");

/** Actuators that compute and never edit. Two callers need to tell them apart
 *  from a fix: `bb fix`, which must not close a finding a plan did not fix, and
 *  triage, which must not price one at zero. The derivation is free; the
 *  decision on top of it is the work, and filing both as free lies about one. */
export const PLAN_ONLY = new Set([
  "plan-file-split", "plan-file-regions", "plan-block-lift", "plan-orphan-disposition",
  "plan-catch-reasons", "plan-ui-leverage", "scaffold-test", "plan-fallback-contracts",
]);

/** Write one plan and return its workspace-relative path. */
export function writePlan(name, key, { title, why, rows = [], footer = "" }) {
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  const body = [
    `# ${title}`,
    "",
    why,
    "",
    ...rows,
    footer ? "" : "",
    footer,
    "",
    `<!-- ${name}, written by \`bb fix\` at 0 model tokens. Nothing was edited. -->`,
  ].filter((l) => l !== null).join("\n");
  const p = path.join(PLAN_DIR, `${name}-${slug(key) || "root"}.md`);
  fs.writeFileSync(p, body);
  return rel(p);
}

/** Every plan actuator has the same shape: derive rows, or decline with a
 *  reason. This runs the deriver so a throw inside it becomes a decline and
 *  never a crash — one unparsable file must not cost the other ten plans. */
export function planned(name, f, derive, { apply = false } = {}) {
  let out;
  try {
    out = derive();
  } catch (e) {
    return { ok: false, changed: false, planned: false, declined: [{ path: f.path, reason: `the plan could not be derived: ${String(e?.message || e)}` }], patch: null, applied: false, why: "derivation failed" };
  }
  if (!out || !out.rows?.length) {
    return { ok: true, changed: false, planned: false, declined: out?.declined || [], patch: null, applied: false, why: out?.why || "nothing left to plan" };
  }
  // Derived either way, written only under --apply: a dry run over 200 findings
  // that leaves 200 files behind is not a dry run.
  const patch = apply ? writePlan(name, f.key || f.path, out) : null;
  return { ok: true, changed: false, planned: true, keeps_open: true, declined: out.declined || [], patch, applied: apply,
    files: out.files || [], why: `${out.rows.length} row(s)${apply ? " planned" : " would be planned; re-run with --apply"}` };
}

/** A fenced quote of a file's line range, 1-based and inclusive. */
export function quoteRange(text, from, to, lang = "") {
  const lines = String(text).split("\n").slice(Math.max(0, from - 1), to);
  return ["```" + lang, ...lines, "```"];
}
