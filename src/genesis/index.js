// genesis/index.js — the inlet. One document in, a working corpus out.
//
// This is the front of the pipeline and the only place a person has to write
// anything:
//
//   bb genesis <doc>       the world model: surfaces, actors, rules, capabilities   0 tokens
//   bb genesis plan        of everything the world can do, what nothing covers      0 tokens
//   bb genesis pack        the specs, packed to the smallest brief that can be
//                          acted on, one per surface, acceptance included
//   bb genesis send        hand a pack to an agent                     THE ONLY SPEND
//   bb cookbook run        the scenarios it wrote, executed by the kernel  0 tokens
//
// The split is the whole design, and it is the split between the two files this
// one joins: world.js derives (free, re-runnable, arithmetic) and packs.js asks
// (a judgement, and the only part a model is paid for). This file is the verb.
import path from "node:path";
import * as store from "../core/store.js";
import { rel } from "../core/paths.js";
import { readJson } from "../core/config.js";
import { out, warn, emit, hr } from "../core/log.js";
import { pad, table, human } from "../core/util.js";
import { DIR, PACKS, worldPath, ids, world, current, derive, seed, plan } from "./world.js";
import { packText, pack, send } from "./packs.js";

export { DIR, PACKS, worldPath, ids, world, current, derive, seed, plan } from "./world.js";
export { packText, pack, send } from "./packs.js";

function showWorld(w) {
  out(`  ${w.id} — from ${w.from || "?"}, ${w.counts.lines} lines, derived ${String(w.derived_at).slice(0, 16)}`);
  out(`  ${w.counts.surfaces} surfaces · ${w.counts.rules} rules · ${w.counts.capabilities} capabilities · ${w.counts.actors} actors · ${w.counts.constants} constants`, "");
  if (w.surfaces.length) {
    out("");
    out(table(w.surfaces.map((s) => [s.id, s.title.slice(0, 40), `${s.rules} rules`, `${s.capabilities} caps`, s.why]), { header: ["surface", "title", "", "", "from"] })
      .split("\n").map((l) => "  " + l).join("\n"));
  }
  if (w.unknown.length) { out("", "  what it could not settle — stated, not filled in:"); for (const u of w.unknown) out(`    ? ${u}`); }
}

async function genesisCmd({ _, flags }) {
  const sub = _[0] || "";
  const known = new Set(["show", "list", "plan", "pack", "send", "seed", "status"]);

  if (!sub || !known.has(sub)) {
    // `bb genesis <doc>` is the whole point: no sub-verb, one argument.
    const r = derive({ doc: sub || String(flags.doc || ""), prompt: String(flags.prompt || ""), name: String(flags.name || ""), base: String(flags.base || "") });
    if (r.rc) { warn(r.why); return r.rc; }
    const s = seed(r.id, { base: String(flags.base || ""), corpusId: String(flags.persona || "") });
    if (flags.json) { emit({ world: r.world, seed: s }); return 0; }
    showWorld(r.world);
    out("", `  world  ${r.file}`);
    out(`  corpus ${s.dir}${s.existed ? " (kept what was there)" : ""} — ${s.surfaces} surfaces, ${s.actors} actors, no scenarios yet`);
    const p = plan(r.id, { corpusId: s.corpus });
    if (!p.rc) out(`  plan   ${p.specs_total} capabilities nothing covers; \`bb genesis plan\` ranks them, \`bb genesis pack\` writes the briefs`);
    return 0;
  }

  const id = current(String(flags.world || flags.id || ""));
  if (sub === "list") {
    const rows = ids().map((i) => { const w = world(i); return [i, w?.from || "", w?.counts?.surfaces ?? "?", w?.counts?.rules ?? "?", w?.counts?.capabilities ?? "?", String(w?.derived_at || "").slice(0, 16)]; });
    if (flags.json) { emit({ worlds: rows.map((r) => ({ id: r[0], from: r[1] })), current: id }); return 0; }
    if (!rows.length) { out("  no worlds. bb genesis <doc>"); return 0; }
    out(table(rows, { header: ["world", "from", "surfaces", "rules", "caps", "derived"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }
  const w = world(id);
  if (!w) { warn(`no world \`${id}\`. bb genesis <doc>`); return 2; }

  if (sub === "show") { if (flags.json) { emit(w); return 0; } showWorld(w); return 0; }

  if (sub === "seed") {
    const s = seed(id, { base: String(flags.base || ""), corpusId: String(flags.persona || "") });
    if (flags.json) { emit(s); return s.rc; }
    out(`  ${s.dir} — ${s.surfaces} surfaces, ${s.actors} actors${s.existed ? " (kept what was there)" : ""}`);
    return s.rc;
  }

  if (sub === "plan") {
    // The coverage check re-reads the world and the whole corpus to answer a
    // question whose only inputs are those two things. When neither has moved
    // the answer cannot have, so it is gated like every other repeatable.
    const { shouldRun, remember } = await import("../recom/repeatable.js");
    const gate = flags.force ? { run: true, verdict: "forced", why: "--force" } : shouldRun("genesis/coverage", { world: id });
    if (!gate.run && !flags.json) {
      out(`  fresh  the world and the corpus read as they did, so coverage was not re-derived.\n  ${gate.why}\n  --force re-derives it.`);
      return 0;
    }
    const p = plan(id, { corpusId: String(flags.persona || ""), limit: Number(flags.limit) || 40 });
    if (p.rc) { warn(p.why); return p.rc; }
    remember("genesis/coverage", { ok: true, opts: { world: id },
      summary: `${p.covered} of ${p.declared} declared capabilities are covered by corpus ${p.corpus} (${p.coverage_pct ?? "—"}%), ${p.shallow} shallow.` });
    if (flags.json) { emit(p); return 0; }
    out(`  ${p.id} against corpus ${p.corpus}: ${p.covered}/${p.declared} capabilities covered (${p.coverage_pct ?? "—"}%), ${p.shallow} of them shallow`);
    if (p.phantom_calls.length) out(`  ${p.phantom_calls.length} call(s) the corpus makes against nothing the document declares: ${p.phantom_calls.slice(0, 4).join(", ")}`);
    out("");
    out(table(p.specs.map((s) => [s.capability.slice(0, 46), s.tier, s.surface || "-", s.severity, s.score, (s.cite || []).length ? `${s.cite.length} rule(s)` : ""]),
      { header: ["nothing covers", "tier", "surface", "sev", "score", "cites"] }).split("\n").map((l) => "  " + l).join("\n"));
    if (p.specs_total > p.specs.length) out(`\n  ${p.specs_total - p.specs.length} more; --limit`);
    return 0;
  }

  if (sub === "pack") {
    const r = pack(id, { corpusId: String(flags.persona || ""), limit: Number(flags.limit) || 40, batch: Number(flags.batch) || 4, max: Number(flags.max) || 0 });
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    out(`  ${r.packs.length} pack(s) for corpus ${r.corpus} — ${human(r.packs.reduce((a, p) => a + p.est_tokens, 0))} tokens ESTIMATE if every one is sent`);
    out("");
    out(table(r.packs.map((p) => [p.surface, p.specs.length, p.tier, human(p.est_tokens), p.file]), { header: ["surface", "specs", "tier", "~tok", "pack"] })
      .split("\n").map((l) => "  " + l).join("\n"));
    out(`\n  Nothing has been sent. \`bb genesis send\` drafts a call per pack; \`--run --spend\` is what opens an agent.`);
    return 0;
  }

  if (sub === "send") {
    const r = await send(id, _[1] || String(flags.surface || ""), { run: !!flags.run, spend: !!flags.spend, agent: String(flags.agent || "") });
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    for (const s of r.sent) out(`  ${pad(s.surface, 16)} ${pad(s.state || "?", 9)} ${s.why || ""}`);
    return 0;
  }
  return 2;
}

export const commands = {
  genesis: {
    help: "a document or a prompt becomes a world model, a corpus and the briefs that fill it (0 tokens until send)",
    usage: "bb genesis <doc.md|-|--prompt \"...\"> [--base url] [--name id] | show | plan | pack [--batch 4] | send [surface] [--run --spend] | seed | list",
    long: [
      "  bb genesis docs/PRD.md          surfaces, actors, rules, capabilities — and a corpus seeded from them",
      "  bb genesis plan                 of everything that world can do, what no scenario touches, ranked",
      "  bb genesis pack                 one brief per surface, carrying the derived half already done",
      "  bb genesis send calendar --run --spend    the only step that costs anything",
      "  bb cookbook run                 what the agent wrote, executed by the kernel, in seconds",
      "",
      "Nothing here calls a model. `send` hands a packed file to whichever agent `bb bridge` is configured for.",
    ].join("\n"),
    run: genesisCmd,
  },
};
