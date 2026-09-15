// tables.js — the derived artefacts a session reads INSTEAD of walking the
// studio. Same producer shape as snapgen, same runner, same fingerprinted skip:
// a table that has not drifted is not rebuilt, and INDEX.md carries the token
// estimate so a session can decide whether to open one at all.
import fs from "node:fs";
import path from "node:path";
import { OUT } from "../core/paths.js";
import { makeRegistry } from "../kit/registry.js";
import { table } from "../core/util.js";
import { contrast } from "./check.js";
import { loadStudio } from "./check.js";
import { cards } from "./library.js";
import { intake } from "./research.js";

export const DIR = path.join(OUT, "designlabs");

const inputsOf = (dir) => {
  const list = [path.join(dir, "system.json")];
  const sdir = path.join(dir, "screens");
  try { for (const n of fs.readdirSync(sdir)) if (n.endsWith(".json")) list.push(path.join(sdir, n)); } catch { /* none yet */ }
  return list;
};

export function registry(dir) {
  const reg = makeRegistry("designlabs", DIR, {
    title: "designlabs",
    blurb: "the declared design system, its screens and the doctrine each is held to",
  });

  reg.add({
    name: "system", group: "design", description: "tokens, type, space, radius, motion and targets, with every declared colour pair's measured contrast ratio",
    inputs: () => inputsOf(dir),
    build: () => {
      const st = loadStudio(dir);
      if (!st.system) return "No system.json in " + dir + ".\n";
      const s = st.system;
      const L = [`# ${s.name} — design system`, "", s.note || "", "", "## Colour", "",
        table(Object.entries(s.color.tokens), { header: ["token", "value"] }), "",
        "### Pairs, measured", ""];
      const rows = [];
      for (const p of s.color.pairs || []) {
        const fg = s.color.tokens[p.fg] ?? p.fg, bg = s.color.tokens[p.bg] ?? p.bg;
        const need = p.size === "large" || p.size === "ui" ? 3 : 4.5;
        const c = contrast(fg, bg);
        rows.push([p.use, `${fg} / ${bg}`, c == null ? "unknown" : `${c.toFixed(2)}:1`, `${need}:1`, c == null ? "UNKNOWN" : c >= need ? "ok" : "FAIL"]);
      }
      L.push(table(rows, { header: ["use", "fg on bg", "ratio", "floor", "verdict"] }), "");
      L.push("## Type", "", table([
        ["display", `${s.type.display.family}, ${s.type.display.fallback}`, s.type.display.license || "?"],
        ["text", `${s.type.text.family}, ${s.type.text.fallback}`, s.type.text.license || "?"]], { header: ["role", "family", "licence"] }), "");
      L.push(table(Object.entries(s.type.scale || {}), { header: ["step", "size"] }), "");
      L.push("## Space, radius, motion, targets", "");
      L.push(`space: ${(s.space || []).join(", ")}px`, "");
      L.push(table(Object.entries(s.radius || {}), { header: ["radius", "value"] }), "");
      L.push(table(Object.entries(s.motion || {}), { header: ["motion", "duration"] }), "");
      L.push(table(Object.entries(s.targets || {}), { header: ["target", "size"] }), "");
      return L.join("\n");
    },
  });

  reg.add({
    name: "screens", group: "design", description: "every screen crossed with every state it declares, plus its element budget and what it absorbs",
    inputs: () => inputsOf(dir),
    build: () => {
      const st = loadStudio(dir);
      if (!st.screens.length) return "No screens declared.\n";
      const states = [...new Set(st.screens.flatMap((s) => Object.keys(s.states || {})))];
      const rows = [];
      for (const s of st.screens) {
        rows.push([s.id, s.area || "", ...states.map((n) => (s.states?.[n] ? "y" : s.impossible?.[n] ? "n/a" : "—")),
          s.audit?.budget != null ? `${s.audit.elements ?? "?"}/${s.audit.budget}` : "—", String(s.primary ?? "—")]);
      }
      const L = ["# Screens × states", "", table(rows, { header: ["screen", "area", ...states, "budget", "primary"] }), "",
        "`—` is a state that was never drawn. `n/a` is one declared impossible with a reason.", "", "## What each screen absorbs", ""];
      for (const s of st.screens) {
        L.push(`### ${s.id}`, "", s.lede || "", "",
          `- absorbs: ${s.audit?.absorbs || "_not declared_"}`,
          `- transfers: ${s.audit?.transfers || "_not declared_"}`,
          `- flow: ${(s.flow || []).map((n) => n.node + (n.terminal ? "*" : n.failure ? "!" : "")).join(" → ") || "_none_"}`, "");
      }
      return L.join("\n");
    },
  });

  reg.add({
    name: "doctrine", group: "design", description: "the rules the gate enforces, the card that sets each one, and what it checks",
    inputs: () => cards().map((c) => c.file),
    build: () => {
      const rows = [];
      for (const c of cards()) rows.push([c.rule || "—", c.title, c.severity, c.check || "review only"]);
      return ["# Doctrine", "", table(rows, { header: ["rule", "principle", "severity", "checked"] }), "",
        "Read one card in full with `bb designlabs principles <id>`.", ""].join("\n");
    },
  });

  reg.add({
    name: "corpus", group: "design", description: "what the reference corpus holds, per source, and which entries are bookmarks rather than research",
    inputs: () => { try { return fs.readdirSync(path.join(dir, "corpus")).map((n) => path.join(dir, "corpus", n)); } catch { return []; } },
    build: () => {
      const rows = intake(dir);
      if (!rows.length) return "The corpus is empty. `bb designlabs plan <question>` writes the brief that fills it.\n";
      const t = [];
      for (const r of rows) t.push([r.file, r.source, r.kind, r.ok ? "ok" : r.problems[0]]);
      return ["# Corpus", "", table(t, { header: ["file", "source", "kind", "state"] }), ""].join("\n");
    },
  });

  return reg;
}
