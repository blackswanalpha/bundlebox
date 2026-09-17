// genesis/packs.js — the brief a session is handed, and the one verb that can
// spend.
//
// A pack carries the derived half already done — the rules quoted from the
// document, the step shape the tier forces, the acceptance command — so the far
// side does not spend its first fifteen turns rediscovering what `bb genesis
// plan` established in two seconds. One pack per surface, because a scenario is
// written in a persona's voice and the voice is per surface: four scenarios for
// one surface is one priming, not four.
import fs from "node:fs";
import path from "node:path";
import * as bridge from "../bridge/index.js";
import * as corpus from "../cookbook/corpus.js";
import * as episodes from "../buckmaster/episodes.js";
import { OUT, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { readText } from "../core/fs.js";
import { now, slug } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import { PACKS, world, plan } from "./world.js";

/** One brief per surface, carrying the derived half and nothing else.
 *
 *  Grouped by surface on purpose: a scenario is written in a persona's voice
 *  and the voice is per surface, so one call that writes four scenarios for one
 *  surface costs one priming instead of four. The acceptance is `bb cookbook
 *  check`, which is free and refuses anything that asserts nothing — so a pack
 *  cannot come back green having written empty scenarios. */
export function packText(id, specs, { corpusId, w, persona = {} }) {
  const surface = specs[0].surface || "(none)";
  const sfc = (w.surfaces || []).find((s) => s.id === surface);
  const dir = `.bundlebox/cookbook/${corpusId}/scenarios`;
  // The built-in half is the same in every pack; the other half is this
  // corpus's, and naming it is the difference between a brief that lists what
  // resolves and one that lists what a DIFFERENT corpus happened to define.
  // `bb cookbook check` refuses a token nothing defines, so an example var the
  // persona does not carry is a refusal the far side cannot diagnose.
  const pv = Object.keys(persona.vars || {});
  const ps = (persona.setup || []).flatMap((st) => Object.keys((st && st.save) || {}));
  const defined = [
    "`{{base}}`, always injected — the base the board actually ran against",
    pv.length ? `${pv.map((k) => `\`{{${k}}}\``).join(" ")} from \`persona.json\` vars` : "",
    ps.length ? `${ps.map((k) => `\`{{${k}}}\``).join(" ")} saved by the persona's \`setup\`` : "",
    "`{{anything_saved}}` from an earlier `save` in the SAME scenario",
  ].filter(Boolean).join(" · ");
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
    "**Substitution tokens, built in** (these always resolve): `{{now}}` `{{today}}` `{{epoch}}` (this instant) · `{{+2d}}` `{{-1d}}` (a date) · `{{now+90m}}` `{{now-3d}}` (an instant) · `{{localdate}}` `{{localdate-1d}}` `{{localday+7h}}` (the persona's clock; `localday` is the NEXT local midnight plus the offset, in UTC) · `{{timezone}}` `{{tzoffset}}` · `{{run}}` `{{rand}}` `{{rand:16}}`. An offset carries its unit — `s` `m` `h` `d` `w` — so `{{+90}}` resolves to nothing rather than to seconds. A string that is exactly one token keeps that value's TYPE.", "",
    `**Substitution tokens this corpus defines** (there are no others — the acceptance refuses a name nothing in scope defines): ${defined}.`, "",
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
    "That is free, needs no server, and refuses a scenario that asserts nothing, an unknown surface, an unimplemented expectation key, a duplicate id and a `{{token}}` nothing in scope defines. Run it; report what it printed.", "");
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
      const text = packText(id, specs, { corpusId: cid, w, persona: (corpus.load(cid) || {}).persona || {} });
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
