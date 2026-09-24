// cookbook/index.js — the scenario verb.
//
// A detector asks what the FILES say. A scenario asks what the RUNNING system
// does. That is the one class of question in this factory that makes a request,
// and everything else about it stays factory-shaped: JSON on disk, no model
// anywhere, findings with evidence, one ledger.
//
// The loop this verb closes, and the reason it is worth automating:
//
//   bb cookbook check     the corpus asserts something              free
//   bb cookbook select    which scenarios are worth running now     free, learned
//   bb cookbook calibrate the selector, replayed against stored boards   free
//   bb cookbook run       the kernel runs them                      free, seconds
//   bb cookbook board     what the last run found                   free
//                         red steps are findings, so `bb compile` packs them,
//                         `bb route` budgets them and only then does a model see
//                         one — with the evidence already gathered.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import * as episodes from "../buckmaster/episodes.js";
import { VAR, OUT, ROOT, rel } from "../core/paths.js";
import { readJson, writeJson, load as loadCfg, calibrationPath } from "../core/config.js";
import { out, warn, emit, hr } from "../core/log.js";
import { now, stamp, human, pad, table } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import * as corpus from "./corpus.js";
import { run as runEngine, pick } from "./engine.js";

export const BOARDS = () => path.join(VAR, "boards");
const KEEP = 20;
const RED = new Set(["failed", "error"]);

export function boardFiles(id = "") {
  try {
    return fs.readdirSync(BOARDS()).filter((f) => f.endsWith(".json") && (!id || f.startsWith(`${id}-`))).sort()
      .map((f) => path.join(BOARDS(), f));
  } catch { return []; } // no boards run yet
}
export const boards = (id, { limit = KEEP } = {}) => boardFiles(id).slice(-limit).map((f) => readJson(f, null)).filter(Boolean);
export const latest = (id) => { const f = boardFiles(id); return f.length ? readJson(f[f.length - 1], null) : null; };

function keep(id) {
  const files = boardFiles(id);
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) { try { fs.unlinkSync(f); } catch { /* a board we cannot delete is not a failure */ } }
}

export function store_board(board) {
  fs.mkdirSync(BOARDS(), { recursive: true });
  const file = path.join(BOARDS(), `${board.corpus}-${stamp()}.json`);
  writeJson(file, board);
  keep(board.corpus);
  return rel(file);
}

/** Red steps become findings, one per scenario, carrying the rule it
 *  contradicts. Blocked is the ENVIRONMENT and empty is the CORPUS, and both
 *  are filed as such rather than as product defects — a board that reports a
 *  directory permission as nineteen defects is a board nobody reads twice. */
export function findings(board) {
  const det = `cookbook:${board.corpus}`;
  const rows = [];
  for (const sc of board.scenarios || []) {
    const red = (sc.steps || []).filter((s) => RED.has(s.state));
    const blocked = (sc.steps || []).filter((s) => s.state === "blocked");
    const empty = (sc.steps || []).filter((s) => s.state === "empty");
    if (red.length) {
      const first = red[0];
      const detail = [
        sc.rule ? `The rule this contradicts:\n${(Array.isArray(sc.rule) ? sc.rule : [sc.rule]).map((r) => `  - ${r}`).join("\n")}` : "No `rule` block: the corpus states no source for this expectation.",
        "",
        ...red.slice(0, 6).map((s) => `${s.request || s.name}\n  ${s.why.join("\n  ")}${s.evidence?.status ? `\n  status ${s.evidence.status}` : ""}${s.evidence?.body ? `\n  body: ${String(s.evidence.body).slice(0, 300)}` : ""}`),
      ].join("\n").slice(0, 1500);
      rows.push({ detector: det, severity: sc.severity || "medium", precision: "exact",
        title: `${sc.surface}: ${sc.title || sc.id}`, path: sc.id, files: [], key: `${board.corpus}/${sc.id}`,
        detail, evidence: { base: board.base, engine: board.engine, steps: red.length, first: { request: first.request, why: first.why, got: first.evidence?.got ?? null, status: first.evidence?.status ?? null } },
        fix_hint: "Three things a red step can be, in the order worth checking: the corpus is wrong (a route moved, a field renamed); the environment is wrong (a flag off, nothing seeded); or the system disagrees with its own source. The `rule` block says which.",
        auto_fix: null, kind: "investigate", est_tokens: estimateText(detail, "prose") });
    } else if (blocked.length) {
      rows.push({ detector: det, severity: "low", precision: "exact",
        title: `${sc.surface}: ${sc.id} was blocked before it could test anything`, path: sc.id, files: [], key: `${board.corpus}/${sc.id}/blocked`,
        detail: `A precondition did not hold, so ${blocked.length} step(s) were never asked. This is the ENVIRONMENT, not the product.\n${blocked[0].why.join("\n")}`,
        evidence: { blocked: blocked.length, why: blocked[0].why }, fix_hint: "Fix the precondition, then read this surface.", auto_fix: null, kind: "verify", est_tokens: 300 });
    }
    if (empty.length) {
      rows.push({ detector: det, severity: "medium", precision: "exact",
        title: `${sc.id}: ${empty.length} step(s) assert nothing`, path: sc.id, files: [sc._file || ""].filter(Boolean), key: `${board.corpus}/${sc.id}/empty`,
        detail: `Green here means nothing was checked: ${empty.map((s) => s.name).join(", ")}. \`bb cookbook check\` refuses this shape; it reached a board because the step was added after the last check.`,
        evidence: { steps: empty.map((s) => s.name) }, fix_hint: "Give the step an `expect` block, or delete it.", auto_fix: null, kind: "fix", est_tokens: 250 });
    }
  }
  return { detector: det, rows };
}

export async function runCorpus(id, opts = {}) {
  const c = corpus.load(id);
  if (!c) return { rc: 2, why: `no corpus \`${id}\`. bb cookbook list` };
  const gate = corpus.check(c);
  if (!gate.ok && !opts.force) return { rc: 2, why: `the corpus does not validate; \`bb cookbook check --persona ${id}\` (or --force)`, errors: gate.errors };
  let ids = opts.ids || null;
  let selection = null;
  if (opts.budget) {
    selection = select(id, { budget: opts.budget });
    if (selection?.selected) ids = selection.selected;
  }
  const input = corpus.spec(c, { base: opts.base, rpm: opts.rpm, only: opts.only, ids, parallel: opts.parallel, root: ROOT });
  if (!input.base) return { rc: 2, why: "no base: pass --base, or put one in persona.json. Nothing is guessed" };
  if (!input.scenarios.length) return { rc: 2, why: "nothing selected to run" };
  const t0 = Date.now();
  const res = await runEngine(input, { engine: opts.engine || "auto" }); // no --engine given, not a failure
  const board = { corpus: id, at: now(), ...res, selected: ids ? ids.length : input.scenarios.length, of: c.scenarios.length,
    selection: selection ? { budget_steps: selection.budget_steps, steps_selected: selection.steps_selected, basis: selection.basis } : null };
  const file = store_board(board);
  const f = findings(board);
  if (opts.write !== false) store.mergeFindings(f.rows, { detectors: new Set([f.detector]) });
  const steps = board.totals.passed + board.totals.failed + board.totals.blocked + board.totals.error + board.totals.empty;
  episodes.write({ kind: "stage", verb: "cookbook", stage: `cookbook:${id}`, run_id: opts.runId || "",
    features: { corpus_scenarios: input.scenarios.length, engine: board.engine, rpm: input.rpm, paced: input.rpm > 0 },
    rc: board.totals.failed + board.totals.error ? 1 : 0, seconds: (Date.now() - t0) / 1000,
    produced: f.rows.length, produces: ["findings", "board"],
    turns_saved: episodes.turns({ commands: steps, rows: steps }),
    detail: { board: file, totals: board.totals } });
  return { rc: 0, board, file, findings: f.rows.length };
}

/** Which scenarios are worth running now. Free, and it is the half that makes
 *  running a big corpus every time unnecessary. */
/** The fitted ranking weights, or null when nothing has been calibrated here.
 *  Shipped defaults live in `scenarios.py`; a fit lives beside every other
 *  per-repo factor in calibration.json, so `bb doctor` shows both in one place
 *  and a workspace that has never calibrated runs on the shipped numbers. */
export function fittedWeights() {
  const c = readJson(calibrationPath(), {}) || {};
  const w = c.cookbook_select?.weights;
  return w && typeof w === "object" ? w : null;
}

export function select(id, { budget = 0, weights = fittedWeights() } = {}) {
  const c = corpus.load(id);
  if (!c) return null;
  const r = expert.call("scenario-select", {
    scenarios: c.scenarios.map((s) => ({ id: s.id, surface: s.surface, severity: s.severity, steps: s.steps || [] })),
    boards: boards(id), budget_steps: Number(budget) || 0, now: now(), weights: weights || undefined,
  });
  return r;
}

/** The experiment: replay every stored board against 108 candidate weight
 *  vectors and keep the one that finds the most red per step spent. Costs a
 *  read and a few milliseconds of Python — no request, no model, nothing run.
 *  The shipped vector is candidate zero, so this cannot return worse than now. */
export function calibrate(id, { budget = 0, costPenalty = 0 } = {}) {
  const c = corpus.load(id);
  if (!c) return null;
  return expert.call("scenario-calibrate", {
    scenarios: c.scenarios.map((s) => ({ id: s.id, surface: s.surface, severity: s.severity, steps: s.steps || [] })),
    boards: boards(id), budget_steps: Number(budget) || 0,
    ...(costPenalty ? { cost_penalty: Number(costPenalty) } : {}),
  });
}

/** Write a fit. Keyed by corpus: two corpora have two histories and one set of
 *  weights fitted on the wrong one is worse than the shipped default. */
export function applyWeights(id, fit) {
  const p = calibrationPath();
  const cal = readJson(p, {}) || {};
  cal.cookbook_select = { weights: fit.weights, corpus: id, boards: fit.scored,
    score_before: fit.score_before, score_after: fit.score_after, calibrated_at: now() };
  writeJson(p, cal);
  return p;
}

export function verdicts(id) {
  const b = boards(id, { limit: 2 });
  if (!b.length) return null;
  const th = loadCfg().cookbook?.thresholds || {};
  return expert.call("board-verdicts", { board: b[b.length - 1], previous: b.length > 1 ? b[b.length - 2] : null, thresholds: th });
}

// ── reporting ───────────────────────────────────────────────────────────────

const MARK = { passed: "ok  ", failed: "RED ", error: "ERR ", blocked: "blk ", empty: "EMPTY" };

export function boardText(board) {
  const L = [`  ${board.corpus} — ${board.base}   ${board.engine} engine (${board.engine_why || ""})`, ""];
  const bySurface = new Map();
  for (const sc of board.scenarios || []) {
    const k = sc.surface || "(none)";
    if (!bySurface.has(k)) bySurface.set(k, []);
    bySurface.get(k).push(sc);
  }
  for (const [surface, scs] of bySurface) {
    const c = { passed: 0, failed: 0, blocked: 0, error: 0, empty: 0 };
    for (const sc of scs) for (const st of sc.steps || []) c[st.state in c ? st.state : "empty"]++;
    const decided = c.passed + c.failed + c.error;
    const score = decided ? Math.round((100 * c.passed) / decided) : null;
    L.push(`  ${pad(surface, 18)} ${pad(`${c.passed} ok`, 8)} ${pad(c.failed + c.error ? `${c.failed + c.error} red` : "", 8)} ${pad(c.blocked ? `${c.blocked} blocked` : "", 12)} ${score == null ? "—" : `${score}`}`);
    for (const sc of scs) {
      const red = (sc.steps || []).filter((s) => RED.has(s.state));
      if (!red.length) continue;
      L.push(`      ${sc.id}${sc.severity ? ` [${sc.severity}]` : ""} — ${sc.title || ""}`);
      for (const st of red.slice(0, 4)) L.push(`        ${pad(MARK[st.state] || st.state, 5)} ${st.request || st.name}: ${st.why.join("; ").slice(0, 140)}`);
    }
  }
  const t = board.totals || {};
  L.push("", `  ${t.passed || 0} passed · ${(t.failed || 0) + (t.error || 0)} red · ${t.blocked || 0} blocked · ${t.empty || 0} empty` +
    `   ${board.seconds}s, ${board.requests} requests${board.rpm ? ` at ${board.rpm} rpm` : " unpaced"}${board.throttled ? `, ${board.throttled} 429s absorbed` : ""}`);
  if (board.setup?.state === "failed") L.push(`  !! setup failed — nothing below it is a claim about the product`);
  if (board.selected != null && board.of != null && board.selected < board.of) L.push(`  ${board.selected} of ${board.of} scenarios selected${board.selection?.basis ? ` (${board.selection.basis})` : ""}`);
  return L.join("\n");
}

// ── commands ────────────────────────────────────────────────────────────────

const only = (flags) => String(flags.only || "");
/** Which corpus a bare `bb cookbook run` means. `cookbook.default` in config
 *  wins; otherwise the first corpus that declares a base, because a corpus with
 *  no base cannot be run and picking it alphabetically makes the gear fail on a
 *  workspace that has a perfectly runnable one. */
const which = (flags) => {
  const named = String(flags.persona || flags.corpus || flags.p || "");
  if (named) return named;
  const cfg = loadCfg().cookbook?.default;
  if (cfg && corpus.ids().includes(String(cfg))) return String(cfg);
  const ids = corpus.ids();
  return ids.find((id) => corpus.load(id)?.persona?.base) || ids[0] || "";
};

async function cookbookCmd({ _, flags }) {
  const sub = _[0] || "list";

  if (sub === "list" || sub === "personas") {
    const rows = corpus.list();
    if (flags.json) { emit({ corpora: rows, dir: rel(corpus.DIR()) }); return 0; }
    if (!rows.length) { out(`  no corpora under ${rel(corpus.DIR())}.\n  bb genesis <doc>  derives one from a document\n  bb cookbook init <id>  scaffolds an empty one`); return 0; }
    out(table(rows.map((r) => [r.id, r.title, `${r.scenarios} scenarios`, `${r.steps} steps`, `${r.surfaces} surfaces`, r.base || "no base"]),
      { header: ["corpus", "title", "", "", "", "base"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "init") {
    const id = _[1];
    if (!id) { warn("bb cookbook init <id> [--base url]"); return 2; }
    const r = corpus.init(id, { base: String(flags.base || ""), timezone: String(flags.timezone || "UTC"), tzOffset: Number(flags.tzOffset) || 0 });
    out(`  ${r.why}${r.dir ? `\n  ${r.dir}` : ""}`);
    return r.rc;
  }

  if (sub === "check") {
    const targets = flags.persona || flags.corpus ? [which(flags)] : corpus.ids();
    if (!targets.length) { out("  no corpora to check"); return 0; }
    const all = [];
    for (const id of targets) {
      const c = corpus.load(id);
      if (!c) { all.push({ id, ok: false, errors: ["unreadable"], warnings: [], counts: {} }); continue; }
      const r = corpus.check(c);
      all.push({ id, ...r, engine: pick(corpus.spec(c, {})).engine });
    }
    if (flags.json) { emit({ corpora: all }); return all.every((a) => a.ok) ? 0 : 1; }
    for (const a of all) {
      out(`  ${pad(a.id, 16)} ${a.ok ? "ok" : "REFUSED"}  ${a.counts.scenarios || 0} scenarios, ${a.counts.steps || 0} steps, ${a.counts.surfaces || 0} surfaces  (${a.engine} engine)`);
      for (const e of a.errors) out(`    !! ${e}`);
      for (const w of a.warnings.slice(0, 12)) out(`    ·  ${w}`);
    }
    return all.every((a) => a.ok) ? 0 : 1;
  }

  if (sub === "select") {
    const id = which(flags);
    const r = select(id, { budget: Number(flags.budget) || 0 });
    if (!r) { warn(`no corpus \`${id}\`, or python3 is not on this box (bb doctor)`); return 2; }
    if (flags.json) { emit(r); return 0; }
    out(`  ${id} — ${r.basis}`);
    out(table(r.ranked.slice(0, Number(flags.limit) || 20).map((x) => [x.id, x.severity || "-", x.last_state, x.runs ? `${x.reds}/${x.runs} red` : "-", x.age_days == null ? "-" : `${x.age_days}d`, x.steps, x.value]),
      { header: ["scenario", "sev", "last", "history", "age", "steps", "value"] }).split("\n").map((l) => "  " + l).join("\n"));
    if (r.budget_steps) out(`\n  ${r.selected.length} selected, ${r.steps_selected} steps of a ${r.budget_steps}-step budget`);
    return 0;
  }

  if (sub === "calibrate") {
    const id = which(flags);
    const r = calibrate(id, { budget: Number(flags.budget) || 0, costPenalty: Number(flags.cost) || 0 });
    if (!r) { warn(`no corpus \`${id}\`, or python3 is not on this box (bb doctor)`); return 2; }
    if (flags.json) { emit(r); return r.ok ? 0 : 1; }
    const shape = (w) => `p_red ${w.p_red} / flip ${w.flip} / staleness ${w.staleness} / cost ${w.cost}`;
    if (!r.ok) {
      out(`  ${id} — not calibrated: ${r.why}`);
      out(`  running on the shipped weights: ${shape(r.weights)}`);
      return 1;
    }
    out(`  ${id} — ${r.basis}`, "");
    out(table(r.per_board.map((b) => [b.at || "?", b.red, b.caught, `${b.selected}/${b.of}`, `${b.steps}/${b.steps_total}`, b.recall, b.score]),
      { header: ["board", "red", "caught", "picked", "steps", "recall", "score"] }).split("\n").map((l) => "  " + l).join("\n"));
    out("");
    out(`  shipped  ${shape(r.shipped)}   score ${r.score_before}`);
    out(`  fitted   ${shape(r.weights)}   score ${r.score_after}`);
    if (!r.changed) { out(`\n  the shipped weights already win on these ${r.scored} board(s); nothing to apply`); return 0; }
    if (flags.apply) { out(`\n  written to ${rel(applyWeights(id, r))}`); return 0; }
    out(`\n  ${r.candidates} vectors tried. \`bb cookbook calibrate --apply\` writes the fitted set; until then select runs on the shipped one.`);
    return 0;
  }

  if (sub === "board") {
    const id = which(flags);
    const b = latest(id);
    if (!b) { warn(`no stored board for \`${id}\`. bb cookbook run --persona ${id} --base <url>`); return 2; }
    const v = flags.rules ? verdicts(id) : null;
    if (flags.json) { emit({ board: b, verdicts: v }); return 0; }
    out(boardText(b));
    if (v?.findings?.length) { hr(); for (const f of v.findings) out(`  ${pad(f.severity, 8)} ${f.rule.padEnd(20)} ${f.title}`); }
    return 0;
  }

  if (sub === "run") {
    const id = which(flags);
    if (!id) { warn("no corpus. bb cookbook init <id>, or bb genesis <doc>"); return 2; }
    if (flags.plan) {
      const c = corpus.load(id);
      if (!c) { warn(`no corpus \`${id}\``); return 2; }
      const input = corpus.spec(c, { base: String(flags.base || ""), rpm: flags.rpm, only: only(flags), root: ROOT });
      const p = pick(input, { engine: String(flags.engine || "auto") });
      out(`  ${id}: ${input.scenarios.length} scenarios, ${input.scenarios.reduce((a, s) => a + s.steps.length, 0)} steps against ${input.base || "(no base)"}\n  engine ${p.engine} — ${p.why}\n  ${input.rpm ? `paced at ${input.rpm} rpm` : "unpaced"}`);
      return 0;
    }
    // A board is the dearest repeatable in this box: it drives a real service,
    // and nothing about that changes when neither the corpus nor the service
    // has moved. So the same gate every other repeatable surface now has —
    // re-probe the declared facts, run only when one of them reads differently.
    // `--force` is already this verb's word for "run it anyway".
    // `--base` and nothing else. The corpus declares its own in `persona.json`
    // and `corpus.spec` already falls back to it, so a gear or a cron line can
    // run this with no URL at all.
    //
    // It briefly fell back to `mainboard.bugbash.base` here, which was wrong in
    // the exact way that setting's own comment warns about: bugbash's base is
    // the UI ORIGIN and a corpus runs against the API, two services on two
    // ports. Setting it would have silently overridden the corpus's declared
    // base and pointed every scenario at a 404 page.
    const base = String(flags.base || "");
    const { shouldRun, remember } = await import("../recom/repeatable.js");
    const gate = flags.force ? { run: true, verdict: "forced", why: "--force" } : shouldRun("cookbook/board", { base });
    if (!gate.run) {
      if (flags.json) { emit({ skipped: true, ...gate }); return 0; }
      out(`  fresh  the corpus and ${base || "the base"} read exactly as they did when this board was last run, so nothing was driven.`);
      out(`  ${gate.why}\n  \`bb cookbook board\` shows it. --force runs it anyway.`);
      return 0;
    }
    const r = await runCorpus(id, { base, rpm: flags.rpm, only: only(flags),
      parallel: flags.parallel, engine: String(flags.engine || "auto"), budget: Number(flags.budget) || 0,
      ids: flags.ids ? String(flags.ids).split(",") : null, force: !!flags.force, runId: String(flags.run || "") });
    if (r.rc) { if (flags.json) emit(r); else { warn(r.why); for (const e of r.errors || []) out(`    !! ${e}`); } return r.rc; }
    // The base the board RAN against, not the flag. With no `--base` the flag is
    // empty and the corpus's own persona supplied it, so recording the flag
    // would leave the record with no `http:` probe and no way to go stale when
    // the service it asserted against moves.
    remember("cookbook/board", { ok: true, opts: { base: String(r.board?.base || base) }, evidence: [String(r.file || "")].filter(Boolean),
      summary: `The corpus ran against ${base || "the configured base"}: ${r.board.totals.passed} passed, ${r.board.totals.failed} failed, ${r.board.totals.error} errored. While the corpus and that service read the same, this board stands.` });
    if (flags.json) { emit({ board: r.board, file: r.file, findings: r.findings }); return 0; }
    out(boardText(r.board));
    out(`\n  ${r.findings} finding(s) stored · board ${r.file}`);
    return (r.board.totals.failed + r.board.totals.error) ? 1 : 0;
  }

  warn(`unknown cookbook sub-verb: ${sub}. list | check | select | calibrate | run | board | init`);
  return 2;
}

export const commands = {
  cookbook: {
    help: "run a scenario corpus against the running system; red steps become findings (0 model tokens)",
    usage: "bb cookbook [list|check|select|calibrate|run|board|init] [--persona id] [--base url] [--rpm n] [--only surface] [--budget steps] [--engine kernel|js] [--plan] [--apply] [--json]",
    long: [
      "A detector asks what the files say. A corpus asks what the running system does.",
      "",
      "  bb cookbook check                every corpus validates — no server, no requests",
      "  bb cookbook calibrate            replay the stored boards, fit the selector\'s weights (--apply to keep them)",
      "  bb cookbook select --budget 60   which scenarios are worth running now, and why",
      "  bb cookbook run --base http://127.0.0.1:4400",
      "  bb cookbook board --rules        the last board, and the rules it fired",
      "",
      "Corpora live in .bundlebox/cookbook/<id>/. `bb genesis <doc>` derives one from a document.",
    ].join("\n"),
    run: cookbookCmd,
  },
};
export { corpus };
