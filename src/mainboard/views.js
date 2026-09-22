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
import * as dotty from "../dotty/index.js";
import * as cdp from "../dotty/cdp.js";
import * as bugbash from "./bugbash.js";
import * as turntables from "./turntables.js";
import * as proofhouse from "./proofhouse.js";
import * as store from "../core/store.js";
import { load } from "../core/config.js";
import * as expert from "../core/expert.js";
import * as kernel from "../core/kernel.js";
import { codeFiles } from "../snapgen/tables.js";

// The four at the end came in with the bugbash port. They are about the
// rendered surface rather than about system behaviour, which is why they are
// their own words and not stretched out of `GAP`: a tap target under the touch
// floor and a route the corpus never calls are not the same kind of fact and a
// board that spells them the same cannot be sorted by anybody.
// FACTORY is the one category whose subject is this box rather than the system
// under test. Its own word for the same reason the four UI ones have theirs: a
// unit scoped to the whole tree and a route that 500s are not the same kind of
// fact, and a board that spells them the same cannot be sorted by anybody.
export const CATEGORIES = ["PLATFORM", "GAP", "CONTRACT", "SCORE", "FRICTION", "PERFORMANCE", "RACE", "SECURITY", "COVERAGE",
  "UI", "COPY", "A11Y", "STATE", "FACTORY"];
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
  {
    id: "bugbash", title: "Bugbash", question: "does the rendered screen clear the bar?", writes: ["UI", "COPY", "A11Y", "STATE"], prefix: "BB",
    async run({ base = "" } = {}) {
      const cfg = load()?.mainboard?.bugbash || {};
      // The board's --base is the API the corpus calls. The UI is a different
      // service on a different port, and joining a screen path to the API base
      // probes the API's 404 page and reports on it. So bugbash takes its own
      // base and only falls back to the board's when nothing declared one.
      const uiBase = String(cfg.base || base || "");
      const routes = bugbash.routesFrom(cfg, uiBase);
      if (!routes.length) {
        return { ran: false, skipped: "no screen declared. Set `mainboard.bugbash.routes` in .bundlebox/config.json — a list of paths, joined to --base, or absolute URLs. This view never guesses a URL: probing one nobody asked about reports on a page that is not the product" };
      }
      const { host, port } = { host: String(cfg.host || "127.0.0.1"), port: Number(cfg.port || 9222) };
      const up = await cdp.targets({ host, port, timeout: 3000 }).then(() => true).catch(() => false);
      if (!up) return { ran: false, skipped: `no browser at ${host}:${port}. Every row here is a measurement against a rendered page, and there is nothing rendering — start Chrome with --remote-debugging-port=${port} (\`bb dotty targets\` checks it)` };

      // designlabs measures the DECLARATION and says which of its rules a parse
      // cannot close. A rule it reports as a pass, contradicted by the pixel, is
      // the one finding this pair produces that neither half can make alone — so
      // the declared verdict comes in with the judgement.
      const dlOpen = new Set(store.get("findings", [])
        .filter((f) => f.status === "open" && String(f.detector || "").startsWith("designlabs"))
        .map((f) => String(f.key || f.title || "")));
      const declared = { "target.min-size": [...dlOpen].some((k) => k.includes("target.min-size")) ? "fail" : "pass" };

      const banned = Array.isArray(cfg.banned) ? cfg.banned : bugbash.BANNED_DEFAULT;
      const narrowWidth = Number(cfg.narrow) || 390;
      const findings = [];
      const facts = { routes: routes.length, swept: 0, blank: 0, errors: 0 };
      for (const r of routes.slice(0, Number(cfg.max_routes) || 24)) {
        let row;
        try { row = await dotty.sweep({ url: r.url, label: r.label, narrow: narrowWidth, flags: { host, port, settle: Number(cfg.settle) || 8000 } }); }
        catch (e) {
          findings.push({ id: `BB-${r.label}-unreachable`, category: "STATE", severity: "high",
            title: `${r.label} could not be captured`,
            detail: `The browser could not render ${r.url}: ${e.message}. Nothing on this route was checked, which is not the same as this route being fine.`,
            evidence: { route: r.label, url: r.url, error: String(e.message).slice(0, 200) }, target: "local" });
          continue;
        }
        facts.swept += 1;
        if (row.blank === true) facts.blank += 1;
        facts.errors += (row.errors || []).length;
        const j = bugbash.judge(row, { banned, declared, narrowWidth });
        findings.push(...j.findings);
      }
      return { ran: true, findings, facts };
    },
  },
  {
    id: "turntables", title: "Turntables", question: "run the same scenario again — does it still give the same answer?", writes: ["RACE", "CONTRACT"], prefix: "TT",
    async run({ corpusId = "" } = {}) {
      const ids = corpusId ? [corpusId] : corpus.ids();
      if (!ids.length) return { ran: false, skipped: "no corpus; there is nothing to have run twice" };
      const findings = [];
      const facts = {};
      const thin = [];
      for (const id of ids) {
        // Filter on the board's OWN corpus field, not on the filename: board
        // files are `<corpus>-<stamp>.json` and a corpus whose id is a prefix of
        // another's would otherwise be handed the other's history and file
        // regressions against scenarios it has never run.
        const history = cookbook.boards(id, { limit: Number(load()?.mainboard?.turntables?.window) || 10 })
          .filter((b) => b && b.corpus === id);
        if (history.length < 2) { thin.push(`${id}: ${history.length} stored run(s)`); continue; }
        const r = turntables.replay(history, { corpus: id });
        findings.push(...r.findings);
        facts[id] = r.facts;
      }
      if (!Object.keys(facts).length) {
        return { ran: false, skipped: `a replay needs two runs of the same corpus to compare — ${thin.join(", ")}. \`bb cookbook run\` stores one each time; the \`scenarios\` gear does it on every tick` };
      }
      return { ran: true, findings, facts };
    },
  },
  {
    id: "proofhouse", title: "Proofhouse", question: "is what this box produced fit to act on?", writes: ["FACTORY"], prefix: "PH",
    // The only view that reads no service and no corpus: its subject is on disk
    // already. It is last on purpose — every view above it may have written a
    // finding this run, and a queue is worth checking after it is full.
    async run() {
      const units = store.get("units", []) || [];
      const rows = store.get("findings", []) || [];
      if (!units.length && !rows.length) return { ran: false, skipped: "no units and no findings: this box has produced nothing to check" };
      let universe = 0;
      try { universe = codeFiles().length; } catch { /* reported as a blind spot below, never as a pass */ }
      const r = proofhouse.check({ units, findings: rows, universe });
      // R1 says a view that did not run reports why. A view that ran with one
      // eye shut has the same failure at a smaller size, so the facts carry it.
      return { ran: true, findings: r.findings, facts: { ...r.facts, blind: r.blind } };
    },
  },
];

export const view = (id) => VIEWS.find((v) => v.id === id) || null;
