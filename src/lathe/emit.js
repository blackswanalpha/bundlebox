// lathe/emit.js — the model turned into things that run.
//
// Four artefacts, and one rule they all obey: every row names the support
// behind it. A proposal with no count is a suggestion, and this file does not
// make suggestions — it reports what the workspace already did, often enough
// that doing it by hand again is a choice.
//
// Nothing here is executable on arrival. A script is written as a PROPOSAL with
// its tags filled in from the pattern, because the sequence model knows what ran
// and in what order and cannot know whether running it unattended is safe. That
// judgement is the one thing left for a person, and it is cheap once the body is
// already written.
import fs from "node:fs";
import path from "node:path";
import { OUT, rel } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { human } from "../core/util.js";
import { latest as oversightLatest } from "../oversight/rules.js";
import { clean } from "../slop/index.js";

export const DIR = () => path.join(OUT, "lathe");
const file = (...p) => path.join(DIR(), ...p);

/** Which artefacts are on disk now. */
export function onDisk() {
  const want = ["scripts.md", "snippets.md", "autocomplete.md", "boilerplate.md"];
  return want.map((n) => file(n)).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });  // absence is the answer
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// ── 1. scriptag: a habit, as a tagged script ────────────────────────────────

/** `bb scripts` indexes an executable by a header of `@tag`, `@title`,
 *  `@needs`, `@produces`, `@turns`. Every one of those is something the
 *  sequence model measured, so the header writes itself:
 *
 *    @turns is the pattern's LENGTH, because that is the number of turns a
 *    session spent on it, and it is recorded as an estimate — doctrine 3 — never
 *    added to counted turns.
 *    @needs is the binaries the commands name.
 *    @tag is `lathe`, so `bb scripts` can list what was proposed rather than
 *    written by a person. */
export function scriptFor(pattern, { kind = "shell" } = {}) {
  const items = pattern.items || [];
  const name = slug(items.join("-")) || "habit";
  const body = kind === "verb" ? items.map((v) => `bb ${v} --apply`) : items;
  const needs = [...new Set(body.map((c) => String(c).trim().split(/\s+/)[0]).filter(Boolean))];
  const header = [
    "#!/usr/bin/env bash",
    "# @tag lathe",
    `# @title ${items.join(" → ")}`,
    `# @needs ${needs.join(",")}`,
    `# @turns ${items.length}`,
    `# @cost 0`,
    "# @safe false",
    "#",
    `# PROPOSED by ${"LATHE-1"} from ${pattern.support} occurrence(s) across ${pattern.sessions} session(s)`,
    `# ${pattern.lift ? `lift ${pattern.lift} over the base rate of \`${items[items.length - 1]}\`; ` : ""}confidence ${pattern.confidence} that the run continues this way once it has started.`,
    "#",
    "# Not run by anything until a person moves it into scripts/ and sets @safe.",
    "# The model knows what ran and in what order. Whether running it unattended",
    "# is safe is not in the data.",
    "set -euo pipefail",
    "",
  ];
  return { name: `${name}.sh`, text: header.concat(body).join("\n") + "\n", needs, turns: items.length };
}

export function scripts(model, { minSupport = 3 } = {}) {
  const rows = [];
  for (const [kind, list] of [["verb", model.sequence?.verbs || []], ["shell", model.sequence?.shell || []]]) {
    for (const p of list) {
      if ((p.support || 0) < minSupport) continue;
      rows.push({ kind, pattern: p, script: scriptFor(p, { kind }) });
    }
  }
  const L = ["# scriptag — the habits this workspace has, as scripts it could run", "",
    `From ${model.name}. A row is here because it happened at least ${minSupport} times. \`@turns\` is what the`,
    "script displaces and is recorded as an ESTIMATE; nothing adds it to counted turns.", "",
    "Move one into `scripts/` and set `@safe true` to make it a row `bb scripts` can run and a gear can gate on.", "",
    "| habit | occurrences | sessions | confidence | lift | turns | proposed file |",
    "|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    L.push(`| \`${r.pattern.items.join(r.kind === "verb" ? " → " : " ; ")}\` | ${r.pattern.support} | ${r.pattern.sessions} | ${r.pattern.confidence} | ${r.pattern.lift ?? "-"} | ${r.script.turns} | \`${r.script.name}\` |`);
  }
  if (!rows.length) L.push(`| - | - | - | - | - | - | nothing ran ${minSupport} times yet: \`bb lathe learn\` after a few sessions |`);
  for (const r of rows) L.push("", `## ${r.script.name}`, "", "```bash", r.script.text.trimEnd(), "```");
  return { text: L.join("\n") + "\n", count: rows.length };
}

// ── 2. snippets: what the tree already repeats ──────────────────────────────

/** From the oversight scan's duplicate windows, which are already computed and
 *  stored. Nothing is re-derived here: a snippet is a region two files share,
 *  and the scan measured exactly that. */
export function snippets({ cap = 20 } = {}) {
  const doc = oversightLatest();
  const pairs = (doc?.dupes?.pairs || []).slice(0, cap);
  const L = ["# snippets — the regions this tree already repeats", "",
    doc ? `From the oversight scan of ${String(doc.at).slice(0, 10)}. Each row is a window two files share, measured` : "No oversight scan on file: `bb oversight scan --write`.",
    doc ? "line for line. A third occurrence is the point at which copying it again costs more than naming it." : "", "",
    "| shared lines | a | b | what to do |",
    "|---|---|---|---|"];
  for (const p of pairs) {
    L.push(`| ${p.shared_lines} | \`${rel(p.a)}\` | \`${rel(p.b)}\` | name it once and call it from both, or state in one line why the duplication is deliberate |`);
  }
  if (!pairs.length) L.push("| - | - | - | nothing measured repeats |");
  return { text: L.join("\n") + "\n", count: pairs.length };
}

// ── 3. boilerplate: the tree's own conventions, extracted ───────────────────

/** The longest run of leading lines that a group of files SHARES.
 *
 *  This is the same sequence miner the habits use, with lines as items instead
 *  of commands, which is why it needs no template language and no guessing: a
 *  prologue is a contiguous pattern over file heads, and the most common one IS
 *  the convention. A convention nobody follows twice does not appear. */
export function commonPrologue(runs, { minFiles = 3 } = {}) {
  if (runs.length < minFiles) return null;
  const best = [];
  // Grow line by line from the first line, keeping what enough files share.
  for (let len = 1; len <= 14; len++) {
    const counts = new Map();
    for (const r of runs) {
      if (r.length < len) continue;
      const key = r.slice(0, len).join("\n");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let top = null;
    for (const [k, n] of counts) if (!top || n > top.n) top = { k, n };
    if (!top || top.n < minFiles) break;
    best.length = 0;
    best.push({ lines: top.k.split("\n"), files: top.n });
  }
  return best.length ? best[0] : null;
}

export async function boilerplate({ minFiles = 3 } = {}) {
  const { prologues } = await import("./index.js");
  const { codeFiles } = await import("../snapgen/tables.js");
  const all = codeFiles().map(rel);
  // Groups the tree declares by its own layout: the test directory, and each
  // source subdirectory. Nothing invented; a group with too few files has no
  // convention to extract.
  const groups = new Map();
  for (const f of all) {
    const parts = f.split("/");
    const key = /^(test|tests|spec|__tests__)$/.test(parts[0]) ? "test"
      : parts.length >= 3 && /^(src|lib|app|packages|internal|pkg)$/.test(parts[0]) ? `${parts[0]}/${parts[1]}`
      : parts[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const rows = [];
  for (const [key, files] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    if (files.length < minFiles) continue;
    const p = commonPrologue(prologues(files), { minFiles });
    if (!p || p.lines.length < 2) continue;
    rows.push({ group: key, files: files.length, shared: p.files, lines: p.lines });
  }
  const L = ["# boilerplate — what a new file in this tree starts with", "",
    "Extracted, not written: each block is the longest run of leading lines that at least",
    `${minFiles} files in that group already share, found with the same closed-sequence miner the habits use.`,
    "A convention nobody followed twice does not appear here.", ""];
  for (const r of rows.slice(0, 12)) {
    L.push(`## \`${r.group}\` — ${r.shared} of ${r.files} files start this way`, "", "```", ...r.lines, "```", "");
  }
  if (!rows.length) L.push("No group of files shares a prologue. Either the tree is small or its files genuinely differ.");
  return { text: L.join("\n") + "\n", count: rows.length };
}

// ── 4. autocomplete: the tree's own names, ranked by how certain they are ───

export function autocomplete(model, { cap = 300 } = {}) {
  const px = model.completion?.prefixes || [];
  const certain = px.filter((p) => p.certain);
  const near = px.filter((p) => !p.certain).slice(0, cap);
  const L = ["# autocomplete — the prefixes this tree can finish for you", "",
    `From ${model.name} over ${model.inputs?.declarations || 0} declarations in the compiled index.`,
    "A prefix is listed when its continuations are few enough that finishing it is a prediction rather",
    "than a menu: `certain` resolves to exactly one name, and entropy is the bits of choice left.", "",
    `## Certain — one continuation only (${certain.length})`, "",
    "| type this | and it is |", "|---|---|"];
  for (const p of certain.slice(0, cap)) L.push(`| \`${p.prefix}\` | \`${p.names[0]}\` |`);
  if (!certain.length) L.push("| - | no prefix in this tree resolves to exactly one name |");
  L.push("", `## Narrow — a short menu (${near.length})`, "", "| this | bits | is one of |", "|---|---|---|");
  for (const p of near) L.push(`| \`${p.prefix}\` | ${p.entropy} | ${p.names.map((n) => `\`${n}\``).join(", ")} |`);
  if (!near.length) L.push("| - | - | nothing narrow enough to list |");
  return { text: L.join("\n") + "\n", count: certain.length + near.length };
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function all(model, { apply = false, minSupport = 3 } = {}) {
  const built = [
    ["scripts.md", scripts(model, { minSupport }), "habits, as tagged scripts"],
    ["snippets.md", snippets({}), "regions the tree repeats"],
    ["boilerplate.md", await boilerplate({}), "what a new file starts with"],
    ["autocomplete.md", autocomplete(model, {}), "prefixes with one continuation"],
  ];
  const rows = [];
  for (const [name, r, what] of built) {
    const p = file(name);
    const text = clean(r.text);
    let state = "write";
    let before = null;
    try { before = fs.readFileSync(p, "utf8"); } catch { /* not there yet */ }
    if (before === text) state = "unchanged";
    else if (before != null) state = "update";
    if (apply && state !== "unchanged") { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(p, text); }
    rows.push({ path: p, state: apply && state !== "unchanged" ? "wrote" : state, what: `${r.count} — ${what}`, count: r.count, tokens: Math.round(text.length / 4) });
  }
  if (apply) {
    // Compared before it is written, like every other artefact here. It used to
    // be written unconditionally, which made a re-emit of an unchanged model
    // report that it had rewritten the index — a diff where there was no change.
    const index = ["# lathe — what this workspace automates without an agent", "",
      `${model.name}, learned ${model.learned_at}. Every artefact below was derived from stored measurements;`,
      "nothing here called a model and nothing here cost a token.", "",
      "| artefact | rows | ~tokens | what |", "|---|---|---|---|",
      ...rows.map((r) => `| [\`${path.basename(r.path)}\`](${path.basename(r.path)}) | ${r.count} | ${human(r.tokens)} | ${r.what.split(" — ")[1]} |`),
      "", `Re-learn with \`bb lathe learn\`, re-emit with \`bb lathe build --apply\`. Both run locally for nothing.`,
    ].join("\n") + "\n";
    let prev = null;
    try { prev = fs.readFileSync(file("INDEX.md"), "utf8"); } catch { /* not there yet */ }
    if (prev !== index) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(file("INDEX.md"), index); }
    rows.push({ path: file("INDEX.md"), state: prev === index ? "unchanged" : "wrote", what: `${rows.length} — the index`, count: rows.length, tokens: Math.round(index.length / 4) });
  }
  return { apply, rows };
}
