// tokens.js — the substitution tokens a scenario is written in, and the dotted
// paths its expectations read. The JS half of `kernel/src/subst.rs`;
// test/cookbook.test.js pins the two to the same answers, because which
// runtime happens to be installed must not change what a board says.
//
// Two properties carry the weight:
//   - a string that is EXACTLY one token keeps that value's TYPE, so a byte
//     count compares against a number and not against "4096";
//   - an unresolved token is an ERROR, never a literal. A typo would otherwise
//     be compared as the text `{{tenatn}}`, which is a red step about nothing.

const pad = (n, w = 2) => String(n).padStart(w, "0");

export const fmtDate = (secs) => new Date(Math.floor(secs) * 1000).toISOString().slice(0, 10);
export const fmtIso = (secs) => new Date(Math.floor(secs) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
export const stampOf = (secs) => fmtIso(secs).replace(/[-:]/g, "");

const UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
/** "+90m", "-3d". The unit is mandatory: "+90" is unresolved rather than silently seconds. */
export function offset(spec) {
  const m = /^([+-])(\d+(?:\.\d+)?)([smhdw])$/.exec(spec || "");
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * UNITS[m[3]];
}

export function randHex(n = 8) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return s.slice(0, n);
}

/** One token's value, or undefined when nothing in scope defines it. */
export function token(name, clock, vars) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  const tz = (clock.tz_offset_minutes || 0) * 60;
  switch (name) {
    case "now": return fmtIso(clock.now);
    case "today": return fmtDate(clock.now);
    case "localdate": return fmtDate(clock.now + tz);
    case "tzoffset": return Number(clock.tz_offset_minutes || 0);
    case "timezone": return clock.timezone || "UTC";
    case "run": return clock.run;
    case "epoch": return Math.floor(clock.now);
    case "rand": return randHex(8);
  }
  if (name.startsWith("rand:")) { const n = Number(name.slice(5)); return Number.isFinite(n) ? randHex(Math.min(n, 64)) : undefined; }
  if (name.startsWith("now")) { const d = offset(name.slice(3)); return d == null ? undefined : fmtIso(clock.now + d); }
  if (name.startsWith("localdate")) { const d = offset(name.slice(9)); return d == null ? undefined : fmtDate(clock.now + tz + d); }
  if (name.startsWith("localday")) {
    // Local midnight plus the offset, expressed in UTC, clamped FORWARD by whole
    // days. The clamp is unconditional: anything conditional on the hour is a
    // bug that is green for most of the day.
    const d = offset(name.slice(8));
    if (d == null) return undefined;
    let t = Math.floor((clock.now + tz) / 86400) * 86400 + d - tz;
    while (t <= clock.now) t += 86400;
    return fmtIso(t);
  }
  if (name.startsWith("+") || name.startsWith("-")) { const d = offset(name); return d == null ? undefined : fmtDate(clock.now + d); }
  return undefined;
}

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function substString(s, clock, vars, missing) {
  const all = [...String(s).matchAll(TOKEN)];
  if (!all.length) return s;
  if (all.length === 1 && all[0].index === 0 && all[0][0].length === s.length) {
    const v = token(all[0][1], clock, vars);
    if (v === undefined) { missing.push(all[0][1]); return s; }
    return v;
  }
  return String(s).replace(TOKEN, (_, name) => {
    const v = token(name, clock, vars);
    if (v === undefined) { missing.push(name); return `{{${name}}}`; }
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

export function subst(v, clock, vars, missing) {
  if (typeof v === "string") return substString(v, clock, vars, missing);
  if (Array.isArray(v)) return v.map((x) => subst(x, clock, vars, missing));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[String(substString(k, clock, vars, missing))] = subst(val, clock, vars, missing);
    return o;
  }
  return v;
}

/** `event.version`, `briefs.0.brief_date`. A bare array body arrives wrapped as `_list`. */
export function at(v, path) {
  if (!path) return v;
  let cur = v;
  for (const seg of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) { const i = Number(seg); if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined; cur = cur[i]; continue; }
    if (typeof cur !== "object" || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export const lenOf = (v) => (Array.isArray(v) ? v.length : typeof v === "string" ? [...v].length : v && typeof v === "object" ? Object.keys(v).length : null);
export const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "list" : typeof v === "boolean" ? "bool" : typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : typeof v === "string" ? "str" : "dict");
export const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));
export const clockOf = ({ timezone = "UTC", tz_offset_minutes = 0, run = "", now = Date.now() / 1000 } = {}) =>
  ({ now, timezone, tz_offset_minutes, run: run || stampOf(now) });
