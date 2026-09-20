// compiler.js — findings become work units, and a work unit is a packed brief.
//
// Units are grouped so a lane is worth opening: findings of the same detector
// in the same top-level directory become ONE unit, because the second one costs
// almost nothing once the first is understood, and a lane below the floor has
// paid full price for a fraction of a session.
import fs from "node:fs";
import path from "node:path";
import { load } from "../core/config.js";
import * as throttle from "./throttle.js";
import { ROOT, abs } from "../core/paths.js";
import { git, gitOk, run as exec, shellCmd } from "../core/exec.js";
import * as kernel from "../core/kernel.js";
import { human, sha1 } from "../core/util.js";
import * as anc from "./anchors.js";
import * as context from "./context.js";
import * as brief from "./brief.js";

const SEV = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const sev = (s) => SEV[String(s || "").toLowerCase()] ?? 0;

/** Promote-or-not for one finding. The detectors module owns the real rule
 *  engine; when it is absent or broken this falls back to a severity gate so a
 *  compile never depends on a module that is still being written. */
let _triage = null;
async function triageFn() {
  if (_triage) return _triage;
  try {
    const m = await import("../detectors/index.js");
    if (typeof m.triage === "function") return (_triage = m.triage);
  } catch { /* fall through to the local gate */ }
  _triage = (f, cfg) => {
    const at = sev(cfg.detectors?.promote_at ?? "medium");
    const promote = sev(f.severity) >= at;
    return { promote, reason: promote ? `severity ${f.severity} >= ${cfg.detectors?.promote_at}` : `severity ${f.severity} below ${cfg.detectors?.promote_at}`,
      model: cfg.lanes?.model || "", kind: f.kind || "fix", priority: 5 - sev(f.severity), ev: sev(f.severity) + 1 };
  };
  return _triage;
}

const topDirOf = (p) => { const s = String(p || "").replace(/\\/g, "/"); return s.includes("/") ? s.split("/")[0] : "."; };

// What PROVES a change, read off the tree and merged under `kernel.gates` so a
// configured gate always wins over a guessed one. `quick` is the cheapest gate
// found (lint, then typecheck, then test); `full` is the test run.
/** User gates in either shape. `kernel.gates` is documented per directory —
 *  `{".": {quick, full}}` — and `bb init` writes the flat `{quick, full, ...}`.
 *  Both shapes exist in the wild, so both are read here rather than in each
 *  caller: a config in the documented shape used to merge as keys named `.` and
 *  `demo`, leaving `quick` empty and every unit `unproven` with no warning. */
export function userGates(cfg = load()) {
  const user = cfg.kernel?.gates || {};
  return Object.values(user).some((v) => v && typeof v === "object") ? user : { ".": user };
}

/** What the tree in `dir` proves a change with, read off its manifest. Nothing
 *  about config here: this is detection, and detection knows only the files. */
export function detectIn(dir) {
  const g = { quick: "", full: "", lint: "", typecheck: "", test: "", source: null };
  const has = (n) => fs.existsSync(path.join(dir, n));
  if (has("package.json")) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts || {}; } catch { /* unparseable: no scripts */ }
    if (scripts.lint) g.lint = "npm run lint";
    if (scripts.typecheck) g.typecheck = "npm run typecheck";
    if (scripts.test) g.test = "npm test";
    if (g.lint || g.typecheck || g.test) g.source = "package.json";
  }
  if (!g.source && has("Makefile")) {
    const mk = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
    const target = (t) => new RegExp(`^${t}\\s*:`, "m").test(mk);
    if (target("lint")) g.lint = "make lint";
    if (target("typecheck")) g.typecheck = "make typecheck";
    if (target("test")) g.test = "make test";
    else if (target("check")) g.test = "make check";
    if (g.lint || g.typecheck || g.test) g.source = "Makefile";
  }
  if (!g.source) {
    if (has("pyproject.toml") || has("setup.py")) { g.test = "pytest -q"; g.source = has("pyproject.toml") ? "pyproject.toml" : "setup.py"; }
    else if (has("Cargo.toml")) { g.test = "cargo test"; g.source = "Cargo.toml"; }
    else if (has("go.mod")) { g.test = "go test ./..."; g.source = "go.mod"; }
    else if (has("pubspec.yaml")) { g.lint = "flutter analyze"; g.source = "pubspec.yaml"; }
  }
  g.quick = g.lint || g.typecheck || g.test;
  g.full = g.test || g.quick;
  return g;
}

/** The gate for one scope: what its own directory proves a change with, then
 *  the root's as a fallback, then whatever `kernel.gates` declares over the top.
 *
 *  `scope` in the result is the directory the command must RUN in, which is not
 *  always the scope asked for: a sub-project with no manifest of its own falls
 *  back to the root's gate, and that gate belongs at the root. */
export function detectGates(root = ROOT, scope = ".") {
  const cfg = load();
  const dir = scope === "." ? root : path.join(root, scope);
  let g = detectIn(dir), from = scope;
  // A sub-directory that is not a project of its own is proven the way the
  // workspace is proven, and that command runs at the workspace root.
  if (!g.source && scope !== ".") { g = detectIn(root); from = "."; }
  // The most specific declared scope that contains this one, then the root.
  const byDir = userGates(cfg);
  const pick = Object.keys(byDir)
    .filter((d) => d === "." || scope === d || String(scope).startsWith(d + "/"))
    .sort((a, b) => b.length - a.length)[0];
  const user = Object.fromEntries(Object.entries((pick && byDir[pick]) || {}).filter(([, v]) => v && typeof v === "string"));
  return { ...g, ...user, scope: user.quick || user.full ? pick : from };
}

/** Run one gate command and report the verdict, the tail and the seconds.
 *
 *  One implementation, because a gate that runs one way for a lane and another
 *  way for `bb gates run` is two gates. The kernel enforces the timeout itself
 *  and caps the output, so a gate that hangs before its first byte is still
 *  killed and a failing build cannot eat the window explaining that it failed;
 *  without the kernel it is the platform's own shell, chosen in the one place
 *  that owns that choice. */
export function runGate(cmd, { cwd = ROOT, timeout = 1800, capBytes = 4000, tail = 400 } = {}) {
  const k = kernel.call("gate", { cmd, cwd, timeout, cap_bytes: capBytes });
  if (k && k.verdict) return { cmd, rc: k.rc ?? 1, tail: String(k.output_tail || "").slice(-tail), seconds: k.seconds, timed_out: k.timed_out, via: "kernel" };
  const t0 = Date.now();
  const r = exec(shellCmd(cmd, { merge: true }), { cwd, timeout: timeout * 1000 });
  return { cmd, rc: r.rc, tail: (r.out + r.err).slice(-tail), seconds: Math.round((Date.now() - t0) / 100) / 10,
    timed_out: r.rc === 124, via: "js" };
}

/** The re-check that proves THESE findings are gone: the scan must succeed AND
 *  none of the ids may reappear. Written as two commands, not one pipeline,
 *  because `! scan | grep` passes when the scan itself crashes. */
function recheck(detector, ids) {
  const out = ".bundlebox/out/recheck.json";
  const pats = ids.map((id) => `-e '"${id}"'`).join(" ");
  return `bb scan --only ${detector} --json > ${out} && ! grep -q ${pats} ${out}`;
}

/** The last two commits that mention this detector, as prior art. Best effort:
 *  null when git could not be asked, [] when it was asked and had nothing. */
export function priorArt(detector, cwd = ROOT) {
  if (!gitOk(cwd)) return null;
  const r = git(["log", `--grep=${detector}`, "-n", "2", "--stat", "--format=%x00%h|%ad|%s", "--date=short"], cwd);
  if (r.rc !== 0) return null;
  const rows = [];
  for (const chunk of r.out.split("\0").slice(1)) {
    const [head, ...rest] = chunk.split("\n");
    const [sha, date, ...subj] = head.split("|");
    if (!sha) continue;
    rows.push({ sha, date, subject: subj.join("|"), stat: rest.join("\n").trim() });
  }
  return rows;
}

const stripText = (a) => { const { text, ...rest } = a; return rest; };
const uid = (s) => `u-${sha1(s).slice(0, 8)}`;

/** What the throttle held back on the last compile, so `bb compile` can say so
 *  instead of silently shrinking the plan. */
let lastDeferred = [];
export const deferred = () => lastDeferred;

/** The detectors a board-level limit silenced, and how many open rows each is
 *  holding. Printed rather than dropped: a finding that stops being promoted
 *  must still be countable, or the board shrinks by forgetting. */
let lastSuppressed = {};
export const suppressed = () => lastSuppressed;

/** Cooldown history, widened with each detector's open row count. The two are
 *  merged here because `throttle.apply` reads one map. */
function openHistory(findings) {
  const open = throttle.openCounts(findings || []);
  const out = {};
  for (const [det, n] of Object.entries(open)) out[det] = { cooldown: 0, open: n };
  const cool = throttle.cooldowns();
  for (const [det, v] of Object.entries(cool)) out[det] = { ...(out[det] || { open: 0 }), ...v };
  return out;
}

/** Group, triage, throttle, pack, split. Returns units ready for the router. */
export async function compileUnits(findings, { maxUnits = 0 } = {}) {
  const cfg = load();
  const triage = await triageFn();

  // Triage first: a finding the rule engine declines never becomes a unit, and
  // a finding an actuator can close becomes a zero-token unit.
  const decisions = [];
  for (const f of findings || []) {
    if (f.status && f.status !== "open") continue;
    let d;
    try { d = triage(f, cfg) || {}; } catch { d = {}; }
    decisions.push({ id: f.id, detector: f.detector, promote: !!d.promote, priority: d.priority, ev: d.ev, est_tokens: f.est_tokens, auto_fix: f.auto_fix || "", _f: f, _t: d });
  }
  // The throttle sees the whole run: how many promotions, whose, and at what
  // estimated cost. A deferred finding is not declined, it is next in line.
  //
  // It also sees the BOARD, which is the part it was missing. A per-run limit
  // cannot tell four rows a run from four hundred rows over a hundred runs, and
  // the second is a rule producing work nobody closes. The open counts come off
  // the findings in hand, so the number the limit reads is the number
  // `bb findings` prints.
  const gate = throttle.apply(decisions, cfg, openHistory(findings));
  const triaged = gate.promoted.map((d) => ({ ...d._f, _t: d._t }));
  lastDeferred = gate.deferred.map((d) => ({ id: d.id, detector: d.detector, reason: d.throttle_reason }));
  lastSuppressed = gate.suppressed || {};

  const groups = new Map();
  for (const f of triaged) {
    const k = `${topDirOf(f.path || (f.files || [])[0])}\0${f.detector}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const units = [];
  const priorCache = new Map();
  for (const key of [...groups.keys()].sort()) {
    const [topDir, detector] = key.split("\0");
    const members = groups.get(key).sort((a, b) => (a._t.priority ?? 5) - (b._t.priority ?? 5) || String(a.id).localeCompare(String(b.id)));
    const scope = [...new Set(members.flatMap((f) => (f.files && f.files.length ? f.files : [f.path]).filter(Boolean)))].sort();
    const actuator = members.find((f) => f.auto_fix)?.auto_fix || null;
    const models = members.map((f) => f._t.model).filter(Boolean);
    const model = models.find((m) => /opus/i.test(m)) || models[0] || cfg.lanes?.model || "";
    const kind = members[0]._t.kind || members[0].kind || "fix";
    const priority = Math.min(...members.map((f) => f._t.priority ?? 5));
    const ev = members.reduce((s, f) => s + (Number(f._t.ev) || 0), 0);
    const ids = members.map((f) => f.id);
    const title = `${detector}: ${topDir === "." ? "root" : topDir} (${members.length} finding${members.length > 1 ? "s" : ""})`;

    // Acceptance is a command. A finding may carry its own; otherwise the quick
    // gate plus a re-scan of this detector. `verify`/`investigate`/`write` units
    // have nothing a re-scan can prove, so they get the gate alone or nothing.
    let acceptance = members.find((f) => f.acceptance)?.acceptance || "";
    // The gate of the directory this unit touches, not the root's: a workspace
    // of projects has one gate per project and none at the top.
    const gates = detectGates(ROOT, topDir);
    // Acceptance runs at the LANE's cwd, which is the workspace root. A gate
    // declared for a sub-directory has to be taken there, in a subshell so the
    // re-scan that follows it still runs at the root.
    const quick = gates.quick && gates.scope !== "." ? `(cd ${JSON.stringify(gates.scope)} && ${gates.quick})` : gates.quick;
    if (!acceptance) acceptance = [quick, kind === "fix" ? recheck(detector, ids) : ""].filter(Boolean).join(" && ");
    const unproven = !acceptance;

    const anchors = anc.forFindings(members);
    const repo = repoOf(scope[0] || ".");
    if (!priorCache.has(`${repo}\0${detector}`)) priorCache.set(`${repo}\0${detector}`, priorArt(detector, abs(repo)));
    const prior = priorCache.get(`${repo}\0${detector}`);
    const deliverable = members.find((f) => f.deliverable)?.deliverable || "";
    const extra = deliverable ? `## What this unit must produce\n${deliverable}\n` : "";

    const base = { kind, rule: detector, detector, title, finding_ids: ids, top_dir: topDir, repo, model, actuator, priority, ev,
      acceptance, unproven, prior: prior ? prior.map(({ stat, ...r }) => r) : null,
      status: actuator ? "local" : "ready" };

    const text = brief.build({ title, findings: members, scope, acceptance, extra, anchors, prior });
    const ctx = context.evaluate(scope, { brief: text, anchors, kind });
    if (ctx.verdict !== "SPLIT" || !ctx.split?.length) {
      units.push({ ...base, id: uid(title + ids.join("")), scope, anchors: anchors.map(stripText), brief: text,
        est_tokens: ctx.projected, projected: ctx.projected, verdict: ctx.verdict, context: ctx });
      continue;
    }
    // SPLIT: the same evidence, a different slice of the scope each time.
    const n = ctx.split.length;
    ctx.split.forEach((part, i) => {
      const inPart = new Set(part);
      const subTitle = `${title} [${i + 1}/${n}]`;
      const subMembers = members.filter((f) => !(f.files || []).length || f.files.some((p) => inPart.has(p)) || inPart.has(f.path));
      const subAnchors = anchors.filter((a) => inPart.has(a.path));
      const subExtra = `${extra}This is part ${i + 1} of ${n}. The other parts cover the rest of the same findings; do not touch their files.\n`;
      const subText = brief.build({ title: subTitle, findings: subMembers.length ? subMembers : members, scope: part, acceptance, extra: subExtra, anchors: subAnchors, prior });
      const subCtx = context.evaluate(part, { brief: subText, anchors: subAnchors, kind });
      units.push({ ...base, title: subTitle, id: uid(subTitle + ids.join("")), scope: part, anchors: subAnchors.map(stripText),
        finding_ids: (subMembers.length ? subMembers : members).map((f) => f.id), brief: subText,
        est_tokens: subCtx.projected, projected: subCtx.projected, verdict: subCtx.verdict, context: subCtx, part: [i + 1, n] });
    });
  }

  // Priority first: it is an ORDERING constraint, not a preference. Within a
  // priority, expected value: a cheap exact fix outranks an expensive heuristic
  // one, which "biggest first" had exactly backwards.
  units.sort((a, b) => a.priority - b.priority || b.ev - a.ev || b.est_tokens - a.est_tokens);
  return maxUnits ? units.slice(0, maxUnits) : units;
}

/** The repo a path belongs to: the nearest ancestor with its own `.git`, as a
 *  rel path, else "." (the root, whether or not it is a repo). A lane is never
 *  split across repos because a session with two checkouts open cd's into the
 *  wrong one. */
export function repoOf(relPath) {
  let d = path.posix.dirname(String(relPath).replace(/\\/g, "/"));
  while (d && d !== ".") {
    if (fs.existsSync(path.join(ROOT, d, ".git"))) return d;
    d = path.posix.dirname(d);
  }
  return ".";
}

export function summary(units) {
  const back = lastDeferred.length ? `\n  ${lastDeferred.length} finding(s) deferred by the throttle: ${lastDeferred[0].reason}` : "";
  if (!units.length) return "  no work units — nothing promoted" + back;
  const p = (s, w, r) => (r ? String(s).padStart(w) : String(s).padEnd(w));
  const lines = [`  ${p("unit", 11)} ${p("model", 8)} ${p("ctx", 7, 1)} ${p("files", 5, 1)} ${p("saved", 7, 1)} ${p("ev", 5, 1)}  title`];
  let savedTotal = 0;
  for (const u of units) {
    const saved = u.context?.payload_saved || 0;
    savedTotal += saved;
    lines.push(`  ${p(u.id, 11)} ${p(u.model || "-", 8)} ${p(human(u.est_tokens), 7, 1)} ${p(u.scope.length, 5, 1)} ${p(saved ? human(saved) : "-", 7, 1)} ${p((u.ev || 0).toFixed(1), 5, 1)}  ${u.title}`
      + (u.actuator ? "  [actuator]" : "") + (u.unproven ? "  [unproven]" : "") + (u.verdict !== "FITS" ? `  [${u.verdict}]` : ""));
  }
  const total = units.reduce((s, u) => s + u.est_tokens, 0);
  lines.push(`  ${"-".repeat(66)}`);
  lines.push(`  ${units.length} units, ${human(total)} projected context total (ESTIMATE)`
    + (savedTotal ? `, ${human(savedTotal)} of payload skipped by anchoring` : ""));
  if (back) lines.push(back.slice(1));
  return lines.join("\n");
}
