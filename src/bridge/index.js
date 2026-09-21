// bridge/index.js — the one path from the local factory to a model.
//
// A call is a directory under .bundlebox/out/bridge/<id>/ holding brief.md
// (everything the agent is given, nothing else is sent) and call.json. The
// brief is packed in a fixed order, each section free to produce and each one
// a set of turns the far side does not spend:
//
//   1. the problem, one line
//   2. what memory recalls          the claims the episode table supports
//   3. local evidence               pinpoint's pack, or the open findings on the named files
//   4. what already ran             so the agent does not redo the last ten minutes of local work
//   5. done when                    one acceptance command; it decides
//
// Three separate flags guard spending because they are three decisions:
// `draft` is the default and spends nothing; `--run` sends; `--spend` allows
// a non-zero cost. `bridge.enabled` is false until somebody sets it. The daily
// ceiling counts only usage rows the factory attributed (run_id, lane_id or
// call_id) and FAILS CLOSED: a ledger that cannot be read cannot bound anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shellCmd } from "../core/exec.js";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import * as adapters from "../adapters/index.js";
import { load } from "../core/config.js";
import { OUT, ROOT, rel, abs } from "../core/paths.js";
import { writeJson } from "../core/config.js";
import { readText } from "../core/fs.js";
import { out, emit, warn } from "../core/log.js";
import { now, stamp, slug, human, pad } from "../core/util.js";
import * as prices from "../tokens/prices.js";
import { text as estimateText } from "../tokens/estimate.js";
import * as episodes from "../buckmaster/episodes.js";

export const REASONS = {
  exhausted: "The local automation could not finish this. Everything below was gathered for free; none of it needs re-deriving.",
  assist: "An automation finished and produced something for a model to act on.",
  complete: "A pipeline completed. What is left is a decision.",
  asked: "Somebody asked for this directly.",
};
export const DIR = () => path.join(OUT, "bridge");
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** Last row per id wins. */
export function calls() {
  const by = new Map();
  for (const r of store.rows("calls")) if (r && r.id) by.set(r.id, r);
  return [...by.values()];
}
function save(row) { store.append("calls", row); writeJson(path.join(DIR(), row.id, "call.json"), row); return row; }

const PATHISH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.\w+|[\w-]+\.(?:js|mjs|ts|py|md|json|sh|dart|go|rs))(?=$|[\s`'")\]:,])/g;
function namedFiles(problem, files) {
  if (files?.length) return files.map(String);
  return [...String(problem).matchAll(PATHISH)].map((m) => m[1]);
}

function memorySection(problem) {
  const claims = store.get("memory", []);
  if (!Array.isArray(claims) || !claims.length) return { text: "(none)", keys: [] };
  const r = expert.call("memory-recall", { claims, about: problem, budget_tokens: 1100 });
  if (!r || !r.claims?.length) return { text: "(none)", keys: [] };
  return { text: r.claims.map((c) => `- ${c.claim} (confidence ${c.decayed})`).join("\n"), keys: r.claims.map((c) => c.key) };
}

/** pinpoint when the module exists; otherwise the open findings that touch the
 *  named files. The fallback says which it is, so the agent knows nothing was anchored. */
async function evidenceSection(problem, files) {
  let pp = null;
  try { pp = await import("../pinpoint/index.js"); } catch { pp = null; }
  if (pp) {
    try {
      // pinpoint: build(problem, {files}) -> pack; prompt(pack) -> the anchored brief.
      if (typeof pp.build === "function") {
        const b = await pp.build(problem, { files });
        const body = typeof pp.prompt === "function" ? pp.prompt(b) : (b && (b.prompt || b.body)) || "";
        if (body) {
          // pinpoint carries the same problem as an H1, after its cached
          // preamble; two identical titles read as generated, so it goes.
          const lines = String(body).split("\n").filter((l) => !(/^#\s/.test(l) && l.replace(/^#+\s*/, "").trim() === problem.trim()));
          // Nested under "## Local evidence": pinpoint's own H1/H2 become H3 so
          // the brief keeps exactly five top-level sections.
          return { text: lines.map((l) => l.replace(/^#{1,2}\s/, "### ")).join("\n").trim(), via: "pinpoint" };
        }
      }
    } catch (e) { warn(`pinpoint failed (${e.message}); falling back to findings`); }
  }
  const open = store.get("findings", []).filter((f) => f && f.status === "open");
  const hits = files.length ? open.filter((f) => files.some((p) => f.path === p || (f.files || []).includes(p) || String(f.path || "").endsWith(p))) : [];
  if (!hits.length) return { text: files.length ? `No open findings touch ${files.join(", ")}. Read them yourself; nothing was anchored.` : `No files named in the problem. ${open.length} findings are open; \`bb scan\` lists them.`, via: "findings" };
  const lines = [`Open findings on the named files (not anchored; pinpoint is not installed):`, ""];
  for (const f of hits.slice(0, 12)) lines.push(`- [${f.severity}] ${f.detector}: ${f.title} (${f.path})`, `  ${String(f.detail || "").slice(0, 400)}`);
  return { text: lines.join("\n"), via: "findings" };
}

function ranSection({ runId, gear }) {
  let eps = store.rows("episodes", { limit: 2000 });
  if (runId) eps = eps.filter((e) => e.run_id === runId);
  else if (gear) eps = eps.filter((e) => e.gear === gear);
  eps = eps.slice(-20);
  if (!eps.length) return "(nothing recorded for this run)";
  const lines = eps.map((e) => `- \`${e.stage || e.verb}\` (${e.verb}) — ${e.state || "ran"}, rc ${e.rc}${e.produced != null ? `, ${e.produced} produced` : ""}, ${e.seconds}s${e.detail?.why ? `: ${e.detail.why}` : ""}`);
  lines.push("", "These are local, free, and already done. Their results are in the store; do not run them again.");
  return lines.join("\n");
}

export function brief({ problem, reason, gear, stage, memory, evidence, ran, acceptance }) {
  return [
    `# Call: ${problem}`, "",
    REASONS[reason] || REASONS.asked,
    gear ? `Raised by gear \`${gear}\`${stage ? `, stage \`${stage}\`` : ""}.` : "", "",
    "## What memory recalls", "", memory, "",
    "## Local evidence", "", evidence, "",
    "## What already ran, and what it got — do not repeat these", "", ran, "",
    "## Done when", "", "This decides whether the answer was right. Run it; do not declare done without it.", "", "```bash", acceptance, "```", "",
    "Report what it printed, not what you expect it to print.", "",
  ].join("\n");
}

/** Pack a call and write it. Spends nothing. */
export async function draft({ problem, reason = "asked", gear = "", stage = "", files = null, runId = "", acceptance = "", body = "", lean = false } = {}) {
  if (!problem) return { rc: 2, why: "a call needs a problem" };
  if (!REASONS[reason]) reason = "asked";
  const id = `${stamp()}-${slug(problem) || "call"}`;
  const dir = path.join(DIR(), id);
  fs.mkdirSync(dir, { recursive: true });
  const named = namedFiles(problem, files);
  // A caller that already derived the evidence hands it over instead of paying
  // pinpoint to derive it again, and a lean call drops the memory section too.
  // Both exist for one reason: the far side is the only part of this factory
  // that costs anything, so a section that adds nothing is tokens burnt.
  const mem = lean ? { text: "(skipped: lean call)", keys: [] } : memorySection(problem);
  const ev = body ? { text: body, via: "caller" } : await evidenceSection(problem, named);
  const accept = acceptance || load().bridge?.acceptance || "bb scan --json";
  const text = brief({ problem, reason, gear, stage, memory: mem.text, evidence: ev.text, ran: ranSection({ runId, gear }), acceptance: accept });
  const briefFile = path.join(dir, "brief.md");
  fs.writeFileSync(briefFile, text);
  const row = { id, state: "drafted", reason, gear, stage, problem, files: named, brief_file: rel(briefFile), est_tokens: estimateText(text, "prose"),
    evidence_via: ev.via, recalled: mem.keys, acceptance: accept, agent: "", run_id: runId, drafted_at: now(), rc: null, spent_tokens: 0 };
  save(row);
  episodes.write({ kind: "call", verb: `bridge:${reason}`, stage: stage || "bridge", gear, run_id: runId, features: { reason, est_tokens: row.est_tokens, recalled: mem.keys.length }, rc: 0, produced: 1, produces: ["call"], detail: { call: id } });
  return { ...row, rc: 0, why: `drafted, not sent: bb bridge send ${id} --run` };
}

/** Today's attributed spend against `bridge.daily_budget_usd`. Only rows the
 *  factory tagged count: an interactive session in the same window is not the
 *  factory's spend. Any error refuses. */
export function ceiling(cfg = load(), readUsage = () => store.rows("usage")) {
  const limit = num(cfg.bridge?.daily_budget_usd);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const by = new Map();
    for (const r of readUsage()) {
      if (!r || !(r.run_id || r.lane_id || r.call_id)) continue;
      if (!String(r.ts || r.at || "").startsWith(today)) continue;
      by.set(`${r.session_id} ${r.msg_id}`, r);
    }
    let spent = 0, unpriced = 0;
    for (const r of by.values()) {
      const c = prices.cost(r.model, { inp: num(r.input), out: num(r.output), cache_write: num(r.cache_write), cache_read: num(r.cache_read) });
      if (c) spent += c.total; else unpriced += 1;
    }
    // `over_by` is the fold gap, reported rather than closed. This ceiling is
    // measured off folded transcripts, and a call that lands between two folds
    // is invisible to the check in front of the next one — so a tick can
    // overspend by one call, and the first evidence of it is a spend already
    // PAST the limit rather than at it. Saying by how much is the difference
    // between a ceiling that held and one that was noticed afterwards.
    const over = limit && spent > limit ? Math.round((spent - limit) * 100) / 100 : 0;
    if (limit && spent >= limit) return { ok: false, limit, spent, unpriced, over_by: over,
      why: `today's attributed spend $${spent.toFixed(2)} has reached the $${limit} bridge ceiling${over ? ` and is $${over.toFixed(2)} past it: one call landed inside the fold gap` : ""}` };
    return { ok: true, limit, spent, unpriced, over_by: 0 };
  } catch (e) { return { ok: false, limit, spent: null, why: `budget check failed (${e.message}); refusing to send` }; }
}

function refuse(row, why) { const r = { ...row, state: "refused", refused_why: why, refused_at: now() }; save(r); return { ...r, rc: 2, why }; }

/** Spawn the chosen agent against a drafted call. The only spending path. */
export async function send(callId, { agent = "", run = false, spend = false, allowNear = false, cfg = load(), readUsage = undefined, timeout = 1800000 } = {}) {
  const row = calls().find((c) => c.id === callId);
  if (!row) return { rc: 2, state: null, why: `no call ${callId}. bb bridge list` };
  if (!cfg.bridge?.enabled) return refuse(row, "bridge disabled: set bridge.enabled=true in .bundlebox/config.json");
  if (row.state === "sent" || row.state === "done") return { ...row, rc: 0, why: `already ${row.state}` };
  const adp = (agent && adapters.get(agent)) || adapters.pick(cfg);
  if (agent && !adapters.get(agent)) return refuse(row, `no adapter named ${agent}`);
  const promptFile = abs(row.brief_file);
  const prompt = readText(promptFile, "");
  if (!prompt) return refuse(row, `brief missing at ${row.brief_file}`);
  // The prompt travels as the adapter declares: stdin, or inline via the
  // adapter's own promptText, or its file. Never the filename as the prompt.
  const spec = adp.buildCmd({ promptFile, prompt, cwd: ROOT, model: cfg.lanes?.model || "", permissionMode: cfg.lanes?.permission_mode, budgetUsd: cfg.lanes?.max_budget_usd, name: `bb-bridge-${row.id}` });
  if (!run) { const r = { ...row, agent: adp.name, argv: spec.argv }; save(r); return { ...r, rc: 0, why: `drafted, not sent: pass --run to send${spec.argv ? "" : " (adapter spawns nothing)"}` }; }
  const budget = ceiling(cfg, readUsage);
  if (!budget.ok) return refuse(row, budget.why);
  // The window gate, asked immediately before the one thing here that costs
  // anything. A call opened with twenty minutes of block left is cut off
  // half-written: it spends the tokens and produces nothing to accept.
  if (cfg.bridge?.window_guard !== false) {
    const { guard } = await import("../monitor/index.js");
    const g = guard({ plan: cfg.monitor?.plan || "custom", allowNear: allowNear || cfg.bridge?.allow_near === true });
    if (!g.ok) return refuse(row, g.why);
  }
  if (!spec.argv) { const r = { ...row, state: "queued", agent: adp.name, queued_at: now() }; save(r); return { ...r, rc: 0, why: `adapter \`${adp.name}\` spawns nothing; the brief is on disk at ${rel(path.dirname(promptFile))}` }; }
  if (!spend) return refuse(row, `adapter \`${adp.name}\` spends tokens; pass --spend to allow a non-zero cost`);

  const { laneEnv } = await import("../run/runner.js");
  const env = laneEnv({ ...(spec.env || {}), BB_CALL: row.id });
  const t0 = Date.now();
  const r = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: ROOT, env, input: spec.stdin === "prompt" ? prompt : undefined, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const rc = r.error ? (r.error.code === "ENOENT" ? 127 : 124) : (r.status ?? 1);
  fs.writeFileSync(path.join(DIR(), row.id, "result.txt"), `${r.stdout || ""}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}${r.error ? `\n--- error ---\n${r.error.message}` : ""}`);
  let accepted = null;
  if (rc === 0 && row.acceptance) {
    // Hard-coded bash here meant a Windows box could not SPAWN the acceptance,
    // and `a.status` of null then read as `accepted: 0` — a gate that never ran
    // recorded as a gate that failed, which is the one reading it must not have.
    const [shBin, ...shArgs] = shellCmd(row.acceptance);
    const a = spawnSync(shBin, shArgs, { cwd: ROOT, env, encoding: "utf8", timeout: 600000 });
    accepted = a.status === 0 ? 1 : 0;
  }
  const done = { ...row, state: accepted === 1 ? "done" : "sent", agent: adp.name, argv: spec.argv, rc, accepted, seconds, sent_at: now(), spent_tokens: null, budget: { limit: budget.limit, spent_before: budget.spent } };
  save(done);
  // Cost is MEASURED at the next ledger fold, where a usage row carrying
  // call_id lands; the estimate never enters the usage table.
  episodes.write({ kind: "call", verb: `bridge:${row.reason}`, stage: row.stage || "bridge", gear: row.gear, run_id: row.run_id, features: { reason: row.reason, agent: adp.name, est_tokens: row.est_tokens },
    rc, seconds, produced: rc === 0 ? 1 : 0, useful: accepted == null ? -1 : accepted, detail: { call: row.id } });
  return { ...done, why: rc === 0 ? (accepted === 0 ? "agent exited 0 but the acceptance failed" : "sent") : `agent exited ${rc}`, out_tail: String(r.stdout || "").slice(-800) };
}

export function reportText(rows = calls()) {
  if (!rows.length) return "  BRIDGE — no calls. That is the good state: a call is the local path admitting it could not finish.";
  const lines = [`  BRIDGE — ${rows.length} calls`, ""];
  for (const r of rows.slice(-30)) {
    lines.push(`    ${pad(r.id, 44)} ${pad(r.state, 8)} ${pad(r.reason, 10)} ${pad(r.agent || "-", 8)} ${pad(human(r.est_tokens), 7, true)} est${r.accepted != null ? (r.accepted ? "  accepted" : "  REJECTED") : ""}`);
    lines.push(`      ${String(r.problem || "").slice(0, 96)}${r.refused_why ? `\n      refused: ${r.refused_why}` : ""}`);
  }
  const drafted = rows.filter((r) => r.state === "drafted").length;
  if (drafted) lines.push("", `    ${drafted} drafted and unsent. They cost nothing where they are.`);
  return lines.join("\n");
}

async function bridgeCmd({ _, flags }) {
  const sub = _[0] || "list";
  if (sub === "draft") {
    const problem = _.slice(1).join(" ");
    if (!problem) { warn('what problem? bb bridge draft "<problem>"'); return 2; }
    const r = await draft({ problem, reason: flags.reason || "asked", gear: flags.gear || "", stage: flags.stage || "", files: flags.files ? String(flags.files).split(",") : null, runId: flags.run || "", acceptance: flags.acceptance || "" });
    if (flags.json) { emit(r); return r.rc; }
    out(r.rc ? `  ${r.why}` : `  drafted ${r.id}\n    brief ${r.brief_file} (${human(r.est_tokens)} tokens ESTIMATE, evidence via ${r.evidence_via}, ${r.recalled.length} memories)\n    ${r.why}`);
    return r.rc;
  }
  if (sub === "send") {
    const id = _[1];
    if (!id) { warn("which call? bb bridge send <id> [--run] [--spend] [--agent name]"); return 2; }
    const r = await send(id, { agent: flags.agent ? String(flags.agent) : "", run: !!flags.run, spend: !!flags.spend, allowNear: !!flags.allowNear });
    if (flags.json) { emit(r); return r.rc; }
    out(`  ${r.id || id}: ${r.state || "?"} — ${r.why}`);
    if (r.argv && !flags.run) out(`    would run: ${r.argv.join(" ")}`);
    if (r.out_tail) out(r.out_tail.split("\n").map((l) => `    ${l}`).join("\n"));
    return r.rc;
  }
  if (sub === "list" || sub === "report") {
    const rows = calls();
    if (flags.json) { emit({ calls: rows, ceiling: ceiling() }); return 0; }
    out(reportText(rows));
    if (sub === "report") { const c = ceiling(); out(`\n  ceiling: ${c.ok ? `$${(c.spent ?? 0).toFixed(2)} of ${c.limit ? `$${c.limit}` : "no limit"} today (attributed rows only${c.unpriced ? `, ${c.unpriced} unpriced` : ""})` : c.why}`); }
    return 0;
  }
  warn(`unknown bridge sub-verb: ${sub}. draft | send | list | report`);
  return 2;
}

export const commands = {
  bridge: {
    help: "draft a packed call to an agent; send only with --run (and --spend for a paid agent)",
    usage: "bb bridge draft \"<problem>\" [--reason exhausted|assist|complete|asked] [--files a,b] | send <id> [--run] [--spend] [--allow-near] [--agent name] | list | report [--json]",
    run: bridgeCmd,
  },
};
