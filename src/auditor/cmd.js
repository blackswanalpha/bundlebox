// auditor/cmd.js — the verb's surface: the sub-verbs, their flags, and how each
// one is printed.
//
// Split from `index.js` because a command surface and a domain model change for
// different reasons and at different rates. `index.js` answers "what is an area,
// what is its charter, does it meet the bar". This file answers "what does
// `bb auditor gate commandcenter` put on a terminal". Nothing here decides
// anything; it reads the model and formats it.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as bridge from "../bridge/index.js";
import * as genesis from "../genesis/index.js";
import { OUT, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { now, slug, pad, table, human } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import * as standards from "./standards.js";
import * as charter from "./charter.js";
import * as brief from "./brief.js";
import * as review from "./review.js";
import { areas, areaOf, charterFor, gate, KINDS } from "./index.js";

const indent = (s) => s.split("\n").map((l) => "  " + l).join("\n");

async function cmd({ _, flags }) {
  const sub = _[0] || "areas";
  const listFlag = (f) => (f ? String(f).split(",").map((x) => x.trim()).filter(Boolean) : []);

  if (sub === "areas") {
    const rows = areas();
    if (flags.json) { emit({ areas: rows.map((a) => ({ ...a, files: a.count })) }); return 0; }
    if (!rows.length) { out("  no areas: nothing under this tree groups into one"); return 0; }
    out(indent(table(rows.map((a) => [a.id, a.count, human(a.tokens), a.findings || "",
      a.charter ? `${a.charter.adal}·${a.charter.standards}${a.charter.drifted ? " drifted" : ""}` : "—",
      a.reviews.map((r) => r.kind).join(" ") || "no reviews"]),
      { header: ["area", "files", "~tokens", "open", "charter", "reviews"] })));
    const un = rows.filter((a) => !a.charter).length;
    out(`\n  ${rows.length - un} of ${rows.length} area(s) charted. ${un ? `\`bb auditor charter <area>\` declares the bar for the rest.` : "Every area has a declared bar."}`);
    return 0;
  }

  if (sub === "standards") {
    const all = areas();
    const files = _[1] ? (areaOf(_[1], all)?.files || []) : all.flatMap((a) => a.files);
    if (_[1] && !areaOf(_[1], all)) { warn(`no area \`${_[1]}\``); return 2; }
    const sel = standards.select({ files, world: genesis.world(genesis.current()), area: _[1] || "",
      findings: store.get("findings", []), force: listFlag(flags.force), drop: listFlag(flags.drop) });
    const lvl = standards.levelOf(sel.standards, sel.signals);
    if (flags.json) { emit({ scope: _[1] || "(whole tree)", ...sel, adal: lvl }); return 0; }
    out(`  ${sel.standards.length} of ${standards.STANDARDS.length} standard(s) in force for ${_[1] || "this tree"} — level ${lvl.level} (${lvl.title})`);
    out(indent(table(sel.standards.map((s) => [s.id, s.domain, s.adal, s.title, s.because]),
      { header: ["id", "domain", "adal", "the bar", "because"] })));
    out(`\n  Signals read from the tree: ${Object.entries(sel.signals).map(([k, v]) => `${k} (${v})`).join(" · ")}`);
    out(`  Not in force: ${standards.STANDARDS.filter((s) => !sel.standards.some((x) => x.id === s.id)).map((s) => s.id).join(", ") || "none"}`);
    return 0;
  }

  if (sub === "charter") {
    const id = _[1];
    if (!id) { warn("bb auditor charter <area> [--force SEC,PERF-1] [--drop I18N]"); return 2; }
    const r = charterFor(id, { force: listFlag(flags.force), drop: listFlag(flags.drop), write: flags.write !== false });
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r.charter); return 0; }
    if (flags.show) { out(charter.render(r.charter)); return 0; }
    const ch = r.charter;
    out(`  ${r.md}  —  level ${ch.adal.level} (${ch.adal.title}), ${ch.standards.length} standard(s) in force`);
    out(indent(table(ch.standards.map((s) => [s.id, s.domain, s.adal, s.title]), { header: ["id", "domain", "adal", "the bar"] })));
    out(`\n  blocks a release: ${ch.governance.blocks_release.join(", ") || "nothing on its own"}`);
    out(`  coverage floor:   ${ch.adal.coverage}%   independent review: ${ch.adal.independent_review ? "required" : "not at this level"}`);
    out(`  ${r.md} is the document. bb auditor brief ${id} writes the pack an agent is handed before it edits.`);
    return 0;
  }

  if (sub === "brief") {
    const id = _[1];
    if (!id) { warn("bb auditor brief <area> [--objective \"...\"]"); return 2; }
    const a = areaOf(id);
    if (!a) { warn(`no area \`${id}\`. bb auditor areas`); return 2; }
    let ch = charter.read(id);
    if (!ch) { const r = charterFor(id); if (r.rc) { warn(r.why); return r.rc; } ch = r.charter;
      out(`  no charter for ${id}; derived one first — ${rel(charter.doc(id))}`); }
    const p = brief.pack(a, ch, { objective: String(flags.objective || _.slice(2).join(" ") || "") });
    if (flags.json) { emit(p); return 0; }
    if (flags.show) { out(fs.readFileSync(abs(p.file), "utf8")); return 0; }
    out(`  ${p.file}  (~${human(p.est_tokens)} tokens, level ${p.adal}, ${p.standards} standard(s))`);
    out(`\n  Nothing sent. Hand this file to the session BEFORE it edits anything, or`);
    out(`  \`bb auditor send ${id} brief --run --spend\` opens an agent on it.`);
    return 0;
  }

  if (sub === "gate") {
    const id = _[1];
    if (!id) { warn("bb auditor gate <area>"); return 2; }
    const g = gate(id);
    if (g.rc) { warn(g.why); return g.rc; }
    if (flags.json) { emit(g); return g.verdict === "CLEAR" ? 0 : g.verdict === "UNPROVEN" ? 20 : g.verdict === "HOLD" ? 10 : 11; }
    out(`  ${g.area} — level ${g.adal} — ${g.verdict}`);
    out(indent(table(g.standards.map((s) => [s.id, s.state, s.why]), { header: ["id", "", "why"] })));
    out(`\n  ${g.counts.met} met · ${g.counts.failed} failed · ${g.counts.unproven} unproven`);
    out(`  ${g.why}`);
    if (g.charter_drifted) out(`  !! the charter was derived against a different tree — bb auditor charter ${id}`);
    out(`\n  UNPROVEN is not green. A standard nobody checked is reported as unchecked.`);
    return g.verdict === "CLEAR" ? 0 : g.verdict === "UNPROVEN" ? 20 : g.verdict === "HOLD" ? 10 : 11;
  }

  if (sub === "plan") {
    const all = areas();
    const rows = review.plan(all, { kinds: flags.kind ? String(flags.kind).split(",") : Object.keys(KINDS), limit: Number(flags.limit) || 30 });
    const uncharted = all.filter((a) => !a.charter);
    if (flags.json) { emit({ uncharted: uncharted.map((a) => a.id), plan: rows }); return 0; }
    if (uncharted.length) {
      out(`  ${uncharted.length} area(s) with no charter — the bar is undeclared, so nothing can be measured against it:`);
      out(indent(table(uncharted.map((a) => [a.id, a.count, human(a.tokens), `bb auditor charter ${a.id}`]), { header: ["area", "files", "~tokens", "close it with"] })));
      out("");
    }
    if (!rows.length) { out("  every area has a current review of every kind"); return 0; }
    out(indent(table(rows.map((r) => [r.area, r.kind, r.state, r.adal, r.files, r.findings || "", r.score, r.why]),
      { header: ["area", "kind", "", "adal", "files", "open", "score", "why"] })));
    return 0;
  }

  if (sub === "pack") {
    const all = areas();
    const specs = review.plan(all, { kinds: flags.kind ? String(flags.kind).split(",") : Object.keys(KINDS), limit: Number(flags.limit) || 6 });
    const dir = path.join(OUT, "auditor");
    fs.mkdirSync(dir, { recursive: true });
    const packs = [];
    for (const s of specs) {
      const a = areaOf(s.area, all);
      if (!a) continue;
      const ch = charter.read(s.area);
      const text = review.packText(s, a, ch);
      const f = path.join(dir, `${slug(s.area)}-${s.kind}.md`);
      fs.writeFileSync(f, text);
      packs.push({ ...s, file: rel(f), est_tokens: (await import("../tokens/estimate.js")).text(text, "prose"),
        acceptance: `bb auditor record ${s.area} ${s.kind} <file>` });
    }
    writeJson(path.join(dir, "index.json"), { at: now(), packs });
    if (flags.json) { emit({ rc: 0, packs }); return 0; }
    out(`  ${packs.length} pack(s) — ${human(packs.reduce((a, p) => a + p.est_tokens, 0))} tokens ESTIMATE if every one is sent`);
    out(indent(table(packs.map((p) => [p.area, p.kind, p.adal, human(p.est_tokens), p.file]), { header: ["area", "kind", "adal", "~tok", "pack"] })));
    out("\n  Nothing sent. `bb auditor send <area> <kind>` drafts a call; --run --spend opens an agent.");
    return 0;
  }

  if (sub === "send") {
    const kind = _[2] || "";
    if (kind === "brief") {
      const id = _[1];
      const a = areaOf(id);
      if (!a) { warn(`no area \`${id}\``); return 2; }
      const ch = charter.read(id) || charterFor(id).charter;
      const p = brief.pack(a, ch, { objective: String(flags.objective || "") });
      const body = fs.readFileSync(abs(p.file), "utf8");
      const d = await bridge.draft({ problem: `work in ${id} under its charter`, reason: "assist", gear: "auditor",
        stage: `auditor:${id}:brief`, acceptance: `bb auditor gate ${id}`, body, lean: true });
      if (d.rc) { warn(d.why); return 2; }
      if (!flags.run) { out(`  ${pad(id, 14)} brief        drafted ${d.id} — bb bridge send ${d.id} --run --spend`); return 0; }
      const s = await bridge.send(d.id, { run: true, spend: !!flags.spend, agent: String(flags.agent || "") });
      out(`  ${pad(id, 14)} brief        ${s.state} — ${s.why}`);
      return 0;
    }
    const idx = readJson(path.join(OUT, "auditor", "index.json"), null);
    if (!idx) { warn("no packs. bb auditor pack"); return 2; }
    const want = idx.packs.filter((p) => (!_[1] || p.area === _[1]) && (!kind || p.kind === kind));
    if (!want.length) { warn(`no pack for ${_[1] || "*"} ${kind || "*"}`); return 2; }
    for (const p of want) {
      const body = fs.readFileSync(abs(p.file), "utf8");
      const d = await bridge.draft({ problem: `${p.kind} review of ${p.area}`, reason: "assist", gear: "auditor",
        stage: `auditor:${p.area}`, acceptance: `bb auditor record ${p.area} ${p.kind} <the file you wrote>`, body, lean: true });
      if (d.rc) { warn(d.why); continue; }
      if (!flags.run) { out(`  ${pad(p.area, 14)} ${pad(p.kind, 12)} drafted ${d.id} — bb bridge send ${d.id} --run --spend`); continue; }
      const s = await bridge.send(d.id, { run: true, spend: !!flags.spend, agent: String(flags.agent || "") });
      out(`  ${pad(p.area, 14)} ${pad(p.kind, 12)} ${s.state} — ${s.why}`);
    }
    return 0;
  }

  if (sub === "record") {
    const [, area, kind, file] = _;
    if (!area || !kind || !file) { warn("bb auditor record <area> <kind> <file.md>"); return 2; }
    const r = review.record(areas(), area, kind, file);
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    out(`  ${r.review} — ${r.recorded} finding(s) recorded${r.refused.length ? `, ${r.refused.length} refused` : ""}`);
    for (const x of r.refused) out(`    !! ${x}`);
    if (r.no_standard) out(`    ${r.no_standard} finding(s) cite no standard — recorded, but governance cannot disposition them`);
    return 0;
  }

  if (sub === "drift") {
    const all = areas();
    const ch = charter.drift(all);
    const rv = review.drift(all);
    if (flags.json) { emit({ charters: ch, reviews: rv }); return ch.some((r) => r.state !== "current") || rv.some((r) => r.state === "drifted") ? 1 : 0; }
    out("  CHARTERS — living. A drifted charter is re-derived, not argued with.");
    out(indent(ch.length ? table(ch.map((r) => [r.area, r.state, r.adal || "", r.why]), { header: ["area", "", "adal", "why"] })
      : "no charters yet. bb auditor charter <area>"));
    out("\n  REVIEWS — dated. A drifted review is never edited; a new one is written beside it.");
    out(indent(rv.length ? table(rv.map((r) => [r.area, r.kind, r.at, r.state, r.why]), { header: ["area", "kind", "written", "", ""] })
      : "no reviews yet. bb auditor plan"));
    return ch.some((r) => r.state !== "current") || rv.some((r) => r.state === "drifted") ? 1 : 0;
  }

  warn(`unknown auditor sub-verb: ${sub}. areas | standards | charter | brief | gate | plan | pack | send | record | drift`);
  return 2;
}

export const commands = {
  auditor: {
    help: "the bar, declared before the work: scope, standards, governance, assurance — then checked after it",
    usage: "bb auditor [areas|standards [area]|charter <area>|brief <area>|gate <area>|plan|pack|send <area> <kind>|record <area> <kind> <file>|drift] [--json]",
    long: [
      "  BEFORE the code is written",
      "  bb auditor standards [area]    the menu, and which rows this tree's own signals pull in",
      "  bb auditor charter <area>      scope · standards · governance · assurance, derived and written down",
      "  bb auditor brief <area>        the instruction pack a session is handed before its first edit",
      "",
      "  AFTER it is written",
      "  bb auditor gate <area>         which standards have evidence, which are failed, which nobody checked",
      "  bb auditor plan                what has no charter, and which reviews describe a tree that has moved",
      "  bb auditor pack                one review brief per area and kind, carrying the counted half",
      "  bb auditor record <area> <kind> <file>   ingest a written review as findings",
      "  bb auditor drift               charters that need re-deriving, reviews that have gone stale",
      "",
      "A CHARTER is living: when the area changes, re-derive it.",
      "A REVIEW is dated: never update one — write a new one beside it. That fixed point is the only thing it is for.",
      "",
      "bb auditor gate exit codes: 0 clear · 10 hold · 11 block · 20 unproven. UNPROVEN is never green.",
    ].join("\n"),
    run: cmd,
  },
};
