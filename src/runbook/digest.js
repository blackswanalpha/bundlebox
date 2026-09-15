// digest.js — the log digest, and the JavaScript half of it.
//
// The kernel (`bbk digest`) is the fast path: offset reads, one scanner pass
// per line, no regex engine. Measured on a 3.9 MB, 40,000-line log it returns
// five signatures in 60 ms, and the second call — which reads only what arrived
// since the first — in 1 ms.
//
// This is the other half, and it exists for the same reason every other
// fallback in this factory does: a missing kernel must never make a verb return
// nothing. It is a LINE-FOR-LINE port of `kernel/src/digest.rs`, not a second
// opinion about what a signature is, because two normalisers would eventually
// disagree and the one that drifted would be the one reporting that nothing
// changed. `test/digest.test.js` pins them to identical answers.
import fs from "node:fs";
import path from "node:path";
import * as kernel from "../core/kernel.js";
import { BB_DIR, VAR, rel } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";

export const BUCKETS = () => path.join(BB_DIR, "runbook", "digest.json");
export const CURSORS = () => path.join(VAR, "log-cursors.json");
const MAX_SIGNATURE = 140;

const isDigit = (c) => c >= 48 && c <= 57;
const isHex = (c) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isAlnum = (c) => isDigit(c) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const LEVELS = new Set(["V", "D", "I", "W", "E", "F"]);

/** The level a line declares, from the shapes real logs use: logcat's single
 *  letter after the pid/tid pair, and the words uvicorn, node and python print.
 *  A space means the line does not say. */
export function levelOf(line) {
  let i = 0, fields = 0;
  while (i < line.length && fields < 7) {
    while (i < line.length && line[i] === " ") i++;
    const start = i;
    while (i < line.length && line[i] !== " ") i++;
    if (i === start) break;
    const f = line.slice(start, i);
    if (fields >= 2 && f.length === 1 && LEVELS.has(f)) return f;
    if (fields >= 2 && f.length > 1 && !/^[\d.:-]+$/.test(f)) break;
    fields++;
  }
  const upper = line.slice(0, 200).toUpperCase();
  if (upper.includes("ERROR") || upper.includes("EXCEPTION") || upper.includes("TRACEBACK")) return "E";
  if (upper.includes("WARN")) return "W";
  return " ";
}

/** Erase everything that differs between two occurrences of the same event.
 *  One pass, no backtracking; every branch consumes at least one character. */
export function signature(line) {
  const n = line.length;
  const at = (k) => line.charCodeAt(k);
  let out = "";
  let i = 0;

  // A leading timestamp: at least six digits and two separators. Anything less
  // is a number the line is about, and erasing it would lose the fact.
  {
    let j = 0;
    if (j < n && (line[j] === "[" || line[j] === "(")) j++;
    const start = j;
    let digits = 0, seps = 0;
    while (j < n) {
      const c = at(j);
      if (isDigit(c)) { digits++; j++; }
      else if ("-:./T,+".includes(line[j])) { seps++; j++; }
      else if (line[j] === " " && seps > 0 && digits >= 4 && j + 1 < n && isDigit(at(j + 1))) { seps++; j++; }
      else if (line[j] === "Z" && digits >= 6) { j++; break; }
      else break;
    }
    if (digits >= 6 && seps >= 2 && j > start) {
      if (j < n && (line[j] === "]" || line[j] === ")")) j++;
      i = j;
    }
  }
  while (i < n && line[i] === " ") i++;

  // logcat puts `<pid> <tid>` between the timestamp and the level. Two long
  // integers side by side at the head of a line are never the fact.
  {
    let j = i, nums = 0;
    while (nums < 2) {
      while (j < n && line[j] === " ") j++;
      const s = j;
      while (j < n && isDigit(at(j))) j++;
      if (j - s < 3 || j - s > 7) break;
      nums++;
    }
    if (nums === 2) { out += "# # "; i = j; while (i < n && line[i] === " ") i++; }
  }

  let lastSpace = false;
  while (i < n) {
    const c = at(i);

    if (line[i] === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') { if (line[j] === "\\") j++; j++; }
      if (j < n && j - (i + 1) >= 24) { out += '"…"'; i = j + 1; lastSpace = false; continue; }
    }

    if (line[i] === "0" && i + 2 < n && (line[i + 1] === "x" || line[i + 1] === "X") && isHex(at(i + 2))) {
      let j = i + 2;
      while (j < n && isHex(at(j))) j++;
      out += "X"; i = j; lastSpace = false; continue;
    }

    if (isDigit(c) || (isHex(c) && !isDigit(c))) {
      const start = i;
      let j = i, dashes = 0, anyAlpha = false;
      while (j < n) {
        const d = at(j);
        if (isDigit(d)) j++;
        else if (isHex(d)) { anyAlpha = true; j++; }
        else if (line[j] === "-" && j + 1 < n && isHex(at(j + 1)) && j - start >= 8) { dashes++; j++; }
        else break;
      }
      const run = j - start;
      const boundary = start === 0 || !(isAlnum(at(start - 1)) || line[start - 1] === "_");
      if (boundary && ((dashes === 4 && run >= 32) || (run >= 12 && anyAlpha))) {
        out += "X"; i = j; lastSpace = false; continue;
      }
      if (boundary && !anyAlpha) {
        let k = start;
        while (k < n && (isDigit(at(k)) || (line[k] === "." && k + 1 < n && isDigit(at(k + 1))))) k++;
        const unitStart = k;
        let u = k;
        while (u < n && u - unitStart < 2 && /[a-z]/i.test(line[u])) u++;
        const unit = line.slice(unitStart, u).toLowerCase();
        const known = ["ms", "s", "kb", "mb", "gb", "b", "k", "m", "g", "%"].includes(unit);
        out += "#";
        if (known) { out += line.slice(unitStart, u); i = u; } else i = k;
        if (i < n && line[i] === "%") { out += "%"; i++; }
        lastSpace = false; continue;
      }
    }

    // A path of three or more segments. One or two is usually the fact
    // (`GET /health`, `src/app.js`).
    if (line[i] === "/" && i + 1 < n && (isAlnum(at(i + 1)) || line[i + 1] === "_" || line[i + 1] === ".")) {
      let j = i, segs = 0;
      while (j < n && line[j] === "/") {
        j++;
        const s = j;
        while (j < n && (isAlnum(at(j)) || "_-.@+".includes(line[j]))) j++;
        if (j === s) { j = s; break; }
        segs++;
      }
      if (segs >= 3) { out += "P"; i = j; lastSpace = false; continue; }
    }

    if (line[i] === " " || line[i] === "\t") {
      if (!lastSpace && out.length) { out += " "; lastSpace = true; }
      i++;
      continue;
    }

    lastSpace = false;
    out += line[i];
    i++;
    if (out.length >= MAX_SIGNATURE) break;
  }
  return out.replace(/\s+$/, "").slice(0, MAX_SIGNATURE);
}

/** The named failures this workspace has already paid to learn. A known
 *  failure arrives as one line saying what it is, rather than as a stack trace
 *  somebody has to recognise again. */
export function buckets() {
  const v = readJson(BUCKETS(), null);
  const rows = Array.isArray(v) ? v : (v?.buckets || []);
  return rows.filter((b) => b && b.id && b.match).map((b) => ({
    id: String(b.id), severity: b.severity === "high" || b.severity === "low" ? b.severity : "medium",
    match: String(b.match), says: String(b.says || ""),
  }));
}

export function logFiles(dir, id = "") {
  if (id) { const p = path.join(dir, `${id}.log`); return fs.existsSync(p) ? [p] : []; }
  try { return fs.readdirSync(dir).filter((f) => /\.(log|logcat)$/.test(f)).sort().map((f) => path.join(dir, f)); }
  catch { return []; }
}

/** The JS half: same offsets, same scanner, same buckets. */
function digestJs(files, { top, level, grep, sample, cap, rules }) {
  const re = grep ? new RegExp(grep) : null;
  const bres = rules.map((b) => ({ ...b, re: new RegExp(b.match), n: 0, sample: "" }));
  const out = [];
  let totals = { bytes: 0, lines: 0, errors: 0, warnings: 0 };
  for (const { path: file, from: asked } of files) {
    let st;
    try { st = fs.statSync(file); } catch (e) { out.push({ path: file, bytes: 0, why: `unreadable: ${e.message}` }); continue; }
    const rotated = st.size < asked;
    let from = rotated ? 0 : asked;
    if (st.size - from > cap) from = st.size - cap;
    const len = Math.max(0, st.size - from);
    let text = "";
    if (len > 0) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, from);
      fs.closeSync(fd);
      text = buf.toString("utf8");
    }
    const counts = new Map();
    let lines = 0, kept = 0, errors = 0, warnings = 0;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      lines++;
      const lv = levelOf(line);
      if (lv === "E") errors++; else if (lv === "W") warnings++;
      for (const b of bres) if (b.re.test(line)) { b.n++; if (!b.sample) b.sample = line.slice(0, 200); }
      if (level !== " " && lv !== level) continue;
      if (re && !re.test(line)) continue;
      kept++;
      const sig = signature(line);
      if (!sig) continue;
      const e = counts.get(sig) || { n: 0, sample: sample ? line.slice(0, 200) : "" };
      e.n++;
      counts.set(sig, e);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
    out.push({ path: file, bytes: len, from, to: st.size, rotated, lines, kept, errors, warnings,
      distinct: rows.length,
      signatures: rows.slice(0, top).map(([sig, v]) => (sample && v.sample ? { sig, n: v.n, sample: v.sample } : { sig, n: v.n })) });
    totals = { bytes: totals.bytes + len, lines: totals.lines + lines, errors: totals.errors + errors, warnings: totals.warnings + warnings };
  }
  const order = { high: 0, medium: 1, low: 2 };
  const fired = bres.filter((b) => b.n > 0).map(({ id, severity, n, says, sample: s }) => ({ id, severity, n, says, sample: s }))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  return { ok: true, files: out, buckets: fired, refused: [], high: fired.some((b) => b.severity === "high"), totals };
}

/** One digest. The kernel when there is one, the port when there is not, and
 *  the answer says which — a board that does not name its engine is a board
 *  whose numbers cannot be compared with the last one. */
export function digest(dir, { id = "", since = true, top = 40, level = "", grep = "", sample = false,
  cap = 8 * 1024 * 1024, engine = "auto" } = {}) {
  const cursors = readJson(CURSORS(), {}) || {};
  const files = logFiles(dir, id).map((p) => ({ path: p, from: since ? (cursors[p] || 0) : 0 }));
  if (!files.length) return { ok: true, files: [], buckets: [], refused: [], high: false, via: "none", totals: { bytes: 0, lines: 0, errors: 0, warnings: 0 } };
  const rules = buckets();
  const lv = (level || " ").slice(0, 1).toUpperCase();
  const payload = { files, top, level: lv === " " ? "" : lv, grep, sample, cap, buckets: rules };
  let r = null;
  if (engine !== "js") r = kernel.call("digest", payload, { timeout: 120000 });
  const via = r ? "kernel" : "js";
  if (!r) r = digestJs(files, { top, level: lv, grep, sample, cap, rules });
  for (const f of r.files || []) if (Number.isFinite(f.to)) cursors[f.path] = f.to;
  writeJson(CURSORS(), cursors);
  return { ...r, via, files: (r.files || []).map((f) => ({ ...f, file: rel(f.path) })) };
}

/** The example buckets a new workspace starts from: the failures that cost a
 *  session to recognise the first time anywhere. */
export const SEED = [
  { id: "oom-kill", severity: "high", match: "(Out of memory|oom-kill|Killed process|JavaScript heap out of memory)",
    says: "Something was killed for memory. The cage, or the box, ran out — check `bb runbook status` for the ceiling it hit." },
  { id: "port-in-use", severity: "high", match: "(EADDRINUSE|Address already in use|bind: address already in use)",
    says: "The port is already held. A previous run did not stop; `bb runbook down all --apply` first." },
  { id: "auth-refused", severity: "high", match: "(401 Unauthorized|403 Forbidden|invalid.?token|jwt (expired|malformed)|no matching key)",
    says: "Credentials are being refused, so every authed read comes back empty and the board reads as a product defect." },
  { id: "rate-limited", severity: "medium", match: "(429|rate.?limit|Too Many Requests|quota exceeded)",
    says: "The upstream is throttling. Lower the corpus rpm before reading any timing from this run." },
  { id: "db-unreachable", severity: "high", match: "(ECONNREFUSED|could not connect to server|Connection refused|no such host)",
    says: "A dependency is not up. Start it before the scenarios, or every step below it is blocked rather than failed." },
  { id: "unhandled-rejection", severity: "medium", match: "(UnhandledPromiseRejection|unhandled rejection|Unhandled exception)",
    says: "A promise rejected with nothing catching it. The process may still be running and wrong." },
  { id: "migration-pending", severity: "medium", match: "(pending migration|relation .* does not exist|no such table|no such column)",
    says: "The schema on disk is not the schema the code expects. Migrate before reading anything from this run." },
  { id: "disk-full", severity: "high", match: "(ENOSPC|No space left on device)",
    says: "The disk is full. Nothing after this line is evidence about the product." },
];

export function initBuckets() {
  const f = BUCKETS();
  if (fs.existsSync(f)) return { rc: 2, file: rel(f), why: `${rel(f)} exists` };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, SEED);
  return { rc: 0, file: rel(f), why: `${SEED.length} known failures written; add yours as rows` };
}
