// janitor/parse.js — the frontend. Four stores in, one IR out.
//
// A compiler frontend's whole job is to stop the rest of the compiler caring
// where anything came from. The four stores an agent's memory is smeared
// across have nothing in common — one is markdown a human wrote, one is JSON a
// harness wrote, one is an append-only log, one is a directory of skills — and
// after this file none of the passes know which is which.
//
//   memory      markdown the agent reads at the top of every session:
//               MEMORY.md, the per-project memory files, CLAUDE.md and
//               AGENTS.md anywhere in the tree and in the agent's home.
//   wiring      what is installed in front of the agent: skills, hook rules,
//               the instruction blocks `bb wire` injects. Vercel's evaluation
//               found 56% of skills are never invoked, and an uninvoked skill
//               is not free — it is billed on every turn it sits in the window.
//   transcripts what the sessions actually did. Two uses: episodes, and the
//               ROOTS the mark pass traces from.
//   var         this factory's own store. JSONL that only ever grows.
//
// Classification is deterministic and ordered, and the order is the safety
// property: a line that reads as a rule is a rule even when it also carries a
// file path, because misfiling a rule as a fact hands it to a pass that is
// allowed to rewrite it.
//
// Zero tokens. Every input is a file that already exists on this disk.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, VAR, rel } from "../core/paths.js";
import { make, terms } from "./heap.js";
import { text as estimateText } from "../tokens/estimate.js";

const HOME = os.homedir();
export const AGENT_HOME = path.join(HOME, ".claude");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "__pycache__", ".venv", "venv", ".next", "out", "coverage"]);
const MEMORY_NAMES = /^(CLAUDE|AGENTS|MEMORY|GEMINI|AGENT)\.md$/i;

// How Claude Code names a workspace's directory under ~/.claude/projects. This
// is the same rule as `slug` in ../adapters/claude.js and is repeated here on
// purpose: importing it pulls in the adapter registry, which is a deliberate
// import cycle that only resolves when something else has loaded it first, and
// a frontend that works from the CLI and throws under the test runner is worse
// than one duplicated line.
const projectSlug = (p) => String(p).replace(/[/\\:._]/g, "-");

const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mtime = (f) => { try { return new Date(fs.statSync(f).mtimeMs).toISOString(); } catch { return null; } };

/** Walk, bounded. A memory sweep that descends into node_modules is a memory
 *  sweep nobody runs twice. */
function walk(dir, { depth = 6, match = () => true, limit = 4000 } = {}) {
  const found = [];
  const stack = [[dir, 0]];
  while (stack.length && found.length < limit) {
    const [d, lvl] = stack.pop();
    if (lvl > depth) continue;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".bundlebox")) stack.push([p, lvl + 1]); continue; }
      if (match(e.name, p)) found.push(p);
    }
  }
  return found;
}

// ── classification ──────────────────────────────────────────────────────────

// Normative wording, and only near the front of the block. The loose version of
// this regex classified 1067 of 5736 objects as rules, which is not a heap with
// a thousand constraints in it — it is a heap full of prose containing the word
// "must". A rule is written like a rule: the directive is the first thing said.
// Being wrong in this direction is the expensive one, because the compactor is
// forbidden from touching a rule and the placement pass pins every one it is
// handed, so a misclassified paragraph is billed at the head of every window.
const RULE_RE = /\b(never|always|must not|must|do not|don't|shall not|cannot|may not|are not allowed|is not allowed|forbidden|only ever|under no circumstance|required)\b/i;
const RULE_HEAD = 72;      // how far into a block the directive has to appear
const RULE_MAX = 420;      // a rule long enough to be a paragraph is a paragraph
const URL_RE = /\bhttps?:\/\/[^\s)<>"']+/i;
// A path with a real extension, optionally :line — the only anchor the
// resolver can check for free.
// The trailing lookahead is the whole correctness of this regex. Without it
// `github.com` matches as the file `github.c` and every URL in the heap becomes
// a fact with a dead anchor.
const ANCHOR_RE = /(?:^|[\s`(<"'])((?:[\w.@-]+\/)*[\w@-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|rb|java|kt|swift|c|h|cpp|hpp|sh|sql|toml|yml|yaml|json|md))(?![A-Za-z0-9])(?::(\d+))?/;
const SYMBOL_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)`/;
const EPISODE_RE = /\b(shipped|merged|landed|released|fixed|reverted|migrated|deprecated|renamed|deleted|added|on \d{4}-\d{2}-\d{2}|as of \d{4}-\d{2}-\d{2}|v\d+\.\d+\.\d+)\b/i;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** Order is the contract: rule, pointer, fact, episode, note. */
export function classify(text) {
  const t = String(text || "");
  if (t.length <= RULE_MAX && RULE_RE.test(t.slice(0, RULE_HEAD))) return "rule";
  if (URL_RE.test(t) && t.length < 400) return "pointer";
  if (ANCHOR_RE.test(t) || SYMBOL_RE.test(t)) return "fact";
  if (EPISODE_RE.test(t)) return "episode";
  return "note";
}

// A claim with a specific number in it and nothing to check it against. Not a
// classification — a `note` stays a note — but the one shape of unanchored
// statement that reads as authoritative and cannot ever be proved stale.
const ASSERTION_RE = /\bv?\d+(?:\.\d+){1,2}\b|\b\d+(?:\.\d+)?\s?(?:%|ms|kb|mb|gb|x faster|tokens|rows|files)\b/i;
export const isUncheckableClaim = (o) => o.kind === "note" && !o.anchor && ASSERTION_RE.test(o.text);

/** The checkable part of a claim. `null` means the resolver has nothing to do
 *  and the object can never be quarantined for a dead anchor — which is itself
 *  a finding, because a fact nobody can check is a fact nobody can retract. */
export function anchorOf(text) {
  const t = String(text || "");
  const m = ANCHOR_RE.exec(t);
  if (m) return { file: m[1], line: m[2] ? Number(m[2]) : 0, symbol: (SYMBOL_RE.exec(t) || [])[1] || null };
  const s = SYMBOL_RE.exec(t);
  if (s) return { file: null, line: 0, symbol: s[1] };
  const u = URL_RE.exec(t);
  if (u) return { file: null, line: 0, symbol: null, url: u[0] };
  return null;
}

/** `[[wiki-links]]`, the one edge an agent memory file already writes by hand.
 *  The mark pass traces these, so a memory nothing links to and nothing cites
 *  is genuinely unreachable rather than merely quiet. */
export const linksOf = (text) => [...String(text || "").matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());

// ── markdown → objects ──────────────────────────────────────────────────────

/** One object per bullet or paragraph, never per line: a rule wrapped across
 *  three lines is one rule, and splitting it is how the exact wording that
 *  makes it enforceable gets lost. Fenced code is skipped — it is an example,
 *  not a claim. */
export function blocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let buf = [], start = 0, fence = false, heading = "";
  const flush = () => {
    const body = buf.join(" ").replace(/\s+/g, " ").trim();
    if (body.length > 3) out.push({ text: body, line: start + 1, heading });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*```/.test(raw)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    if (/^\s*#{1,6}\s/.test(raw)) { flush(); heading = raw.replace(/^\s*#+\s*/, "").trim(); continue; }
    if (!raw.trim()) { flush(); continue; }
    // A table is rows, not a paragraph. Joining one into a single block put
    // every claim in it on the line of the header, which is the one line that
    // states nothing. The `|---|` separator carries no claim at all.
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      flush();
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(raw)) out.push({ text: raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" — "), line: i + 1, heading });
      continue;
    }
    if (/^\s*[-*+]\s|^\s*\d+\.\s/.test(raw)) { flush(); start = i; buf.push(raw.replace(/^\s*(?:[-*+]|\d+\.)\s*/, "")); continue; }
    if (!buf.length) start = i;
    buf.push(raw.trim());
  }
  flush();
  return out;
}

/** Frontmatter as a flat dict. Only the keys the memory format actually uses;
 *  a YAML parser is a dependency and this is four keys. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s{0,4}([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2]) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function fromMarkdown(file, { gen, store }) {
  const text = readText(file);
  if (text == null) return [];
  const fm = frontmatter(text);
  const src = file.startsWith(ROOT) ? rel(file) : file.replace(HOME, "~");
  const learned = mtime(file);
  return blocks(text).map((b) => {
    const kind = classify(b.text);
    const dated = DATE_RE.exec(b.text);
    return make({
      kind,
      text: b.text,
      source: src,
      line: b.line,
      anchor: anchorOf(b.text),
      learned_at: learned,
      valid_from: dated ? dated[1] : learned,
      gen,
      tokens: estimateText(b.text),
      refs: linksOf(b.text),
      meta: { store, heading: b.heading, name: fm.name || "", mtype: fm.type || "" },
    });
  });
}

// ── collectors ──────────────────────────────────────────────────────────────

/** The markdown an agent loads before it has read a single line of code. This
 *  is the heap that actually rots over 3 to 12 months: nothing in any harness
 *  ever revisits it, so a fact written in month one is still being quoted with
 *  full confidence in month ten. */
export function collectMemory({ home = AGENT_HOME, root = ROOT, allProjects = false } = {}) {
  const files = [];
  // The agent's own home: global instructions, and the memory for THIS
  // workspace. Not every project's — a sweep run from one repo that retracts
  // another repo's memory is a sweep that has to be explained, and the ids and
  // the tombstones would be written into this workspace's store where the other
  // repo will never see them. `--all-projects` is the deliberate opt-in.
  if (isDir(home)) {
    for (const f of ["CLAUDE.md", "AGENTS.md"]) { const p = path.join(home, f); if (fs.existsSync(p)) files.push([p, "old"]); }
    const projects = path.join(home, "projects");
    if (isDir(projects)) {
      const mine = projectSlug(root);
      for (const proj of walk(projects, { depth: 3, match: (n) => MEMORY_NAMES.test(n) || n.endsWith(".md"), limit: 800 })) {
        const which = path.relative(projects, proj).split(path.sep)[0] || "";
        if (!allProjects && which !== mine && !which.startsWith(`${mine}-`)) continue;
        if (proj.includes(`${path.sep}memory${path.sep}`) || MEMORY_NAMES.test(path.basename(proj))) files.push([proj, "old"]);
      }
    }
  }
  // The tree itself: every CLAUDE.md / AGENTS.md a repo carries.
  for (const f of walk(root, { depth: 5, match: (n) => MEMORY_NAMES.test(n), limit: 200 })) files.push([f, "middle"]);
  const seen = new Set();
  const objs = [];
  for (const [f, gen] of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    objs.push(...fromMarkdown(f, { gen, store: "memory" }));
  }
  return objs;
}

/** Skills, hook rules and injected instruction blocks. Each is one object, not
 *  one per line: the unit that gets installed or removed is the whole file, and
 *  a skill is reached or not reached as a whole. */
export function collectWiring({ home = AGENT_HOME, root = ROOT } = {}) {
  const objs = [];
  const add = (file, label, gen) => {
    const text = readText(file);
    if (text == null) return;
    const fm = frontmatter(text);
    const name = fm.name || path.basename(path.dirname(file)) || path.basename(file);
    const desc = (fm.description || blocks(text)[0]?.text || "").slice(0, 300);
    objs.push(make({
      kind: "pointer",
      text: `${label} ${name} — ${desc}`,
      source: file.startsWith(ROOT) ? rel(file) : file.replace(HOME, "~"),
      line: 1,
      anchor: { file: file.startsWith(ROOT) ? rel(file) : file, line: 0, symbol: null },
      learned_at: mtime(file),
      gen,
      tokens: estimateText(text),
      meta: { store: "wiring", surface: label, name, bytes: text.length },
    }));
  };
  for (const base of [home, path.join(root, ".claude")]) {
    const skills = path.join(base, "skills");
    if (isDir(skills)) for (const f of walk(skills, { depth: 3, match: (n) => n === "SKILL.md", limit: 400 })) add(f, "skill", base === home ? "old" : "middle");
    const plugins = path.join(base, "plugins");
    if (isDir(plugins)) for (const f of walk(plugins, { depth: 5, match: (n) => n === "SKILL.md", limit: 400 })) add(f, "skill", "old");
    const hooks = path.join(base, "hooks");
    if (isDir(hooks)) for (const f of walk(hooks, { depth: 2, match: (n) => n.endsWith(".json") || n.endsWith(".md"), limit: 200 })) add(f, "hook", base === home ? "old" : "middle");
  }
  // Hook and MCP entries declared in settings, one object each: they are billed
  // per turn and nothing ever re-reads them.
  for (const s of ["settings.json", "settings.local.json"]) {
    for (const base of [home, path.join(root, ".claude")]) {
      const f = path.join(base, s);
      const text = readText(f);
      if (text == null) continue;
      let cfg; try { cfg = JSON.parse(text); } catch { continue; }
      for (const [evt, arr] of Object.entries(cfg.hooks || {})) {
        for (const entry of [].concat(arr || [])) {
          for (const h of [].concat(entry.hooks || [])) {
            objs.push(make({
              kind: "rule", text: `hook ${evt} ${entry.matcher || "*"} → ${String(h.command || h.type || "").slice(0, 200)}`,
              source: f.replace(HOME, "~"), line: 1, learned_at: mtime(f), gen: "old",
              tokens: estimateText(String(h.command || "")), meta: { store: "wiring", surface: "hook", event: evt },
            }));
          }
        }
      }
    }
  }
  return objs;
}

/** Transcripts, read for two things: the episodes they contain, and the roots
 *  the mark pass traces from. Only the last `days` are parsed — a transcript
 *  from March is history, and history is what the var store is for. */
export function collectTranscripts({ days = 120, maxFiles = 400 } = {}) {
  const objs = [];
  const roots = { files: new Set(), terms: new Set(), at: new Map() };
  let entries = [];
  try { entries = require_transcripts(); } catch { entries = []; }
  const cutoff = Date.now() - days * 86400000;
  for (const t of entries.slice(0, maxFiles)) {
    const file = t && t.file;
    if (!file) continue;
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    const when = new Date(st.mtimeMs).toISOString();
    const text = readText(file);
    if (text == null) continue;
    // Every file path and quoted symbol a session mentioned is a root. This is
    // the reachability evidence; it is cheap because the transcript is on disk.
    const mine = new Set();
    for (const m of text.matchAll(/"(?:file_path|filePath|notebook_path)"\s*:\s*"([^"]+)"/g)) {
      mine.add(m[1]);
      const p = m[1].startsWith(ROOT) ? rel(m[1]) : m[1];
      roots.files.add(p);
      roots.files.add(path.basename(p));
      if (!roots.at.has(p) || roots.at.get(p) < when) roots.at.set(p, when);
    }
    for (const w of terms(text.slice(0, 400000))) roots.terms.add(w);
    const touched = mine.size;
    objs.push(make({
      kind: "episode",
      text: `session ${path.basename(file, ".jsonl").slice(0, 8)} on ${when.slice(0, 10)} touched ${touched} paths`,
      source: file.replace(HOME, "~"), line: 0, learned_at: when, gen: "young",
      tokens: 0, meta: { store: "transcripts", bytes: st.size, adapter: t.adapter || "" },
    }));
  }
  return { objects: objs, roots };
}

// The ledger is the only module that knows where each agent keeps transcripts.
// Imported lazily so a broken ledger costs the transcript collector and not the
// whole compiler — `bb janitor` on a box with no agent installed still runs.
let _ledger = null;
function require_transcripts() {
  if (!_ledger) return [];
  return _ledger.transcripts() || [];
}
export async function loadLedger() {
  try { _ledger = await import("../tokens/ledger.js"); } catch { _ledger = null; }
  return !!_ledger;
}

/** This factory's own store. Append-only JSONL that only grows, and documents
 *  that are rewritten whole. Rows become episodes, which is what they are; the
 *  point of holding them in the heap is that the warehouse can then ask one
 *  question across all four stores instead of four questions across one. */
export function collectVar({ dir = VAR, maxRows = 2000 } = {}) {
  const objs = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return objs; }
  for (const n of names) {
    const f = path.join(dir, n);
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    if (n.endsWith(".jsonl")) {
      const text = readText(f);
      if (text == null) continue;
      const lines = text.split(/\r?\n/).filter(Boolean);
      // One object per FILE plus a bounded sample of rows. Ten thousand
      // episodes in the IR would make every pass quadratic for no new fact.
      objs.push(make({
        kind: "episode", text: `${n} — ${lines.length} rows, ${st.size} bytes, append-only`,
        source: rel(f), line: 0, learned_at: new Date(st.mtimeMs).toISOString(), gen: "young",
        meta: { store: "var", rows: lines.length, bytes: st.size, jsonl: true },
      }));
      for (const line of lines.slice(-Math.min(maxRows / Math.max(1, names.length), 200))) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        const when = r.ts || r.at || r.time || new Date(st.mtimeMs).toISOString();
        objs.push(make({
          kind: "episode", text: `${n.replace(/\.jsonl$/, "")} ${JSON.stringify(r).slice(0, 220)}`,
          source: rel(f), line: 0, learned_at: when, valid_from: when, gen: "young",
          meta: { store: "var", row: true },
        }));
      }
    } else if (n.endsWith(".json")) {
      objs.push(make({
        kind: "note", text: `${n} — ${st.size} bytes, rewritten whole`,
        source: rel(f), line: 0, learned_at: new Date(st.mtimeMs).toISOString(), gen: "young",
        meta: { store: "var", bytes: st.size, doc: true },
      }));
    }
  }
  return objs;
}

/** Run every collector the options ask for. The stores are independent, so one
 *  that throws costs its own objects and nothing else. */
export async function parse({ stores = ["memory", "wiring", "transcripts", "var"], root = ROOT, home = AGENT_HOME, days = 120, allProjects = false } = {}) {
  const objects = [];
  const errors = [];
  let roots = { files: new Set(), terms: new Set(), at: new Map() };
  const want = new Set(stores);
  const step = (name, fn) => { if (!want.has(name)) return; try { objects.push(...fn()); } catch (e) { errors.push({ store: name, error: String(e && e.message || e) }); } };
  step("memory", () => collectMemory({ home, root, allProjects }));
  step("wiring", () => collectWiring({ home, root }));
  if (want.has("transcripts")) {
    try { await loadLedger(); const r = collectTranscripts({ days }); objects.push(...r.objects); roots = r.roots; }
    catch (e) { errors.push({ store: "transcripts", error: String(e && e.message || e) }); }
  }
  step("var", () => collectVar());
  return { objects, roots, errors };
}
