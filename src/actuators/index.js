// actuators/index.js — local fixes, zero model tokens.
//
// Each actuator closes one mechanical case of one finding and DECLINES the
// rest with a reason: a guessed link is a confidently wrong link nobody checks
// again. Every one writes its patch (or its plan) to var/patches before it
// touches anything, `apply=false` is a real dry run, and the result names what
// changed and what was declined and why.
import fs from "node:fs";
import path from "node:path";
import { walk } from "../core/fs.js";
import { git } from "../core/exec.js";
import { ROOT, VAR, abs, rel } from "../core/paths.js";
import { slug } from "../core/util.js";
import { makeCtx } from "../detectors/index.js";
import { claims, word } from "../detectors/doc-drift.js";
import { inFence } from "../detectors/_shared.js";
import { unifiedDiff } from "./_diff.js";

// Actuators the janitor must never run unattended. Empty today: every actuator
// here either writes a reversible patch or asks git for an operation git itself
// refuses when it would lose work. The set exists so the next one that deletes
// a ref has somewhere to be declared, and `bb fix` checks it before running.
export const DESTRUCTIVE = new Set();

const PATCH_DIR = path.join(VAR, "patches");
function writePatch(name, key, text) {
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  const p = path.join(PATCH_DIR, `${name}-${slug(key) || "root"}.patch`);
  fs.writeFileSync(p, text);
  return rel(p);
}
const result = (o) => ({ ok: true, changed: false, declined: [], patch: null, applied: false, why: "", ...o });

let _index = null;
/** basename -> [rel] over every file (no suffix filter): a doc may cite an svg. */
function basenames() {
  if (_index) return _index;
  _index = new Map();
  for (const p of walk(ROOT, { suffixes: null })) { const r = rel(p), b = path.basename(r); if (!_index.has(b)) _index.set(b, []); _index.get(b).push(r); }
  return _index;
}

/** Repoint a markdown citation at the file it moved to. Only when the basename
 *  is unique in the tree and the citation's own directory claim survives. */
export function fixDocLinks(f, { apply = false } = {}) {
  const docRel = f.path;
  const doc = abs(docRel);
  const src = fs.existsSync(doc) ? fs.readFileSync(doc, "utf8") : "";
  if (!src) return result({ ok: false, why: `${docRel} is not readable` });
  const declined = [], edits = [];
  let next = src;
  for (const b of f.evidence?.broken || []) {
    const t = b.target;
    const at = `${docRel}:${b.line}`;
    const resolved = path.resolve(path.dirname(doc), t);
    if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) { declined.push({ path: at, reason: `${t} resolves outside the workspace; a path quoted from another tree, not a link from this document` }); continue; }
    if (b.line && inFence(src, b.line)) { declined.push({ path: at, reason: `${t} is inside a code fence; an example, not a citation` }); continue; }
    if (fs.existsSync(resolved)) continue;   // fixed since the scan
    const base = path.posix.basename(t);
    let cands = (basenames().get(base) || []).filter((c) => c !== docRel);
    const parent = path.posix.basename(path.posix.dirname(t));
    // With several candidates the citation's own parent dir is a claim that
    // picks between them (`..` and `.` are not claims). With ONE candidate in
    // the whole tree there is nothing to confuse it with: that is the moved
    // file, and a move across directories is the case this actuator exists for.
    if (cands.length > 1 && parent && parent !== "." && parent !== "..") {
      const kept = cands.filter((c) => `/${c}`.includes(`/${parent}/`));
      if (kept.length) cands = kept;
    }
    if (!cands.length) { declined.push({ path: at, reason: `nothing named ${base} is where the citation says; it was deleted, not moved` }); continue; }
    if (cands.length > 1) {
      const tail = cands.filter((c) => c.endsWith(t.replace(/^(\.\.?\/)+/, "")));
      if (tail.length !== 1) { declined.push({ path: at, reason: `${cands.length} files named ${base} (${cands.slice(0, 3).join(", ")}); which one is a choice` }); continue; }
      cands = tail;
    }
    let to = path.relative(path.dirname(doc), abs(cands[0])).split(path.sep).join("/");
    if (!to.startsWith(".") && t.startsWith("./")) to = "./" + to;
    if (to === t) continue;
    const before = next;
    next = next.split(`](${t})`).join(`](${to})`).split(`\`${t}\``).join(`\`${to}\``);
    if (next === before) { declined.push({ path: at, reason: `${t} is cited in a form this actuator does not rewrite` }); continue; }
    edits.push({ line: b.line, from: t, to });
  }
  if (!edits.length) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "every citation already resolves" });
  const patch = writePatch("fix-doc-links", docRel, unifiedDiff(src, next, { from: `a/${docRel}`, to: `b/${docRel}` }));
  if (apply) fs.writeFileSync(doc, next);
  return result({ changed: true, applied: apply, edits, declined, patch, files: [docRel], why: `${edits.length} citation(s) repointed, ${declined.length} declined` });
}

/** Rewrite a counted claim in a document to the count, preserving its form. */
export function syncDocCounts(f, { apply = false } = {}) {
  const docRel = f.path;
  const doc = abs(docRel);
  const src = fs.existsSync(doc) ? fs.readFileSync(doc, "utf8") : "";
  if (!src) return result({ ok: false, why: `${docRel} is not readable` });
  // Re-count with the same code the detector ran; never trust a stored number.
  const mine = claims(makeCtx()).filter((c) => c.doc === docRel && (!f.key || c.key === f.key || f.evidence?.label === c.label));
  if (!mine.length) return result({ declined: [{ path: docRel, reason: `no countable claim for ${f.evidence?.label || f.key} found in the document now` }], ok: false, why: "claim not found" });
  const declined = [], edits = [];
  let next = src, shift = 0;
  for (const c of mine.sort((x, y) => x.start - y.start)) {
    if (c.claimed === c.counted) continue;
    if (inFence(src, c.line)) { declined.push({ path: `${docRel}:${c.line}`, reason: "inside a code fence" }); continue; }
    const to = word(c.counted, c.token);
    const start = c.start + shift;
    // The matched span only: the same digits appear elsewhere in a document.
    if (next.slice(start, start + c.token.length) !== c.token) { declined.push({ path: `${docRel}:${c.line}`, reason: "document changed under the actuator" }); continue; }
    next = next.slice(0, start) + to + next.slice(start + c.token.length);
    shift += to.length - c.token.length;
    edits.push({ line: c.line, label: c.label, from: c.token, to });
  }
  if (!edits.length) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "every claim matches" });
  const patch = writePatch("sync-doc-counts", docRel, unifiedDiff(src, next, { from: `a/${docRel}`, to: `b/${docRel}` }));
  if (apply) fs.writeFileSync(doc, next);
  return result({ changed: true, applied: apply, edits, declined, patch, files: [docRel], why: `${edits.length} count(s) rewritten` });
}

/** `git worktree prune`: drops bookkeeping for checkouts that are gone. It
 *  cannot touch a worktree that still exists, which is why it needs no person. */
export function pruneWorktrees(f, { apply = false } = {}) {
  const dry = git(["worktree", "prune", "--dry-run", "-v"], ROOT);
  if (dry.rc !== 0) return result({ ok: false, why: dry.err.trim().slice(-200) || "git worktree prune failed" });
  const stale = dry.out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!stale.length) return result({ why: "no stale worktree records" });
  const patch = writePatch("prune-worktrees", "root", `# git worktree prune -v\n${stale.map((s) => "# " + s).join("\n")}\n`);
  if (!apply) return result({ patch, would_prune: stale, why: `${stale.length} stale record(s); re-run with --apply` });
  const r = git(["worktree", "prune", "-v"], ROOT);
  return result({ ok: r.rc === 0, changed: r.rc === 0, applied: true, patch, pruned: stale, why: r.rc === 0 ? `${stale.length} record(s) pruned` : (r.err || r.out).trim().slice(-200) });
}

/** `git pull --ff-only`, only on a clean tree on a protected branch. A fast
 *  forward cannot conflict, rewrite or lose an edit: git refuses instead. */
export function syncTrunk(f, { apply = false, cfg } = {}) {
  const protectedBranches = (cfg || makeCtx().cfg).git?.protected || [];
  const cur = git(["branch", "--show-current"], ROOT).out.trim();
  if (!protectedBranches.includes(cur)) return result({ declined: [{ path: ".", reason: `on ${cur || "a detached HEAD"}, not a protected branch; switching is not this actuator's decision` }], why: "declined" });
  const st = git(["status", "--porcelain"], ROOT);
  if (st.out.trim()) return result({ declined: [{ path: ".", reason: `${st.out.trim().split("\n").length} uncommitted file(s); a pull into a dirty tree is a person's call` }], why: "declined" });
  const sb = git(["status", "-sb", "--porcelain=v1"], ROOT).out.split("\n")[0] || "";
  const behind = Number((/behind (\d+)/.exec(sb) || [])[1] || 0);
  if (!behind) return result({ why: `${cur} is not behind its upstream` });
  const patch = writePatch("sync-trunk", cur, `# git pull --ff-only  (${behind} commit(s) behind on ${cur})\n`);
  if (!apply) return result({ patch, would_pull: behind, why: `${behind} commit(s) behind; re-run with --apply` });
  const r = git(["pull", "--ff-only"], ROOT);
  return result({ ok: r.rc === 0, changed: r.rc === 0, applied: true, patch, why: r.rc === 0 ? `fast-forwarded ${behind} commit(s)` : `git refused: ${(r.err || r.out).trim().slice(-200)}` });
}

export const ACTUATORS = { "fix-doc-links": fixDocLinks, "sync-doc-counts": syncDocCounts, "prune-worktrees": pruneWorktrees, "sync-trunk": syncTrunk };

/** Run the actuator a finding names. Never throws: a failure is a result. */
export function actuate(f, { apply = false, cfg } = {}) {
  const name = f?.auto_fix;
  const fn = ACTUATORS[name];
  if (!fn) return result({ ok: false, why: `no actuator ${name || "(none)"}` });
  try { return { name, ...fn(f, { apply, cfg }) }; } catch (e) { return result({ name, ok: false, why: String(e?.message || e) }); }
}
