// recom/repeatable.js — the surfaces that re-drive on a schedule, and the facts
// that say when they do not have to.
//
// `bb recom gate <id> -- <command>` already knows how not to run something whose
// answer still holds. What it needed was somebody to call it, and the four
// places that most obviously should were the four that never did:
//
//   cron       the crontab line runs `pipeline run factory` every 30 minutes,
//              whether anything moved or not. On a quiet box that is 48 full
//              pipeline runs a day over a tree nobody touched.
//   pipeline   each stage re-derives its own exit criterion on every status
//              call, and several of them walk directories to do it.
//   cookbook   a board is re-run against a corpus that has not changed, which
//              is the most expensive of the four because it spends.
//   genesis    the coverage check re-reads the world and the corpus to answer
//              a question whose inputs are two files.
//
// This is not a cache and the difference is the whole point. A record carries
// `depends` — the specific facts that, had they been different, would have made
// the run come out differently — and those are re-probed on every read. A stage
// is skipped because its inputs READ THE SAME, never because it ran recently.
//
// Two rules, and they are the ones that keep the asymmetry safe.
//
//   1. Anything not provably fresh RUNS. `unknown` is not `fresh`; a probe that
//      could not be read is a reason to do the work, not to skip it.
//   2. A record is written only after a run that SUCCEEDED. A fact-record made
//      from a failure would gate the next run on the fingerprint of a broken
//      world, and the surface would then skip itself for ever.
import path from "node:path";
import { ROOT, BB_DIR, VAR, abs } from "../core/paths.js";
import { load } from "../core/config.js";
import { check, get, record } from "./index.js";

/** The declared surfaces. Data, because adding one must be a row somebody reads
 *  in review and not a call site buried in the module it gates.
 *
 *  `depends` is a function so a surface can name the paths that exist NOW —
 *  a corpus directory, a genesis world — rather than a list written when the
 *  workspace looked different. */
export const REPEATABLES = {
  "cron/factory": {
    what: "the unattended pipeline run",
    saved_wall_s: 240,
    // The tree, the config and the artefacts the factory writes against. When
    // none of these has moved, running the free pipeline produces the same
    // tables it produced last time.
    depends: () => [
      `git_head:${ROOT}`,
      `git_paths:${ROOT}:.`,
      `file_sha:${path.join(BB_DIR, "config.json")}`,
    ],
  },
  "pipeline/orient": {
    what: "the snapgen tables",
    saved_wall_s: 20,
    depends: () => [`git_paths:${ROOT}:.`],
  },
  "pipeline/situation": {
    what: "the local detectors",
    saved_wall_s: 30,
    depends: () => [`git_paths:${ROOT}:.`, `file_sha:${path.join(BB_DIR, "config.json")}`],
  },
  "pipeline/agent": {
    what: "compiling the findings into units",
    saved_wall_s: 15,
    depends: () => [`file_sha:${path.join(VAR, "findings.json")}`, `file_sha:${path.join(BB_DIR, "config.json")}`],
  },
  "cookbook/board": {
    what: "running the corpus against the system",
    // The dearest of the four: a board run drives a real service, so the record
    // stands in for wall clock and, on a corpus an agent writes, for tokens.
    saved_wall_s: 600,
    saved_tokens: 0,
    depends: ({ base = "" } = {}) => {
      const out = [`git_paths:${ROOT}:${path.relative(ROOT, path.join(BB_DIR, "cookbook")) || ".bundlebox/cookbook"}`];
      // The service the board asserts against is a fact about the run. Without
      // it a record would say "the corpus is unchanged" and skip a run against
      // a deployment that moved underneath it.
      if (base) out.push(`http:${base}`);
      return out;
    },
  },
  "genesis/coverage": {
    what: "the world-model coverage check",
    saved_wall_s: 20,
    depends: ({ world = "" } = {}) => {
      const dir = path.join(BB_DIR, "genesis", world || "");
      return [`file_sha:${path.join(dir, "world.json")}`,
        `git_paths:${ROOT}:${path.relative(ROOT, path.join(BB_DIR, "cookbook")) || ".bundlebox/cookbook"}`];
    },
  },
};

export const ids = () => Object.keys(REPEATABLES);

/** The probe list for one surface, or [] when it is not declared. */
export function factsFor(id, opts = {}) {
  const r = REPEATABLES[id];
  if (!r) return [];
  return r.depends(opts) || [];
}

/** Does this surface have to run?
 *
 *  `run: false` only ever comes back with a record that exists and whose every
 *  declared fact re-probed identical. Everything else — no record, a moved
 *  fact, a fact nobody could read, `recom.auto_facts` off — is `run: true` with
 *  the reason, which is rule 1 of this file written as code. */
export function shouldRun(id, opts = {}) {
  const cfg = opts.cfg || load();
  if (!cfg.recom?.auto_facts) return { run: true, verdict: "off", why: "recom.auto_facts is off" };
  if (!REPEATABLES[id]) return { run: true, verdict: "undeclared", why: `\`${id}\` is not a declared repeatable` };
  if (!get(id)) return { run: true, verdict: "missing", why: "no fact-record yet; this run writes one" };
  const v = check(id);
  if (v.verdict === "fresh") {
    return { run: false, verdict: "fresh", why: `every declared fact reads as it did (${v.probed} probe(s), ${v.ms}ms)`,
      record: v, saved_wall_s: get(id)?.saved_wall_s || 0 };
  }
  const moved = (v.moved || []).map((m) => m.probe).join(", ");
  const dark = (v.unreadable || []).map((u) => u.probe).join(", ");
  return { run: true, verdict: v.verdict,
    why: moved ? `${moved} moved` : dark ? `${dark} could not be read, and unreadable is not unchanged` : v.why || v.verdict,
    moved: v.moved || [], unreadable: v.unreadable || [] };
}

/** Write or re-stamp the record for a surface that has just run WELL.
 *
 *  Returns a row rather than throwing: this is called from a stage and a cron
 *  line, and a surface that did its work must not fail because the record of it
 *  could not be written. */
export function remember(id, { outcome = "works", summary = "", evidence = [], ok = true, opts = {}, cfg = load() } = {}) {
  if (!cfg.recom?.auto_facts) return { ok: false, why: "recom.auto_facts is off" };
  if (cfg.recom?.record_on_success && !ok) return { ok: false, why: "the run did not succeed; a record of a broken world would gate the next one on it" };
  const r = REPEATABLES[id];
  if (!r) return { ok: false, why: `\`${id}\` is not a declared repeatable` };
  const depends = factsFor(id, opts);
  if (!depends.length) return { ok: false, why: "no facts could be named for this surface right now" };
  const got = record({
    id,
    title: r.what,
    outcome,
    summary: summary || `${r.what}: ran and produced its artefacts. Re-probed against ${depends.length} fact(s); while they read the same this does not have to run again.`,
    steps: [],
    evidence: evidence.map(String).slice(0, 20),
    depends,
    saved_wall_s: Number(r.saved_wall_s) || 0,
    saved_tokens: Number(r.saved_tokens) || 0,
  }, { apply: true });
  return got.rc === 0 ? { ok: true, id, state: got.state } : { ok: false, why: got.why };
}

/** Every declared surface with its verdict now. What `bb recom repeatable`
 *  prints and what `bb doctor` reads. */
export function survey({ cfg = load() } = {}) {
  return ids().map((id) => {
    const r = REPEATABLES[id];
    const s = shouldRun(id, { cfg });
    // The RECORD's fact count once there is one. `factsFor(id)` is called here
    // with no options, and a surface whose probe list depends on a runtime
    // argument — `cookbook/board` adds an `http:` probe for the base it ran
    // against — declares fewer facts than it recorded. Reporting 1 beside a
    // verdict that says "2 probe(s)" is this box disagreeing with itself.
    const rec = get(id);
    return { id, what: r.what, facts: (rec?.depends || factsFor(id)).length, ...s };
  });
}

/** Paths as a caller should name them in `evidence`. Here so the four surfaces
 *  spell their artefacts the same way in every record. */
export const evidenceOf = (...p) => p.map((x) => path.relative(ROOT, abs(String(x)))).filter(Boolean);
