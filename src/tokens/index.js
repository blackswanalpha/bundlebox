// tokens/index.js — the token verbs: estimate, ledger, calibrate, profile,
// prices, budget; plus `session` and `headroom`. Every number printed says
// whether it was MEASURED or is an ESTIMATE, and a model without a price is
// printed with tokens and no cost.
import { load } from "../core/config.js";
import { out, emit, warn } from "../core/log.js";
import { human, table } from "../core/util.js";
import { rel } from "../core/paths.js";
import { num } from "../adapters/index.js";
import * as estimate from "./estimate.js";
import * as prices from "./prices.js";
import * as ledger from "./ledger.js";
import * as calibrate from "./calibrate.js";
import * as session from "./session.js";
import * as probe from "./probe.js";
import * as headroom from "./headroom.js";

export { estimate, prices, ledger, calibrate, session, probe, headroom };

const usd = (x, priced = true) => (priced ? `$${(Number(x) || 0).toFixed(2)}` : "n/a");

/** Today's spend (UTC) across the ledger, priced where the model is known. */
export function spentToday() {
  const today = new Date().toISOString().slice(0, 10);
  let usdTotal = 0, tokens = 0, unpriced = 0;
  for (const r of ledger.usage()) {
    const ts = r.ts || r.at || "";
    if (!ts.startsWith(today)) continue;
    tokens += num(r.input) + num(r.cache_write) + num(r.cache_read) + num(r.output);
    const c = prices.cost(r.model, { inp: num(r.input), out: num(r.output), cache_write: num(r.cache_write), cache_read: num(r.cache_read) });
    if (c) usdTotal += c.total; else unpriced += 1;
  }
  return { date: today, usd: usdTotal, tokens, unpriced_rows: unpriced };
}

async function tokensCmd({ _, flags }) {
  const sub = _[0] || "estimate";
  if (sub === "estimate") {
    const paths = _.slice(1);
    const r = paths.length ? estimate.files(paths) : estimate.tree(".");
    if (flags.json) { emit({ kind: "ESTIMATE", ...r }); return 0; }
    const rows = Object.entries(r.files).sort((a, b) => b[1] - a[1]).slice(0, flags.top || 40).map(([p, n]) => [p, human(n)]);
    out(table(rows, { header: ["file", "tokens (ESTIMATE)"] }));
    out(`  total ${human(r.total)} tokens ESTIMATE over ${Object.keys(r.files).length} files, ${human(r.bytes)} bytes${r.missing.length ? `; missing: ${r.missing.join(", ")}` : ""}`);
    return 0;
  }
  if (sub === "ledger") {
    const f = ledger.fold();
    const r = ledger.rollup({ since: flags.since || "" });
    const unknown = ledger.transcripts().unknown;
    if (flags.json) { emit({ kind: "MEASURED", folded: f, unknown_adapters: unknown, ...r }); return 0; }
    const rows = r.sessions.slice(0, flags.limit || 30).map((s) => [s.session_id.slice(0, 12), s.agent, s.model, s.turns, human(s.input), human(s.cache_write), human(s.cache_read), human(s.output), human(s.peak), usd(s.usd, s.priced), s.run_id || ""]);
    out(table(rows, { header: ["session", "agent", "model", "turns", "input", "cache wr", "cache rd", "output", "peak", "usd", "run"] }));
    out(`  ${r.total.sessions} sessions, ${r.total.turns} turns, ${usd(r.total.usd)} priced${r.total.unpriced ? ` (${r.total.unpriced} sessions carry an unpriced model)` : ""}   MEASURED; folded ${f.appended} new rows`);
    if (unknown.length) out(`  could not look: ${unknown.join(", ")} (no transcript layout on this box)`);
    return 0;
  }
  if (sub === "calibrate") {
    // Every per-repo factor by default, not only the estimator's coefficients.
    // `churn_factor`, `anchor_widen` and `reserve_by_kind` were shipped
    // constants with no refit anywhere in the box, which meant one machine's
    // 2.4 silently mis-budgeted every brief in every other workspace.
    // `--tokens-only` is the old behaviour for a caller that wants just that.
    if (flags.tokensOnly) {
      const f = calibrate.fit({ sample: flags.sample || 4000 });
      if (flags.json) { emit(f); return f.ok ? 0 : 1; }
      out(calibrate.report(f));
      if (!f.ok) return 1;
      if (flags.write || flags.apply) out(`  wrote ${rel(calibrate.write(f))}`); else out("  dry run — add --apply to save into var/calibration.json");
      return 0;
    }
    const a = calibrate.fitAll({ sample: flags.sample || 4000 });
    if (flags.json) { emit(a); return 0; }
    out(calibrate.reportAll(a));
    if (flags.write || flags.apply) {
      const w = calibrate.writeAll(a);
      out(w.wrote.length ? `\n  wrote ${w.wrote.join(", ")} into ${rel(w.path)}` : "\n  nothing had enough samples to fit; the shipped numbers stand");
    } else {
      out("\n  dry run — add --apply to read-merge what fitted into var/calibration.json.");
    }
    return 0;
  }
  if (sub === "profile") {
    if (!flags.probe) {
      const cal = load().budget;
      // The free measurement first: real sessions in this workspace already
      // paid for an opening window, and their transcripts are on disk. It is an
      // UPPER bound on a lean lane, but it is measured, and the alternative is
      // a 25k constant nobody measured.
      const obs = await probe.observe();
      if (flags.json) { emit({ baseline: cal.overhead_tokens, lean: cal.overhead_lean, observed: obs }); return 0; }
      out(`  overhead  baseline ${human(cal.overhead_tokens)}   lean ${human(cal.overhead_lean)}   (from var/calibration.json; 0 = never probed)`);
      if (obs.ok) {
        out(`  observed  min ${human(obs.min)}   median ${human(obs.median)}   max ${human(obs.max)}   MEASURED off ${obs.n} transcript${obs.n > 1 ? "s" : ""} in this workspace`);
        out("            interactive sessions carry MCP servers, the full tool set and a global CLAUDE.md a lean lane does not: this is an upper bound");
        if (flags.write) out(`  wrote ${rel(probe.write(obs))}`);
        else out("  add --write to use the observed minimum instead of the 25.0k floor, or --probe to measure a real lane (SPENDS tokens)");
      } else {
        out(`  observed  ${obs.why}`);
        out("  add --probe to measure: it opens three one-turn sessions and SPENDS a few thousand tokens");
      }
      return 0;
    }
    warn("probing spends tokens: three one-turn sessions");
    const p = await probe.measure({ cwd: flags.cwd || undefined, model: flags.model || "sonnet" });
    if (flags.json) { emit(p); return 0; }
    out(probe.report(p));
    out(`  wrote ${rel(probe.write(p))}`);
    return 0;
  }
  if (sub === "prices") { if (flags.json) emit(prices.PER_MTOK); else out(prices.table()); return 0; }
  if (sub === "budget") {
    const cfg = load().lanes;
    const s = spentToday();
    const limit = num(cfg.daily_budget_usd);
    if (flags.json) { emit({ kind: "MEASURED", ...s, limit_usd: limit, ok: !limit || s.usd < limit }); return 0; }
    out(`  today ${s.date}: ${usd(s.usd)} over ${human(s.tokens)} tokens MEASURED${s.unpriced_rows ? ` (${s.unpriced_rows} rows unpriced)` : ""}`);
    out(limit ? `  lanes.daily_budget_usd ${usd(limit)} — ${s.usd < limit ? "under" : "REACHED, bb run --apply will refuse"}` : "  lanes.daily_budget_usd 0 — no cap");
    return 0;
  }
  warn(`unknown sub-verb: ${sub}`);
  return 2;
}

async function sessionCmd({ _, flags }) {
  const sub = _[0];
  if (sub === "list") {
    const rows = session.list();
    if (flags.json) { emit(rows); return 0; }
    if (!rows.length) { out("  no sessions measured yet"); return 0; }
    for (const r of rows) out("  " + r.line);
    return 0;
  }
  const opts = { sessionId: String(flags.session || (sub && sub !== "end" ? sub : "") || ""), transcriptPath: String(flags.transcript || "") };
  if (sub === "end") {
    const r = await session.end(opts);
    if (flags.json) emit(r); else out(r.line);
    return 0;
  }
  const m = await session.measure(opts);
  if (flags.json) { emit(m); return 0; }
  if (!m.session) { out("  no transcript found for this workspace"); return 1; }
  out(session.report(m));
  if (flags.write) out(`  wrote ${session.write(m).join(", ")}`);
  return 0;
}

async function headroomCmd({ _, flags }) {
  const sub = _[0] || "status";
  if (sub === "start") {
    const r = await headroom.start({ apply: Boolean(flags.apply) });
    if (flags.json) { emit(r); return r.ok || r.dry_run ? 0 : 1; }
    if (r.dry_run) out(`  would run: ${r.cmd}   (add --apply)`);
    else if (r.adopted) out(`  adopted the proxy already on ${headroom.baseUrl()}${r.ok ? "" : ` — ${r.why}`}`);
    else out(r.ok ? `  started pid ${r.pid} on ${headroom.baseUrl()} in ${r.seconds}s` : `  ${r.why}`);
    return r.ok || r.dry_run ? 0 : 1;
  }
  if (sub === "stop") { const r = headroom.stop(); if (flags.json) emit(r); else out(r.ok ? `  stopped pid ${r.pid}` : `  ${r.why}`); return r.ok ? 0 : 1; }
  if (sub === "savings") { const w = await headroom.wire(); if (flags.json) emit(w); else out(await headroom.report()); return 0; }
  if (sub === "doctor") {
    const d = await headroom.doctor();
    if (flags.json) { emit(d); return 0; }
    for (const [k, v] of Object.entries(d)) out(`  ${k.padEnd(10)} ${v === "" ? "-" : v}`);
    return 0;
  }
  if (flags.json) emit(await headroom.doctor()); else out(await headroom.report());
  return 0;
}

export const commands = {
  tokens: { help: "estimate, ledger, calibrate, profile, prices, budget", usage: "bb tokens estimate <paths> | ledger | calibrate [--apply] [--tokens-only] | profile [--probe] | prices | budget [--json]", run: tokensCmd },
  session: { help: "what a session used and saved (MEASURED vs ESTIMATE)", usage: "bb session [id] [--write] | end --session <id> --transcript <path> | list [--json]", run: sessionCmd },
  headroom: { help: "the wire: local compression proxy", usage: "bb headroom start --apply | status | stop | savings | doctor [--json]", run: headroomCmd },
};
