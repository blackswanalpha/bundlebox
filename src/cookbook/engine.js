// engine.js — run a corpus. Two engines, one contract.
//
// The kernel (`bbk scenario`) is the fast path: threads, one connection per
// worker, a shared pacer, hundreds of steps in seconds. It speaks http only,
// because TLS would be a dependency it must build without, and it implements a
// documented subset of the pattern language.
//
// This is the other engine — fetch, https, every RegExp Node has — and it is
// what runs when the kernel is absent, when the base is https, or when a corpus
// uses a pattern outside the subset. `pick()` decides and SAYS which, because a
// board that does not name its engine is a board whose numbers cannot be
// compared with the last one.
//
// The two are pinned to identical answers by test/cookbook.test.js. Where they
// could only differ silently — the state machine — the rules are stated once
// here and mirrored in `kernel/src/scenario.rs`:
//
//   passed   every expectation held and at least one was made
//   failed   an expectation did not hold
//   error    the request never happened, or a {{token}} resolved to nothing
//   blocked  a precondition earlier in this scenario did not hold
//   empty    the step asserted nothing; `bb cookbook check` refuses the corpus
import fs from "node:fs";
import path from "node:path";
import * as kernel from "../core/kernel.js";
import { run as execRun, shellCmd } from "../core/exec.js";
import { check, checkCmd, asserts, stdoutBody, parseUi } from "./expect.js";
import { subst, clockOf, at, show } from "./tokens.js";
import { byId as driverById, ids as driverIds } from "./drivers/index.js";

const RED = new Set(["failed", "error"]);
const tail = (s, cap) => (String(s).length <= cap ? String(s) : `…${String(s).slice(-cap)}`);

function bodyJson(raw) {
  const t = String(raw || "").trim();
  if (!t) return {};
  try { const v = JSON.parse(t); return Array.isArray(v) ? { _list: v } : (v && typeof v === "object" ? v : { _value: v }); }
  catch { return { _text: t }; }
}

class Pacer {
  constructor(rpm) { this.gap = rpm > 0 ? 60000 / rpm : 0; this.next = 0; }
  async wait() {
    if (!this.gap) return;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

function headerList(spec, step, vars, missing) {
  const out = {};
  const push = (o) => { for (const [k, v] of Object.entries(o || {})) out[k] = show(subst(v, spec.clock, vars, missing)); };
  push(spec.headers);
  if (step.as && spec.actors?.[step.as]?.headers) push(spec.actors[step.as].headers);
  push(step.headers);
  return out;
}

async function httpStep(spec, step, vars, name) {
  const missing = [];
  const line = show(subst(String(step.do || ""), spec.clock, vars, missing));
  const [methodRaw, ...rest] = line.split(/\s+/);
  const method = (methodRaw || "GET").toUpperCase();
  const target = rest.join("");
  const url = /^https?:\/\//.test(target) ? target : spec.base.replace(/\/$/, "") + (target.startsWith("/") ? target : `/${target}`);
  const headers = headerList(spec, step, vars, missing);
  const body = step.body === undefined ? undefined : JSON.stringify(subst(step.body, spec.clock, vars, missing));
  const expect = subst(step.expect || {}, spec.clock, vars, missing);
  const request = `${method} ${target}`;
  const evidence = { request };
  if (missing.length) {
    return { name, kind: "http", state: "error", status: null, ms: 0, request, evidence,
      why: [`unresolved token(s): {{${[...new Set(missing)].join("}}, {{")}}} — nothing in this scenario saved them`] };
  }
  if (body !== undefined) { evidence.sent = tail(body, Math.min(spec.cap, 600)); if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json"; }

  const attempts = Math.max(1, Number(step.poll?.attempts) || 1);
  const gap = Number(step.poll?.ms) || 500;
  let last = null, err = null, why = [], got = {}, totalMs = 0;
  const expects429 = expect.status === 429;
  for (let a = 0; a < attempts; a++) {
    if (a) await new Promise((r) => setTimeout(r, gap));
    let left = spec.max429;
    for (;;) {
      await spec.pacer.wait();
      spec.requests++;
      const t0 = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), spec.timeoutMs);
      try {
        const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: "manual" });
        const text = await res.text();
        const ms = Date.now() - t0;
        if (res.status === 429 && left > 0 && !expects429) {
          spec.throttled++; left--;
          const ra = Number(res.headers.get("retry-after"));
          await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(ra) ? ra * 1000 : 2000, 30000)));
          continue;
        }
        last = { status: res.status, text, ms };
        totalMs += ms;
        err = null;
      } catch (e) {
        err = e.name === "AbortError" ? `timed out after ${spec.timeoutMs}ms` : String(e.message || e);
        totalMs += Date.now() - t0;
      } finally { clearTimeout(timer); }
      break;
    }
    if (!last) break;
    ({ why, got } = check(expect, bodyJson(last.text), last.status, last.ms));
    if (!why.length) break;
  }
  evidence.got = got;
  if (err || !last) { evidence.error = err || "no response and no error"; return { name, kind: "http", state: "error", status: null, ms: totalMs, why: [`request failed: ${evidence.error}`], request, evidence }; }
  evidence.status = last.status;
  evidence.body = tail(last.text, spec.cap);
  const { n, unknown } = asserts(expect);
  for (const u of unknown) why.push(`unknown expectation key \`${u}\` — nothing checked it`);
  const state = why.length ? "failed" : n === 0 ? "empty" : "passed";
  // A save runs only on a step that held: saving off a red response propagates
  // one defect into every step after it.
  if (state === "passed" && step.save) {
    const parsed = bodyJson(last.text);
    for (const [k, p] of Object.entries(step.save)) { const v = at(parsed, show(subst(p, spec.clock, vars, []))); if (v !== undefined) vars[k] = v; }
  }
  return { name, kind: "http", state, status: last.status, ms: totalMs, why, request, evidence };
}

function staticStep(spec, step, vars, name) {
  const missing = [];
  const s = subst(step.static || {}, spec.clock, vars, missing);
  const file = String(s.file || "");
  const evidence = { file };
  const request = `static ${file}`;
  let text;
  try { text = fs.readFileSync(path.join(spec.root, file), "utf8"); }
  catch (e) { return { name, kind: "static", state: "failed", status: null, ms: 0, why: [`${file}: ${e.message}`], request, evidence }; }
  const why = [];
  let n = 0;
  for (const [key, wantPresent] of [["contains", true], ["absent", false]]) {
    const want = s[key];
    for (const needle of typeof want === "string" ? [want] : Array.isArray(want) ? want : []) {
      n++;
      if (text.includes(needle) !== wantPresent) why.push(`${file} ${wantPresent ? "does not contain" : "contains"} ${JSON.stringify(needle)}`);
    }
  }
  if (typeof s.matches === "string") {
    n++;
    try { if (!new RegExp(s.matches).test(text)) why.push(`${file} does not match /${s.matches}/`); }
    catch (e) { why.push(`/${s.matches}/ is not a valid pattern (${e.message})`); }
  }
  evidence.lines = text.split("\n").length;
  return { name, kind: "static", state: why.length ? "failed" : n === 0 ? "empty" : "passed", status: null, ms: 0, why, request, evidence };
}

function cmdStep(spec, step, vars, name) {
  const missing = [];
  const cmd = show(subst(String(step.run || ""), spec.clock, vars, missing));
  const expect = step.expect === undefined ? null : subst(step.expect, spec.clock, vars, missing);
  const evidence = { cmd };
  if (missing.length) return { name, kind: "cmd", state: "error", status: null, ms: 0, why: [`unresolved token(s): ${[...new Set(missing)].join(", ")}`], request: cmd, evidence };
  const t0 = Date.now();
  const r = execRun(shellCmd(cmd), { cwd: spec.root, timeout: spec.timeoutMs });
  const ms = Date.now() - t0;
  evidence.rc = r.rc;
  evidence.stdout = tail(r.out, spec.cap);
  if (String(r.err).trim()) evidence.stderr = tail(r.err, Math.min(spec.cap, 1200));
  const { why, n } = checkCmd(expect, { rc: r.rc, stdout: r.out, stderr: r.err, ms });
  // A command that printed JSON can hand a value to the next step, exactly as a
  // response does. Without this a scenario has to re-run the command to get at
  // a field it already printed.
  if (step.save && typeof step.save === "object") {
    const body = stdoutBody(r.out);
    if (body) for (const [k, p2] of Object.entries(step.save)) {
      const v = at(body, show(subst(p2, spec.clock, vars, [])));
      if (v !== undefined) vars[k] = v;
    }
  }
  return { name, kind: "cmd", state: why.length ? "failed" : n === 0 ? "empty" : "passed", status: r.rc, ms, why, request: cmd, evidence };
}

/** One `ui` step, executed by the driver the corpus declared. The session is
 *  held for the whole scenario, so `click` follows `type` on the same page. */
async function uiStep(spec, step, vars, name, ui) {
  const missing = [];
  const line = show(subst(String(step.ui || ""), spec.clock, vars, missing));
  const request = `ui ${line}`;
  const evidence = { ui: line, driver: spec.driver || "" };
  if (missing.length) return { name, kind: "ui", state: "error", status: null, ms: 0, why: [`unresolved token(s): ${[...new Set(missing)].join(", ")}`], request, evidence };
  const a = parseUi(line);
  if (a.why) return { name, kind: "ui", state: "error", status: null, ms: 0, why: [a.why], request, evidence };
  const drv = driverById(spec.driver);
  if (!drv) return { name, kind: "ui", state: "error", status: null, ms: 0, request, evidence,
    why: [spec.driver ? `no driver \`${spec.driver}\`; persona.driver is one of ${driverIds().join(", ")}` : `this scenario has \`ui\` steps and persona.json declares no \`driver\` (${driverIds().join(", ")})`] };
  const ready = await drv.available();
  if (!ready.ok) return { name, kind: "ui", state: "blocked", status: null, ms: 0, why: [ready.why], request, evidence };
  const t0 = Date.now();
  try {
    if (!ui.session) ui.session = await drv.open({ root: spec.root, base: spec.base }, "");
    const r = await drv.act(ui.session, a);
    Object.assign(evidence, r.got || {});
    // A drive step is a bare `run`: `click #submit` claims the element is there
    // and takes a click, and a click on nothing is a red step, not a no-op.
    return { name, kind: "ui", state: r.ok ? "passed" : "failed", status: null,
      ms: Date.now() - t0, why: r.ok ? [] : [r.why], request, evidence };
  } catch (e) {
    return { name, kind: "ui", state: "error", status: null, ms: Date.now() - t0, why: [String(e.message || e).split("\n")[0]], request, evidence };
  }
}

async function runSteps(spec, steps, vars) {
  const out = [];
  const ui = { session: null, opened: "" };
  let blocked = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const name = step.name || `step ${i + 1}`;
    if (blocked && !step.cleanup) { out.push({ name, kind: "blocked", state: "blocked", status: null, ms: 0, why: [blocked], request: "", evidence: {} }); continue; }
    let r;
    if (step.static) r = staticStep(spec, step, vars, name);
    else if (step.run) r = cmdStep(spec, step, vars, name);
    else if (step.ui) r = await uiStep(spec, step, vars, name, ui);
    else if (step.do) r = await httpStep(spec, step, vars, name);
    else r = { name, kind: "none", state: "empty", status: null, ms: 0, why: ["a step must have `do`, `run`, `static` or `ui`"], request: "", evidence: {} };
    if (step.precondition && r.state !== "passed") blocked = `blocked by precondition \`${r.name}\`: ${r.why[0] || ""}`;
    out.push(r);
  }
  if (ui.session) { const drv = driverById(spec.driver); try { await drv?.close(ui.session); } catch { /* the scenario is over either way */ } }
  return { steps: out, blocked };
}

const stateOf = (steps) => steps.some((s) => s.state === "error") ? "error"
  : steps.some((s) => s.state === "failed") ? "failed"
  : steps.some((s) => s.state === "blocked") ? "blocked"
  : steps.some((s) => s.state === "empty") ? "empty" : "passed";

const carry = (sc, steps, seconds) => ({
  id: sc.id || "", surface: sc.surface || "", severity: sc.severity || "", title: sc.title || "",
  question: sc.question || "", ...(sc.rule ? { rule: sc.rule } : {}), state: stateOf(steps),
  seconds: Math.round(seconds * 100) / 100, steps,
});

export async function runJs(input) {
  const t0 = Date.now();
  const spec = {
    base: String(input.base || "").replace(/\/$/, ""),
    headers: input.headers || {}, actors: input.actors || {},
    clock: clockOf({ timezone: input.timezone, tz_offset_minutes: input.tz_offset_minutes, run: input.run }),
    pacer: new Pacer(Number(input.rpm) || 0),
    timeoutMs: Number(input.timeout_ms) || 20000,
    cap: Number(input.cap_bytes) || 1200,
    root: input.root || process.cwd(),
    driver: String(input.driver || ""),
    max429: Number(input.max_429) ?? 6,
    requests: 0, throttled: 0,
  };
  const globals = { ...(input.vars || {}) };
  const setupSteps = input.setup || [];
  const setupVars = { ...globals };
  const setup = setupSteps.length ? await runSteps(spec, setupSteps, setupVars) : { steps: [], blocked: null };
  const setupFailed = setup.steps.some((s) => RED.has(s.state)) || !!setup.blocked;
  const scenarios = input.scenarios || [];
  let rows;
  if (setupFailed) {
    rows = scenarios.map((sc) => carry(sc, (sc.steps || []).map((st, j) => ({
      name: st.name || `step ${j + 1}`, kind: "blocked", state: "blocked", status: null, ms: 0,
      why: ["setup failed; nothing after it is a claim about the product"], request: "", evidence: {} })), 0));
  } else {
    const parallel = Math.min(Math.max(Number(input.parallel) || 1, 1), 32);
    rows = new Array(scenarios.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, scenarios.length || 1) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= scenarios.length) return;
        const sc = scenarios[i];
        const s0 = Date.now();
        const { steps } = await runSteps(spec, sc.steps || [], { ...setupVars });
        rows[i] = carry(sc, steps, (Date.now() - s0) / 1000);
      }
    }));
  }
  const totals = { passed: 0, failed: 0, blocked: 0, error: 0, empty: 0 };
  for (const sc of rows) for (const st of sc.steps) totals[st.state in totals ? st.state : "empty"]++;
  return {
    ok: true, engine: "js", base: spec.base,
    setup: { state: setupSteps.length ? (setupFailed ? "failed" : "passed") : "none", steps: setup.steps },
    scenarios: rows, totals, seconds: Math.round((Date.now() - t0) / 100) / 10,
    requests: spec.requests, throttled: spec.throttled, rpm: Number(input.rpm) || 0,
  };
}

/** Which engine can run this corpus, and why not the other one. */
export const hasUi = (input) => (input.setup || []).some((s) => s && s.ui)
  || (input.scenarios || []).some((sc) => (sc.steps || []).some((s) => s && s.ui));

export function pick(input, { engine = "auto" } = {}) {
  const https = /^https:/i.test(String(input.base || ""));
  if (engine === "js") return { engine: "js", why: "asked for" };
  // The drivers live in this engine and the kernel has no `ui` step at all, so
  // `--engine kernel` over a ui corpus would be a green board about nothing.
  if (hasUi(input)) return { engine: "js", why: "the corpus has `ui` steps and the drivers are node-side" };
  if (engine === "kernel") return kernel.available() ? { engine: "kernel", why: "asked for" } : { engine: "js", why: "no kernel binary on this box" };
  if (!kernel.available()) return { engine: "js", why: "no kernel binary on this box (`bb kernel build`)" };
  if (https) return { engine: "js", why: "the base is https and the kernel speaks http only" };
  const bad = unsupportedPatterns(input);
  if (bad.length) return { engine: "js", why: `pattern${bad.length > 1 ? "s" : ""} outside the kernel's subset: ${bad.slice(0, 3).map((b) => `/${b.pattern}/`).join(", ")}` };
  return { engine: "kernel", why: "http base, every pattern inside the subset" };
}

/** Patterns the kernel would refuse. Asked of the kernel itself rather than
 *  re-implemented here: two opinions about what the subset is, is no subset. */
export function unsupportedPatterns(input) {
  if (!kernel.available()) return [];
  const pats = [];
  const walk = (steps, where) => {
    for (const st of steps || []) {
      for (const [p, pat] of Object.entries(st.expect?.json_matches || {})) pats.push({ pattern: String(pat), where: `${where}:${st.name || "?"}`, path: p });
      if (typeof st.static?.matches === "string") pats.push({ pattern: st.static.matches, where: `${where}:${st.name || "?"}`, path: "static" });
    }
  };
  walk(input.setup, "setup");
  for (const sc of input.scenarios || []) walk(sc.steps, sc.id || "?");
  const bad = [];
  for (const p of pats) {
    const r = kernel.call("rx", { pattern: p.pattern, subject: "" });
    if (r && r.supported === false) bad.push({ ...p, why: r.why });
  }
  return bad;
}

export async function run(input, { engine = "auto" } = {}) {
  const chosen = pick(input, { engine });
  if (chosen.engine === "kernel") {
    const r = kernel.call("scenario", input, { timeout: Number(input.wall_timeout_ms) || 3600000 });
    if (r && r.ok) return { ...r, engine_why: chosen.why };
    // A kernel that refused says why; falling through silently would hide it.
    return { ...(await runJs(input)), engine_why: `kernel declined (${r?.why || kernel.lastError}); ran in js` };
  }
  return { ...(await runJs(input)), engine_why: chosen.why };
}
