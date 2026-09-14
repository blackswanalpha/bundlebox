// check.js — the gate. Every rule here is a parse, a count, a set difference or
// a ratio over the DECLARED system, so the whole pass costs milliseconds and no
// tokens. What a browser alone can answer (does this state actually render
// differently) is reported `unknown`, never `pass`: a gate that greens what it
// did not look at is worse than no gate. Each verdict cites the doctrine card
// that set the rule, so a failure can be argued with rather than obeyed.
import fs from "node:fs";
import path from "node:path";
import { readText } from "../core/fs.js";
import { byRule } from "./library.js";

export const VERDICT = { pass: "PASS", fail: "FAIL", unknown: "UNKNOWN", review: "REVIEW", skip: "SKIP" };

// ── WCAG relative luminance ────────────────────────────────────────────────
export function rgb(hex) {
  const h = String(hex || "").trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
export function luminance(hex) {
  const c = rgb(hex);
  if (!c) return null;
  const lin = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
/** WCAG 2.2 contrast ratio, or null when either colour is not a literal. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
const FLOOR = { text: 4.5, large: 3, ui: 3 };

const ms = (v) => { const m = /^(-?\d+(?:\.\d+)?)\s*(ms|s)$/.exec(String(v || "").trim()); return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : null; };
const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)\s*px$/.exec(String(v || "").trim()); return m ? Number(m[1]) : (typeof v === "number" ? v : null); };

// ── loading a studio ───────────────────────────────────────────────────────
/** {dir, system, screens:[], errors:[]} — never throws; a bad file is an error row. */
export function loadStudio(dir) {
  const errors = [];
  const readJson = (p) => { try { return JSON.parse(readText(p, "")); } catch (e) { errors.push(`${path.basename(p)}: ${e.message}`); return null; } };
  const system = fs.existsSync(path.join(dir, "system.json")) ? readJson(path.join(dir, "system.json")) : null;
  if (!system) errors.push("system.json: missing — `bb designlabs init` writes one");
  const sdir = path.join(dir, "screens");
  let screens = [];
  if (fs.existsSync(sdir)) {
    // index.json is the studio's load order, not a screen. Reading it as one is
    // how the gate came to report a screen called `undefined`.
    screens = fs.readdirSync(sdir).filter((n) => n.endsWith(".json") && n !== "index.json").sort()
      .map((n) => {
        const s = readJson(path.join(sdir, n));
        if (!s || typeof s !== "object" || Array.isArray(s)) { errors.push(`screens/${n}: not a screen object`); return null; }
        s._file = path.join("screens", n);
        s.id ||= n.replace(/\.json$/, "");
        return s;
      })
      .filter(Boolean);
  } else errors.push("screens/: missing — a system with no screens proves nothing");
  return { dir, system, screens, errors };
}

const R = (rule, verdict, summary, rows = []) => ({ rule, verdict, summary, rows, card: byRule()[rule]?.id || null, severity: byRule()[rule]?.severity || "low" });

// ── the rules ──────────────────────────────────────────────────────────────
function accessFloor(st, cfg) {
  const tokens = st.system?.color?.tokens || {};
  const pairs = st.system?.color?.pairs || [];
  if (!pairs.length) return R("access.floor", VERDICT.unknown, "no colour pairs declared; nothing to measure");
  const rows = [];
  for (const p of pairs) {
    const fg = tokens[p.fg] ?? p.fg, bg = tokens[p.bg] ?? p.bg;
    const over = p.over || null;               // "image" | "gradient" | null
    const need = FLOOR[p.size === "large" ? "large" : p.size === "ui" ? "ui" : "text"];
    if (over) { rows.push({ ok: null, text: `${p.use}: over a ${over} — a static ratio cannot be computed`, need }); continue; }
    const c = contrast(fg, bg);
    if (c == null) { rows.push({ ok: null, text: `${p.use}: ${p.fg}/${p.bg} is not a literal colour`, need }); continue; }
    rows.push({ ok: c >= need, text: `${p.use}: ${fg} on ${bg} = ${c.toFixed(2)}:1 (needs ${need}:1)`, ratio: c, need });
  }
  const bad = rows.filter((r) => r.ok === false), unk = rows.filter((r) => r.ok === null);
  if (bad.length) return R("access.floor", VERDICT.fail, `${bad.length} of ${rows.length} pairs below the WCAG floor`, rows);
  if (unk.length) return R("access.floor", VERDICT.unknown, `${rows.length - unk.length} pairs pass; ${unk.length} could not be measured`, rows);
  return R("access.floor", VERDICT.pass, `${rows.length} pairs at or above the WCAG floor`, rows);
}

function motionDuration(st, cfg) {
  const scale = st.system?.motion || {};
  const rows = [];
  for (const [k, v] of Object.entries(scale)) {
    const n = ms(v);
    if (n == null) continue;
    rows.push({ ok: n <= cfg.max_motion_ms, text: `${k}: ${v}`, ms: n });
  }
  if (!rows.length) return R("motion.duration", VERDICT.unknown, "no motion scale declared");
  const bad = rows.filter((r) => !r.ok);
  return bad.length
    ? R("motion.duration", VERDICT.fail, `${bad.length} duration${bad.length === 1 ? "" : "s"} over the ${cfg.max_motion_ms}ms threshold`, rows)
    : R("motion.duration", VERDICT.pass, `${rows.length} durations, all under ${cfg.max_motion_ms}ms`, rows);
}

function targetSize(st, cfg) {
  const t = st.system?.targets || {};
  const rows = Object.entries(t).map(([k, v]) => {
    const n = px(v);
    return { ok: n == null ? null : n >= cfg.min_target_px, text: `${k}: ${n == null ? v : n + "px"}`, px: n };
  });
  if (!rows.length) return R("target.min-size", VERDICT.unknown, "no interactive target sizes declared");
  const bad = rows.filter((r) => r.ok === false);
  return bad.length
    ? R("target.min-size", VERDICT.fail, `${bad.length} target${bad.length === 1 ? "" : "s"} under ${cfg.min_target_px}px`, rows)
    : R("target.min-size", VERDICT.pass, `${rows.length} targets at or above ${cfg.min_target_px}px`, rows);
}

function stateCoverage(st, cfg) {
  const need = cfg.required_states;
  const rows = [];
  for (const s of st.screens) {
    const have = Object.keys(s.states || {});
    const waived = Object.keys(s.impossible || {});
    const missing = need.filter((n) => !have.includes(n) && !waived.includes(n));
    rows.push({ ok: missing.length === 0, text: missing.length ? `${s.id}: missing ${missing.join(", ")}` : `${s.id}: ${have.length} states${waived.length ? ` (+${waived.length} declared impossible)` : ""}`, missing });
  }
  if (!rows.length) return R("state.coverage", VERDICT.unknown, "no screens to check");
  const bad = rows.filter((r) => !r.ok);
  return bad.length
    ? R("state.coverage", VERDICT.fail, `${bad.length} of ${rows.length} screens have not drawn all six states`, rows)
    : R("state.coverage", VERDICT.pass, `${rows.length} screens draw every required state`, rows);
}

function choiceCount(st) {
  const rows = st.screens.map((s) => {
    const sec = s.secondary || [];
    const problems = [];
    if (Array.isArray(s.primary) && s.primary.length > 1) problems.push(`${s.primary.length} primaries`);
    if (!s.primary) problems.push("no primary declared");
    if (sec.length > 5) problems.push(`${sec.length} secondary choices`);
    if (s.primary && sec.includes(Array.isArray(s.primary) ? s.primary[0] : s.primary)) problems.push("primary repeated in secondary");
    return { ok: problems.length === 0, text: problems.length ? `${s.id}: ${problems.join("; ")}` : `${s.id}: 1 primary, ${sec.length} secondary` };
  });
  if (!rows.length) return R("choice.count", VERDICT.unknown, "no screens to check");
  const bad = rows.filter((r) => !r.ok);
  return bad.length ? R("choice.count", VERDICT.fail, `${bad.length} screens do not rank their actions`, rows)
    : R("choice.count", VERDICT.pass, `${rows.length} screens name one primary action`, rows);
}

function flowEnding(st) {
  const withFlow = st.screens.filter((s) => Array.isArray(s.flow) && s.flow.length);
  if (!withFlow.length) return R("flow.ending", VERDICT.unknown, "no flows declared");
  const rows = withFlow.map((s) => {
    const term = s.flow.some((n) => n.terminal), fail = s.flow.some((n) => n.failure);
    const miss = [!term && "no terminal node", !fail && "no failure ending"].filter(Boolean);
    return { ok: miss.length === 0, text: miss.length ? `${s.id}: ${miss.join(", ")}` : `${s.id}: ${s.flow.length} nodes, terminal and failure both declared` };
  });
  const bad = rows.filter((r) => !r.ok);
  return bad.length ? R("flow.ending", VERDICT.fail, `${bad.length} flows end nowhere in particular`, rows)
    : R("flow.ending", VERDICT.pass, `${rows.length} flows declare both endings`, rows);
}

function complexityOwner(st) {
  const rows = st.screens.map((s) => {
    const a = s.audit || {};
    const ok = Boolean(String(a.absorbs || "").trim()) && Boolean(String(a.transfers || "").trim());
    return { ok, text: ok ? `${s.id}: absorbs "${String(a.absorbs).slice(0, 48)}"` : `${s.id}: audit names neither what it absorbs nor what it transfers` };
  });
  if (!rows.length) return R("complexity.owner", VERDICT.unknown, "no screens to check");
  const bad = rows.filter((r) => !r.ok);
  return bad.length ? R("complexity.owner", VERDICT.fail, `${bad.length} screens claim simplicity without saying who pays`, rows)
    : R("complexity.owner", VERDICT.pass, `${rows.length} screens name both sides of their complexity`, rows);
}

function groupBySpace(st) {
  const rows = [];
  for (const s of st.screens) for (const g of s.groups || []) {
    const inner = px(g.inner), outer = px(g.outer);
    if (inner == null || outer == null) { rows.push({ ok: null, text: `${s.id}/${g.name}: gaps not declared in px` }); continue; }
    rows.push({ ok: inner < outer, text: `${s.id}/${g.name}: inner ${inner}px, outer ${outer}px`, ratio: outer / inner });
  }
  if (!rows.length) return R("group.by-space", VERDICT.unknown, "no groups declare an inner and outer gap");
  const bad = rows.filter((r) => r.ok === false);
  return bad.length ? R("group.by-space", VERDICT.fail, `${bad.length} groups where the outer gap does not exceed the inner one`, rows)
    : R("group.by-space", VERDICT.pass, `${rows.length} groups group by whitespace`, rows);
}

function accentScarcity(st) {
  const rows = st.screens.map((s) => {
    const n = typeof s.accents === "number" ? s.accents : null;
    return { ok: n == null ? null : n <= 1, text: n == null ? `${s.id}: accent count not declared` : `${s.id}: ${n} accented element${n === 1 ? "" : "s"}` };
  });
  const bad = rows.filter((r) => r.ok === false), unk = rows.filter((r) => r.ok === null);
  if (bad.length) return R("accent.scarcity", VERDICT.fail, `${bad.length} screens spend the accent more than once`, rows);
  if (unk.length === rows.length) return R("accent.scarcity", VERDICT.unknown, "no screen declares its accent count", rows);
  return R("accent.scarcity", VERDICT.pass, `${rows.length - unk.length} screens spend the accent once`, rows);
}

function chromeBudget(st) {
  const rows = [];
  for (const s of st.screens) {
    const a = s.audit || {};
    if (typeof a.budget !== "number") { rows.push({ ok: null, text: `${s.id}: no element budget declared` }); continue; }
    const n = typeof a.elements === "number" ? a.elements : null;
    rows.push({ ok: n == null ? null : n <= a.budget, text: `${s.id}: ${n ?? "?"} elements against a budget of ${a.budget}` });
  }
  const bad = rows.filter((r) => r.ok === false), unk = rows.filter((r) => r.ok === null);
  if (bad.length) return R("chrome.budget", VERDICT.fail, `${bad.length} screens over their own element budget`, rows);
  if (unk.length === rows.length) return R("chrome.budget", VERDICT.unknown, "no screen declares an element budget", rows);
  return R("chrome.budget", VERDICT.pass, `${rows.length - unk.length} screens inside their budget`, rows);
}

const ACTION_VERB = /\b(retry|try again|reconnect|sign in|check|refresh|reload|contact|undo|go back|choose|add|remove|open|enable|allow|update)\b/i;
function errorRecoverable(st) {
  const rows = [];
  for (const s of st.screens) {
    for (const d of s.destructive || []) {
      const ok = Boolean(d.undo) || Boolean(d.confirm);
      rows.push({ ok, text: ok ? `${s.id}/${d.action}: ${d.undo ? "undoable" : "confirmed"}` : `${s.id}/${d.action}: irreversible with neither undo nor confirmation` });
    }
    const err = (s.states || {}).error;
    if (err) {
      const copy = String(err.copy || err.note || "");
      rows.push({ ok: ACTION_VERB.test(copy), text: copy ? `${s.id}/error: "${copy.slice(0, 64)}"` : `${s.id}/error: no copy declared` });
    }
  }
  if (!rows.length) return R("error.recoverable", VERDICT.unknown, "no destructive actions or error copy declared");
  const bad = rows.filter((r) => !r.ok);
  return bad.length ? R("error.recoverable", VERDICT.fail, `${bad.length} paths leave the user with no next action`, rows)
    : R("error.recoverable", VERDICT.pass, `${rows.length} paths are recoverable and say so`, rows);
}

function groupSize(st) {
  const rows = [];
  for (const s of st.screens) for (const g of s.groups || []) {
    if (typeof g.items !== "number") continue;
    rows.push({ ok: g.items <= 7, text: `${s.id}/${g.name}: ${g.items} siblings` });
  }
  if (!rows.length) return R("group.size", VERDICT.unknown, "no group declares its sibling count");
  const bad = rows.filter((r) => !r.ok);
  return bad.length ? R("group.size", VERDICT.fail, `${bad.length} ungrouped runs longer than seven`, rows)
    : R("group.size", VERDICT.pass, `${rows.length} groups inside the chunking limit`, rows);
}

function disclosureLayers(st) {
  const rows = st.screens.map((s) => {
    const depth = typeof s.disclosure_depth === "number" ? s.disclosure_depth : null;
    return { ok: depth == null ? null : depth <= 1, text: depth == null ? `${s.id}: disclosure depth not declared` : `${s.id}: secondary controls ${depth} action${depth === 1 ? "" : "s"} away` };
  });
  const bad = rows.filter((r) => r.ok === false), unk = rows.filter((r) => r.ok === null);
  if (bad.length) return R("disclosure.layers", VERDICT.fail, `${bad.length} screens bury a control more than one action deep`, rows);
  if (unk.length === rows.length) return R("disclosure.layers", VERDICT.unknown, "no screen declares its disclosure depth", rows);
  return R("disclosure.layers", VERDICT.pass, `${rows.length - unk.length} screens keep secondary controls one action away`, rows);
}

// Rules a static pass genuinely cannot settle. Named, so their absence from the
// PASS column is visible rather than quietly missing.
function browserOnly(st) {
  return [
    R("affordance.signified", VERDICT.unknown, "a parse cannot see a pixel: open selftest/states.html over http:// (it diffs 22 computed properties per state against rest), or put Reticle in front of the running app — `bb designlabs sources --kind tooling`"),
    R("convention.respect", VERDICT.review, `${st.screens.filter((s) => ["auth", "nav", "checkout"].includes(s.area)).length} screens on conventional surfaces; each needs a waiver sentence if it deviates`),
    R("memory.load", VERDICT.review, "flows carry values forward by hand; a reader must confirm nothing is recalled from a previous node"),
    R("order.edges", VERDICT.review, "ordering is reported, not enforced"),
    R("beauty.trap", VERDICT.review, "a redesign may not close a usability finding; check the audit claims are behavioural"),
  ];
}

/** Every rule over one studio. `generic` is the ui-generic row, injected by the
 *  caller because it needs a tree walk the rest of this module does not do. */
export function runRules(st, cfg, generic = null) {
  if (!st.system) return [R("system.declared", VERDICT.fail, "no system.json: nothing to check")];
  const rows = [
    accessFloor(st, cfg), stateCoverage(st, cfg), motionDuration(st, cfg), targetSize(st, cfg),
    accentScarcity(st), errorRecoverable(st), groupBySpace(st), choiceCount(st), flowEnding(st),
    complexityOwner(st), chromeBudget(st), groupSize(st), disclosureLayers(st),
  ];
  if (generic) rows.push(generic);
  rows.push(...browserOnly(st));
  return rows;
}

export const failed = (rows) => rows.filter((r) => r.verdict === VERDICT.fail);
export const tally = (rows) => rows.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
