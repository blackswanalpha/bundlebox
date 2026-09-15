// sources.js — what a frame can be filled from. Every one of these is already
// on disk because some other verb put it there; nothing here measures anything
// new and nothing here makes a request.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as ledger from "../tokens/ledger.js";
import * as monitor from "../monitor/index.js";
import * as cookbook from "../cookbook/index.js";
import * as corpus from "../cookbook/corpus.js";
import * as simulate from "../simulate/index.js";
import * as stages from "../pipeline/stages.js";
import { readJson } from "../core/config.js";
import { Frame } from "./frame.js";

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

export const SOURCES = {
  findings: { row: "one finding in the store", build: () => store.get("findings", []).map((f) => ({ ...f, files: (f.files || []).length, open: f.status === "open" ? 1 : 0, evidence: undefined, detail: undefined })) },
  units: { row: "one compiled unit", build: () => store.get("units", []).map((u) => ({ ...u, scope: (u.scope || []).length, findings: (u.finding_ids || []).length, brief: undefined, anchors: (u.anchors || []).length })) },
  lanes: { row: "one routed lane, with actual peak over estimate", build: () => store.get("lanes", []).map((l) => ({ ...l, files: (l.files || []).length, units: (l.unit_ids || []).length, ratio: l.peak && l.est_tokens ? Math.round((100 * n(l.peak)) / n(l.est_tokens)) / 100 : null })) },
  usage: { row: "one API turn, as the ledger folded it", build: () => monitor.rows() },
  blocks: { row: "one five-hour billing block", build: () => monitor.blocks().map((b) => ({ started: new Date(b.start).toISOString(), minutes: b.minutes, turns: b.turns, tokens: b.tokens, usd: b.usd, sessions: b.sessions.length, models: b.models.join(" ") })) },
  sessions: { row: "one session, with its title and what it displaced", build: () => monitor.sessions({ limit: 500 }).map((s) => ({ ...s, models: s.models.join(" "), run_ids: s.run_ids.length })) },
  episodes: { row: "one local action the factory took", build: () => store.rows("episodes").map((e) => ({ id: e.id, kind: e.kind, verb: e.verb, stage: e.stage, gear: e.gear, rc: e.rc, seconds: e.seconds, produced: e.produced, turns_saved: e.turns_saved, useful: e.useful, state: e.state, at: e.at })) },
  calls: { row: "one bridge call", build: () => store.rows("calls").map((c) => ({ id: c.id, state: c.state, reason: c.reason, agent: c.agent, est_tokens: c.est_tokens, accepted: c.accepted, rc: c.rc, at: c.drafted_at || c.at })) },
  scenarios: { row: "one scenario on disk", build: () => corpus.ids().flatMap((id) => (corpus.load(id)?.scenarios || []).map((s) => ({ corpus: id, id: s.id, surface: s.surface, severity: s.severity, steps: (s.steps || []).length, has_rule: s.rule ? 1 : 0, file: s._file }))) },
  board: { row: "one scenario in the latest stored board, per corpus", build: () => corpus.ids().flatMap((id) => { const b = cookbook.latest(id); if (!b) return []; return (b.scenarios || []).map((s) => ({ corpus: id, at: b.at, base: b.base, engine: b.engine, id: s.id, surface: s.surface, severity: s.severity, state: s.state, seconds: s.seconds, steps: (s.steps || []).length, red: (s.steps || []).filter((x) => x.state === "failed" || x.state === "error").length })); }) },
  // The LATEST run per profile, not every run ever stored. A simulation is a
  // measurement of the system at a moment; keeping every one of them in the
  // frame means a run against a service that was down two days ago is still
  // the answer to "what is the error rate", and the only way to clear it is to
  // delete files. The history stays on disk and `bb simulate show` reads it;
  // what the evals judge is the current state.
  simulations: { row: "one level of the latest stored simulation per profile", build: () => {
    let names = [];
    try { names = fs.readdirSync(simulate.RUNS()).filter((f) => f.endsWith(".json")).sort(); } catch { names = []; }
    const latest = new Map();
    for (const f of names) {
      const r = readJson(path.join(simulate.RUNS(), f), null);
      if (!r) continue;
      const prev = latest.get(r.profile);
      if (!prev || String(r.at || "") >= String(prev.at || "")) latest.set(r.profile, r);
    }
    return [...latest.values()].flatMap((r) => (r.levels || []).map((l) => ({
      profile: r.profile, at: r.at, base: r.base, budget_ms: r.budget_ms, floor_ms: r.floor_ms, ...l })));
  } },
  stages: { row: "one pipeline stage and whether its exit criterion holds", build: () => stages.status().map((s) => ({ id: s.id, title: s.title, state: s.state, why: s.why, fix: s.fix })) },
  turns: { row: "one API turn straight from a transcript", build: () => ledger.transcripts().flatMap(({ adapter, file }) => { let t = []; try { t = ledger.turns(file, adapter) || []; } catch { t = []; } return t.map((x) => ({ adapter, session: path.basename(file).replace(/\.\w+$/, ""), ...x, toolResults: Array.isArray(x.toolResults) ? x.toolResults.length : 0 })); }) },
};

export const names = () => Object.keys(SOURCES);

export function load(name) {
  const s = SOURCES[name];
  if (!s) return null;
  try { return new Frame((s.build() || []).filter(Boolean), { name }); }
  catch (e) { return new Frame([{ error: String(e.message || e) }], { name }); }
}
