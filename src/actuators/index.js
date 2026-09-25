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
import { git, run, which } from "../core/exec.js";
import { langOf } from "../core/fs.js";
import { ROOT, VAR, abs, rel } from "../core/paths.js";
import * as store from "../core/store.js";
import { slug } from "../core/util.js";
import { secretSweep } from "../git/repo.js";
import { REGISTRY, makeCtx, runAll } from "../detectors/index.js";
import { claims, word } from "../detectors/doc-drift.js";
import { blankFences, codeRels, inFence, usedElsewhere } from "../detectors/_shared.js";
import { exportDeclRe } from "../detectors/dead-exports.js";
import { isWholeLineDebug } from "../detectors/debug-leftovers.js";
import { conflictBlocks } from "../detectors/merge-markers.js";
import { unifiedDiff } from "./_diff.js";
import * as plans from "./plans.js";

// Actuators the janitor must never run unattended. Every other actuator here
// either writes a reversible patch or asks git for an operation git itself
// refuses when it would lose work; `drop-dead-knob` is the one that changes
// what this box DOES for somebody who already set the key, so `bb fix` makes
// a person pass `--force` before it runs.
export const DESTRUCTIVE = new Set(["drop-dead-knob"]);

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

// ── the six that close a mechanical case ────────────────────────────────────
//
// Each one below tests its detector's OWN rule against the file as it reads
// now, rather than trusting the stored evidence: a scan is a photograph, and an
// actuator that acts on a photograph unexports a symbol somebody started using
// this morning. Eleven detectors have no entry here on purpose — a TODO, a god
// file, a duplicated block, a swallowed error, a leaked key and a missing test
// each name a decision, and an actuator that guesses one writes a wrong edit
// with a zero-token receipt attached.

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parses = (s) => { try { JSON.parse(s); return true; } catch { return false; } }; // probe: the throw is the answer

/** Drop the `export` keyword from a declaration this corpus never imports.
 *  The detector marked which lines carry the one rewritable form; this re-tests
 *  that rule against the current line AND re-asks the corpus whether the name
 *  has been referenced since the scan. A default export, a list entry and a
 *  Python def are each declined by name: what they are for is a decision. */
export function dropDeadExport(f, { apply = false } = {}) {
  const r = f.path, p = abs(r);
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!src) return result({ ok: false, why: `${r} is not readable` });
  const ctx = makeCtx();
  const lines = src.split("\n");
  const declined = [], edits = [];
  for (const sym of f.evidence?.symbols || []) {
    const at = `${r}:${sym.line}`;
    const line = lines[sym.line - 1];
    if (line === undefined) { declined.push({ path: at, reason: `${r} has no line ${sym.line} now; the scan is older than the file` }); continue; }
    if (!sym.plain) { declined.push({ path: at, reason: `${sym.name} is a default export, an \`export {…}\` entry or a Python def; that is a surface somebody declared, not a keyword left on` }); continue; }
    const re = exportDeclRe(sym.name);
    if (!re.test(line)) { declined.push({ path: at, reason: `line ${sym.line} no longer declares ${sym.name}; re-run \`bb scan\`` }); continue; }
    if (usedElsewhere(ctx, sym.name, r)) { declined.push({ path: at, reason: `${sym.name} is referenced outside ${r} now; the finding is stale` }); continue; }
    lines[sym.line - 1] = line.replace(re, "$1$2");
    edits.push({ line: sym.line, name: sym.name });
  }
  if (!edits.length) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "nothing left to unexport" });
  const next = lines.join("\n");
  const patch = writePatch("drop-dead-export", r, unifiedDiff(src, next, { from: `a/${r}`, to: `b/${r}` }));
  if (apply) fs.writeFileSync(p, next);
  return result({ changed: true, applied: apply, edits, declined, patch, files: [r], why: `${edits.length} export keyword(s) dropped, ${declined.length} declined` });
}

/** Delete a dependency nothing imports from the manifest that declares it.
 *  The detector's answer is recomputed first, so a package imported since the
 *  scan survives. package.json is edited by line and then re-parsed and
 *  compared against the object this expected: a comma this got wrong fails
 *  here, not at somebody's next install. A pyproject array is TOML, and a
 *  half-written manifest installs nothing, so it is declined. */
export function removeDeadDep(f, { apply = false } = {}) {
  const r = f.path, p = abs(r);
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!src) return result({ ok: false, why: `${r} is not readable` });
  if (!/^(package\.json|requirements[^/]*\.txt)$/.test(r)) {
    return result({ declined: [{ path: r, reason: `${r} is TOML; this box owns no TOML writer and a manifest rewritten by regex installs nothing` }], why: "declined" });
  }
  const live = new Set();
  for (const g of REGISTRY["dead-deps"].run(makeCtx())) if (g.key === r) for (const d of g.evidence?.deps || []) live.add(d.name);
  const claimed = (f.evidence?.deps || []).map((d) => d.name).filter(Boolean);
  const declined = claimed.filter((n) => !live.has(n)).map((n) => ({ path: r, reason: `${n} is imported or named somewhere now; the finding is stale` }));
  const names = claimed.filter((n) => live.has(n));
  if (!names.length) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "every declared dependency is used now" });

  const lines = src.split("\n");
  const drop = new Set(), removed = [];
  const isPkg = r === "package.json";
  for (const n of names) {
    const re = isPkg
      ? new RegExp(`^\\s*"${esc(n)}"\\s*:\\s*"[^"]*"\\s*,?\\s*$`)
      : new RegExp(`^\\s*${esc(n)}\\s*(\\[[^\\]]*\\])?\\s*([<>=!~;].*)?$`, "i");
    const hits = [];
    lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
    if (hits.length !== 1) { declined.push({ path: r, reason: `${n} is on ${hits.length} line(s) of ${r}; a line this cannot point at is one it does not delete` }); continue; }
    drop.add(hits[0]); removed.push(n);
  }
  if (!removed.length) return result({ ok: false, declined, why: `${declined.length} declined` });
  let next = lines.filter((_, i) => !drop.has(i)).join("\n");
  if (isPkg) {
    // The last entry of a block takes its comma with it, and JSON has no
    // trailing comma. Repaired only when the edit stopped parsing, then proved.
    if (!parses(next)) next = next.replace(/,(\s*[}\]])/g, "$1");
    const expect = JSON.parse(src);
    for (const n of removed) for (const b of ["dependencies", "devDependencies", "peerDependencies"]) if (expect[b]) delete expect[b][n];
    let got = null;
    try { got = JSON.parse(next); } catch { /* proved below */ }
    if (!got || JSON.stringify(got) !== JSON.stringify(expect)) {
      declined.push({ path: r, reason: "the edit did not re-parse as this manifest minus those names; nothing was written" });
      return result({ ok: false, declined, why: "verification failed" });
    }
  }
  const patch = writePatch("remove-dead-dep", r, unifiedDiff(src, next, { from: `a/${r}`, to: `b/${r}` }));
  if (apply) fs.writeFileSync(p, next);
  return result({ changed: true, applied: apply, removed, declined, patch, files: [r], why: `${removed.length} dependenc${removed.length === 1 ? "y" : "ies"} removed, ${declined.length} declined` });
}

/** Delete a line that is nothing but a debug statement. The predicate is the
 *  detector's, re-tested against the line as it reads now, so a log inside an
 *  expression, a call that spans lines and a line that does work after the log
 *  are each declined with the text that disqualified them. */
export function stripDebugLine(f, { apply = false } = {}) {
  const r = f.path, p = abs(r);
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!src) return result({ ok: false, why: `${r} is not readable` });
  const lines = src.split("\n");
  const declined = [], drop = new Set();
  for (const h of f.evidence?.hits || []) {
    const at = `${r}:${h.line}`;
    const line = lines[h.line - 1];
    if (line === undefined) { declined.push({ path: at, reason: `${r} has no line ${h.line} now; the scan is older than the file` }); continue; }
    if (!isWholeLineDebug(line)) { declined.push({ path: at, reason: `the line is more than one debug statement (\`${line.trim().slice(0, 60)}\`); deleting it would delete work` }); continue; }
    drop.add(h.line - 1);
  }
  if (!drop.size) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "no whole-line debug statement left" });
  const next = lines.filter((_, i) => !drop.has(i)).join("\n");
  const patch = writePatch("strip-debug-line", r, unifiedDiff(src, next, { from: `a/${r}`, to: `b/${r}` }));
  if (apply) fs.writeFileSync(p, next);
  return result({ changed: true, applied: apply, lines: [...drop].map((i) => i + 1), declined, patch, files: [r], why: `${drop.size} debug line(s) deleted, ${declined.length} declined` });
}

/** `npm install --package-lock-only`: npm re-resolves the lock from the
 *  manifest, which is the whole fix and needs nobody. Only the drift row —
 *  which lockfile a project commits is a decision, not a drift. It reaches the
 *  registry, so the dry run says so before anyone passes `--apply`. */
export function relockNpm(f, { apply = false } = {}) {
  if (f.key !== "npm:drift") return result({ declined: [{ path: f.path, reason: `${f.key} asks which package manager this project commits to; that is a decision, not a drift` }], why: "declined" });
  if (!which("npm")) return result({ ok: false, why: "npm is not on PATH" });
  const lockRel = "package-lock.json", p = abs(lockRel);
  const before = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!before) return result({ ok: false, why: `${lockRel} is not readable` });
  const n = f.evidence?.count ?? 0;
  if (!apply) {
    const patch = writePatch("relock-npm", lockRel, `# npm install --package-lock-only  (${n} entr${n === 1 ? "y" : "ies"} adrift)\n`);
    return result({ patch, would_relock: n, why: `${n} entr${n === 1 ? "y" : "ies"} adrift; re-run with --apply (npm resolves against the registry)` });
  }
  const rr = run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: ROOT, timeout: 180000 });
  const after = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (rr.rc !== 0) return result({ ok: false, applied: true, why: `npm refused: ${(rr.err || rr.out).trim().slice(-200)}` });
  const patch = writePatch("relock-npm", lockRel, unifiedDiff(before, after, { from: `a/${lockRel}`, to: `b/${lockRel}` }));
  return result({ changed: before !== after, applied: true, patch, files: [lockRel], why: before === after ? "npm rewrote nothing; the lock already matched" : `${lockRel} rewritten by npm` });
}

/** Collapse a conflict block whose two sides are byte-identical. git writes one
 *  when the same change arrives down two paths, and keeping one side is the
 *  only resolution there is — every other block is a merge, and a merge is a
 *  person's. All or nothing: `bb fix` closes a finding the moment the file
 *  changes, and a file with one block resolved and three left still fails every
 *  reader, so one real conflict leaves the whole file alone. */
export function resolveIdenticalConflict(f, { apply = false } = {}) {
  const r = f.path, p = abs(r);
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!src) return result({ ok: false, why: `${r} is not readable` });
  // A markdown file explaining conflict markers shows them in a fence; the
  // detector reads it blanked, and blanking preserves line numbers.
  const scanned = r.endsWith(".md") ? blankFences(src) : src;
  const blocks = conflictBlocks(scanned);
  if (!blocks.length) return result({ why: `${r} holds no conflict block now` });
  const declined = blocks.filter((b) => !b.identical).map((b) => ({
    path: `${r}:${b.open}`,
    reason: b.close == null
      ? "the block has no separator or no end; half a conflict is a file somebody is still editing"
      : `the two sides differ (${b.ours.length} vs ${b.theirs.length} line(s)); choosing between them IS the merge`,
  }));
  if (declined.length) return result({ ok: false, declined, why: `${declined.length} block(s) need a person; ${r} left alone` });
  const drop = new Set();
  for (const b of blocks) { drop.add(b.open - 1); for (let k = b.mid - 1; k <= b.close - 1; k++) drop.add(k); }
  const next = src.split("\n").filter((_, i) => !drop.has(i)).join("\n");
  const patch = writePatch("resolve-identical-conflict", r, unifiedDiff(src, next, { from: `a/${r}`, to: `b/${r}` }));
  if (apply) fs.writeFileSync(p, next);
  return result({ changed: true, applied: apply, blocks: blocks.length, patch, files: [r], why: `${blocks.length} identical block(s) collapsed to one side` });
}

/** Delete a defaults key nothing in this tree reads. DESTRUCTIVE, and the
 *  reason is not the edit: a knob somebody already set in their own config
 *  stops being ignored and starts being unknown, and that is a behaviour change
 *  however dead the key is here. Scalars on their own line only, the name must
 *  be unique in the file, and `node --check` proves the result before it is
 *  written, because the failure mode of a wrong line delete is a box that will
 *  not boot. */
export function dropDeadKnob(f, { apply = false } = {}) {
  const r = "src/core/config.js", p = abs(r);
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!src) return result({ ok: false, why: `${r} is not readable` });
  const live = new Set();
  for (const g of REGISTRY["dead-config"].run(makeCtx())) for (const k of g.evidence?.keys || []) live.add(k);
  const lines = src.split("\n");
  const declined = [], drop = new Set(), removed = [];
  const SCALAR = String.raw`(?:-?\d[\d_.eE+-]*|true|false|null|"[^"]*"|'[^']*'|\[[^\]]*\])`;
  for (const knob of f.evidence?.keys || []) {
    const key = String(knob).split(".").pop();
    if (!live.has(knob)) { declined.push({ path: `${r} ${knob}`, reason: `${knob} is read somewhere now; the finding is stale` }); continue; }
    const re = new RegExp(`^\\s*${esc(key)}\\s*:\\s*${SCALAR}\\s*,?\\s*$`);
    const hits = [];
    lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
    if (hits.length !== 1) { declined.push({ path: `${r} ${knob}`, reason: `\`${key}\` is a one-line scalar on ${hits.length} line(s); a multi-line value or a name used in two sections is a person's edit` }); continue; }
    drop.add(hits[0]); removed.push(knob);
  }
  if (!removed.length) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "every declared knob is read now" });
  const next = lines.filter((_, i) => !drop.has(i)).join("\n");
  const tmp = path.join(PATCH_DIR, "drop-dead-knob-check.js");
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  fs.writeFileSync(tmp, next);
  const check = run([process.execPath, "--check", tmp], { cwd: ROOT, timeout: 30000 });
  fs.rmSync(tmp, { force: true });
  if (check.rc !== 0) {
    declined.push({ path: r, reason: `the edit does not parse (${(check.err || "").trim().split("\n")[0].slice(0, 120)}); nothing was written` });
    return result({ ok: false, declined, why: "verification failed" });
  }
  const patch = writePatch("drop-dead-knob", r, unifiedDiff(src, next, { from: `a/${r}`, to: `b/${r}` }));
  if (apply) fs.writeFileSync(p, next);
  return result({ changed: true, applied: apply, removed, declined, patch, files: [r], why: `${removed.length} knob(s) deleted, ${declined.length} declined` });
}

// ── the four that still edit ────────────────────────────────────────────────

/** Re-derive the findings whose file changed under them. The one survey whose
 *  fix IS a command: `bb scan` re-runs the detectors against the bytes on disk
 *  now. Running only the detectors the stale rows name keeps it to the work the
 *  finding actually describes. */
export function rescanStale(f, { apply = false } = {}) {
  const rows = f.evidence?.findings || [];
  if (!rows.length) return result({ why: "no stale finding recorded" });
  const names = new Set();
  for (const s of rows) if (s.detector && REGISTRY[s.detector]) names.add(s.detector);
  if (!names.size) return result({ ok: false, declined: rows.map((s) => ({ path: s.path, reason: `${s.detector} is not a registered detector; it cannot be re-derived` })), why: "nothing re-derivable" });
  const only = [...names];
  if (!apply) return result({ patch: writePatch("rescan-stale", "store", `# bb scan --detector ${only.join(",")}   (${rows.length} stale row(s))\n`), would_rescan: rows.length, why: `${rows.length} row(s) across ${only.length} detector(s); re-run with --apply` });
  const { findings } = runAll({ only });
  const before = store.openFindings().length;
  store.mergeFindings(findings, { detectors: names });
  const after = store.openFindings().length;
  return result({ changed: true, applied: true, detectors: only, why: `${only.length} detector(s) re-derived; ${before} open findings became ${after}` });
}

/** Stop a secret-shaped file reaching the next commit. It does NOT close the
 *  finding and it never touches the value: a key that reached a remote is
 *  public whatever .gitignore says, so rotation is still owed and the finding
 *  stays open to say so. A file git already TRACKS is declined outright —
 *  ignoring it then changes nothing and reads like it did. */
export function ignoreSecretFile(f, { apply = false } = {}) {
  const r = f.path;
  if (!secretSweep([r]).length) {
    return result({ declined: [{ path: r, reason: `${r} is not a file whose NAME says it holds credentials; a secret inside ordinary source is removed by editing it, and that is a person's edit` }], why: "declined" });
  }
  const tracked = git(["ls-files", "--error-unmatch", r], ROOT).rc === 0;
  if (tracked) {
    return result({ ok: false, keeps_open: true, declined: [{ path: r, reason: `git already tracks ${r}; ignoring it now hides the file from the next commit and nothing from the history. Rotate the key, then remove the file with \`git rm --cached\`` }], why: "already tracked" });
  }
  const giRel = ".gitignore", gi = abs(giRel);
  const src = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const already = src.split("\n").some((l) => l.trim() === r || l.trim() === `/${r}`);
  if (already) return result({ keeps_open: true, why: `${giRel} already ignores ${r}; the key still needs rotating` });
  const next = (src && !src.endsWith("\n") ? src + "\n" : src) + `${r}\n`;
  const patch = writePatch("ignore-secret-file", r, unifiedDiff(src, next, { from: `a/${giRel}`, to: `b/${giRel}` }));
  if (apply) fs.writeFileSync(gi, next);
  return result({ changed: true, applied: apply, keeps_open: true, patch, files: [giRel], why: `${r} added to ${giRel}. The finding stays open: rotate the key` });
}

/** `.filter(x => p).map(x => f)` -> `.flatMap(x => p ? [f] : [])`, and only when
 *  both callbacks are one-parameter arrows naming the SAME parameter. The two
 *  callbacks see different indices once the filter has run, so a rewrite that
 *  renames a parameter or carries a second argument is a behaviour change
 *  wearing a refactor's clothes. Every other anti-slop rule is a type decision
 *  and declines by name. */
const FILTER_MAP = /\.filter\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([^;]*?)\s*\)\s*\.map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([^;]*?)\s*\)/;
export function flattenFilterMap(f, { apply = false } = {}) {
  const r = f.path, p = abs(r);
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!src) return result({ ok: false, why: `${r} is not readable` });
  const lines = src.split("\n");
  const declined = [], edits = [];
  for (const h of f.evidence?.hits || []) {
    const at = `${r}:${h.line}`;
    if (h.rule !== "filter-then-map") { declined.push({ path: at, reason: `${h.rule} is a decision about a type or a seam, not a rewrite` }); continue; }
    const line = lines[h.line - 1];
    if (line === undefined) { declined.push({ path: at, reason: `${r} has no line ${h.line} now; re-run \`bb scan\`` }); continue; }
    const m = FILTER_MAP.exec(line);
    if (!m) { declined.push({ path: at, reason: "the two callbacks are not one-line single-parameter arrows; this rewrite does not read a block body" }); continue; }
    const [whole, pa, cond, pb, body] = m;
    if (pa !== pb) { declined.push({ path: at, reason: `the callbacks name their parameter differently (\`${pa}\` then \`${pb}\`); renaming one is an edit this will not make blind` }); continue; }
    if (/\bindex\b|\bi\b\s*\)/.test(whole)) { declined.push({ path: at, reason: "a callback takes the index, and the index the map sees is not the index the filter saw" }); continue; }
    lines[h.line - 1] = line.replace(whole, `.flatMap(${pa} => (${cond}) ? [${body}] : [])`);
    edits.push({ line: h.line, from: whole.slice(0, 60) });
  }
  if (!edits.length) return result({ ok: !declined.length, declined, why: declined.length ? `${declined.length} declined` : "nothing rewritable left" });
  const next = lines.join("\n");
  const patch = writePatch("flatten-filter-map", r, unifiedDiff(src, next, { from: `a/${r}`, to: `b/${r}` }));
  if (apply) fs.writeFileSync(p, next);
  return result({ changed: true, applied: apply, edits, declined, patch, files: [r], why: `${edits.length} pass(es) collapsed, ${declined.length} declined` });
}

/** Uppercase a marker the census cannot see. `// todo: ship this` is invisible
 *  to a survey matching `TODO`, so the count is wrong in the one direction that
 *  matters: a tree reports fewer open markers than it has. The work the marker
 *  names is untouched; only its spelling is. */
const HASH_COMMENT_LANGS = new Set(["py", "ruby", "sh", "bash", "yaml", "yml", "toml", "perl", "r", "make"]);
const LOWER_MARKER = /(^|[^\w])(\/\/|\/\*|<!--|--|\*|#)(\s*)(todo|fixme|xxx|hack)\b(?=[:\s])/gi;
export function normalizeTodoMarker(f, { apply = false } = {}) {
  const ctx = makeCtx();
  const dir = f.path === "." ? "" : `${f.path}/`;
  const files = [], declined = [], edits = [];
  for (const r of codeRels(ctx)) if (r.startsWith(dir)) files.push(r);
  if (!files.length) return result({ ok: false, why: `no code file under ${f.path}` });
  const written = [];
  for (const r of files) {
    const p = abs(r), hash = HASH_COMMENT_LANGS.has(langOf(r));
    let src;
    try { src = fs.readFileSync(p, "utf8"); } catch { declined.push({ path: r, reason: "not readable now" }); continue; }
    if (!/todo|fixme|xxx|hack/i.test(src)) continue;
    let touched = 0;
    const next = src.replace(LOWER_MARKER, (whole, pre, open, gap, marker) => {
      if (marker === marker.toUpperCase()) return whole;
      // `#` opens a comment in some languages and an id selector in others; a
      // rewrite in the wrong one edits a rule rather than a note.
      if (open === "#" && !hash) return whole;
      touched++;
      return `${pre}${open}${gap}${marker.toUpperCase()}`;
    });
    if (!touched) continue;
    edits.push({ file: r, count: touched });
    written.push([p, next, src]);
  }
  if (!edits.length) return result({ ok: true, declined, why: "every marker is already in the form the census counts" });
  const total = edits.reduce((n, e) => n + e.count, 0);
  const first = written[0];
  const patch = writePatch("normalize-todo-marker", f.path, unifiedDiff(first[2], first[1], { from: `a/${rel(first[0])}`, to: `b/${rel(first[0])}` }));
  if (apply) for (const [p2, text] of written) fs.writeFileSync(p2, text);
  return result({ changed: true, applied: apply, edits, declined, patch, files: edits.map((e) => e.file), why: `${total} marker(s) in ${edits.length} file(s) raised to the form the census counts` });
}

export const ACTUATORS = {
  "fix-doc-links": fixDocLinks, "sync-doc-counts": syncDocCounts, "prune-worktrees": pruneWorktrees, "sync-trunk": syncTrunk,
  "drop-dead-export": dropDeadExport, "remove-dead-dep": removeDeadDep, "strip-debug-line": stripDebugLine,
  "relock-npm": relockNpm, "resolve-identical-conflict": resolveIdenticalConflict, "drop-dead-knob": dropDeadKnob,
  // The twelve that used to name none. Five edit; seven write the plan behind
  // a decision and leave the finding open for the person who makes it.
  "rescan-stale": rescanStale, "ignore-secret-file": ignoreSecretFile,
  "flatten-filter-map": flattenFilterMap, "normalize-todo-marker": normalizeTodoMarker,
  "plan-file-split": plans.planFileSplit, "plan-file-regions": plans.planFileRegions,
  "plan-block-lift": plans.planBlockLift, "plan-orphan-disposition": plans.planOrphanDisposition,
  "plan-catch-reasons": plans.planCatchReasons, "plan-ui-leverage": plans.planUiLeverage,
  "scaffold-test": plans.scaffoldTest, "plan-fallback-contracts": plans.planFallbackContracts,
};

/** Run the actuator a finding names. Never throws: a failure is a result. */
export function actuate(f, { apply = false, cfg } = {}) {
  const name = f?.auto_fix;
  const fn = ACTUATORS[name];
  if (!fn) return result({ ok: false, why: `no actuator ${name || "(none)"}` });
  try { return { name, ...fn(f, { apply, cfg }) }; } catch (e) { return result({ name, ok: false, why: String(e?.message || e) }); }
}
