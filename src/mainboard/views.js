// views.js — the views, declared. One seed, one ledger, one taxonomy.
//
// A view does not rebuild the harness underneath it. `runbook` owns services,
// `cookbook` owns the corpus, `simulate` owns load, `genesis` owns the world
// model. A view's only contribution is the question it asks across them and the
// findings it records.
//
// Four rules every view is held to, because each one has a failure that looks
// exactly like a pass:
//
//   R1  A view that did not run returns `skipped` with a reason. Green because
//       nothing was checked and green because everything held are identical
//       from outside, and this is the only thing between them.
//   R2  A finding must carry evidence a reader can check: a request and its
//       answer, a file and a line, a measurement with the run it came from.
//       `record()` refuses one without.
//   R3  A finding states what was OBSERVED. A view that read a defect out of the
//       source rather than triggering it prefixes its evidence `static:`.
//   R4  A finding names what it is a claim about: `local`, `mirror` or `prod`.
//       Production is reached only through a two-part opt-in.
import * as cookbook from "../cookbook/index.js";
import * as corpus from "../cookbook/corpus.js";
import * as genesis from "../genesis/index.js";
import * as simulate from "../simulate/index.js";
import * as runbook from "../runbook/index.js";
import * as expert from "../core/expert.js";
import * as kernel from "../core/kernel.js";

export const CATEGORIES = ["PLATFORM", "GAP", "CONTRACT", "SCORE", "FRICTION", "PERFORMANCE", "RACE", "SECURITY", "COVERAGE"];
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;

export const VIEWS = [
  {
    id: "runbook", title: "Runbook", question: "is it up, and is it answering?", writes: ["PLATFORM"], prefix: "RB",
    async run() {
      const rows = runbook.status();
      if (!rows.length) return { ran: false, skipped: "no services declared; nothing after this knows whether anything was listening" };
      const findings = [];
      for (const r of rows) {
        if (r.state !== "up") findings.push({ id: `RB-${r.id}-down`, category: "PLATFORM", severity: "high",
          title: `${r.id} is ${r.state}`, detail: `Declared as \`${r.declared}\`. Every view after this one is reporting on a service that is not running.`,
          evidence: { service: r.id, process: r.state, log: r.log || null }, target: "local" });
        else if (r.answering && r.answering !== "up" && r.answering !== "unknown") findings.push({ id: `RB-${r.id}-health`, category: "PLATFORM", severity: "high",
          title: `${r.id} is running but ${r.answering} at ${r.health}`, detail: r.why || "The process is alive and the health endpoint does not answer.",
          evidence: { service: r.id, health: r.health, state: r.answering, status: r.status ?? null, why: r.why || null }, target: "local" });
      }
      return { ran: true, findings, facts: { services: rows.length, up: rows.filter((r) => r.state === "up").length } };
    },
  },
  {
    id: "cookbook", title: "Cookbook", question: "does the system obey its own stated rules?", writes: ["GAP", "CONTRACT"], prefix: "CB",
    async run({ base = "", corpusId = "", budget = 0, runId = "" } = {}) {
      const ids = corpusId ? [corpusId] : corpus.ids();
      if (!ids.length) return { ran: false, skipped: "no corpus; `bb genesis <doc>` seeds one" };
      const findings = [];
      const facts = {};
      for (const id of ids) {
        const r = await cookbook.runCorpus(id, { base, budget, runId });
        if (r.rc) { findings.push({ id: `CB-${id}-refused`, category: "CONTRACT", severity: "medium",
          title: `corpus ${id} did not run`, detail: r.why, evidence: { corpus: id, why: r.why, errors: (r.errors || []).slice(0, 6) }, target: "local" }); continue; }
        const t = r.board.totals;
        facts[id] = t;
        for (const sc of r.board.scenarios) {
          const red = (sc.steps || []).filter((s) => s.state === "failed" || s.state === "error");
          if (!red.length) continue;
          findings.push({ id: `CB-${id}-${sc.id}`, category: sc.rule ? "CONTRACT" : "GAP", severity: sc.severity || "medium",
            title: `${sc.surface}: ${sc.title || sc.id}`,
            detail: `${red.length} red step(s). ${sc.rule ? `The rule this contradicts: ${(Array.isArray(sc.rule) ? sc.rule : [sc.rule]).join(" ")}` : "No rule block: the corpus states no source for this expectation."}`,
            evidence: { request: red[0].request, why: red[0].why, status: red[0].evidence?.status ?? null, got: red[0].evidence?.got ?? null, base: r.board.base },
            case: sc.id, target: LOCAL.test(r.board.base) ? "local" : "prod" });
        }
      }
      return { ran: true, findings, facts };
    },
  },
  {
    id: "scoreyard", title: "Scoreyard", question: "could a person get through, surface by surface?", writes: ["SCORE", "FRICTION"], prefix: "SY",
    async run({ corpusId = "" } = {}) {
      const ids = corpusId ? [corpusId] : corpus.ids();
      const findings = [];
      const facts = {};
      let any = false;
      for (const id of ids) {
        const v = cookbook.verdicts(id);
        if (!v) continue;
        any = true;
        facts[id] = v.surfaces;
        for (const f of v.findings) {
          // The cookbook view already files every red STEP. This view files the
          // surface-level judgement and refers the detail to the view that owns it.
          if (f.rule === "red_share_gap") continue;
          findings.push({ id: `SY-${id}-${f.key || f.title}`.slice(0, 80), category: f.rule === "blocked_share_env" ? "FRICTION" : f.rule === "empty_steps" ? "COVERAGE" : "SCORE",
            severity: f.severity, title: f.title, detail: f.detail, evidence: { ...f.evidence, corpus: id, rule: f.rule },
            refers: f.rule === "regression" ? "cookbook" : "", target: "local" });
        }
      }
      return any ? { ran: true, findings, facts } : { ran: false, skipped: "no stored board to score; run the cookbook view first" };
    },
  },
  {
    id: "clockwork", title: "Clockwork", question: "where does it break under load, and what are its real limits?", writes: ["PERFORMANCE", "RACE"], prefix: "CW",
    async run({ base = "", profile = "smoke" } = {}) {
      if (!base) return { ran: false, skipped: "no base to put under load; --base" };
      if (!kernel.available()) return { ran: false, skipped: "the simulator is a kernel op and there is no `bbk` on this box" };
      const r = simulate.simulate(profile, { base });
      if (r.rc) return { ran: false, skipped: r.why };
      return { ran: true, facts: { floor_ms: r.run.floor_ms, budget_ms: r.run.budget_ms, levels: r.run.levels.length },
        findings: r.run.findings.map((f) => ({ id: `CW-${profile}-${f.rule}-${f.level}`, category: "PERFORMANCE", severity: f.severity,
          title: f.title, detail: f.detail, evidence: { ...f.facts, base, profile, level: f.level }, target: LOCAL.test(base) ? "local" : "prod" })) };
    },
  },
  {
    id: "redline", title: "Redline", question: "what answers without credentials?", writes: ["SECURITY"], prefix: "RL",
    async run({ base = "", worldId = "", corpusId = "", target = "local" } = {}) {
      if (!base) return { ran: false, skipped: "no base to probe; --base" };
      if (!LOCAL.test(base) && !(target === "prod" && process.env.BB_PROD === "1")) {
        return { ran: false, skipped: `${base} is not loopback. Probing it needs BOTH --target prod AND BB_PROD=1 in the environment` };
      }
      if (!kernel.available()) return { ran: false, skipped: "probing is a kernel op and there is no `bbk` on this box" };
      const w = genesis.world(worldId || genesis.current());
      if (!w) return { ran: false, skipped: "no world model; nothing declares what routes exist" };
      const c = corpus.load(corpusId || corpus.ids()[0]);
      const authed = Object.keys(c?.persona?.headers || {}).some((h) => /^(authorization|cookie|x-api-key|x-auth)/i.test(h));
      if (!authed) return { ran: false, skipped: "the corpus sends no credential header, so 'without credentials' is the only state there is — nothing to compare" };
      const reads = (w.capabilities || []).filter((cap) => cap.kind === "http" && cap.method === "GET" && !cap.path.includes("health"));
      if (!reads.length) return { ran: false, skipped: "the world declares no readable route" };
      const targets = reads.slice(0, 120).map((cap) => ({ name: cap.id, url: base.replace(/\/$/, "") + cap.path.replace(/\{[^}]*\}/g, "probe"), method: "GET" }));
      const probe = kernel.call("probe", { targets, timeout_ms: 4000 });
      const findings = [];
      for (const t of probe?.targets || []) {
        // 2xx with no credential on a route the corpus only ever calls with one.
        if (t.state === "up" && t.status >= 200 && t.status < 300) {
          findings.push({ id: `RL-${t.name}`.slice(0, 80), category: "SECURITY", severity: "high",
            title: `${t.name} answers 200 with no credential`,
            detail: "The corpus sends a credential header on every call. This route answered without one. Either it is deliberately public and the corpus should say so, or it is not.",
            evidence: { url: t.url, status: t.status, ms: t.ms, sent_headers: "none" }, refers: "cookbook", target: LOCAL.test(base) ? "local" : "prod" });
        }
      }
      return { ran: true, findings, facts: { probed: targets.length, open: findings.length } };
    },
  },
  {
    id: "cyberrender", title: "Cyberrender", question: "of everything this world can do, what does no scenario touch?", writes: ["COVERAGE"], prefix: "CR",
    async run({ worldId = "", corpusId = "" } = {}) {
      const id = worldId || genesis.current();
      if (!id) return { ran: false, skipped: "no world model to measure coverage against" };
      const p = genesis.plan(id, { corpusId });
      if (p.rc) return { ran: false, skipped: p.why };
      const findings = [];
      if (p.coverage_pct != null && p.coverage_pct < 80) {
        findings.push({ id: `CR-${id}-coverage`, category: "COVERAGE", severity: p.coverage_pct < 40 ? "high" : "medium",
          title: `${p.corpus} exercises ${p.coverage_pct}% of what ${id} declares`,
          detail: `${p.declared - p.covered} of ${p.declared} capabilities have no scenario, and ${p.shallow} of the covered ones only assert a status code. A green board over half a system is the most expensive kind of green there is. \`bb genesis pack\` writes the briefs.`,
          evidence: { declared: p.declared, covered: p.covered, shallow: p.shallow, top: p.specs.slice(0, 6).map((s) => `${s.capability} (${s.tier})`) },
          refers: "cookbook", target: "local" });
      }
      if (p.phantom_calls.length) {
        findings.push({ id: `CR-${id}-phantom`, category: "COVERAGE", severity: "medium",
          title: `${p.phantom_calls.length} call(s) the corpus makes against nothing the world declares`,
          detail: "Either the document is out of date or the corpus is calling a route that does not exist. Both are worth knowing and they are fixed in opposite places.",
          evidence: { calls: p.phantom_calls.slice(0, 12) }, target: "local" });
      }
      return { ran: true, findings, facts: { coverage_pct: p.coverage_pct, declared: p.declared, covered: p.covered, specs: p.specs_total } };
    },
  },
];

export const view = (id) => VIEWS.find((v) => v.id === id) || null;
