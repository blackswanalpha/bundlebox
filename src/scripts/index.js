// scripts/index.js — index the executables that already exist, and run them
// under the contract they declared.
//
// A header comment of `@tag`, `@title`, `@needs`, `@produces`, `@on`, `@cost`,
// `@turns`, `@safe` turns a script into a row a gear can gate on and a session
// can look up instead of opening it. Only the first HEADER_LINES are read: a
// script is a program, not a document. A candidate is something in bin/ or
// scripts/, a *.sh anywhere, or a file that starts with a shebang: the file
// declaring itself runnable is exactly the claim being indexed, and "ends in
// .js" is not that claim.
//
// `@turns` is what the author BELIEVES the script displaces. It is recorded as
// ESTIMATE and never added to counted turns (doctrine 3).
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import { run as exec, which } from "../core/exec.js";
import { ROOT, OUT, rel, abs } from "../core/paths.js";
import { walk } from "../core/fs.js";
import { out, emit, warn } from "../core/log.js";
import { now, pad } from "../core/util.js";
import { fingerprint } from "../kit/cache.js";
import * as episodes from "../learn/episodes.js";

export const TAGS = new Set(["tag", "title", "needs", "produces", "on", "cost", "turns", "safe", "gear"]);
const LIST_TAGS = new Set(["needs", "produces", "on"]);
export const HEADER_LINES = 80;
const TAG_LINE = /^\s*(?:#|\/\/|--|\*)+\s*@(\w+)\s*:?\s*(.*?)\s*$/;
const SHEBANG_SUFFIX = [".js", ".mjs", ".cjs", ".py", ".ts", ".rb", ".pl", ".bash", ".zsh", ".fish", ""];

export function hasShebang(p) {
  let fd;
  try { fd = fs.openSync(p, "r"); const b = Buffer.alloc(2); const n = fs.readSync(fd, b, 0, 2, 0); return n === 2 && b[0] === 0x23 && b[1] === 0x21; } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function candidates() {
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) seen.add(p); };
  for (const d of ["bin", "scripts"]) for (const p of walk(abs(d), { suffixes: [] })) add(p);
  for (const p of walk(ROOT, { suffixes: [".sh"] })) add(p);
  for (const p of walk(ROOT, { suffixes: SHEBANG_SUFFIX.filter(Boolean) })) if (!seen.has(p) && hasShebang(p)) add(p);
  return [...seen].sort();
}

/** The header block, or null when the file carries no `@tag`. */
export function parse(p) {
  let head;
  try { head = fs.readFileSync(p, "utf8").split("\n", HEADER_LINES); } catch { return null; }
  const got = {}, unknown = [];
  for (const line of head) {
    const m = TAG_LINE.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!TAGS.has(key)) { unknown.push(key); continue; }
    got[key] = LIST_TAGS.has(key) ? m[2].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : m[2];
  }
  if (!got.tag) return null;
  const warnings = [];
  let turns = null;
  if (got.turns !== undefined) {
    const n = Number(String(got.turns).trim());
    if (Number.isFinite(n) && n >= 0) turns = n;
    else warnings.push(`@turns is not a number: "${got.turns}"`);
  }
  if (!got.title) warnings.push("@tag with no @title: a row that says nothing");
  if (unknown.length) warnings.push(`unknown tags ignored: ${unknown.join(", ")}`);
  return {
    tag: String(got.tag).trim(), path: rel(p), title: got.title || "", needs: got.needs || [], produces: got.produces || [], on: got.on || [],
    gear: got.gear || "", cost: got.cost || "", turns, turns_kind: "ESTIMATE",
    safe: ["yes", "true", "1"].includes(String(got.safe || "").trim().toLowerCase()),
    fingerprint: fingerprint([p]), warnings,
  };
}

/** Rebuild the index. A row whose file is gone, or no longer tagged, is
 *  removed and reported: a stale index sends a gear to a script that is not there. */
export function scan({ write = true } = {}) {
  const prior = store.get("scripts", []);
  const rows = [], untagged = [], warnings = [];
  for (const p of candidates()) {
    const r = parse(p);
    if (!r) { untagged.push(rel(p)); continue; }
    for (const w of r.warnings) warnings.push({ path: r.path, tag: r.tag, warning: w });
    rows.push(r);
  }
  const seen = {};
  for (const r of rows) {
    if (seen[r.tag]) warnings.push({ path: r.path, tag: r.tag, warning: `duplicate tag: also ${seen[r.tag]}` });
    seen[r.tag] = r.path;
  }
  const current = new Set(rows.map((r) => r.path));
  const removed = (Array.isArray(prior) ? prior : []).filter((r) => r && !current.has(r.path)).map((r) => r.path);
  if (write) store.put("scripts", rows);
  return { at: now(), tagged: rows.length, untagged: untagged.length, untagged_paths: untagged, removed, warnings, rows };
}

/** What the script says it needs and this box does not have. Path first,
 *  binary second: a need naming something in the workspace is not a package. */
export function missing(row) {
  const out = [];
  for (const need of row.needs || []) {
    if (fs.existsSync(abs(need))) continue;
    if (need.includes("/") || /\.\w+$/.test(need)) out.push(`path missing: ${need}`);
    else if (!which(need)) out.push(`binary missing: ${need}`);
  }
  return out;
}

export const one = (tag) => store.get("scripts", []).find((r) => r && r.tag === tag) || null;

export function check(tag) {
  const row = one(tag);
  if (!row) return { rc: 2, why: `no script tagged \`${tag}\`: bb scripts scan` };
  if (!fs.existsSync(abs(row.path))) return { rc: 2, why: `${row.path} is gone; the index is stale: bb scripts scan` };
  const miss = missing(row);
  return { rc: miss.length ? 1 : 0, missing: miss, row, why: miss.join("; ") };
}

/** Dry unless --apply. Needs are checked first: a refused run costs nothing
 *  and names what is missing; by hand it is a failed run and a read of the error. */
export function run(tag, { args = [], apply = false, timeout = 1800000, gear = "", runId = "" } = {}) {
  const c = check(tag);
  if (c.rc) return { tag, rc: c.rc, ran: false, why: c.why, missing: c.missing || [] };
  const row = c.row;
  const cmd = [abs(row.path), ...args.map(String)];
  if (!apply) return { tag, rc: 0, ran: false, would: cmd.join(" "), why: "dry run; --apply runs it" };
  const t0 = Date.now();
  const r = exec(cmd, { cwd: ROOT, timeout });
  const seconds = Math.round((Date.now() - t0) / 10) / 100;
  const ep = episodes.write({ kind: "script", verb: `script:${tag}`, stage: tag, gear, run_id: runId,
    features: { needs: row.needs.length, safe: row.safe ? 1 : 0, declared_turns: row.turns, declared_turns_kind: "ESTIMATE" },
    rc: r.rc, seconds, produced: r.rc === 0 ? 1 : 0, produces: row.produces, reads: row.needs, turns_saved: 0,
    detail: { cmd: cmd.slice(0, 4).join(" "), tail: (r.out || r.err).slice(-600), declared_turns: row.turns, declared_turns_kind: "ESTIMATE" } });
  const prior = store.get("scripts", []);
  store.put("scripts", prior.map((s) => (s.tag === tag ? { ...s, runs: (s.runs || 0) + 1, last_rc: r.rc, last_run: now() } : s)));
  return { tag, rc: r.rc, ran: true, seconds, out: r.out, err: r.err, missing_binary: r.missing, episode: ep.id, declared_turns: row.turns, declared_turns_kind: "ESTIMATE" };
}

export function tableText(rows = store.get("scripts", [])) {
  if (!rows.length) return "# scripts\n\n(nothing indexed: `bb scripts scan`)\n";
  const lines = ["# scripts — every tagged automation in this workspace", "", "Generated by `bb scripts table`. A script here runs as `bb scripts run <tag> --apply`, which checks its needs first.", "",
    "| tag | what it does | needs | cost | turns (ESTIMATE) | safe | path |", "|---|---|---|---|---|---|---|"];
  for (const r of [...rows].sort((a, b) => (a.gear || "~").localeCompare(b.gear || "~") || a.tag.localeCompare(b.tag))) {
    lines.push(`| \`${r.tag}\` | ${r.title || "—"} | ${r.needs.join(", ") || "—"} | ${r.cost || "—"} | ${r.turns ?? "—"} | ${r.safe ? "yes" : "no"} | \`${r.path}\` |`);
  }
  return lines.join("\n") + "\n";
}

function scanText(r) {
  const lines = [`  SCRIPTS — ${r.tagged} tagged, ${r.untagged} untagged${r.removed.length ? `, ${r.removed.length} removed from the index` : ""}`, ""];
  for (const row of [...r.rows].sort((a, b) => a.tag.localeCompare(b.tag))) {
    const miss = missing(row);
    lines.push(`  ${miss.length ? "!" : " "}  ${pad(row.tag, 18)} ${pad((row.title || "").slice(0, 52), 52)} ${pad(row.cost || "", 8)} ${row.turns != null ? `${row.turns}t ESTIMATE` : ""}`);
    if (miss.length) lines.push(`       needs: ${miss.join("; ")}`);
  }
  for (const w of r.warnings) lines.push(`  ! ${w.path}: ${w.warning}`);
  for (const p of r.removed) lines.push(`  - removed: ${p}`);
  if (r.untagged) { lines.push("", `  ${r.untagged} scripts carry no @tag; invisible to every gear and session. First five:`); for (const p of r.untagged_paths.slice(0, 5)) lines.push(`    ${p}`); }
  return lines.join("\n");
}

async function scriptsCmd({ _, flags, rest = [] }) {
  const sub = _[0] || "list";
  if (sub === "scan") {
    const r = scan({ write: true });
    if (flags.json) { emit(r); return 0; }
    out(scanText(r));
    return 0;
  }
  if (sub === "list") {
    const rows = store.get("scripts", []);
    if (flags.json) { emit({ scripts: rows }); return 0; }
    if (!rows.length) { out("  nothing indexed: bb scripts scan"); return 0; }
    for (const r of rows) out(`  ${pad(r.tag, 18)} ${pad((r.title || "").slice(0, 50), 50)} ${pad(r.safe ? "safe" : "", 5)} ${r.runs ? `${r.runs} runs` : ""}  ${r.path}`);
    return 0;
  }
  if (sub === "run") {
    const tag = _[1];
    if (!tag) { warn("which script? bb scripts run <tag> [--apply] [-- args]"); return 2; }
    const r = run(tag, { args: rest, apply: !!flags.apply });
    if (flags.json) { emit(r); return r.rc; }
    if (!r.ran) { out(`  ${tag}: ${r.why}${r.would ? `\n    would run: ${r.would}` : ""}`); return r.rc; }
    out(`  ${tag} — ${r.rc === 0 ? "ok" : `rc ${r.rc}`} in ${r.seconds}s; declared ${r.declared_turns ?? "—"} turns ESTIMATE`);
    for (const l of String(r.out || r.err || "").trim().split("\n").slice(-6)) out(`    ${l.slice(0, 110)}`);
    return r.rc;
  }
  if (sub === "table") {
    const text = tableText();
    if (flags.write) { const p = path.join(OUT, "scripts", "index.md"); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); out(`  wrote ${rel(p)}`); return 0; }
    out(text);
    return 0;
  }
  warn(`unknown scripts sub-verb: ${sub}. scan | list | run <tag> | table`);
  return 2;
}

export const commands = {
  scripts: {
    help: "index tagged scripts (@tag/@title/@needs/...) and run them with their needs checked",
    usage: "bb scripts scan | list | run <tag> [--apply] | table [--write] [--json]",
    run: scriptsCmd,
  },
};
