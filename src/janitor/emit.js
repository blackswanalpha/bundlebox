// janitor/emit.js — the backend. Four artefacts, one for each kind of reader.
//
//   WINDOW.md         the target. The placed image an agent loads instead of
//                     reading four stores at the top of a session. Ordered by
//                     the placement pass, so the file is not in a readable
//                     order and is not meant to be — position is allocation.
//   HEAP.md           the same heap for a human: what is in it, what rotted,
//                     what was reclaimed and why.
//   heap.jsonl        every object including the retracted ones. The warehouse
//                     reads this, and so does the next run — a compile that
//                     forgets what it retracted last week re-learns it.
//   diagnostics.json  the compiler output, in the shape a hook can act on.
//
// Every artefact is rewritten whole and fingerprinted by the content it was
// built from, so a second run that changes nothing writes nothing.
import fs from "node:fs";
import path from "node:path";
import { OUT, VAR, ensureDirs } from "../core/paths.js";
import { writeJson, readJson } from "../core/config.js";
import { now, sha1, human, pad, table } from "../core/util.js";
import { warn } from "../core/log.js";
import { HALF_LIFE, KINDS } from "./heap.js";

export const DIR = () => path.join(OUT, "janitor");
export const TOMBS = () => path.join(VAR, "janitor-tombstones.jsonl");
export const STATE = () => path.join(VAR, "janitor.json");

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = (() => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } })();  // not written yet
  if (prev === text) return false;
  fs.writeFileSync(file, text);
  return true;
};

const sev = { error: "E", warning: "W", note: "N" };
const bySeverity = (ds) => ({
  error: ds.filter((d) => d.severity === "error").length,
  warning: ds.filter((d) => d.severity === "warning").length,
  note: ds.filter((d) => d.severity === "note").length,
});

// ── the window ──────────────────────────────────────────────────────────────

/** The emitted image. Rules first in full, the ranked remainder dealt around
 *  the dead zone, rules recalled at the tail. The banner says what the order is
 *  for, because an agent that reorders this file by topic undoes the pass. */
export function windowText(placed, stats, { title = "compiled memory" } = {}) {
  const L = [];
  L.push(`# ${title}`);
  L.push("");
  L.push(`Compiled by \`bb janitor\` at ${now()}. ${placed.length} objects, ${human(stats.tokens)} tokens against a ${human(stats.budget)} budget.`);
  L.push("");
  L.push("Ordered by attention, not by topic: the highest-value claims are at the two ends and the");
  L.push("lowest-value ones are in the middle, because a context window is not read uniformly. Rules are");
  L.push("stated in full at the top and recalled in one line at the bottom. Do not re-sort this file.");
  L.push("");
  let band = "";
  for (const o of placed) {
    if (o.band !== band) {
      band = o.band;
      L.push("");
      L.push(band === "head" ? "## rules — in force, stated in full"
        : band === "tail" ? "## rules — recall"
        : band === "front" ? "## what is true, most-used first"
        : "## what is true, continued");
      L.push("");
    }
    const where = o.source ? ` \`${o.source}${o.line ? `:${o.line}` : ""}\`` : "";
    const flag = o.resolution === "drifted" ? " ⚠drifted" : o.resolution === "dead" ? " ⚠dead" : "";
    L.push(`- ${o.text}${where}${flag}`);
  }
  L.push("");
  return L.join("\n");
}

// ── the report ──────────────────────────────────────────────────────────────

export function heapText({ objects, placed, diags, passes, stats }) {
  const live = objects.filter((o) => !o.retracted_at);
  const quarantined = objects.filter((o) => o.meta && o.meta.quarantined);
  const retracted = objects.filter((o) => o.retracted_at);
  const counts = bySeverity(diags);
  const L = [];
  L.push("# janitor — the agent heap");
  L.push("");
  L.push(`Built ${now()}. ${objects.length} objects parsed from ${new Set(objects.map((o) => o.source)).size} sources.`);
  L.push("");
  L.push(`**${counts.error} errors, ${counts.warning} warnings, ${counts.note} notes.** ` +
    `${live.length} live, ${quarantined.length} quarantined, ${retracted.length} retracted. ` +
    `${human(stats.tokens_reclaimed || 0)} tokens reclaimed.`);
  L.push("");

  L.push("## passes");
  L.push("");
  L.push(table(passes.map((p) => [p.name, p.what, String(p.n), p.detail || ""]),
    { header: ["pass", "what it does", "n", "result"] }));
  L.push("");

  L.push("## the heap, by kind");
  L.push("");
  const rows = KINDS.map((k) => {
    const of = live.filter((o) => o.kind === k);
    const reached = of.filter((o) => o.reached).length;
    const dead = of.filter((o) => o.resolution === "dead").length;
    const drift = of.filter((o) => o.resolution === "drifted").length;
    return [k, String(of.length), String(reached), String(dead + drift),
      Number.isFinite(HALF_LIFE[k]) ? `${HALF_LIFE[k]}d` : "never",
      human(of.reduce((a, o) => a + (o.tokens || 0), 0))];
  });
  L.push(table(rows, { header: ["kind", "live", "reached", "bad anchor", "half-life", "tokens"] }));
  L.push("");

  if (counts.error || counts.warning) {
    L.push("## what needs a human");
    L.push("");
    for (const d of diags.filter((x) => x.severity !== "note").slice(0, 80)) {
      L.push(`- **${sev[d.severity]} ${d.code}** ${d.source}${d.line ? `:${d.line}` : ""} — ${d.message}`);
      if (d.fix) L.push(`  - fix: ${d.fix}`);
    }
    L.push("");
  }

  if (quarantined.length) {
    L.push("## quarantined — kept on disk, held out of the window");
    L.push("");
    L.push("Not known to be false. Known to be uncheckable, which is how a stale line gets quoted with");
    L.push("full confidence. Repoint the anchor or retract the claim.");
    L.push("");
    for (const o of quarantined.slice(0, 60)) L.push(`- \`${o.source}:${o.line}\` ${o.text.slice(0, 160)}`);
    L.push("");
  }

  if (retracted.length) {
    L.push("## retracted — still on disk, out of the live set");
    L.push("");
    for (const o of retracted.slice(0, 60)) L.push(`- \`${o.source}:${o.line}\` ${o.text.slice(0, 120)} — *${(o.meta && o.meta.retracted_why) || ""}*`);
    L.push("");
  }

  L.push("## placement");
  L.push("");
  L.push(`${placed.length} objects emitted. Value at the edges ${stats.edge_value}, in the dead zone ${stats.dead_zone_value}` +
    `${stats.lift ? `, a lift of ${stats.lift}x` : ""}. ${stats.rules_pinned} rules pinned at the head and ${stats.rules_recalled} recalled at the tail.`);
  L.push("");
  return L.join("\n");
}

// ── writing ─────────────────────────────────────────────────────────────────

/** Append retractions to the tombstone log. This is what stops the next run
 *  re-learning what this one retracted: the ids are read back at parse time. */
export function appendTombstones(objects) {
  const fresh = objects.filter((o) => o.retracted_at);
  if (!fresh.length) return 0;
  ensureDirs();
  const lines = fresh.map((o) => JSON.stringify({
    id: o.id, kind: o.kind, source: o.source, line: o.line,
    text: o.text.slice(0, 400), retracted_at: o.retracted_at,
    why: (o.meta && o.meta.retracted_why) || "", learned_at: o.learned_at,
  })).join("\n");
  try { fs.appendFileSync(TOMBS(), lines + "\n"); } catch (e) { warn(`tombstones not written, the next run re-learns ${fresh.length} retraction(s): ${e.message}`); return 0; }
  return fresh.length;
}

/** Ids this heap has already retracted, so a re-parse of the same unchanged
 *  source does not resurrect them. */
export function knownTombstones() {
  const seen = new Map();
  let text;
  try { text = fs.readFileSync(TOMBS(), "utf8"); } catch { return seen; }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && r.id) seen.set(r.id, r); } catch { /* a bad line is one lost tombstone, not a failed build */ }
  }
  return seen;
}

/** The rule band on its own. The hooks read this and never the whole heap: a
 *  handler that runs on every prompt cannot afford to parse a heap, and after a
 *  compaction the ONLY thing worth spending the re-injection budget on is the
 *  set of constraints that round just summarised away. */
export function rulesText(objects) {
  const live = objects.filter((o) => o.kind === "rule" && !o.retracted_at && !(o.meta && o.meta.quarantined));
  if (!live.length) return "";
  const L = ["# rules in force", "", `${live.length} constraints, compiled ${now()}. Stated in full because a summarised rule is advice.`, ""];
  for (const o of live) L.push(`- ${o.text}${o.source ? ` \`${o.source}${o.line ? `:${o.line}` : ""}\`` : ""}`);
  L.push("");
  return L.join("\n");
}

/** Build all four artefacts, and write them only when the caller is applying.
 *
 *  `write` defaults to `apply` because the status verb said "read-only" while
 *  replacing 1.1MB of `out/janitor/` on every bare run — WINDOW.md is the image
 *  an agent loads, so a command documented as safe was silently swapping the
 *  artefact another session was reading, and a status check was
 *  indistinguishable on disk from a deliberate compile. Computing costs nothing
 *  a status run was not already paying; it is the writing that was undeclared. */
export function emit({ objects, placed, diags, passes, stats, apply = false, dir = DIR(), write: doWrite = apply }) {
  const files = {};
  const win = windowText(placed, stats);
  const heap = heapText({ objects, placed, diags, passes, stats });
  const rules = rulesText(objects);
  const jsonl = objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
  const fp = sha1(win + heap).slice(0, 12);

  let tombed = 0;
  if (!doWrite) return { dir, fingerprint: fp, files, tombstoned: tombed, window_tokens: stats.tokens, written: false };

  files["WINDOW.md"] = write(path.join(dir, "WINDOW.md"), win);
  files["HEAP.md"] = write(path.join(dir, "HEAP.md"), heap);
  files["RULES.md"] = write(path.join(dir, "RULES.md"), rules);
  files["heap.jsonl"] = write(path.join(dir, "heap.jsonl"), jsonl);
  writeJson(path.join(dir, "diagnostics.json"), { at: now(), fingerprint: fp, counts: bySeverity(diags), diagnostics: diags });

  if (apply) tombed = appendTombstones(objects);
  writeJson(STATE(), {
    at: now(), fingerprint: fp, applied: !!apply, tombstoned: tombed,
    objects: objects.length, placed: placed.length, stats, counts: bySeverity(diags),
  });

  return { dir, fingerprint: fp, files, tombstoned: tombed, window_tokens: stats.tokens, written: true };
}
