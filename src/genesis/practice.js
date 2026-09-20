// genesis/practice.js — the phase this pipeline used to stop at.
//
// `bb genesis plan` says what no scenario touches and `bb genesis pack` writes
// the brief for each gap, and then a person had to decide to spend. This verb
// spends on their behalf, unattended, and keeps only what a free verifier
// passes. The shape is RSIAgent's practice loop with the roles this tree
// already has:
//
//   curriculum   the coverage plan. Round one is BROAD: one pack per surface,
//                so every surface gets a first scenario. Later rounds are DEEP:
//                the surfaces whose scenarios were rejected, then whatever the
//                plan still lists. Nothing is chosen by a model.
//   actor        `bb genesis send --run --spend`: one agent session per pack.
//                This is the only step that costs tokens, and the bridge's
//                ceiling and window guard stand in front of it as always.
//   verifier     `bb cookbook check` and a run of the NEW scenarios only, both
//                free and neither reading the actor's transcript. A scenario is
//                kept when it validates and, run against the base, is green or
//                red under a quoted rule. A scenario is rejected when it fails the
//                check, when it is red with no `rule` block (the corpus having
//                an opinion), or when it was blocked (the environment). A
//                rejected file is moved aside, never deleted: the lesson below
//                points at it.
//   memory       every rejection becomes one `| E<n> |` row in
//                `.bundlebox/edge-cases.md`, the file `bb pinpoint` reads for
//                its Traps section. Rows are keyed by what and why, re-seen
//                rows bump a count and a date, and a row nobody has re-seen in
//                LESSON_TTL_DAYS is dropped on the next pass: the same decay
//                the expert's memory tiers run under.
//
// The loop stops on its own: when the plan is empty, when a round produced no
// file (the actor wrote nothing, or the bridge refused), or when a round kept
// nothing. Every round is a row in practice.json with what it spent and what
// survived, so the number a person reads is the corpus somebody else paid for.
import fs from "node:fs";
import path from "node:path";
import * as corpus from "../cookbook/corpus.js";
import * as cookbook from "../cookbook/index.js";
import * as episodes from "../buckmaster/episodes.js";
import * as store from "../core/store.js";
import { BB_DIR, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { now } from "../core/util.js";
import { PACKS, world, plan } from "./world.js";
import { pack, send } from "./packs.js";

export const DIR = (id) => path.join(PACKS(), id, "practice");
export const LESSONS = () => path.join(BB_DIR, "edge-cases.md");
export const LESSON_TTL_DAYS = 90;
export const SECTION = "## Practice lessons";
const RED = new Set(["failed", "error"]);

// ── the verifier ────────────────────────────────────────────────────────────

/** The scenario files a corpus holds now, relative, as a set. Taken before the
 *  actor runs so that what it wrote is a set difference and not a guess. */
export function snapshot(cid) {
  const c = corpus.load(cid);
  return new Set(c ? [...c.scenarios.map((s) => s._file), ...c.bad.map((b) => b.file)] : []);
}

export const newFiles = (cid, before) => [...snapshot(cid)].filter((f) => !before.has(f)).sort();

/** Check, then run, the new files only. `{ kept, rejected, board }`. */
export async function verify(cid, files, { base = "", run = true, runId = "", aside = null } = {}) {
  const kept = [], rejected = [];
  const setAsideNow = (rows) => (aside ? aside(rows) : rows);
  if (!files.length) return { kept, rejected, board: null };
  const c = corpus.load(cid);
  if (!c) return { kept, rejected: files.map((file) => ({ file, id: "", kind: "check", why: `no corpus \`${cid}\`` })), board: null };
  const gate = corpus.check(c);
  const byFile = new Map(files.map((f) => [f, []]));
  for (const b of c.bad) if (byFile.has(b.file)) byFile.get(b.file).push(b.why);
  for (const e of gate.errors) { const f = files.find((x) => e.startsWith(x)); if (f) byFile.get(f).push(e.slice(f.length).replace(/^[:\s]+/, "")); }
  const idOf = (f) => (c.scenarios.find((s) => s._file === f) || {}).id || "";
  const candidates = [];
  for (const [file, errs] of byFile) {
    if (errs.length) rejected.push({ file, id: idOf(file), kind: "check", why: errs.slice(0, 3).join("; ") });
    else candidates.push(file);
  }
  // Set the check failures aside BEFORE the run: the engine refuses a corpus
  // that does not validate, and a file that failed its check is exactly that.
  const movedByCheck = setAsideNow(rejected.splice(0));
  rejected.push(...movedByCheck);
  let board = null;
  const at = base || c.persona.base || "";
  if (run && candidates.length && at) {
    const ids = candidates.map(idOf).filter(Boolean);
    // Findings are merged for KEPT scenarios only, after the verdict: a red
    // step on a scenario about to be rejected is a finding about the corpus.
    // `force`: every NEW file passed the check above; an error the gate still
    // reports belongs to a file that was there before this round.
    const r = await cookbook.runCorpus(cid, { ids, base: at, write: false, runId, force: true });
    if (r.rc) {
      for (const file of candidates) rejected.push({ file, id: idOf(file), kind: "run", why: r.why });
      return { kept, rejected, board: null };
    }
    board = r.board;
    const rows = cookbook.findings(board);
    const keptIds = new Set();
    for (const sc of board.scenarios || []) {
      const file = candidates.find((f) => idOf(f) === sc.id);
      if (!file) continue;
      const steps = sc.steps || [];
      const red = steps.filter((s) => RED.has(s.state));
      const blocked = steps.filter((s) => s.state === "blocked");
      if (blocked.length && !red.length) { rejected.push({ file, id: sc.id, kind: "blocked", why: `blocked before it tested anything: ${(blocked[0].why || []).join(" ")}` }); continue; }
      if (red.length && !sc.rule) { rejected.push({ file, id: sc.id, kind: "corpus-opinion", why: `red with no \`rule\` block: ${red[0].request || red[0].name} — ${(red[0].why || []).join(" ")}` }); continue; }
      kept.push({ file, id: sc.id, why: red.length ? `red under a quoted rule: ${red.length} step(s), now a finding` : "green" });
      keptIds.add(sc.id);
    }
    for (const file of candidates) if (!kept.some((k) => k.file === file) && !rejected.some((k) => k.file === file)) rejected.push({ file, id: idOf(file), kind: "run", why: "the board carries no verdict for it" });
    const mine = rows.rows.filter((f) => keptIds.has(f.path));
    if (mine.length) store.mergeFindings(mine, { detectors: new Set([rows.detector]) });
  } else {
    for (const file of candidates) kept.push({ file, id: idOf(file), why: at ? "validated; not run" : "validated; no base to run against" });
  }
  const runRejects = rejected.filter((r) => !r.moved_to);
  const movedByRun = setAsideNow(runRejects);
  return { kept, rejected: [...rejected.filter((r) => r.moved_to), ...movedByRun], board };
}

/** Move a rejected file aside. It stays readable, because the lesson names it. */
export function setAside(id, round, rejected) {
  const dir = path.join(DIR(id), "rejected", String(round).padStart(2, "0"));
  const moved = [];
  for (const r of rejected) {
    const src = abs(r.file);
    if (!fs.existsSync(src)) { moved.push({ ...r }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, path.basename(r.file));
    fs.renameSync(src, dst);
    moved.push({ ...r, moved_to: rel(dst) });
  }
  return moved;
}

// ── the memory ──────────────────────────────────────────────────────────────

const ROW = /^\|\s*E(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*seen (\d{4}-\d{2}-\d{2}) ×(\d+)\s*\|\s*$/;
const today = () => now().slice(0, 10);
const cell = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** Read the rows this verb owns: everything under SECTION. Rows above it are
 *  a person's and are never touched. */
export function lessons(file = LESSONS()) {
  let md = ""; try { md = fs.readFileSync(file, "utf8"); } catch { return { head: "", rows: [], file }; }
  const i = md.indexOf(SECTION);
  if (i < 0) return { head: md, rows: [], file };
  const rows = [];
  for (const line of md.slice(i).split("\n")) {
    const m = ROW.exec(line);
    if (m) rows.push({ n: Number(m[1]), what: m[2], why: m[3], seen: m[4], count: Number(m[5]) });
  }
  return { head: md.slice(0, i).replace(/\s+$/, ""), rows, file };
}

/** Fold rejections into the file. Same what+why: count and date move. Older
 *  than the TTL and not re-seen: dropped. Returns what the file holds now. */
export function remember(rejected, { corpusId = "", file = LESSONS(), ttlDays = LESSON_TTL_DAYS, at = today() } = {}) {
  const cur = lessons(file);
  const cutoff = new Date(Date.parse(at) - ttlDays * 86400000).toISOString().slice(0, 10);
  const rows = cur.rows.filter((r) => r.seen >= cutoff);
  let added = 0, bumped = 0;
  for (const r of rejected) {
    const what = cell(`${corpusId}/${r.id || path.basename(r.file, ".json")} (${r.moved_to || r.file})`);
    const why = cell(`${r.kind}: ${r.why}`).slice(0, 240);
    const had = rows.find((x) => x.what === what && x.why === why);
    if (had) { had.seen = at; had.count += 1; bumped += 1; } else { rows.push({ n: 0, what, why, seen: at, count: 1 }); added += 1; }
  }
  rows.forEach((r, i) => { r.n = i + 1; });
  const body = [
    SECTION, "",
    "Written by `bb genesis practice`: a scenario the verifier rejected, and why. `bb pinpoint` reads these rows as traps",
    `for the surface they name. A row nobody re-sees in ${ttlDays} days is dropped on the next pass.`, "",
    "| id | what | why | last |", "|---|---|---|---|",
    ...rows.map((r) => `| E${r.n} | ${r.what} | ${r.why} | seen ${r.seen} ×${r.count} |`),
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${cur.head ? cur.head + "\n\n" : ""}${body}`);
  return { file: rel(file), rows: rows.length, added, bumped, dropped: cur.rows.length - (rows.length - added) };
}

// ── the loop ────────────────────────────────────────────────────────────────

/** Broad, then deep, until the plan is empty or a round moves nothing.
 *  `actor` is what writes scenarios for one pack; the default is the bridge.
 *  Tests pass their own and spend nothing. */
export async function practice(id, { rounds = 3, batch = 4, maxPacks = 0, agent = "", run = false, spend = false, base = "", actor = null, verifyRun = true, runId = "" } = {}) {
  const w = world(id);
  if (!w) return { rc: 2, why: `no world \`${id}\`. bb genesis <doc>` };
  const first = plan(id);
  if (first.rc) return first;
  const cid = first.corpus;
  const act = actor || (async (p) => { const r = await send(id, p.file, { run, spend, agent }); return r.sent?.[0] || { state: "refused", why: r.why || "nothing sent" }; });
  const report = { id, corpus: cid, at: now(), coverage_before: first.coverage_pct ?? null, rounds: [], kept: 0, rejected: 0, stopped: "" };
  let focus = new Set();
  for (let round = 1; round <= rounds; round++) {
    const p = round === 1 ? first : plan(id);
    if (p.rc) { report.stopped = p.why; break; }
    if (!p.specs.length) { report.stopped = "covered: the plan lists nothing"; break; }
    const surfaces = [...new Set(p.specs.map((s) => s.surface || "(none)"))];
    // Broad: one pack per surface. Deep: the rejected surfaces first, then the rest.
    const cap = round === 1 ? (maxPacks || surfaces.length) : (maxPacks || 0);
    const pk = pack(id, { corpusId: cid, batch, max: 0 });
    if (pk.rc) { report.stopped = pk.why; break; }
    let packs = round === 1 ? surfaces.map((s) => pk.packs.find((x) => x.surface === s)).filter(Boolean) : pk.packs;
    if (round > 1 && focus.size) packs = [...packs.filter((x) => focus.has(x.surface)), ...packs.filter((x) => !focus.has(x.surface))];
    if (cap) packs = packs.slice(0, cap);
    const before = snapshot(cid);
    const sent = [];
    for (const x of packs) { const s = await act(x); sent.push({ surface: x.surface, file: x.file, state: s.state || "?", why: s.why || "", rc: s.rc ?? null, call: s.call || null }); }
    const files = newFiles(cid, before);
    const v = await verify(cid, files, { base, run: verifyRun, runId, aside: (rows) => setAside(id, round, rows) });
    const mem = v.rejected.length ? remember(v.rejected, { corpusId: cid }) : null;
    focus = new Set(v.rejected.map((r) => { const s = (corpus.load(cid)?.surfaces || []).find((x) => r.file.includes(`-${x.id}/`)); return s ? s.id : null; }).filter(Boolean));
    const row = { round, phase: round === 1 ? "broad" : "deep", packs: packs.length, sent, wrote: files.length, kept: v.kept, rejected: v.rejected, lessons: mem, coverage_pct: p.coverage_pct ?? null };
    report.rounds.push(row);
    report.kept += v.kept.length; report.rejected += v.rejected.length;
    episodes.write({ kind: "stage", verb: "genesis", stage: "genesis:practice", run_id: runId,
      features: { round, packs: packs.length, wrote: files.length, spend: spend ? 1 : 0 },
      rc: files.length ? 0 : 1, produced: v.kept.length, produces: ["scenarios", "lessons"], useful: files.length ? (v.kept.length ? 1 : 0) : -1,
      turns_saved: episodes.turns({ rows: v.kept.length + v.rejected.length }),
      detail: { kept: v.kept.length, rejected: v.rejected.length } });
    if (!files.length) { report.stopped = sent.every((s) => s.state === "done" || s.state === "sent") ? "no progress: the actor wrote nothing" : `nothing spent: ${sent.map((s) => s.why).filter(Boolean)[0] || sent[0]?.state || "no packs"}`; break; }
    if (!v.kept.length) { report.stopped = "no progress: the verifier kept nothing this round"; break; }
  }
  if (!report.stopped) report.stopped = `${rounds} round(s) done`;
  const after = plan(id);
  report.coverage_after = after.rc ? null : after.coverage_pct ?? null;
  fs.mkdirSync(DIR(id), { recursive: true });
  writeJson(path.join(DIR(id), "practice.json"), report);
  return { rc: 0, ...report, file: rel(path.join(DIR(id), "practice.json")) };
}

export const last = (id) => readJson(path.join(DIR(id), "practice.json"), null);
