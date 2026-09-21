// spec.js — what a gear IS, as data, and the gate language in front of a stage.
//
// A gear is a declared pipeline: an ordered list of verbs this factory already
// has, each with a gate. Declared, the order is a file the runner executes in
// one process with no model attached; every stage skipped because nothing
// changed is a turn nobody paid for.
//
//   stage.verb           a verb in the cli table; `args` are its positionals
//                        (sub-verb first), `flags` its flags.
//   stage.when           a gate over the run context, see `holds()`.
//   stage.skip_if_fresh  skip when the fingerprint of `inputs()` matches the
//                        last run's. A stage that reads nothing new produces
//                        nothing new.
//   stage.inputs()       the files that fingerprint decides on. A function, not
//                        a list: walking the tree at declaration time would cost
//                        every `bb pipeline list` a walk it does not use.
//   stage.optional       the model may skip it when p_useful is low. A stage
//                        that is not optional runs whatever the model thinks,
//                        which keeps a bad fit from disabling the pipeline.
//   gear.chain           gears to run after this one, in the same process.
//   gear.on              triggers (data only: cron, post-scan, hand).
//
// ## The gate language
//
//   expr := or ; or := and ("or" and)* ; and := not ("and" not)*
//   not  := "not" not | "!" atom | atom
//   atom := "(" or ")" | key op value | key
//   op   := >= <= == != > <
//
// Precedence: `not` binds tightest, then `and`, then `or`; parentheses
// override. Three-valued: a key the context does not have (undefined or null)
// makes its comparison NULL, `null and false` is false, `null or true` is true,
// everything else with a null in it is null. The runner RUNS a stage whose
// gate is null: a gate that cannot be evaluated is not a reason to skip, and a
// silent skip on a broken store is the failure mode this replaces.
import fs from "node:fs";
import path from "node:path";
import { BB_DIR, abs } from "../core/paths.js";
import { readJson } from "../core/config.js";
import { walk } from "../core/fs.js";

const TOKEN = /\s*(?:(>=|<=|==|!=|>|<)|(\(|\)|!)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+(?:\.\d+)?)(?![\w.])|([A-Za-z_][\w.]*))/y;

export function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(i))) break;
      throw new Error(`bad token at ${i}: ${src.slice(i, i + 12)}`);
    }
    i = TOKEN.lastIndex;
    if (m[1]) out.push({ t: "op", v: m[1] });
    else if (m[2]) out.push({ t: m[2] });
    else if (m[3]) out.push({ t: "str", v: m[3].slice(1, -1) });
    else if (m[4]) out.push({ t: "num", v: Number(m[4]) });
    else if (m[5]) {
      const w = m[5].toLowerCase();
      if (w === "and" || w === "or" || w === "not") out.push({ t: w });
      else if (w === "true" || w === "false") out.push({ t: "bool", v: w === "true" });
      else if (w === "null" || w === "none") out.push({ t: "null" });
      else out.push({ t: "key", v: m[5] });
    }
  }
  return out;
}

const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);
const not3 = (a) => (a === null ? null : !a);

function lookup(ctx, key) {
  let cur = ctx;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function compare(op, a, b) {
  if (a === undefined || a === null) return null;
  if (typeof b === "number") {
    const x = Number(a);
    if (!Number.isFinite(x)) return null;
    a = x;
  } else if (typeof b === "boolean") a = Boolean(a);
  else if (b === null) return null;
  else a = String(a);
  switch (op) {
    case ">=": return a >= b; case "<=": return a <= b; case ">": return a > b; case "<": return a < b;
    case "==": return a === b; case "!=": return a !== b;
    default: return null;
  }
}

/** `{value: true|false|null, unknown: [keys the context lacked]}`. */
export function evaluate(expr, ctx = {}) {
  const src = expr == null ? "" : String(expr);
  if (!src.trim()) return { value: true, unknown: [] };
  const unknown = [];
  let toks;
  try { toks = tokenize(src); } catch (e) { return { value: null, unknown: [], error: e.message }; }
  let i = 0;
  const peek = () => toks[i];
  const take = (t) => { const k = toks[i]; if (!k || k.t !== t) throw new Error(`expected ${t} at token ${i}`); i += 1; return k; };
  const literal = () => {
    const k = toks[i];
    if (!k) throw new Error("value expected");
    i += 1;
    if (k.t === "num" || k.t === "str" || k.t === "bool") return k.v;
    if (k.t === "null") return null;
    if (k.t === "key") return k.v; // a bare word on the right is a string
    throw new Error(`bad value ${k.t}`);
  };
  const atom = () => {
    const k = peek();
    if (!k) throw new Error("unexpected end");
    if (k.t === "(") { i += 1; const v = orExpr(); take(")"); return v; }
    if (k.t === "!") { i += 1; return not3(atom()); }
    if (k.t === "key") {
      i += 1;
      const v = lookup(ctx, k.v);
      const nxt = peek();
      if (nxt && nxt.t === "op") {
        i += 1;
        if (v === undefined || v === null) unknown.push(k.v);
        return compare(nxt.v, v, literal());
      }
      if (v === undefined || v === null) { unknown.push(k.v); return null; }
      return Boolean(v);
    }
    if (k.t === "bool") { i += 1; return k.v; }
    if (k.t === "num") { i += 1; return k.v !== 0; }
    throw new Error(`unexpected ${k.t}`);
  };
  const notExpr = () => { if (peek() && peek().t === "not") { i += 1; return not3(notExpr()); } return atom(); };
  const andExpr = () => { let v = notExpr(); while (peek() && peek().t === "and") { i += 1; v = and3(v, notExpr()); } return v; };
  const orExpr = () => { let v = andExpr(); while (peek() && peek().t === "or") { i += 1; v = or3(v, andExpr()); } return v; };
  try {
    const value = orExpr();
    if (i !== toks.length) throw new Error(`trailing tokens at ${i}`);
    return { value, unknown };
  } catch (e) { return { value: null, unknown, error: e.message }; }
}

/** true | false | null. Empty gate is true. */
export const holds = (expr, ctx) => evaluate(expr, ctx).value;

// ── gears ────────────────────────────────────────────────────────────────────

export const verbKey = (s) => [s.verb, ...(s.args || [])].join(" ");

export function stage(d) {
  if (!d || !d.verb) throw new Error("stage needs a verb");
  const args = Array.isArray(d.args) ? d.args.map(String) : [];
  return {
    name: d.name || [d.verb, ...args].join(" "),
    verb: String(d.verb), args, flags: d.flags && typeof d.flags === "object" ? { ...d.flags } : {},
    when: d.when ? String(d.when) : "",
    skip_if_fresh: !!d.skip_if_fresh,
    inputs: typeof d.inputs === "function" ? d.inputs : Array.isArray(d.inputs) ? pathsFn(d.inputs) : null,
    optional: !!d.optional,
    spends: !!d.spends,
    description: d.description || "",
  };
}

/** The three keys that ARE the permission for a stage declared `spends: true`.
 *
 *  Every built-in gear is free, and the rule at the top of gears.js is that a
 *  tick cannot do anything it would need permission for. `spends` does not
 *  weaken that rule, it names where the permission is kept: the bridge switched
 *  on, a ceiling on what the bridge may spend in a day, and a ceiling on what
 *  the lanes it opens may spend in a day. Absent any one of them the stage is
 *  refused and the missing key is named, because a tick that silently did
 *  nothing is indistinguishable from a tick that silently spent. */
export function spendKeys(cfg) {
  const missing = [];
  if (!cfg?.bridge?.enabled) missing.push("bridge.enabled");
  if (!(Number(cfg?.bridge?.daily_budget_usd) > 0)) missing.push("bridge.daily_budget_usd > 0");
  if (!(Number(cfg?.lanes?.daily_budget_usd) > 0)) missing.push("lanes.daily_budget_usd > 0");
  return { ok: missing.length === 0, missing };
}

/** A JSON gear cannot carry a function, so its `inputs` is a list of paths
 *  (files or directories); a directory is walked with the workspace ignores. */
function pathsFn(paths) {
  return () => {
    const out = [];
    for (const p of paths) {
      const a = abs(String(p));
      let st;
      try { st = fs.statSync(a); } catch { continue; }
      if (st.isDirectory()) out.push(...walk(a, { suffixes: [] }));
      else out.push(a);
    }
    return out;
  };
}

export function gear(d) {
  if (!d || !d.name) throw new Error("gear needs a name");
  const stages = (d.stages || []).map(stage);
  return {
    name: String(d.name), description: d.description || "",
    stages,
    // Declared on the gear, or inherited from any stage that declares it: what
    // `bb pipeline list` has to show is whether running this gear can cost
    // money, and a gear whose fourth stage spends is a gear that spends.
    spends: !!d.spends || stages.some((s) => s.spends),
    on: Array.isArray(d.on) ? d.on.map(String) : [],
    chain: (d.chain || []).map((c) => (typeof c === "string" ? { gear: c, when: "" } : { gear: String(c.gear), when: c.when || "" })),
  };
}

export const userFile = () => path.join(BB_DIR, "gears.json");

/** Built-ins, then `.bundlebox/gears.json` on top. A user gear with a built-in's
 *  name REPLACES it whole: a half-overridden pipeline is one nobody can read
 *  off either source. A gear that fails to parse is a warning, not a crash of
 *  the rest. */
export async function load() {
  const { GEARS } = await import("./gears.js");
  const gears = {};
  const warnings = [];
  for (const g of GEARS) gears[g.name] = g;
  const raw = readJson(userFile(), null);
  if (raw && typeof raw === "object") {
    const map = raw.gears && typeof raw.gears === "object" ? raw.gears : raw;
    for (const [name, d] of Object.entries(map)) {
      if (!d || typeof d !== "object") continue;
      try { gears[name] = gear({ ...d, name }); } catch (e) { warnings.push(`gears.json ${name}: ${e.message}`); }
    }
  } else if (fs.existsSync(userFile())) warnings.push("gears.json unreadable; built-ins only");
  return { gears, warnings };
}

/** Declared consecutive edges, so the graph has something to disagree with. */
export function declaredEdges(gears) {
  const out = [];
  for (const g of Object.values(gears)) {
    const keys = g.stages.map(verbKey);
    for (let i = 1; i < keys.length; i++) out.push({ gear: g.name, from: keys[i - 1], to: keys[i] });
  }
  return out;
}
