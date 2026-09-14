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
// The split is the whole design. Deciding WHAT to write is a set difference
// over the document and the corpus, and costs nothing. Writing it — the voice,
// the rule block, the assertions — is a judgement, and it is the only part a
// model is asked for. A pack carries the derived half already done, so the far
// side does not spend its first fifteen turns discovering what `bb scan` and
// `bb genesis plan` established in two seconds.
import fs from "node:fs";
import path from "node:path";
import * as expert from "../core/expert.js";
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import * as bridge from "../bridge/index.js";
import * as corpus from "../cookbook/corpus.js";
import { BB_DIR, OUT, ROOT, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { readText } from "../core/fs.js";
import { out, warn, emit, hr } from "../core/log.js";
import { now, slug, pad, table, human } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";

export const DIR = () => path.join(BB_DIR, "genesis");
export const PACKS = () => path.join(OUT, "genesis");
export const worldPath = (id) => path.join(DIR(), id, "world.json");

export const ids = () => { try { return fs.readdirSync(DIR()).filter((d) => fs.existsSync(worldPath(d))).sort(); } catch { return []; } };
export const world = (id) => readJson(worldPath(id), null);
export const current = (id = "") => id || readJson(path.join(DIR(), "current.json"), {})?.id || ids()[0] || "";

function readSource({ doc = "", prompt = "" }) {
  if (prompt) return { text: String(prompt), from: "--prompt" };
  if (doc === "-") return { text: fs.readFileSync(0, "utf8"), from: "stdin" };
  if (!doc) return { text: "", from: "" };
  const p = abs(doc);
  const text = readText(p, null);
  if (text == null) return { text: "", from: "", why: `cannot read ${rel(p)}` };
  return { text, from: rel(p) };
}

/** Document -> world model, written to disk with the source beside it. The
 *  source is kept because every item in the model cites a line of it, and a
 *  citation into a file that has since moved is not evidence. */
export function derive({ doc = "", prompt = "", name = "", base = "" } = {}) {
  const src = readSource({ doc, prompt });
  if (src.why) return { rc: 2, why: src.why };
  if (!src.text.trim()) return { rc: 2, why: 'nothing to read. bb genesis <doc.md> | bb genesis - | bb genesis --prompt "..."' };
  const id = slug(name || (src.from && src.from !== "stdin" && src.from !== "--prompt" ? path.basename(src.from).replace(/\.\w+$/, "") : "") || "genesis");
  const w = expert.call("world-derive", { text: src.text, name: id, base });
  if (!w) return { rc: 2, why: `python3 >= 3.9 is required to read a document into a world model (${expert.lastError}). bb doctor` };
  const dir = path.join(DIR(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.txt"), src.text);
  const model = { ...w, id, from: src.from, derived_at: now(), source_bytes: Buffer.byteLength(src.text) };
  writeJson(worldPath(id), model);
  writeJson(path.join(DIR(), "current.json"), { id, at: now() });
  episodes.write({ kind: "stage", verb: "genesis", stage: "genesis:derive",
    features: { bytes: model.source_bytes, lines: w.counts.lines },
    rc: 0, produced: w.counts.capabilities, produces: ["world"],
    turns_saved: episodes.turns({ files_read: 1, searches: w.counts.surfaces + w.counts.capabilities }),
    detail: { world: rel(worldPath(id)) } });
  return { rc: 0, id, world: model, file: rel(worldPath(id)) };
}

/** Seed a corpus from a world: the persona, the surfaces and the setup. The
 *  scenarios are deliberately NOT written here — that is the judgement half. */
export function seed(id, { base = "", corpusId = "" } = {}) {
  const w = world(id);
  if (!w) return { rc: 2, why: `no world \`${id}\`. bb genesis <doc>` };
  const cid = corpusId || id;
  const dir = corpus.dirOf(cid);
  const exists = fs.existsSync(path.join(dir, "persona.json"));
  fs.mkdirSync(path.join(dir, "scenarios"), { recursive: true });
  const actors = {};
  for (const a of w.actors || []) actors[a.id] = { headers: {}, note: `${a.title}${a.role ? ` — ${a.role}` : ""} (${a.why})` };
  const persona = exists ? readJson(path.join(dir, "persona.json"), {}) : {};
  writeJson(path.join(dir, "persona.json"), {
    title: persona.title || w.name || cid,
    who: persona.who || (w.actors?.[0] ? `${w.actors[0].title}${w.actors[0].role ? `, ${w.actors[0].role}` : ""}` : "one anonymous caller — the document names no actor"),
    base: base || persona.base || w.base || "",
    timezone: persona.timezone || "UTC", tz_offset_minutes: persona.tz_offset_minutes ?? 0,
    rpm: persona.rpm ?? 55, parallel: persona.parallel ?? 1,
    headers: persona.headers || {}, vars: persona.vars || {},
    actors: Object.keys(actors).length ? { ...actors, ...(persona.actors || {}) } : (persona.actors || {}),
    setup: persona.setup || [],
    from_world: id,
  });
  const surfaces = (w.surfaces || []).map((s) => ({ id: s.id, title: s.title, why: s.why }));
  if (surfaces.length) writeJson(path.join(dir, "surfaces.json"), surfaces);
  for (const s of surfaces) fs.mkdirSync(path.join(dir, "scenarios", `${String(surfaces.indexOf(s) + 1).padStart(2, "0")}-${s.id}`), { recursive: true });
  return { rc: 0, corpus: cid, dir: rel(dir), surfaces: surfaces.length, actors: Object.keys(actors).length, existed: exists };
}

export function plan(id, { corpusId = "", limit = 40 } = {}) {
  const w = world(id);
  if (!w) return { rc: 2, why: `no world \`${id}\`` };
  const cid = corpusId || id;
  const c = corpus.load(cid) || { scenarios: [] };
  const p = expert.call("coverage-plan", { world: w, corpus: { scenarios: c.scenarios }, limit });
  if (!p) return { rc: 2, why: `python3 is required for the coverage plan (${expert.lastError})` };
  return { rc: 0, id, corpus: cid, ...p };
}

// ── packs ───────────────────────────────────────────────────────────────────

/** One brief per surface, carrying the derived half and nothing else.
 *
 *  Grouped by surface on purpose: a scenario is written in a persona's voice
 *  and the voice is per surface, so one call that writes four scenarios for one
 *  surface costs one priming instead of four. The acceptance is `bb cookbook
 *  check`, which is free and refuses anything that asserts nothing — so a pack
 *  cannot come back green having written empty scenarios. */
export function packText(id, specs, { corpusId, w }) {
  const surface = specs[0].surface || "(none)";
  const sfc = (w.surfaces || []).find((s) => s.id === surface);
  const dir = `.bundlebox/cookbook/${corpusId}/scenarios`;
  const L = [
    `# Write ${specs.length} scenario${specs.length > 1 ? "s" : ""} for \`${surface}\``, "",
    `Everything below was derived locally and costs nothing to restate. Do not re-derive it, do not search for it, and do not read the whole tree: what you need is here.`, "",
    `**Where they go:** \`${dir}/NN-${surface}/<nn>-<slug>.json\`, one file per scenario. Path order is execution order and scenarios in one corpus share their setup, so a scenario may rely on a row an EARLIER path wrote.`, "",
    "**The shape, exactly:**", "",
    "```json",
    JSON.stringify({ id: "unique-across-the-corpus", surface, severity: "high | medium | low",
      title: "what a person would call this situation", question: "the question the steps answer",
      rule: ["the behaviour as the SOURCE defines it, quoted, with the constant names"],
      steps: ["…"] }, null, 2),
    "```", "",
    "A step is one of three things and never two:", "",
    "```json",
    '{"name": "…", "do": "POST /path", "body": {}, "expect": {"status": 201}, "save": {"x": "id"}, "precondition": false}',
    '{"name": "…", "run": "npm test", "expect": {"rc": 0, "stdout_contains": "…"}}',
    '{"name": "STATIC: …", "static": {"file": "src/x.js", "contains": "CONST = 24"}}',
    "```", "",
    "**Expectation keys** (anything else is refused, nothing else is implemented): `status` `status_in` `max_ms` `json` `json_not` `json_in` `json_type` `json_present` `json_absent` `json_len_at_least` `json_len_at_most` `json_gte` `json_lte` `json_matches` `each` `contains` `not_both` — and for `run`: `rc` `stdout_contains` `stderr_contains`.", "",
    "**Substitution tokens:** `{{+2d}}` `{{-1d}}` (a date) · `{{now+90m}}` `{{now-3d}}` (an instant) · `{{localdate}}` `{{localday+7h}}` (the persona's clock) · `{{run}}` `{{rand}}` `{{tenant}}` · `{{anything_saved}}` from an earlier `save` in the SAME scenario. A string that is exactly one token keeps that value's TYPE.", "",
    "## The rules this surface states, quoted from the document", "",
  ];
  const cited = new Map();
  for (const s of specs) for (const r of s.cite || []) cited.set(r.id, r);
  if (cited.size) for (const r of cited.values()) L.push(`- **${r.id}** (line ${r.line}): ${r.text}`);
  else L.push("(the document states no rule for this surface — say so in the `rule` block rather than inventing one)");
  L.push("", "## What to write, and the frame each one goes in", "");
  for (const s of specs) {
    L.push(`### \`${s.capability}\` — ${s.tier}`, "", `${s.why}`, "", "```json", JSON.stringify(s.skeleton, null, 2), "```", "");
  }
  L.push(
    "## What this brief does not accept", "",
    "| what it is tempting to do instead | why it does not apply here |",
    "|---|---|",
    "| \"I read the handler; the shape is obvious\" | A scenario asserts what the SERVICE returns, not what the source appears to return. The gap between those two is the only thing this corpus exists to find. |",
    "| \"I'll assert the status and move on\" | A `status`-only step proves the route exists, not that it works. The plan already counts those as shallow and they will come back on the next pass. |",
    "| \"the acceptance is slow, I'll run it at the end\" | It takes under a second and needs no server. Run it after the first file, not after the last. |",
    "| \"this needs a field I do not know, I'll guess it\" | A guessed field name produces a red step about the corpus, which costs another session to un-diagnose. Narrow the assertion and put the gap in `question`. |",
    "| \"I should also fix the bug this found\" | Not in this call. A red step becomes a finding, gets packed and budgeted, and is fixed under its own acceptance. |", "",
    "## Rules for this work", "",
    "1. **Quote, do not invent.** The `rule` block cites the document or the source, with constant names. A red step must be the system contradicting something written down, not the corpus having an opinion.",
    "2. **Every scenario asserts.** A step with an empty `expect` is refused by the acceptance below.",
    "3. **Read back after a write.** A 200 that stored nothing is identical to a 200 that stored everything, from the write alone.",
    "4. **Say what you could not settle.** If a body shape, a field name or an auth header is not in this brief, put it in the scenario's `question` and leave the assertion narrow. A guessed field name is a red step about the corpus.",
    "5. Do not edit anything outside `" + dir + "`.", "",
    "## Done when", "",
    "```bash", `bb cookbook check --persona ${corpusId}`, "```", "",
    "That is free, needs no server, and refuses a scenario that asserts nothing, an unknown surface, an unimplemented expectation key and a duplicate id. Run it; report what it printed.", "");
  return L.join("\n");
}

export function pack(id, { corpusId = "", limit = 40, batch = 4, max = 0 } = {}) {
  const p = plan(id, { corpusId, limit });
  if (p.rc) return p;
  const w = world(id);
  const cid = p.corpus;
  const bySurface = new Map();
  for (const s of p.specs) {
    const k = s.surface || "(none)";
    if (!bySurface.has(k)) bySurface.set(k, []);
    bySurface.get(k).push(s);
  }
  const dir = path.join(PACKS(), id);
  fs.mkdirSync(dir, { recursive: true });
  const packs = [];
  for (const [surface, all] of bySurface) {
    for (let i = 0; i < all.length; i += batch) {
      if (max && packs.length >= max) break;
      const specs = all.slice(i, i + batch);
      const text = packText(id, specs, { corpusId: cid, w });
      const file = path.join(dir, `${slug(surface) || "none"}-${String(Math.floor(i / batch) + 1).padStart(2, "0")}.md`);
      fs.writeFileSync(file, text);
      packs.push({ surface, specs: specs.map((s) => s.capability), tier: specs[0].tier, file: rel(file),
        est_tokens: estimateText(text, "prose"), acceptance: `bb cookbook check --persona ${cid}` });
    }
  }
  writeJson(path.join(dir, "index.json"), { id, corpus: cid, at: now(), packs, coverage: p.coverage_pct, declared: p.declared, covered: p.covered });
  episodes.write({ kind: "stage", verb: "genesis", stage: "genesis:pack",
    features: { specs: p.specs.length, packs: packs.length, coverage_pct: p.coverage_pct ?? -1 },
    rc: 0, produced: packs.length, produces: ["packs"],
    turns_saved: episodes.turns({ searches: p.declared, rows: p.specs.length }),
    detail: { dir: rel(dir) } });
  return { rc: 0, id, corpus: cid, packs, plan: p };
}

/** Hand one pack to an agent. Drafts by default; `--run --spend` sends. */
export async function send(id, which, { run = false, spend = false, agent = "" } = {}) {
  const idx = readJson(path.join(PACKS(), id, "index.json"), null);
  if (!idx) return { rc: 2, why: `no packs for \`${id}\`. bb genesis pack` };
  const rows = which ? idx.packs.filter((p) => p.file.includes(which) || p.surface === which) : idx.packs;
  if (!rows.length) return { rc: 2, why: `no pack matching \`${which}\`` };
  const sent = [];
  for (const p of rows) {
    const body = readText(abs(p.file), "");
    const d = await bridge.draft({ problem: `write ${p.specs.length} scenario(s) for ${p.surface} in corpus ${idx.corpus}`,
      reason: "assist", gear: "genesis", stage: `genesis:${p.surface}`, acceptance: p.acceptance, body, lean: true });
    if (d.rc) { sent.push({ ...p, rc: d.rc, why: d.why }); continue; }
    if (!run) { sent.push({ ...p, call: d.id, state: "drafted", why: `drafted: bb bridge send ${d.id} --run --spend` }); continue; }
    const s = await bridge.send(d.id, { agent, run, spend });
    sent.push({ ...p, call: d.id, state: s.state, rc: s.rc, why: s.why });
  }
  return { rc: 0, sent };
}

// ── commands ────────────────────────────────────────────────────────────────

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
    const p = plan(id, { corpusId: String(flags.persona || ""), limit: Number(flags.limit) || 40 });
    if (p.rc) { warn(p.why); return p.rc; }
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
