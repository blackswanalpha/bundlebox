// stages.js — the pipeline as a declared thing, with an exit criterion per
// stage and the one command that closes it.
//
//   genesis -> situation -> orient -> corpus -> scenarios -> simulation
//           -> pinpoint  -> agent   -> monitor -> echos -> ship
//
// Every stage before `agent` is free. The value of writing the stages down is
// that a pipeline fails by SKIPPING, not by erroring: a corpus nobody ran, a
// board older than the scenarios in it, findings nobody compiled. Each of those
// is silent, and each makes the next stage produce a confident answer about
// stale inputs. So a stage is not "done" because it ran once — it is done when
// its exit criterion holds NOW, and `gaps()` reports the first one that does
// not, with the command that closes it.
//
// An exit criterion that cannot be evaluated returns `unknown`, never `ok`.
// Skipped and passed are different states and a green that means "nothing was
// checked" is the failure mode this whole tree exists to remove.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as kernel from "../core/kernel.js";
import * as expert from "../core/expert.js";
import { BB_DIR, VAR, OUT, ROOT, rel } from "../core/paths.js";
import { readJson, load as loadCfg } from "../core/config.js";
import { gitOk, git } from "../core/exec.js";
import { shouldRun, REPEATABLES } from "../recom/repeatable.js";
import { list as corpusList } from "../cookbook/corpus.js";
import { reachable } from "./facts.js";

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const newest = (dir, suffix = ".json") => {
  let best = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(suffix)) best = Math.max(best, mtime(p)); }
  };
  walk(dir);
  return best;
};
const countFiles = (dir, suffix = ".json") => { let n = 0; const walk = (d) => { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.name.endsWith(suffix)) n++; } }; walk(dir); return n; };
const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60000)}m ago` : "never");

/** The base the first corpus that declares one runs against.
 *
 *  Read here rather than from config because a corpus is a thing with its own
 *  persona, and the service it asserts against is a property of that persona —
 *  not of this workspace, which may hold several. Never throws: a stage
 *  criterion that dies takes the other ten with it. */
function corpusBase() {
  try {
    for (const c of corpusList()) if (c && c.base) return String(c.base);
  } catch { /* no corpus, or one this box cannot read: the caller says so */ }
  return "";
}

const ok = (why, evidence = {}) => ({ state: "ok", why, evidence });
const gap = (why, evidence = {}) => ({ state: "gap", why, evidence });
const unknown = (why, evidence = {}) => ({ state: "unknown", why, evidence });

export const STAGES = [
  {
    id: "genesis", title: "Genesis", question: "is there a world model to work against?",
    cost: 0, fix: "bb genesis <doc.md>",
    exit() {
      const dir = path.join(BB_DIR, "genesis");
      let ids = []; try { ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "world.json"))); } catch { /* no directory is a gap, not an error */ }
      if (!ids.length) return gap("no world has been derived; the pipeline has no inlet");
      const w = readJson(path.join(dir, ids[0], "world.json"), {});
      const n = w?.counts?.capabilities || 0;
      return n ? ok(`${ids.length} world(s), ${n} capabilities, ${w.counts.rules} rules from ${w.from}`, { worlds: ids, counts: w.counts })
        : gap(`world \`${ids[0]}\` names no capability, so nothing can be addressed`, { counts: w.counts });
    },
  },
  {
    id: "situation", title: "Situation", question: "have the local detectors looked at what is on disk?",
    cost: 0, fix: "bb scan",
    exit() {
      const f = store.get("findings", []);
      const t = mtime(path.join(VAR, "findings.json"));
      if (!t) return gap("`bb scan` has never run here; nothing local has looked");
      const age = (Date.now() - t) / 3600000;
      if (age > 24) return gap(`the findings store is ${Math.round(age)}h old; the tree has almost certainly moved`, { findings: f.length, age_hours: Math.round(age) });
      return ok(`${f.filter((x) => x.status === "open").length} open of ${f.length}, scanned ${ago(t)}`, { findings: f.length });
    },
  },
  {
    id: "orient", title: "Orient", question: "is the free context a session opens with built and fresh?",
    cost: 0, fix: "bb pipeline run orient",
    exit() {
      const idx = path.join(OUT, "snapgen", "INDEX.md");
      if (!mtime(idx)) return gap("no snapgen tables; every session pays to find out where things are");
      return ok(`tables built ${ago(mtime(idx))}`, { index: rel(idx) });
    },
  },
  {
    id: "corpus", title: "Corpus", question: "is there a scenario corpus, and does it assert anything?",
    cost: 0, fix: "bb genesis practice --run --spend   (plan, send, verify, remember; or by hand: bb genesis pack, bb genesis send <surface> --run --spend)",
    exit() {
      const dir = path.join(BB_DIR, "cookbook");
      let ids = []; try { ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "persona.json"))); } catch { /* none */ }
      if (!ids.length) return gap("no corpus; `bb genesis <doc>` seeds one from a document");
      const n = ids.reduce((a, id) => a + countFiles(path.join(dir, id, "scenarios")), 0);
      if (!n) return gap(`${ids.length} corpus/corpora seeded but no scenarios written yet — this is the one stage that needs a model`, { corpora: ids });
      return ok(`${ids.length} corpus/corpora, ${n} scenario file(s)`, { corpora: ids, scenarios: n });
    },
  },
  {
    id: "scenarios", title: "Scenarios", question: "has the corpus been run against the system since it last changed?",
    cost: 0, fix: "bb cookbook run   (the corpus declares its own base in persona.json)",
    exit() {
      const boards = newest(path.join(VAR, "boards"));
      const scen = newest(path.join(BB_DIR, "cookbook"));
      if (!scen) return unknown("no corpus to run");
      // A stage whose command cannot run without an argument the workspace has
      // not declared is UNKNOWN, not a gap: reporting a gap says the corpus was
      // not run, when what happened is that nothing here knows what to run it
      // against.
      //
      // The base comes from the corpus itself. `persona.json` carries one and
      // `corpus.spec` falls back to it, which is what lets a gear run this with
      // no URL. It briefly read `mainboard.bugbash.base` instead — that is the
      // UI origin, and a corpus runs against the API, so the two are different
      // services on different ports and reading one for the other points every
      // scenario at a 404 page.
      const base = corpusBase();
      if (!base) {
        return unknown("no corpus declares a base to run against: set `base` in .bundlebox/cookbook/<id>/persona.json, or pass `bb cookbook run --base <url>`", { needs: "persona.base" });
      }
      // A base nothing answers at is the same kind of UNKNOWN as no base: the
      // run cannot happen, and reporting a gap says the corpus was not run
      // when what happened is that there was nothing to run it against.
      if (!reachable(base)) return unknown(`nothing answers at ${base}; the corpus cannot be run until the service is up`, { base, needs: "service" });
      if (!boards) return gap(`the corpus has never been run against ${base}; a corpus nobody runs is documentation`, { base });
      if (boards < scen) return gap(`the newest board is older than the newest scenario (${ago(boards)} vs ${ago(scen)}) — it is reporting on a corpus that has changed`, { board_at: boards, corpus_at: scen });
      return ok(`board is ${ago(boards)}, newer than the corpus`, { board_at: boards });
    },
  },
  {
    id: "simulation", title: "Simulation", question: "does it still hold at more than one caller?",
    cost: 0, fix: "bb simulate run smoke --base <url>",
    exit() {
      const t = newest(path.join(VAR, "simulations"));
      if (!kernel.available()) return unknown("the simulator is a kernel op and there is no `bbk` on this box: `bb kernel build`");
      if (!t) return gap("nothing has been simulated; every number so far is about one caller at a time");
      return ok(`last run ${ago(t)}`, { at: t });
    },
  },
  {
    id: "pinpoint", title: "Pinpoint", question: "is the worst open finding packed to one window?",
    cost: 0, fix: "bb pinpoint \"<the finding's title>\"",
    exit() {
      const open = store.get("findings", []).filter((f) => f.status === "open");
      if (!open.length) return ok("nothing open to pack");
      const t = newest(path.join(OUT, "pinpoint"), ".md");
      const worst = open.sort((a, b) => ({ critical: 4, high: 3, medium: 2, low: 1, info: 0 }[b.severity] || 0) - ({ critical: 4, high: 3, medium: 2, low: 1, info: 0 }[a.severity] || 0))[0];
      if (!t) return gap(`${open.length} open and nothing anchored; a session would search for what \`bb pinpoint\` locates for free`, { worst: worst.title });
      return ok(`last brief ${ago(t)}, ${open.length} open`, { open: open.length });
    },
  },
  {
    id: "agent", title: "Agent", question: "is the work packed and budgeted before anything opens a session?",
    cost: 0, fix: "bb compile --write   then   bb route --write",
    exit() {
      const units = store.get("units", []);
      const ready = units.filter((u) => u.status === "ready");
      const open = store.get("findings", []).filter((f) => f.status === "open");
      if (!open.length && !units.length) return ok("nothing open, nothing to pack");
      if (!units.length) return gap(`${open.length} findings open and none compiled; a session would be handed a list instead of a window`, { open: open.length });
      const heavy = units.filter((u) => u.verdict === "HEAVY").length;
      return ok(`${ready.length} unit(s) ready of ${units.length}${heavy ? `, ${heavy} HEAVY` : ""}`, { units: units.length, ready: ready.length, heavy });
    },
  },
  {
    id: "monitor", title: "Monitor", question: "does the box know what the current window has left?",
    cost: 0, fix: "bb tokens ledger   then   bb monitor",
    exit() {
      const rows = store.rows("usage");
      if (!rows.length) return gap("no usage folded; nothing can gate a spend on what is left");
      const last = rows[rows.length - 1];
      const t = Date.parse(last.ts || last.at || "") || 0;
      const age = (Date.now() - t) / 3600000;
      if (age > 6) return gap(`the ledger's last turn is ${Math.round(age)}h old; fold the transcripts before trusting the window`, { last: last.ts });
      return ok(`${rows.length} turns folded, last ${ago(t)}`, { turns: rows.length });
    },
  },
  {
    id: "echos", title: "Echos", question: "is the work itself going anywhere?",
    cost: 0, fix: "bb echos",
    exit() {
      // The only stage that asks about the WORK rather than the artefacts. Every
      // stage above it checks that something was derived and is fresh; none of
      // them could say whether the sessions doing the deriving are spinning,
      // undoing themselves or carrying a window instead of changing code.
      const f = path.join(OUT, "echos", "latest.json");
      const t = mtime(f);
      if (!t) return gap("the echos have never run here; nothing has looked at whether the work is converging", { fix: "bb echos" });
      const r = readJson(f, {});
      const age = (Date.now() - t) / 3600000;
      if (age > 24) return gap(`the last echo pass is ${Math.round(age)}h old; it is reporting on sessions that have since been replaced`, { at: r.at });
      const hits = (r.echos || []).filter((e) => e.verdict === "hit");
      const dark = (r.echos || []).filter((e) => e.verdict === "unknown");
      if (hits.length) {
        return gap(`${hits.length} echo(s) hit over ${r.sessions} session(s): ${[...new Set(hits.map((e) => e.id))].join(", ")}`,
          { hits: hits.length, ids: [...new Set(hits.map((e) => e.id))] });
      }
      if (dark.length && dark.length === (r.echos || []).length) {
        return unknown(`every echo returned unknown: ${dark[0].detail}`, { at: r.at });
      }
      return ok(`${(r.echos || []).length} echo(s) clear over ${r.sessions} session(s), ran ${ago(t)}`, { sessions: r.sessions });
    },
  },
  {
    id: "ship", title: "Ship", question: "is there a command that proves a change, and a clean way out?",
    cost: 0, fix: "bb init   (writes kernel.gates)   then   bb git status",
    exit() {
      const gates = loadCfg().kernel?.gates || {};
      const named = Object.entries(gates).filter(([k, v]) => v && k !== "source");
      if (!named.length) return gap("no acceptance command is declared, so every unit ships `unproven`");
      if (!gitOk(ROOT)) return unknown("not a git worktree; `bb git` cannot commit, push or open a PR from here");
      const dirty = git(["status", "--porcelain"], ROOT).out.split("\n").filter(Boolean).length;
      return ok(`${named.length} gate(s) declared${dirty ? `, ${dirty} file(s) uncommitted` : ", tree clean"}`, { gates: named.map(([k]) => k), dirty });
    },
  },
];

/** Every stage evaluated now. Never throws: a criterion that blew up is a row
 *  reading `unknown` with the error, because one broken check must not hide the
 *  other nine.
 *
 *  A stage that has a declared fact-record and whose facts still READ THE SAME
 *  carries `held: true`. It is not a different verdict — the exit criterion is
 *  still evaluated and still decides, because a record about inputs cannot
 *  answer a question about outputs. What it changes is the RUNNER: a stage
 *  whose facts hold does not have to re-derive, which is the difference between
 *  spending a pipeline run and reading one. */
export function status() {
  return STAGES.map((s) => {
    let r;
    try { r = s.exit(); } catch (e) { r = unknown(`the check itself failed: ${e.message}`); }
    let facts = null;
    if (REPEATABLES[`pipeline/${s.id}`]) {
      try { facts = shouldRun(`pipeline/${s.id}`); } catch (e) { facts = { run: true, verdict: "unknown", why: String(e.message || e) }; }
    }
    return { id: s.id, title: s.title, question: s.question, fix: s.fix, cost: s.cost, ...r,
      held: Boolean(facts && !facts.run), facts };
  });
}

export function gaps() {
  const rows = status();
  return { stages: rows, gaps: rows.filter((r) => r.state === "gap"), unknown: rows.filter((r) => r.state === "unknown"),
    ok: rows.filter((r) => r.state === "ok").length, of: rows.length,
    held: rows.filter((r) => r.held).map((r) => r.id),
    next: rows.find((r) => r.state === "gap") || null };
}
