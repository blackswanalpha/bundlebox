// expect.js — what a step asserts, evaluated. The JS half of the expectation
// vocabulary in `kernel/src/scenario.rs`; the two are pinned to identical
// answers by test/cookbook.test.js.
//
// `check` returns every expectation that did not hold, in the corpus's own
// words, plus the values it actually saw. The count of keys is returned
// separately because "nothing failed" and "nothing was asserted" are different
// states, and a runner that conflates them reports green for the worst reason.
import { at, lenOf, show, typeName } from "./tokens.js";

export const KEYS = ["status", "status_in", "max_ms", "json", "json_not", "json_in", "json_type",
  "json_present", "json_absent", "json_len_at_least", "json_len_at_most", "json_gte", "json_lte",
  "json_matches", "each", "contains", "not_both",
  "rc", "stdout_contains", "stderr_contains", "contains_text", "absent_text", "matches"];

const eq = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b));
const numOf = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const pairs = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o) : []);

/** How many expectation keys this block carries, and which are not implemented. */
export function asserts(expect) {
  const keys = Object.keys(expect || {});
  return { n: keys.filter((k) => KEYS.includes(k)).length, unknown: keys.filter((k) => !KEYS.includes(k)) };
}

export function check(expect, body, status, ms) {
  const why = [];
  const got = {};
  // `got` is evidence a person reads, not the response: a 900-row list under
  // one path would push the actual failure off the board.
  const note = (p, v) => { const t = show(v === undefined ? null : v); got[p] = t != null && t.length > 240 ? `${t.slice(0, 240)}… (${t.length} bytes)` : (v === undefined ? null : v); };
  const e = expect || {};

  if (typeof e.status === "number" && status !== e.status) why.push(`status ${status}, expected ${e.status}`);
  if (Array.isArray(e.status_in) && !e.status_in.includes(status)) why.push(`status ${status}, expected one of ${JSON.stringify(e.status_in)}`);
  if (typeof e.max_ms === "number" && ms > e.max_ms) why.push(`took ${Math.round(ms)}ms, budget ${e.max_ms}ms`);

  for (const [p, want] of pairs(e.json)) {
    const have = at(body, p); note(p, have);
    if (have === undefined) why.push(`${p} is absent, expected ${show(want)}`);
    else if (!eq(have, want)) why.push(`${p} = ${show(have)}, expected ${show(want)}`);
  }
  for (const [p, want] of pairs(e.json_not)) {
    const have = at(body, p); note(p, have);
    if (have !== undefined && eq(have, want)) why.push(`${p} = ${show(have)}, expected anything else`);
  }
  for (const [p, set] of pairs(e.json_in)) {
    const have = at(body, p); note(p, have);
    if (!Array.isArray(set) || !set.some((x) => eq(x, have))) why.push(`${p} = ${have === undefined ? "absent" : show(have)}, expected one of ${JSON.stringify(set)}`);
  }
  for (const [p, want] of pairs(e.json_type)) {
    const have = at(body, p); note(p, have);
    const t = have === undefined ? "absent" : typeName(have);
    const ok = t === want || ((want === "number" || want === "float") && typeof have === "number");
    if (!ok) why.push(`${p} is ${t}, expected ${want}`);
  }
  for (const p of Array.isArray(e.json_present) ? e.json_present : []) {
    const have = at(body, p); note(p, have);
    if (have === undefined || have === null) why.push(`${p} is absent or null`);
  }
  for (const p of Array.isArray(e.json_absent) ? e.json_absent : []) {
    const have = at(body, p); note(p, have);
    if (have !== undefined && have !== null) why.push(`${p} is present (${show(have)}), expected absent`);
  }
  for (const [p, want] of pairs(e.json_len_at_least)) {
    const have = at(body, p); note(p, have);
    const n = lenOf(have), w = numOf(want);
    if (n == null || w == null) why.push(`${p} has no length`);
    else if (n < w) why.push(`${p} has ${n} items, expected at least ${w}`);
  }
  for (const [p, want] of pairs(e.json_len_at_most)) {
    const have = at(body, p); note(p, have);
    const n = lenOf(have), w = numOf(want);
    if (n == null || w == null) why.push(`${p} has no length`);
    else if (n > w) why.push(`${p} has ${n} items, expected at most ${w}`);
  }
  for (const [key, op, label] of [["json_gte", (a, b) => a >= b, ">="], ["json_lte", (a, b) => a <= b, "<="]]) {
    for (const [p, want] of pairs(e[key])) {
      const have = at(body, p); note(p, have);
      const v = numOf(have), w = numOf(want);
      if (v == null || w == null) why.push(`${p} is not a number`);
      else if (!op(v, w)) why.push(`${p} = ${v}, expected ${label} ${w}`);
    }
  }
  for (const [p, pat] of pairs(e.json_matches)) {
    const have = at(body, p); note(p, have);
    const subject = have === undefined ? "" : show(have);
    let re = null;
    try { re = new RegExp(String(pat)); } catch (err) { why.push(`${p}: /${pat}/ is not a valid pattern (${err.message})`); }
    if (re && !re.test(subject)) why.push(`${p} = ${JSON.stringify(subject)}, expected to match /${pat}/`);
  }
  for (const [p, nested] of pairs(e.each)) {
    const have = at(body, p);
    if (!Array.isArray(have)) { why.push(`${p} is ${have === undefined ? "absent" : typeName(have)}, expected a list to iterate`); continue; }
    have.forEach((item, i) => { for (const w of check(nested, item, status, ms).why) why.push(`${p}[${i}]: ${w}`); });
  }
  for (const [p, want] of pairs(e.contains)) {
    const have = at(body, p);
    if (!Array.isArray(have)) { why.push(`${p} is ${have === undefined ? "absent" : typeName(have)}, expected a list`); continue; }
    if (!have.some((item) => pairs(want).every(([f, v]) => eq(at(item, f), v)))) why.push(`no item of ${p} (${have.length} of them) matches ${JSON.stringify(want)}`);
  }
  if (Array.isArray(e.not_both)) {
    if (e.not_both.length !== 2) why.push("not_both takes exactly two blocks");
    else {
      const holds = (side) => pairs(side).every(([p, v]) => eq(at(body, p), v));
      if (holds(e.not_both[0]) && holds(e.not_both[1])) why.push(`both held and they contradict: ${JSON.stringify(e.not_both[0])} AND ${JSON.stringify(e.not_both[1])}`);
    }
  }
  return { why, got };
}

/** The `run` and `static` halves, which share the vocabulary but not the body. */
export function checkCmd(expect, { rc, stdout, stderr, ms }) {
  const why = [];
  let n = 0;
  const e = expect || null;
  if (e && typeof e.rc === "number") { n++; if (rc !== e.rc) why.push(`rc ${rc}, expected ${e.rc}`); }
  for (const [key, hay, label] of [["stdout_contains", stdout, "stdout"], ["stderr_contains", stderr, "stderr"]]) {
    const want = e && e[key];
    for (const needle of typeof want === "string" ? [want] : Array.isArray(want) ? want : []) {
      n++;
      if (!String(hay).includes(needle)) why.push(`${label} does not contain ${JSON.stringify(needle)}`);
    }
  }
  if (e && typeof e.max_ms === "number") { n++; if (ms > e.max_ms) why.push(`took ${Math.round(ms)}ms, budget ${e.max_ms}ms`); }
  // A bare `run` with no expect block means "this must succeed" — otherwise it
  // is a step that ran a command and checked nothing.
  if (n === 0 && !e) { n = 1; if (rc !== 0) why.push(`rc ${rc} and nothing was asserted; a bare \`run\` step expects 0`); }
  return { why, n };
}
