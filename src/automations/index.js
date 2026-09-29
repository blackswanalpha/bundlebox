// automations/index.js — `bb automations`: one list of everything this box can
// run without an agent, and one door an agent can run it through.
//
// Four kinds already existed and nothing listed them together:
//
//   script    tagged executables `bb scripts` indexes, lathe's applied habits among them
//   scenario  cookbook corpora: HTTP, command and UI checks against a running system
//   service   runbook services: start or stop a declared process
//   imported  records taken from a pinned GitHub repo by `importer.js`
//
// The MCP tools `bb_automations` and `bb_automation_run` are this file. Three
// rules keep an agent-facing run from being worse than the CLI one:
//
//   1. dry by default. A run without `apply` returns what it would do and costs
//      nothing, the same contract as `bb run` and `bb scripts run`.
//   2. an agent runs only what a person cleared: a script with `@safe true`, an
//      imported record `bb automations trust` bound to its hash. Scenarios and
//      services are declared by a person in `.bundlebox/` and are run as declared.
//   3. every applied run writes an episode, with `source` as a feature, so the
//      outcome model can rank an imported automation against a local one.
//
// The list is ranked by that same record. With a trained model (`bb buckmaster
// model --train`) the score is its prediction for the automation's verb and
// source; without one it is (useful + 1) / (runs + 2) over its own episodes,
// where an unlabelled run counts by its exit code and the row says so.
import path from "node:path";
import * as store from "../core/store.js";
import * as episodes from "../buckmaster/episodes.js";
import { run as exec } from "../core/exec.js";
import { ROOT, VAR, rel } from "../core/paths.js";
import { readJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { pad } from "../core/util.js";
import * as importer from "./importer.js";

const lazy = async (file) => { try { return await import(file); } catch { return null; } };

// ── the list ────────────────────────────────────────────────────────────────

const scriptId = (row) => `script:${path.basename(row.path).replace(/\.\w+$/, "")}`;

/** Every automation, unranked. Each row names what it takes to run it. */
export async function catalog() {
  const rows = [];
  const scripts = await lazy("../scripts/index.js");
  if (scripts) {
    let idx = store.get("scripts", []);
    if (!idx.length) idx = scripts.scan({ write: true }).rows || store.get("scripts", []);
    for (const s of idx) {
      const lathe = /(^|\/)lathe-/.test(s.path) || s.tag === "lathe";
      rows.push({ id: scriptId(s), kind: "script", source: lathe ? "lathe" : "local", title: s.title || s.path,
        ref: s.path, verb: `script:${s.tag}`, cleared: Boolean(s.safe),
        gate: s.safe ? "" : "@safe false: a person sets @safe true in its header before an agent may run it" });
    }
  }
  const cookbook = await lazy("../cookbook/corpus.js");
  if (cookbook) {
    for (const c of cookbook.list()) {
      if (c.error) continue;
      rows.push({ id: `scenario:${c.id}`, kind: "scenario", source: "local", title: `${c.title}: ${c.scenarios} scenario(s), ${c.steps} step(s)${c.base ? ` against ${c.base}` : ""}`,
        ref: c.id, verb: "cookbook", stage: `cookbook:${c.id}`, cleared: true, gate: "" });
    }
  }
  const runbook = await lazy("../runbook/services.js");
  if (runbook) {
    for (const s of runbook.services()) {
      rows.push({ id: `service:${s.id}`, kind: "service", source: "local", title: `${s.cmd}${s.port ? ` (port ${s.port})` : ""}; action up|down`,
        ref: s.id, verb: `automation:service:${s.id}`, cleared: true, gate: "" });
    }
  }
  for (const r of importer.records()) {
    rows.push({ id: r.id, kind: "imported", source: "import", title: r.title, ref: r.id, verb: `automation:${r.id}`,
      origin: r.source, findings: r.findings.map((f) => `${f.severity}:${f.rule}`),
      cleared: r.runnable && r.trusted,
      gate: !r.runnable ? `blocked: ${r.why}` : r.trusted ? "" : `untrusted: a person runs \`bb automations trust ${r.id}\`` });
  }
  return rows;
}

/** Score each row from the episode log. Read once for the whole list. */
export function rank(rows, { log = episodes.rows({ limit: 20000 }), model = readJson(path.join(VAR, "model.json"), null) } = {}) {
  const tally = new Map();
  for (const e of log) {
    const keys = [e.verb, e.stage && `stage:${e.stage}`].filter(Boolean);
    const ok = e.useful === 1 || (e.useful === -1 && e.rc === 0);
    for (const k of keys) { const t = tally.get(k) || { runs: 0, ok: 0, labelled: 0 }; t.runs++; t.ok += ok ? 1 : 0; t.labelled += e.useful === -1 ? 0 : 1; tally.set(k, t); }
  }
  const w = model?.useful ? model.weights || {} : null;
  const sig = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  return rows.map((r) => {
    const t = (r.stage && tally.get(`stage:${r.stage}`)) || tally.get(r.verb) || { runs: 0, ok: 0, labelled: 0 };
    const score = w
      ? sig((w["@bias"] || 0) + (w[`verb=${r.verb}`] || 0) + (w[`source=${r.source}`] || 0))
      : (t.ok + 1) / (t.runs + 2);
    const basis = w ? "outcome model" : t.runs ? (t.labelled === t.runs ? "labelled runs" : "runs, unlabelled by exit code") : "no runs yet";
    return { ...r, runs: t.runs, score: Math.round(score * 1000) / 1000, basis };
  }).sort((a, b) => Number(b.cleared) - Number(a.cleared) || b.score - a.score || a.id.localeCompare(b.id));
}

export async function list({ kind = "", source = "", q = "" } = {}) {
  const needle = String(q).toLowerCase();
  return rank((await catalog()).filter((r) => (!kind || r.kind === kind) && (!source || r.source === source)
    && (!needle || `${r.id} ${r.title}`.toLowerCase().includes(needle))));
}

// ── the run ─────────────────────────────────────────────────────────────────

/** Dry unless `apply`. `by: "agent"` refuses anything a person has not cleared. */
export async function run(id, { apply = false, action = "", args = [], by = "person", timeout = 600000, base = "" } = {}) {
  const row = (await catalog()).find((r) => r.id === id);
  if (!row) return { id, rc: 2, ran: false, why: `no automation \`${id}\`: bb_automations lists them` };
  if (row.kind === "imported" && !row.cleared) return { id, rc: 1, ran: false, why: row.gate };
  if (apply && by === "agent" && !row.cleared) return { id, rc: 1, ran: false, why: row.gate };
  const features = { source: row.source, imported: row.kind === "imported" ? 1 : 0, cleared: row.cleared ? 1 : 0, by };

  if (row.kind === "script") {
    const scripts = await import("../scripts/index.js");
    const r = scripts.run(row.ref, { args, apply, timeout, features });
    return { id, ...r };
  }
  if (row.kind === "scenario") {
    if (!apply) return { id, rc: 0, ran: false, would: `bb cookbook run --persona ${row.ref}${base ? ` --base ${base}` : ""}`, why: "dry run; apply runs it" };
    const cookbook = await import("../cookbook/index.js");
    const r = await cookbook.runCorpus(row.ref, { base, features });
    return { id, rc: r.rc, ran: r.rc === 0, why: r.why || "", totals: r.board?.totals, board: r.file ? rel(r.file) : "", findings: r.findings };
  }
  if (row.kind === "service") {
    const act = action || "up";
    if (!["up", "down"].includes(act)) return { id, rc: 2, ran: false, why: `action must be up or down, not ${act}` };
    const lc = await import("../runbook/lifecycle.js");
    const t0 = Date.now();
    const r = act === "up" ? lc.up(row.ref, { apply }) : lc.down(row.ref, { apply });
    if (apply) record(row, features, { rc: r.rc, seconds: (Date.now() - t0) / 1000, detail: { action: act, state: r.state } });
    return { id, ran: apply, action: act, ...r };
  }
  // imported: cleared by now, so the command is exactly the one that was trusted.
  const rec = importer.records().find((x) => x.id === id);
  if (!apply) return { id, rc: 0, ran: false, would: rec.cmd, why: "dry run; apply runs it with bash in the workspace root" };
  const t0 = Date.now();
  const r = exec(["bash", "-c", rec.cmd], { cwd: ROOT, timeout });
  const seconds = Math.round((Date.now() - t0) / 10) / 100;
  const ep = record(row, features, { rc: r.rc, seconds, detail: { origin: rec.source, sha256: rec.sha256, tail: (r.out || r.err).slice(-600) } });
  return { id, rc: r.rc, ran: true, seconds, out: tail(r.out), err: tail(r.err), episode: ep.id };
}

const tail = (s, n = 4000) => (String(s || "").length > n ? `…${String(s).slice(-n)}` : String(s || ""));

function record(row, features, { rc, seconds, detail }) {
  return episodes.write({ kind: "automation", verb: row.verb, stage: row.id, features, rc, seconds,
    produced: rc === 0 ? 1 : 0, turns_saved: 0, detail });
}

// ── the verb ────────────────────────────────────────────────────────────────

function listText(rows) {
  if (!rows.length) return "  no automations: tag a script (`bb scripts`), declare a service (`bb runbook init`), or import one (`bb automations import owner/repo@sha`)";
  return rows.map((r) => `  ${r.cleared ? "●" : "○"} ${pad(r.id, 44)} ${pad(r.kind, 8)} ${pad(r.source, 6)} ${r.score.toFixed(2)} ${pad(String(r.runs), 4, true)}  ${r.title.slice(0, 70)}${r.gate ? `\n      ${r.gate}` : ""}`).join("\n");
}

async function automationsCmd({ _: [sub = "list", ...rest], flags }) {
  if (sub === "list") {
    const rows = await list({ kind: flags.kind || "", source: flags.source || "", q: flags.q || "" });
    if (flags.json) { emit(rows); return 0; }
    out("  ● cleared to run   ○ needs a person first      score  runs");
    out(listText(rows));
    return 0;
  }
  if (sub === "run") {
    const [id, ...args] = rest;
    if (!id) { warn("which automation? bb automations run <id> [--apply] [--action up|down]"); return 2; }
    const r = await run(id, { apply: Boolean(flags.apply), action: flags.action || "", args, base: flags.base || "" });
    if (flags.json) { emit(r); return r.rc ?? 0; }
    if (!r.ran) out(`  ${id}: ${r.why || r.state || ""}${r.would ? `\n    would run: ${r.would}` : ""}`);
    else out(`  ${id}: rc ${r.rc}${r.seconds != null ? ` in ${r.seconds}s` : ""}${r.state ? ` (${r.state})` : ""}`);
    return r.rc ?? 0;
  }
  if (sub === "import") {
    // A 404 or a timeout is an answer about the ref, not a crash of the verb.
    const r = await importer.importRepo(rest[0], { apply: Boolean(flags.apply) }).catch((e) => ({ rc: 1, why: String(e.message || e) }));
    if (flags.json) { emit(r); return r.rc; }
    if (r.rc) { warn(`  ${r.why}`); return r.rc; }
    out(`  ${r.source.owner}/${r.source.repo}@${r.source.sha.slice(0, 12)}: ${r.files.length} file(s) verified, ${r.records.length} record(s)`);
    for (const x of r.records) out(`  ${x.runnable ? "·" : "✗"} ${x.id}${x.findings.length ? `  [${x.findings.map((f) => `${f.severity}:${f.rule}`).join(" ")}]` : ""}`);
    for (const x of r.refused) out(`  ✗ ${x.path}: ${x.why}`);
    out(r.wrote ? `  wrote ${rel(r.file)}. Nothing is trusted yet: bb automations trust <id>` : "  dry run; --apply writes the records");
    return 0;
  }
  if (sub === "trust") {
    const r = importer.trust(rest[0], { revoke: Boolean(flags.revoke) });
    if (flags.json) { emit(r); return r.rc; }
    if (r.rc) warn(`  ${r.why}`); else out(`  ${r.id}: ${r.trusted ? "trusted at its current hash" : "trust revoked"}`);
    return r.rc;
  }
  warn(`unknown automations sub-verb: ${sub}. list | run <id> | import <owner/repo@sha> | trust <id>`);
  return 2;
}

export const commands = {
  automations: {
    help: "list and run every local automation (scripts, scenarios, services, imports); import from a pinned GitHub repo",
    usage: "bb automations list [--kind k] [--source s] [--q text] | run <id> [--apply] [--action up|down] | import <owner/repo@sha> [--apply] | trust <id> [--revoke]",
    run: automationsCmd,
  },
};
