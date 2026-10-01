// genesis/world.js — the derived half: a document becomes a world model, and
// the world model becomes a corpus skeleton and a coverage plan.
//
// Everything in this file is a parse or a set difference over text that already
// exists, so it costs nothing and can be re-run on every tick. Deciding WHAT a
// corpus is missing is arithmetic; WRITING the missing scenario is a judgement,
// and that half lives in packs.js behind the one verb that can spend.
import fs from "node:fs";
import path from "node:path";
import * as expert from "../core/expert.js";
import * as corpus from "../cookbook/corpus.js";
import * as episodes from "../buckmaster/episodes.js";
import * as store from "../core/store.js";
import { BB_DIR, OUT, ROOT, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { readText } from "../core/fs.js";
import { now, slug } from "../core/util.js";

export const DIR = () => path.join(BB_DIR, "genesis");
export const PACKS = () => path.join(OUT, "genesis");
export const worldPath = (id) => path.join(DIR(), id, "world.json");

export const ids = () => { try { return fs.readdirSync(DIR()).filter((d) => fs.existsSync(worldPath(d))).sort(); } catch { return []; } };  // no genesis dir yet: no worlds
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

/** A finding row from the store, by id or by an unambiguous id prefix. */
function findingRow(want) {
  const all = store.get("findings", []) || [];
  const exact = all.find((f) => f.id === want);
  if (exact) return { row: exact };
  const hits = all.filter((f) => String(f.id || "").startsWith(want));
  if (hits.length === 1) return { row: hits[0] };
  if (!hits.length) return { why: `no finding \`${want}\`. bb findings` };
  return { why: `\`${want}\` matches ${hits.length} findings: ${hits.map((f) => f.id).join(", ")}` };
}

/** A pasted issue or crash report: the first non-blank line is the title, the
 *  rest is the body. Nothing else is parsed out of it, because a ticket has no
 *  schema and inventing one is how a derivation starts guessing. */
function ticketRow(file) {
  const text = file === "-" ? fs.readFileSync(0, "utf8") : readText(abs(file), null);
  if (text == null) return { why: `cannot read ${rel(abs(file))}` };
  const lines = String(text).split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { why: `${rel(abs(file))} is empty` };
  return { row: { title: lines[i].replace(/^#+\s*/, "").trim(), body: lines.slice(i + 1).join("\n").trim(), path: "" } };
}

/** Everything after the derivation: the source beside the model, the model on
 *  disk, the episode. Shared by all three inlets, because a world derived from
 *  a finding has to be the same file a world derived from a document is — every
 *  verb downstream reads `world.json` and none of them asks where it came from. */
function writeWorld(id, w, { from, text }) {
  const dir = path.join(DIR(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.txt"), text);
  const model = { ...w, id, from, derived_at: now(), source_bytes: Buffer.byteLength(text) };
  writeJson(worldPath(id), model);
  writeJson(path.join(DIR(), "current.json"), { id, at: now() });
  episodes.write({ kind: "stage", verb: "genesis", stage: "genesis:derive",
    features: { bytes: model.source_bytes, lines: w.counts.lines },
    rc: 0, produced: w.counts.capabilities, produces: ["world"],
    turns_saved: episodes.turns({ files_read: 1, searches: w.counts.surfaces + w.counts.capabilities }),
    detail: { world: rel(worldPath(id)) } });
  return { rc: 0, id, world: model, file: rel(worldPath(id)) };
}

/** Document -> world model, written to disk with the source beside it. The
 *  source is kept because every item in the model cites a line of it, and a
 *  citation into a file that has since moved is not evidence.
 *
 *  `--finding` and `--ticket` are the other two inlets. They reach the same
 *  file: a row already carries the path, the rule it contradicts and the
 *  evidence, so it is a field mapping rather than a second parse. */
export function derive({ doc = "", prompt = "", finding = "", ticket = "", name = "", base = "" } = {}) {
  if (finding || ticket) return deriveRow({ finding, ticket, name, base });
  const src = readSource({ doc, prompt });
  if (src.why) return { rc: 2, why: src.why };
  if (!src.text.trim()) return { rc: 2, why: 'nothing to read. bb genesis <doc.md> | bb genesis - | bb genesis --prompt "..." | bb genesis --finding <id> | bb genesis --ticket <file>' };
  const id = slug(name || (src.from && src.from !== "stdin" && src.from !== "--prompt" ? path.basename(src.from).replace(/\.\w+$/, "") : "") || "genesis");
  const w = expert.call("world-derive", { text: src.text, name: id, base });
  if (!w) return { rc: 2, why: `python3 >= 3.9 is required to read a document into a world model (${expert.lastError}). bb doctor` };
  return writeWorld(id, w, { from: src.from, text: src.text });
}

/** A finding row or a pasted ticket -> the same world model. */
function deriveRow({ finding = "", ticket = "", name = "", base = "" } = {}) {
  const kind = finding ? "finding" : "ticket";
  const got = finding ? findingRow(String(finding)) : ticketRow(String(ticket));
  if (got.why) return { rc: 2, why: got.why };
  const row = got.row;
  const id = slug(name || path.basename(String(row.path || "")).replace(/\.\w+$/, "") || row.id || row.title || kind);
  if (!id) return { rc: 2, why: `the ${kind} names nothing a world can be called; pass --name` };
  const w = expert.call("world-derive-row", { row, kind, name: id, base });
  if (!w) return { rc: 2, why: `python3 >= 3.9 is required to read a ${kind} into a world model (${expert.lastError}). bb doctor` };
  const { source = "", ...model } = w;
  return writeWorld(id, model, { from: `${kind} ${row.id || row.path || row.title}`, text: source });
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
  // Spread what is already there FIRST. Re-deriving a world used to rewrite the
  // persona from this field list alone, which silently dropped every key the
  // list did not name — `excluded`, and anything a later version adds. A seed
  // that discards a corpus's own declarations is a seed nobody runs twice.
  writeJson(path.join(dir, "persona.json"), {
    ...persona,
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
  const c = corpus.load(cid) || { scenarios: [] };  // a world with no corpus has no scenarios
  // The persona's `excluded` travels with the scenarios: a capability a corpus
  // refuses to run (it spends, or it writes to the machine) is reported as out
  // of scope with its reason, not as a gap that can never close.
  const p = expert.call("coverage-plan", {
    world: w, limit,
    corpus: { scenarios: c.scenarios, excluded: (c.persona && c.persona.excluded) || [] },
  });
  if (!p) return { rc: 2, why: `python3 is required for the coverage plan (${expert.lastError})` };
  return { rc: 0, id, corpus: cid, ...p };
}
