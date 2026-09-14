// probe.js — what opening a lane costs HERE, measured under the exact flags.
//
// Every lane is budgeted as `overhead + brief + payload*churn + reserve`, and
// overhead was the one term taken on faith: read off interactive transcripts
// that had MCP servers, the full tool set and the global CLAUDE.md loaded. A
// `claude -p` lane is not that session. So it is probed: one turn, five words,
// and the first usage block IS the overhead, because nothing else is in the
// window yet. Measured on the reference box: baseline 44.3k, lean 29.2k.
//
// `wire` is lean plus the headroom proxy, probed for one reason: to check the
// proxy is TRANSPARENT to the opening window. A wire figure above lean means
// the base URL cost the session something (headroom GH #746). It is skipped,
// not zeroed, when no proxy answers.
//
// A probe SPENDS. It runs only under `bb tokens profile --probe`.
import { run } from "../core/exec.js";
import { readJson, writeJson, calibrationPath } from "../core/config.js";
import { ROOT, rel } from "../core/paths.js";
import { now, human } from "../core/util.js";
import claude, { LEAN_FLAGS, LANE_TOOLS, windowOf } from "../adapters/claude.js";
import * as headroom from "./headroom.js";

export const STACKS = { baseline: [], lean: [...LEAN_FLAGS, "--tools", ...LANE_TOOLS] };

/** The free half of the answer: what the FIRST turn of each real session in
 *  this workspace already cost, read off transcripts that are on disk.
 *
 *  Nothing else is in the window on turn one, so `input + cache_write +
 *  cache_read` there IS the opening cost. It is not the same number a probe
 *  returns — an interactive session carries MCP servers, the full tool set and
 *  the global CLAUDE.md that a `claude -p` lane does not — so it is an UPPER
 *  bound on lane overhead and is labelled as one. It beats OVERHEAD_FLOOR,
 *  which is a constant somebody typed. */
export async function observe({ root = ROOT, limit = 20 } = {}) {
  const ledger = await import("./ledger.js");
  const entries = (ledger.transcripts(root) || []).slice(0, limit);
  const firsts = [];
  for (const e of entries) {
    const t = ledger.turns(e.file, e.adapter);
    if (!t || !t.length) continue;
    const f = t[0];
    const w = (Number(f.input) || 0) + (Number(f.cacheWrite) || 0) + (Number(f.cacheRead) || 0);
    if (w > 0) firsts.push({ session: e.file, adapter: e.adapter, window: w, turns: t.length });
  }
  if (!firsts.length) return { ok: false, why: "no transcripts with a usage block for this workspace", n: 0 };
  const w = firsts.map((f) => f.window).sort((a, b) => a - b);
  const mid = Math.floor(w.length / 2);
  return { ok: true, n: w.length, min: w[0], median: w.length % 2 ? w[mid] : Math.round((w[mid - 1] + w[mid]) / 2),
    max: w[w.length - 1], sessions: firsts, measured_at: now(), kind: "observed" };
}

/** One turn, five words, read the window it arrived in. */
export function probe(stack, { cwd = ROOT, model = "sonnet", timeout = 240000, env = null } = {}) {
  // `--no-session-persistence` is in `claude --help` 2.1.270: a probe must not leave a transcript behind to be folded as spend.
  const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model, "--no-session-persistence", ...stack];
  const t0 = Date.now();
  const r = run(argv, { cwd, timeout, input: "Reply with the single word: ok", env: env || undefined });
  if (r.missing) return { ok: false, why: "claude not installed", window: 0 };
  if (r.rc === 124) return { ok: false, why: "timeout", window: 0 };
  for (const line of (r.out || "").split("\n")) {
    const e = claude.parseEvent(line);
    if (!e || e.isResult || !e.msgId) continue;
    return { ok: true, window: e.input + e.cacheWrite + e.cacheRead, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  }
  return { ok: false, why: (r.err || "no usage block").slice(-200), window: 0 };
}

export async function measure({ cwd = ROOT, model = "sonnet" } = {}) {
  const stacks = {};
  for (const [name, stack] of Object.entries(STACKS)) { stacks[name] = probe(stack, { cwd, model }); stacks[name].flags = stack.join(" ") || "(none)"; }
  // Same gate `bb run` uses, so this probes the configuration lanes really get.
  const wireEnv = await headroom.laneEnv({ agent: "claude" });
  if (Object.keys(wireEnv).length) { stacks.wire = probe(STACKS.lean, { cwd, model, env: wireEnv }); stacks.wire.flags = "lean + " + headroom.baseUrl(); }
  const base = stacks.baseline.window || 0, lean = stacks.lean.window || 0, wire = stacks.wire?.window || 0;
  return { measured_at: now(), cwd: String(cwd), model, stacks, baseline: base, lean, wire,
    wire_overhead: wire && lean ? wire - lean : 0, saved_per_lane: Math.max(0, base - lean), saved_pct: base ? Math.round(1000 * (base - lean) / base) / 10 : 0 };
}

/** READ-MERGE into var/calibration.json beside the churn fit. */
export function write(profile) {
  const p = calibrationPath();
  const cal = readJson(p, {}) || {};
  if (profile.kind === "observed") {
    // An observed figure never overwrites a probed one: a probe measures the
    // session lanes actually open, this measures the ones a person opened.
    cal.overhead_observed = profile;
    if (!cal.overhead_tokens) cal.overhead_tokens = profile.min;
    writeJson(p, cal);
    return p;
  }
  cal.session_profile = profile;
  if (profile.lean) cal.overhead_lean = profile.lean;
  if (profile.baseline) cal.overhead_tokens = profile.baseline;
  writeJson(p, cal);
  return p;
}

export function report(profile) {
  const L = [`  probed ${profile.measured_at}   cwd ${rel(profile.cwd)}   model ${profile.model}`];
  for (const [name, r] of Object.entries(profile.stacks)) L.push(r.ok ? `  ${name.padEnd(10)} ${human(r.window).padStart(8)}   ${r.seconds}s   MEASURED` : `  ${name.padEnd(10)} ${"FAILED".padStart(8)}   ${r.why || ""}`);
  if (profile.saved_per_lane) L.push(`  ${"-".repeat(44)}`, `  saved      ${human(profile.saved_per_lane).padStart(8)}   per lane, before any work  (${profile.saved_pct}%)  MEASURED`);
  if (profile.wire) L.push(`  wire cost  ${human(profile.wire_overhead).padStart(8)}   what the proxy added to the OPENING window; it should be ~0`);
  else if (headroom.cfg().enabled) L.push("  wire       skipped — no headroom proxy answering");
  return L.join("\n");
}
