// recom/index.js — what has already been driven, and whether that answer still
// holds.
//
// `bb scan` answers questions about the SOURCE for nothing. `bb runbook`
// answers them about the RUNNING system for nothing. This answers a third kind,
// and it is the one that has been costing whole sessions:
//
//   Has this automation already been performed, and is its result still true?
//
// Driving a browser through nine screens to learn that checkout stops at the
// address step, or a phone through sign-in to learn it stops at the SMS code,
// costs tens of thousands of tokens and ten minutes of wall clock. The answer
// is worth keeping. The record of it is worth keeping ONLY while the world that
// produced it still stands — which is the whole difficulty, and the reason this
// is not a cache.
//
// **A record does not carry a timestamp anybody trusts.** It carries `depends`
// — the specific facts that, had they been different, would have made the run
// come out differently — and those are re-probed on every read by the kernel,
// in parallel, with real timeouts.
//
// The verdict has three values and never two:
//
//   fresh    every declared fact reads as it did. Use the record. Drive nothing
//   stale    a fact reads differently. It says which, and both values
//   unknown  a fact could not be READ. An unreadable fact is not a matching one
//
// `unknown` is what keeps this honest. A store that let it collapse into
// `fresh` would eventually tell a session a service was up when there was no
// service. `replay` exits non-zero on anything but `fresh`, so no wrapper can
// mistake a stale record for a result.
import fs from "node:fs";
import path from "node:path";
import * as kernel from "../core/kernel.js";
import { BB_DIR, ROOT, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { now, pad, table, slug } from "../core/util.js";
import * as artemis from "./artemis.js";

export const DIR = () => path.join(BB_DIR, "recom", "records");
export const OUTCOMES = new Set(["works", "blocked", "broken", "unproven"]);

/** The closed vocabulary. A record is data that arrives by pull request, so it
 *  must not be able to run a command: there is no `cmd` probe, every probe is
 *  read-only, and adding one is a code change somebody reviews. */
export const PROBES = [
  ["git_paths:<dir>:<a>,<b>", "a hash of just those paths, working tree included — the one that matters most"],
  ["git_head:<dir>", "the commit that repo is on"],
  ["file_sha:<path>", "one file, for anything git does not track"],
  ["http:<url>", "the status code, and nothing else"],
  ["http_body:<url>", "status plus a hash of the first 256 KiB"],
  ["port:<host>:<port>", "is anything listening"],
  ["env:<NAME>", "set or unset — never the value, because a record travels"],
  ["adb_state:<serial>", "is that device attached, and in what state"],
  ["adb_package:<serial>/<pkg>", "versionName@lastUpdateTime — the binary's identity"],
  ["adb_foreground:<serial>", "which component is resumed"],
];

const fileOf = (id) => path.join(DIR(), `${String(id).replace(/[^\w/.-]/g, "-")}.json`);

export function ids() {
  const base = DIR();
  const out = [];
  const rec = (d, prefix) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) rec(path.join(d, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith(".json")) out.push(prefix + e.name.slice(0, -5));
    }
  };
  rec(base, "");
  return out;
}

export const get = (id) => readJson(fileOf(id), null);
export const all = () => ids().map(get).filter(Boolean);

/** Measure the declared facts. One kernel call for the whole set, because a
 *  record with nine dependencies is nine round trips and serially that is the
 *  wall clock the record was supposed to save. */
export function measure(depends, { timeout = 8000 } = {}) {
  const probes = [...new Set((depends || []).map(String).filter(Boolean))];
  if (!probes.length) return { ok: false, rows: [], why: "no facts declared" };
  if (!kernel.available()) return { ok: false, rows: [], why: "no kernel to probe with (`bb kernel build`)" };
  const r = kernel.call("recom", { probes, root: ROOT, timeout_ms: timeout }, { timeout: timeout * probes.length + 10000 });
  if (!r) return { ok: false, rows: [], why: `the kernel declined: ${kernel.lastError}` };
  return { ok: true, rows: r.probes || [] };
}

/** fresh / stale / unknown, and what moved.
 *
 *  `stale` outranks `unknown` when both apply: something definitely changed,
 *  and naming it is more useful than naming the silence. */
export function check(id) {
  const rec = get(id);
  if (!rec) return { id, verdict: "missing", why: `no record \`${id}\`` };
  const m = measure(rec.depends);
  if (!m.ok) return { id, verdict: "unknown", moved: [], unreadable: [{ probe: "-", why: m.why }], why: m.why };
  const moved = [];
  const unreadable = [];
  for (const row of m.rows) {
    const was = rec.fingerprint?.[row.probe];
    if (!row.ok) { unreadable.push({ probe: row.probe, why: row.why || "unreadable", was: was ?? null }); continue; }
    if (was === undefined) { unreadable.push({ probe: row.probe, why: "not in the fingerprint this record was made with", was: null }); continue; }
    if (String(was) !== String(row.value)) moved.push({ probe: row.probe, was, now: row.value });
  }
  const verdict = moved.length ? "stale" : unreadable.length ? "unknown" : "fresh";
  return { id, verdict, moved, unreadable, outcome: rec.outcome, title: rec.title,
    probed: m.rows.length, ms: m.rows.reduce((a, r) => a + (r.ms || 0), 0) };
}

/** Write a record. The fingerprint is NEVER supplied by hand — it is measured
 *  here, because a hand-written one is a claim about a world nobody probed. */
export function record(run, { apply = false } = {}) {
  const id = String(run?.id || "").trim();
  if (!id) return { rc: 2, why: "`id` is required: a record is addressed by it" };
  if (!/^[\w][\w./-]*$/.test(id)) return { rc: 2, why: `bad id \`${id}\`: word characters, dots, dashes and slashes` };
  if (!OUTCOMES.has(run.outcome)) return { rc: 2, why: `outcome must be one of ${[...OUTCOMES].join(", ")}` };
  if (!String(run.summary || "").trim()) return { rc: 2, why: "`summary` is required: one sentence a later session can act on" };
  const depends = [...new Set((run.depends || []).map(String).filter(Boolean))];
  // A record that can never go stale would be replayed for ever.
  if (!depends.length) return { rc: 2, why: "`depends` is empty: a record with no facts can never go stale, so it would be replayed for ever" };

  const m = measure(depends);
  if (!m.ok) return { rc: 1, why: m.why };
  // A fingerprint with a hole in it can never come back fresh, so recording
  // one is recording a record nobody will ever be allowed to use.
  const bad = m.rows.filter((r) => !r.ok);
  if (bad.length) return { rc: 1, why: `refusing: ${bad.length} declared fact(s) are unreadable now, and a fingerprint with a hole in it can never come back fresh`,
    unreadable: bad.map((r) => ({ probe: r.probe, why: r.why })) };

  const rec = {
    id, title: String(run.title || id), outcome: run.outcome,
    summary: String(run.summary).trim(),
    steps: (run.steps || []).map(String).slice(0, 40),
    evidence: (run.evidence || []).map(String).slice(0, 20),
    depends,
    fingerprint: Object.fromEntries(m.rows.map((r) => [r.probe, r.value])),
    saved_wall_s: Number(run.saved_wall_s) || 0,
    saved_tokens: Number(run.saved_tokens) || 0,
    recorded: now(),
  };
  if (!apply) return { rc: 0, id, state: "would record", record: rec, file: rel(fileOf(id)) };
  fs.mkdirSync(path.dirname(fileOf(id)), { recursive: true });
  writeJson(fileOf(id), rec);
  return { rc: 0, id, state: "recorded", file: rel(fileOf(id)), facts: depends.length };
}

export function refresh(id, { apply = false } = {}) {
  const rec = get(id);
  if (!rec) return { rc: 2, why: `no record \`${id}\`` };
  const m = measure(rec.depends);
  if (!m.ok) return { rc: 1, why: m.why };
  const bad = m.rows.filter((r) => !r.ok);
  if (bad.length) return { rc: 1, why: `${bad.length} fact(s) unreadable; re-stamping now would bake a hole into the fingerprint`, unreadable: bad };
  const next = { ...rec, fingerprint: Object.fromEntries(m.rows.map((r) => [r.probe, r.value])), recorded: now() };
  if (!apply) return { rc: 0, id, state: "would re-stamp", changed: m.rows.filter((r) => String(rec.fingerprint?.[r.probe]) !== String(r.value)).length };
  writeJson(fileOf(id), next);
  return { rc: 0, id, state: "re-stamped", file: rel(fileOf(id)) };
}

/** What the store has saved, counted only over records that are fresh RIGHT
 *  NOW. A stale record saves nothing: the run has to happen again. */
export function savings(rows) {
  const fresh = rows.filter((r) => r.verdict === "fresh");
  return {
    records: rows.length, fresh: fresh.length,
    stale: rows.filter((r) => r.verdict === "stale").length,
    unknown: rows.filter((r) => r.verdict === "unknown").length,
    saved_wall_s: fresh.reduce((a, r) => a + (r.saved_wall_s || 0), 0),
    saved_tokens: fresh.reduce((a, r) => a + (r.saved_tokens || 0), 0),
  };
}

const MARK = { fresh: "fresh", stale: "STALE", unknown: "UNKNOWN", missing: "MISSING" };

async function cmd({ _, flags, rest }) {
  const sub = _[0] || "list";

  if (sub === "probes") {
    if (flags.json) { emit({ probes: PROBES.map(([p, w]) => ({ probe: p, answers: w })) }); return 0; }
    out(table(PROBES, { header: ["probe", "answers"] }).split("\n").map((l) => "  " + l).join("\n"));
    out("\n  The vocabulary is closed and every probe is read-only. There is no `cmd` probe: a record");
    out("  arrives by pull request, so it must not be able to run one.");
    return 0;
  }

  if (sub === "list") {
    const rows = all().map((r) => ({ ...check(r.id), saved_wall_s: r.saved_wall_s, saved_tokens: r.saved_tokens }));
    if (flags.json) { emit({ records: rows, savings: savings(rows) }); return 0; }
    if (!rows.length) { out(`  no records. bb recom record --from run.json writes one into ${rel(DIR())}`); return 0; }
    out(table(rows.map((r) => [MARK[r.verdict] || r.verdict, r.id, r.outcome || "", r.title || "",
      r.moved?.length ? `${r.moved.length} moved` : r.unreadable?.length ? `${r.unreadable.length} unreadable` : ""]),
      { header: ["verdict", "id", "outcome", "title", ""] }).split("\n").map((l) => "  " + l).join("\n"));
    const s = savings(rows);
    out(`\n  ${s.fresh} of ${s.records} still hold${s.stale ? `, ${s.stale} stale` : ""}${s.unknown ? `, ${s.unknown} unknown` : ""}`);
    if (s.saved_wall_s || s.saved_tokens) out(`  they stand in for ${Math.round(s.saved_wall_s / 60)} minutes of driving and ~${Math.round(s.saved_tokens / 1000)}k tokens, every time one is read instead of run`);
    return 0;
  }

  if (sub === "check") {
    const id = _[1];
    if (!id) { warn("bb recom check <id>"); return 2; }
    const r = check(id);
    if (flags.json) { emit(r); return r.verdict === "fresh" ? 0 : 1; }
    if (r.verdict === "missing") { warn(r.why); return 2; }
    out(`  ${MARK[r.verdict]}  ${id}  (${r.probed} fact(s) re-probed in ${r.ms}ms)`);
    for (const m of r.moved || []) out(`    moved       ${m.probe}\n                was ${m.was}\n                now ${m.now}`);
    for (const u of r.unreadable || []) out(`    unreadable  ${u.probe}: ${u.why}`);
    if (r.verdict === "fresh") out("    every declared fact reads as it did. Use the record; drive nothing.");
    return r.verdict === "fresh" ? 0 : 1;
  }

  if (sub === "replay") {
    const id = _[1];
    if (!id) { warn("bb recom replay <id>"); return 2; }
    const rec = get(id);
    if (!rec) { warn(`no record \`${id}\``); return 2; }
    const r = check(id);
    if (flags.json) { emit({ ...r, record: r.verdict === "fresh" ? rec : null }); return r.verdict === "fresh" ? 0 : 1; }
    if (r.verdict !== "fresh") {
      warn(`${MARK[r.verdict]}: this answer no longer holds, so it is not being printed. Run it again.`);
      for (const m of r.moved || []) out(`    moved       ${m.probe}: ${m.was} -> ${m.now}`);
      for (const u of r.unreadable || []) out(`    unreadable  ${u.probe}: ${u.why}`);
      return 1;
    }
    out(`  ${rec.title}`);
    out(`  outcome: ${rec.outcome}`);
    out(`  ${rec.summary}`);
    if (rec.steps.length) { out("\n  what was done"); for (const s of rec.steps) out(`    - ${s}`); }
    if (rec.evidence.length) { out("\n  evidence"); for (const e of rec.evidence) out(`    ${e}`); }
    out(`\n  recorded ${rec.recorded}, ${rec.depends.length} fact(s) re-probed just now and all of them hold.`);
    if (rec.saved_wall_s || rec.saved_tokens) out(`  reading this instead of running it: ${Math.round(rec.saved_wall_s / 60)} min and ~${Math.round(rec.saved_tokens / 1000)}k tokens.`);
    return 0;
  }

  if (sub === "record") {
    const from = flags.from;
    if (!from) { warn("bb recom record --from run.json [--apply]"); return 2; }
    const run = readJson(path.isAbsolute(String(from)) ? String(from) : path.join(process.cwd(), String(from)), null);
    if (!run) { warn(`cannot read ${from}`); return 2; }
    const r = record(run, { apply: !!flags.apply });
    if (flags.json) { emit(r); return r.rc; }
    if (r.rc) { warn(r.why); for (const u of r.unreadable || []) out(`    ${u.probe}: ${u.why}`); return r.rc; }
    out(`  ${r.state}  ${r.id}${r.file ? `  ${r.file}` : ""}${r.facts ? `  ${r.facts} fact(s) measured` : ""}`);
    if (!flags.apply) out("\n  dry run. --apply writes it.");
    return 0;
  }

  if (sub === "refresh") {
    const id = _[1];
    if (!id) { warn("bb recom refresh <id> [--apply]"); return 2; }
    const r = refresh(id, { apply: !!flags.apply });
    if (flags.json) { emit(r); return r.rc; }
    if (r.rc) { warn(r.why); return r.rc; }
    out(`  ${r.state}  ${id}${r.changed !== undefined ? `  ${r.changed} fact(s) would change` : ""}`);
    if (!flags.apply) out("\n  dry run. --apply re-stamps it. Only do this after re-verifying the answer yourself.");
    return 0;
  }

  if (sub === "forget") {
    const id = _[1];
    if (!id) { warn("bb recom forget <id> [--apply]"); return 2; }
    if (!get(id)) { warn(`no record \`${id}\``); return 2; }
    if (!flags.apply) { out(`  would delete ${rel(fileOf(id))}\n\n  dry run. --apply deletes it.`); return 0; }
    fs.unlinkSync(fileOf(id));
    out(`  deleted ${rel(fileOf(id))}`);
    return 0;
  }

  if (sub === "gate") {
    const { cmd: gateCmd } = await import("./gate.js");
    return gateCmd({ _, flags, rest });
  }

  if (sub === "mobile") {
    const st = artemis.status();
    if (flags.json) { emit(st); return st.ready ? 0 : 1; }
    if (!st.wired.length) {
      out("  no `artemis` MCP server is registered in any agent config this box keeps.");
      out("  bundlebox does not write that entry: it carries an absolute interpreter path, a");
      out("  PYTHONPATH and a cwd that only ARTEMIS knows, and a wrong guess is a server that");
      out("  never starts — which an agent sees as no tools rather than as an error.");
      out("\n    cd <artemis checkout> && uv run artemis mcp --install claude");
    } else {
      out(table(st.wired.map((w) => [w.agent, w.key, w.cwd || "—",
        w.project_exists === false ? "MISSING" : w.project_exists === true ? "ok" : "?"]),
        { header: ["agent", "key", "project", ""] }).split("\n").map((l) => "  " + l).join("\n"));
      for (const w of st.wired.filter((x) => x.project_exists === false)) {
        warn(`${w.agent}: ${w.cwd} does not exist, so that server will not start and the agent will simply see no mobile tools`);
      }
      out(`\n  tools: ${artemis.TOOLS.join(", ")}`);
    }
    out("");
    if (!st.adb) out(`  ${st.why}`);
    else if (!st.devices.length) out("  adb is here; no device is attached");
    else out(table(st.devices.map((d) => [d.serial, d.state, d.model || d.device || ""]),
      { header: ["serial", "state", "model"] }).split("\n").map((l) => "  " + l).join("\n"));

    out(st.ready
      ? "\n  ready. Put the gate in front of every drive:\n    bb recom gate mobile/<id> -- <the command that drives>"
      : "\n  not ready to drive. The gate still works: with no record it runs the command, which is the safe direction.");
    return st.ready ? 0 : 1;
  }

  if (sub === "template") {
    const id = slug(_[1] || "example");
    if (flags.mobile) {
      const st = artemis.status();
      const dev = st.devices.find((d) => d.state === "device");
      if (!dev) { warn("no attached device to measure probes from; drop --mobile for the generic template"); return 2; }
      console.log(JSON.stringify({
        id: `mobile/${id}`, title: "What was driven on the phone, in one line",
        outcome: "blocked", summary: "one sentence a later session can act on",
        depends: artemis.dependsFor(dev.serial, String(flags.pkg || "") || undefined).filter(Boolean),
        steps: ["mobile_run_task: <the sentence ARTEMIS was given>", "what it turned out to be"],
        evidence: ["the ARTEMIS trace id, from mobile_inspect_trace"],
        saved_wall_s: 600, saved_tokens: 24000,
      }, null, 2));
      if (!flags.pkg) warn("no --pkg: this record depends on the device being attached and on nothing about the build, so it stays fresh through a reinstall");
      return 0;
    }
    // Printed on stdout whatever the mode: this is meant to be redirected into
    // a file and edited, so `--json` would be the only way to get it otherwise.
    console.log(JSON.stringify({
      id: `browser/${id}`, title: "What was driven, in one line",
      outcome: "blocked", summary: "one sentence a later session can act on",
      depends: ["git_paths:.:src/checkout/address.js", "http:http://127.0.0.1:3000/health"],
      steps: ["what was done, in order, and what it turned out to be"],
      evidence: [".bundlebox/var/frames/<stamp>/"],
      saved_wall_s: 600, saved_tokens: 24000,
    }, null, 2));
    return 0;
  }

  warn(`unknown recom sub-verb: ${sub}. list | check <id> | gate <id> -- <cmd> | replay <id> | record --from <file> | refresh <id> | forget <id> | mobile | probes | template`);
  return 2;
}

export const commands = {
  recom: {
    help: "what has already been driven, and whether that answer still holds (0 model tokens)",
    usage: "bb recom [list|check <id>|gate <id> -- <cmd>|replay <id>|record --from <file>|refresh <id>|forget <id>|mobile|probes|template] [--apply] [--json]",
    long: [
      "  bb recom list                 every record, with its verdict right now",
      "  bb recom replay <id>          the answer, if the answer still holds — exits 1 when it does not",
      "  bb recom record --from run.json --apply",
      "  bb recom gate mobile/signin -- artemis run \"sign in\"   run the drive ONLY if the answer stopped holding",
      "  bb recom mobile               is there a driver wired, and a device to drive",
      "",
      "A record declares the facts its result rests on and they are re-probed on every read:",
      "fresh (use it, drive nothing), stale (a fact moved — it names which, and both values),",
      "unknown (a fact could not be read, so never replay). Records live in .bundlebox/recom/records",
      "and are versioned with the code they are about, because a record that is lost is worse than",
      "none: a session pays for the lookup and then pays again for the run.",
    ].join("\n"),
    run: cmd,
  },
};

