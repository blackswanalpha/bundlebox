// corpus.js — what a corpus IS on disk, and the gate in front of running one.
//
//   .bundlebox/cookbook/<id>/persona.json      who is being simulated, and why that shape
//   .bundlebox/cookbook/<id>/surfaces.json     the board order, one line each
//   .bundlebox/cookbook/<id>/scenarios/NN-<surface>/<nn>-<slug>.json
//
// **Path order is execution order and the vars are shared within a scenario.**
// `02-items` has written its rows before `09-search` goes looking for them, so
// a corpus that seeds its own row proves the index rather than the product.
//
// `check()` is the whole difference between green-because-everything-held and
// green-because-nothing-was-checked, and it needs no server: it refuses a
// scenario in which nothing asserts, an unknown surface, an expectation key
// nothing implements, a duplicate id and an `as` that names nobody. A typo in
// `as` would otherwise fall back to the persona silently, and a tenancy-leak
// scenario that ran entirely as ONE user is green for the worst possible reason.
import fs from "node:fs";
import path from "node:path";
import { BB_DIR, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { KEYS } from "./expect.js";
import { unsupportedPatterns } from "./engine.js";

export const DIR = () => path.join(BB_DIR, "cookbook");
export const dirOf = (id) => path.join(DIR(), id);

export function ids() {
  try { return fs.readdirSync(DIR()).filter((d) => fs.existsSync(path.join(DIR(), d, "persona.json"))).sort(); }
  catch { return []; }
}

function walkJson(base) {
  const out = [];
  const rec = (d) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith(".json")) out.push(p);
    }
  };
  rec(base);
  return out;
}

/** One corpus, or null when there is no persona.json. Never throws: a torn
 *  scenario file is a row in `bad`, not a crash of the other ninety. */
export function load(id) {
  const dir = dirOf(id);
  const persona = readJson(path.join(dir, "persona.json"), null);
  if (!persona) return null;
  const surfaces = readJson(path.join(dir, "surfaces.json"), []) || [];
  const scenarios = [];
  const bad = [];
  for (const f of walkJson(path.join(dir, "scenarios"))) {
    const v = readJson(f, null);
    if (!v || typeof v !== "object") { bad.push({ file: rel(f), why: "not a JSON object" }); continue; }
    scenarios.push({ ...v, _file: rel(f) });
  }
  return { id, dir, persona: { id, ...persona }, surfaces: Array.isArray(surfaces) ? surfaces : [], scenarios, bad };
}

export function list() {
  return ids().map((id) => {
    const c = load(id);
    if (!c) return { id, error: "unreadable" };
    return { id, title: c.persona.title || id, who: c.persona.who || "", base: c.persona.base || "",
      surfaces: c.surfaces.length, scenarios: c.scenarios.length,
      steps: c.scenarios.reduce((a, s) => a + (s.steps || []).length, 0) };
  });
}

const ASSERTING = (st) => Boolean(st.static || st.run || (st.expect && Object.keys(st.expect).some((k) => KEYS.includes(k))));

/** Problems with the corpus itself. No server, no requests. */
export function check(c) {
  const errors = [], warnings = [];
  const seen = new Map();
  const surfaceIds = new Set(c.surfaces.map((s) => (typeof s === "string" ? s : s.id)));
  const actorIds = new Set(Object.keys(c.persona.actors || {}));
  for (const b of c.bad) errors.push(`${b.file}: ${b.why}`);
  if (!c.surfaces.length) warnings.push("surfaces.json is empty: the board has no order and `--only` cannot select");
  for (const sc of c.scenarios) {
    const where = sc._file || sc.id || "?";
    if (!sc.id) { errors.push(`${where}: no id`); continue; }
    if (seen.has(sc.id)) errors.push(`${where}: duplicate id \`${sc.id}\`, already used by ${seen.get(sc.id)}`);
    seen.set(sc.id, where);
    if (surfaceIds.size && !surfaceIds.has(sc.surface)) errors.push(`${where}: surface \`${sc.surface}\` is not in surfaces.json`);
    const steps = sc.steps || [];
    if (!steps.length) errors.push(`${where}: no steps`);
    if (steps.length && !steps.some(ASSERTING)) errors.push(`${where}: no step asserts anything — it would be green because nothing was checked`);
    if (!sc.rule) warnings.push(`${where}: no \`rule\` block. A red step is then an argument about what the corpus wants, not the system contradicting the source`);
    if (!sc.severity) warnings.push(`${where}: no severity; it will triage as medium`);
    steps.forEach((st, i) => {
      const at = `${where} step ${i + 1} (${st.name || "unnamed"})`;
      const kinds = ["do", "run", "static"].filter((k) => st[k]);
      if (kinds.length === 0) errors.push(`${at}: has none of \`do\`, \`run\`, \`static\``);
      if (kinds.length > 1) errors.push(`${at}: has both \`${kinds.join("` and `")}\`; a step is one thing`);
      if (st.do && !/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S/i.test(st.do)) errors.push(`${at}: \`do\` must be "METHOD /path", got ${JSON.stringify(st.do)}`);
      for (const k of Object.keys(st.expect || {})) if (!KEYS.includes(k)) errors.push(`${at}: expectation \`${k}\` is not implemented — nothing would check it`);
      if (st.as && !actorIds.has(st.as)) errors.push(`${at}: \`as: ${st.as}\` names nobody in persona.actors`);
      if (st.save && typeof st.save !== "object") errors.push(`${at}: \`save\` must be an object of {name: path}`);
    });
  }
  const bad = unsupportedPatterns(spec(c, {}));
  for (const p of bad) warnings.push(`${p.where}: /${p.pattern}/ is outside the kernel's pattern subset (${p.why}) — this corpus runs on the js engine`);
  return { ok: errors.length === 0, errors, warnings,
    counts: { scenarios: c.scenarios.length, steps: c.scenarios.reduce((a, s) => a + (s.steps || []).length, 0), surfaces: c.surfaces.length, actors: actorIds.size } };
}

/** The engine input for a corpus: the persona's clock and headers, the setup,
 *  and the scenarios in path order, optionally narrowed. */
export function spec(c, { base = "", rpm = null, only = "", ids: pick = null, parallel = null, root = process.cwd() } = {}) {
  const p = c.persona || {};
  let scenarios = c.scenarios;
  if (only) { const want = new Set(String(only).split(",").map((s) => s.trim()).filter(Boolean)); scenarios = scenarios.filter((s) => want.has(s.surface)); }
  if (pick) { const want = new Set(pick); scenarios = scenarios.filter((s) => want.has(s.id)); }
  return {
    base: base || p.base || "",
    rpm: rpm == null ? (p.rpm ?? 55) : Number(rpm),
    parallel: parallel == null ? (p.parallel ?? 1) : Number(parallel),
    timeout_ms: p.timeout_ms ?? 20000,
    timezone: p.timezone || "UTC",
    tz_offset_minutes: p.tz_offset_minutes ?? 0,
    headers: p.headers || {},
    vars: p.vars || {},
    actors: p.actors || {},
    setup: p.setup || [],
    root,
    cap_bytes: p.cap_bytes ?? 1200,
    max_429: p.max_429 ?? 6,
    scenarios: scenarios.map((s) => ({ id: s.id, surface: s.surface, severity: s.severity, title: s.title, question: s.question, rule: s.rule, steps: s.steps || [] })),
  };
}

const SAMPLE = {
  id: "01-up", surface: "health", severity: "high", title: "the service answers at all",
  question: "is it up, and does it say what it is?",
  rule: ["Replace this with the behaviour as the CODE defines it, quoted, with the constant names and the file.",
         "Without it a red step is an argument about what the corpus wants."],
  steps: [{ name: "it answers", do: "GET /health", expect: { status: 200, max_ms: 2000 } }],
};

export function init(id, { base = "", timezone = "UTC", tzOffset = 0, title = "", who = "" } = {}) {
  const dir = dirOf(id);
  if (fs.existsSync(path.join(dir, "persona.json"))) return { rc: 2, why: `${rel(dir)} already holds a corpus` };
  fs.mkdirSync(path.join(dir, "scenarios", "01-health"), { recursive: true });
  writeJson(path.join(dir, "persona.json"), {
    title: title || id, who: who || "who is being simulated, and why that shape stresses what matters",
    base, timezone, tz_offset_minutes: tzOffset, rpm: 55, parallel: 1,
    headers: {}, vars: {}, actors: {},
    setup: [{ name: "the service answers before anything claims to have tested it", do: "GET /health", expect: { status: 200 } }],
  });
  writeJson(path.join(dir, "surfaces.json"), [{ id: "health", title: "Health", why: "is it up at all" }]);
  writeJson(path.join(dir, "scenarios", "01-health", "01-up.json"), SAMPLE);
  return { rc: 0, dir: rel(dir), why: `corpus \`${id}\` scaffolded; \`bb cookbook check\` before you run it` };
}
