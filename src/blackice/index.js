// blackice/index.js — the per-area audit: what a careful reader finds in one
// area of this tree, written down and dated.
//
// This is the one artefact in the factory a model genuinely has to produce.
// Everything else here is a parse, a count or a set difference; a security
// read of an area is a judgement, and the value of it is that it is a FIXED
// POINT you can measure drift against.
//
// Two rules follow from that and they are the whole discipline:
//
// **A report is dated, not living.** Do not update one because the code moved —
// that destroys the only thing it was for. Write a new one beside it. `drift`
// says which reports are describing a tree that has changed.
//
// **Nothing here is derived, so nothing here is checked.** A report can go
// stale silently. That is acceptable for a dated record and not acceptable for
// anything a session orients from — so if a fact in a report is worth relying
// on, the fix is to make a detector compute it, not to keep the paragraph
// fresh by hand.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as bridge from "../bridge/index.js";
import * as genesis from "../genesis/index.js";
import * as episodes from "../buckmaster/episodes.js";
import * as kit from "../kit/cache.js";
import { BB_DIR, OUT, ROOT, rel, abs } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { walk, readText } from "../core/fs.js";
import { out, warn, emit } from "../core/log.js";
import { now, stamp, slug, pad, table, human } from "../core/util.js";
import { files as estimateFiles, text as estimateText } from "../tokens/estimate.js";

export const DIR = () => path.join(BB_DIR, "blackice");
export const KINDS = {
  report: "the risk read: what is here, what it depends on, and what would hurt",
  bugs: "defects a careful reader finds, each with the file and line that shows it",
  security: "what an attacker with each level of access could reach",
  performance: "what gets slow, at what size, and what the cost is made of",
  userflow: "the path a person takes through this area, and where it breaks",
};

/** Areas are the tree's own top-level source groupings, joined to the world's
 *  surfaces where the two agree. Nothing is invented: an area with no files is
 *  not an area. */
export function areas() {
  const all = walk(ROOT);
  const groups = new Map();
  for (const f of all) {
    const r = rel(f);
    const parts = r.split("/");
    // src/foo/bar.js -> "foo"; foo/bar.js -> "foo"; bar.js -> "(root)"
    const key = parts.length >= 3 && /^(src|lib|app|packages|apps|internal|pkg)$/.test(parts[0]) ? parts[1]
      : parts.length >= 2 ? parts[0] : "(root)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const w = genesis.world(genesis.current());
  const surfaces = new Set((w?.surfaces || []).map((s) => s.id));
  const open = store.get("findings", []).filter((f) => f.status === "open");
  const rows = [];
  for (const [id, files] of groups) {
    if (files.length < 2) continue;
    const est = estimateFiles(files.map((f) => abs(f)));
    rows.push({ id, files, count: files.length, tokens: est.total,
      surface: surfaces.has(id) ? id : "",
      findings: open.filter((f) => files.includes(f.path) || (f.files || []).some((x) => files.includes(x))).length,
      reports: reportsFor(id) });
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

export function reportsFor(area) {
  const dir = path.join(DIR(), area);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  return names.map((f) => {
    const m = /^([a-z]+)-(\d{8}T\d{6}Z)\.md$/.exec(f);
    const meta = readJson(path.join(dir, f.replace(/\.md$/, ".json")), {}) || {};
    return { kind: m ? m[1] : f.replace(/\.md$/, ""), at: m ? m[2] : "", file: rel(path.join(dir, f)), fingerprint: meta.fingerprint || "", findings: meta.findings ?? null };
  });
}

const fingerprintOf = (files) => kit.fingerprint(files.map((f) => abs(f)));

/** What is missing, and what is describing a tree that has moved. Ranked by
 *  what an audit of it would actually be worth: size, open findings, staleness. */
export function plan({ kinds = Object.keys(KINDS), limit = 30 } = {}) {
  const rows = [];
  for (const a of areas()) {
    const fp = fingerprintOf(a.files);
    for (const kind of kinds) {
      const have = a.reports.filter((r) => r.kind === kind).sort((x, y) => String(x.at).localeCompare(String(y.at)));
      const last = have[have.length - 1] || null;
      const drifted = last ? last.fingerprint && last.fingerprint !== fp : false;
      if (last && !drifted) continue;
      const ageDays = last?.at ? Math.round((Date.now() - Date.parse(last.at.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z"))) / 86400000) : null;
      rows.push({ area: a.id, kind, state: last ? "drifted" : "missing", last: last?.file || "", age_days: ageDays,
        files: a.count, tokens: a.tokens, findings: a.findings,
        score: Math.round((Math.log2(a.count + 1) * 2 + a.findings + (kind === "security" ? 3 : kind === "report" ? 2 : 0) + (drifted ? 2 : 0)) * 10) / 10,
        why: last ? `the last ${kind} was written ${ageDays}d ago and the area has changed since` : `no ${kind} for ${a.id}` });
    }
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function packText(spec, area) {
  const top = area.files.slice(0, 60);
  const open = store.get("findings", []).filter((f) => f.status === "open" && (area.files.includes(f.path) || (f.files || []).some((x) => area.files.includes(x))));
  const L = [
    `# ${spec.kind} audit — \`${spec.area}\``, "",
    KINDS[spec.kind], "",
    `This is a DATED record. It says what was true today. Do not update an older report because the code has moved: write this one beside it. The only thing an audit is worth is being a fixed point to measure drift against.`, "",
    `## The area, already counted`, "",
    `${area.count} file(s), about ${human(area.tokens)} tokens if every one were read. You are not expected to read every one — read what the question needs.`, "",
    "```", ...top.map((f) => f), area.count > top.length ? `… ${area.count - top.length} more` : "", "```", "",
  ];
  if (open.length) {
    L.push("## What the detectors already found here — do not re-derive these", "");
    for (const f of open.slice(0, 14)) L.push(`- **[${f.severity}] ${f.detector}**: ${f.title}${f.path ? ` (\`${f.path}\`)` : ""}`);
    L.push("");
  } else L.push("## What the detectors already found here", "", "Nothing open. That is a fact about the detectors, not about the area.", "");
  L.push(
    "## What to write", "",
    "A markdown report. Prose for a reader, and then ONE fenced `json` block at the end, exactly this shape, which is the part the factory ingests:", "",
    "```json",
    JSON.stringify({ findings: [{ title: "one sentence", severity: "critical | high | medium | low",
      kind: "fix | verify | investigate", detail: "what it is and why it matters, in a paragraph",
      evidence: { file: "src/x/y.js", line: 128, quote: "the line or two that shows it" } }] }, null, 2),
    "```", "",
    "Every finding must carry `evidence` pointing somewhere a reader can check. A finding without one is an opinion and the ingest refuses it.", "",
    "## What this brief does not accept", "",
    "| what it is tempting to do instead | why it does not apply here |",
    "|---|---|",
    "| \"I'll list the whole file tree back\" | It is above. Restating it is tokens for something already free. |",
    "| \"I'll re-run the detectors to be sure\" | Their output is above and it is current. Your job is the half they cannot compute. |",
    "| \"nothing found, the area looks fine\" | Then say that in one line and return an empty `findings` array. An empty audit is a result; a vague one is not. |",
    "| \"I'll also fix what I found\" | Not in this call. A finding becomes a unit, gets budgeted, and is fixed under its own acceptance. |",
    "| \"severity high, it could theoretically…\" | Severity is about what this code does, not what some code could do. If the path is not reachable here, say so and mark it low. |", "",
    "## Done when", "",
    "```bash", `bb blackice record ${spec.area} ${spec.kind} <the file you wrote>`, "```", "",
    "That ingests the json block and refuses a finding with no evidence. Run it; report what it printed.", "");
  return L.join("\n");
}

export function pack({ limit = 6, kinds = null } = {}) {
  const specs = plan({ kinds: kinds || Object.keys(KINDS), limit });
  const all = areas();
  const dir = path.join(OUT, "blackice");
  fs.mkdirSync(dir, { recursive: true });
  const packs = [];
  for (const s of specs) {
    const area = all.find((a) => a.id === s.area);
    if (!area) continue;
    const text = packText(s, area);
    const file = path.join(dir, `${slug(s.area)}-${s.kind}.md`);
    fs.writeFileSync(file, text);
    packs.push({ ...s, file: rel(file), est_tokens: estimateText(text, "prose"), acceptance: `bb blackice record ${s.area} ${s.kind} <file>` });
  }
  writeJson(path.join(dir, "index.json"), { at: now(), packs });
  return { rc: 0, packs };
}

const JSON_BLOCK = /```json\s*([\s\S]*?)```/g;

/** Ingest a written report. The prose is kept as the dated record; the json
 *  block becomes findings. A finding with no evidence is REFUSED, not stored
 *  with an empty evidence object — that is the whole difference between an
 *  audit and an opinion. */
export function record(area, kind, file) {
  if (!KINDS[kind]) return { rc: 2, why: `kind \`${kind}\` is not one of ${Object.keys(KINDS).join(", ")}` };
  const text = readText(abs(file), null);
  if (text == null) return { rc: 2, why: `cannot read ${file}` };
  const blocks = [...text.matchAll(JSON_BLOCK)].map((m) => m[1]);
  let payload = null;
  for (const b of blocks.reverse()) { try { const v = JSON.parse(b); if (v && Array.isArray(v.findings)) { payload = v; break; } } catch { /* a prose example block is not the payload */ } }
  if (!payload) return { rc: 2, why: "no fenced ```json block holding {\"findings\": [...]} — that block is the contract" };
  const a = areas().find((x) => x.id === area);
  if (!a) return { rc: 2, why: `no area \`${area}\`. bb blackice areas` };
  const at = stamp();
  const dir = path.join(DIR(), area);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${kind}-${at}.md`);
  fs.writeFileSync(target, text);
  const refused = [], rows = [];
  for (const f of payload.findings) {
    if (!f.title) { refused.push("a finding with no title"); continue; }
    if (!f.evidence || !f.evidence.file) { refused.push(`${f.title}: no evidence.file — a finding a reader cannot check is an opinion`); continue; }
    rows.push({ detector: `blackice:${area}`, severity: ["critical", "high", "medium", "low"].includes(f.severity) ? f.severity : "medium",
      precision: "heuristic", title: f.title, path: f.evidence.file, files: [f.evidence.file], key: `${area}/${kind}/${slug(f.title)}`,
      detail: String(f.detail || "").slice(0, 1500), evidence: { ...f.evidence, area, kind, report: rel(target), audited_at: at },
      fix_hint: "This came from a dated audit, not a detector. Confirm it still holds before acting: `bb blackice drift` says whether the area has moved since.",
      auto_fix: null, kind: ["fix", "verify", "investigate"].includes(f.kind) ? f.kind : "investigate", est_tokens: estimateText(String(f.detail || ""), "prose") });
  }
  // Audits accumulate: a re-audit must not resolve the previous one's findings,
  // because a dated record is not a re-scan. mergeFindings is given an empty
  // detector set so nothing is closed by this write.
  store.mergeFindings(rows, { detectors: new Set() });
  writeJson(target.replace(/\.md$/, ".json"), { area, kind, at, fingerprint: fingerprintOf(a.files), findings: rows.length, refused: refused.length, source: rel(abs(file)) });
  episodes.write({ kind: "stage", verb: "blackice", stage: `blackice:${area}:${kind}`,
    features: { area_files: a.count, area_tokens: a.tokens }, rc: 0, produced: rows.length, produces: ["findings", "report"],
    turns_saved: 0, detail: { report: rel(target), refused: refused.length } });
  return { rc: 0, report: rel(target), recorded: rows.length, refused };
}

export function drift() {
  const rows = [];
  for (const a of areas()) {
    const fp = fingerprintOf(a.files);
    for (const r of a.reports) {
      if (!r.fingerprint) { rows.push({ ...r, area: a.id, state: "unknown", why: "written before fingerprints were recorded" }); continue; }
      rows.push({ ...r, area: a.id, state: r.fingerprint === fp ? "current" : "drifted",
        why: r.fingerprint === fp ? "the area has not changed since" : "the area has changed since this was written — write a new one beside it, do not edit this" });
    }
  }
  return rows;
}

async function cmd({ _, flags }) {
  const sub = _[0] || "areas";

  if (sub === "areas") {
    const rows = areas();
    if (flags.json) { emit({ areas: rows.map((a) => ({ ...a, files: a.count })) }); return 0; }
    if (!rows.length) { out("  no areas: nothing under this tree groups into one"); return 0; }
    out(table(rows.map((a) => [a.id, a.count, human(a.tokens), a.findings || "", a.reports.map((r) => r.kind).join(" ") || "no reports"]),
      { header: ["area", "files", "~tokens", "open", "reports"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "plan") {
    const rows = plan({ kinds: flags.kind ? String(flags.kind).split(",") : Object.keys(KINDS), limit: Number(flags.limit) || 30 });
    if (flags.json) { emit({ plan: rows }); return 0; }
    if (!rows.length) { out("  every area has a current report of every kind"); return 0; }
    out(table(rows.map((r) => [r.area, r.kind, r.state, r.files, r.findings || "", r.score, r.why]), { header: ["area", "kind", "", "files", "open", "score", "why"] })
      .split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }

  if (sub === "pack") {
    const r = pack({ limit: Number(flags.limit) || 6, kinds: flags.kind ? String(flags.kind).split(",") : null });
    if (flags.json) { emit(r); return 0; }
    out(`  ${r.packs.length} pack(s) — ${human(r.packs.reduce((a, p) => a + p.est_tokens, 0))} tokens ESTIMATE if every one is sent`);
    out(table(r.packs.map((p) => [p.area, p.kind, human(p.est_tokens), p.file]), { header: ["area", "kind", "~tok", "pack"] }).split("\n").map((l) => "  " + l).join("\n"));
    out("\n  Nothing sent. `bb blackice send <area> <kind>` drafts a call; --run --spend opens an agent.");
    return 0;
  }

  if (sub === "send") {
    const idx = readJson(path.join(OUT, "blackice", "index.json"), null);
    if (!idx) { warn("no packs. bb blackice pack"); return 2; }
    const want = idx.packs.filter((p) => (!_[1] || p.area === _[1]) && (!_[2] || p.kind === _[2]));
    if (!want.length) { warn(`no pack for ${_[1] || "*"} ${_[2] || "*"}`); return 2; }
    for (const p of want) {
      const body = readText(abs(p.file), "");
      const d = await bridge.draft({ problem: `${p.kind} audit of ${p.area}`, reason: "assist", gear: "blackice",
        stage: `blackice:${p.area}`, acceptance: `bb blackice record ${p.area} ${p.kind} <the file you wrote>`, body, lean: true });
      if (d.rc) { warn(d.why); continue; }
      if (!flags.run) { out(`  ${pad(p.area, 14)} ${pad(p.kind, 12)} drafted ${d.id} — bb bridge send ${d.id} --run --spend`); continue; }
      const s = await bridge.send(d.id, { run: true, spend: !!flags.spend, agent: String(flags.agent || "") });
      out(`  ${pad(p.area, 14)} ${pad(p.kind, 12)} ${s.state} — ${s.why}`);
    }
    return 0;
  }

  if (sub === "record") {
    const [, area, kind, file] = _;
    if (!area || !kind || !file) { warn("bb blackice record <area> <kind> <file.md>"); return 2; }
    const r = record(area, kind, file);
    if (r.rc) { warn(r.why); return r.rc; }
    if (flags.json) { emit(r); return 0; }
    out(`  ${r.report} — ${r.recorded} finding(s) recorded${r.refused.length ? `, ${r.refused.length} refused` : ""}`);
    for (const x of r.refused) out(`    !! ${x}`);
    return 0;
  }

  if (sub === "drift") {
    const rows = drift();
    if (flags.json) { emit({ reports: rows }); return rows.some((r) => r.state === "drifted") ? 1 : 0; }
    if (!rows.length) { out("  no reports yet. bb blackice plan"); return 0; }
    out(table(rows.map((r) => [r.area, r.kind, r.at, r.state, r.why]), { header: ["area", "kind", "written", "", ""] }).split("\n").map((l) => "  " + l).join("\n"));
    return rows.some((r) => r.state === "drifted") ? 1 : 0;
  }
  warn(`unknown blackice sub-verb: ${sub}. areas | plan | pack | send | record | drift`);
  return 2;
}

export const commands = {
  blackice: {
    help: "the per-area audit: what a careful reader finds, written down, dated, and ingested as findings",
    usage: "bb blackice [areas|plan|pack|send <area> <kind>|record <area> <kind> <file>|drift] [--kind a,b] [--run --spend] [--json]",
    long: [
      "  bb blackice areas      the tree's own areas, their size and what is open in each",
      "  bb blackice plan       what has no report, and what is describing a tree that has moved",
      "  bb blackice pack       one brief per area and kind, carrying the counted half",
      "  bb blackice record <area> <kind> <file>   ingest a written report",
      "  bb blackice drift      which reports describe an area that has since changed",
      "",
      "A report is a dated record, not living documentation. Never update one: write a new one beside it.",
    ].join("\n"),
    run: cmd,
  },
};
