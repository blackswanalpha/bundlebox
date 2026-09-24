// tools.js — the zero-token verbs as MCP tools. Each `run` returns text (or an
// object, serialised) and degrades to an explanation when its module is absent
// on this install, so a partial build still answers.
import fs from "node:fs";
import path from "node:path";
import { OUT, abs, rel } from "../core/paths.js";
import * as store from "../core/store.js";
import { text as estimateText, files as estimateFiles } from "../tokens/estimate.js";
import { human } from "../core/util.js";

const lazy = async (file) => { try { return await import(file); } catch (e) { return { __missing: String(e.message || e).split("\n")[0] }; } };  // the reason travels in __missing
const missing = (m, what) => `${what} is not available on this install: ${m.__missing}`;
const strs = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export const TOOLS = [
  {
    name: "bb_pinpoint",
    description: "One problem -> one focused brief: the files and symbol regions located already (quoted with line numbers), the scope that fits one window, evidence already on file, the acceptance command, traps and guidelines. Call this BEFORE searching the tree.",
    inputSchema: { type: "object", properties: { problem: { type: "string", description: "the task in one or two sentences" }, files: { type: "array", items: { type: "string" }, description: "files you already know are involved (optional)" }, max_files: { type: "integer", default: 6 }, kind: { type: "string", enum: ["fix", "verify", "investigate", "build", "write"], default: "fix" } }, required: ["problem"] },
    async run(a) {
      const m = await lazy("../pinpoint/index.js");
      if (m.__missing) return missing(m, "bb pinpoint");
      const r = await m.build(String(a.problem), { files: strs(a.files), maxFiles: Number(a.max_files) || 6, kind: a.kind || "fix" });
      return `${r.prompt}\n\n<!-- written to ${rel(r.path)}; projected ${human(r.projected)} of ${human(r.ceiling)} (${r.verdict}) -->`;
    },
  },
  {
    name: "bb_context",
    description: "Does this set of files fit in one session? Returns FITS / TIGHT / SPLIT / HEAVY with the token parts (overhead, payload, churn, reserve) and, when SPLIT, the cut.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } }, kind: { type: "string", default: "fix" } }, required: ["paths"] },
    async run(a) {
      const m = await lazy("../compile/context.js");
      if (m.__missing) return missing(m, "bb context");
      const ev = m.evaluate(strs(a.paths), { kind: a.kind || "fix" });
      const { split, files, ...rest } = ev;
      return { ...rest, files: Object.fromEntries(Object.entries(files || {}).map(([k, v]) => [k, human(v)])), split: split || null };
    },
  },
  {
    name: "bb_snapgen",
    description: "Reference tables built from the tree and kept fresh by fingerprint: layout, symbols-<dir> (name file:line), routes, docs, commands, hot, tests, deps. With no `table` returns the INDEX with each table's token cost so you can choose. Read a table instead of grepping.",
    inputSchema: { type: "object", properties: { table: { type: "string" } } },
    async run(a) {
      const dir = path.join(OUT, "snapgen");
      const index = path.join(dir, "INDEX.md");
      if (!fs.existsSync(index)) {
        const m = await lazy("../snapgen/index.js");
        if (m.__missing) return missing(m, "bb snapgen");
        if (m.commands?.snapgen) await m.commands.snapgen.run({ _: ["build"], flags: { quiet: true } });
      }
      if (!a.table) return fs.existsSync(index) ? fs.readFileSync(index, "utf8") : "no tables built; run `bb snapgen build`";
      const p = path.join(dir, `${String(a.table).replace(/[^\w.-]/g, "")}.md`);
      if (!fs.existsSync(p)) return `no table ${a.table}. INDEX:\n${fs.existsSync(index) ? fs.readFileSync(index, "utf8") : "(none)"}`;
      const t = fs.readFileSync(p, "utf8");
      const n = estimateText(t, "prose");
      // A table is never truncated: half a route table reads as a complete one.
      if (n > 40000) return `table ${a.table} is ~${human(n)} tokens, over the 40k cap for one tool result; read ${rel(p)} in ranges. INDEX:\n${fs.readFileSync(index, "utf8")}`;
      return t;
    },
  },
  {
    name: "bb_findings",
    description: "Open findings from the last `bb scan`: id, severity, detector, title, primary file. Filter by detector or minimum severity.",
    inputSchema: { type: "object", properties: { detector: { type: "string" }, severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] }, limit: { type: "integer", default: 30 } } },
    async run(a) {
      const SEV = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
      let rows = store.openFindings();
      if (a.detector) rows = rows.filter((f) => f.detector === a.detector);
      if (a.severity) rows = rows.filter((f) => (SEV[f.severity] ?? 0) >= (SEV[a.severity] ?? 0));
      rows.sort((x, y) => (SEV[y.severity] ?? 0) - (SEV[x.severity] ?? 0));
      const lim = Number(a.limit) || 30;
      return { count: rows.length, findings: rows.slice(0, lim).map((f) => ({ id: f.id, severity: f.severity, detector: f.detector, title: f.title, path: f.path })) };
    },
  },
  {
    name: "bb_scan",
    description: "Run the zero-token detectors now (seconds) and return the per-detector counts. Use bb_findings to read the results.",
    inputSchema: { type: "object", properties: { only: { type: "array", items: { type: "string" } } } },
    async run(a) {
      const m = await lazy("../detectors/index.js");
      if (m.__missing) return missing(m, "bb scan");
      const t0 = Date.now();
      const { findings, ran } = m.runAll({ only: strs(a.only) });
      const merged = store.mergeFindings(findings, { detectors: new Set(ran.filter((r) => !r.error).map((r) => r.name)) });
      return { seconds: (Date.now() - t0) / 1000, open: merged.filter((f) => f.status === "open").length, ran: ran.map((r) => ({ name: r.name, count: r.count, ms: r.ms, error: r.error || undefined })) };
    },
  },
  {
    name: "bb_oversight_brief",
    description: "What is already known about these files from the last oversight scan: god-shaped, duplicated, bloated, vibe-coded marks, and the guideline to apply while editing. About 300 tokens.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
    async run(a) {
      const m = await lazy("../oversight/index.js");
      if (m.__missing) return missing(m, "bb oversight");
      return (m.brief ? m.brief(strs(a.paths)) : (await lazy("../oversight/guidelines.js")).brief?.(strs(a.paths))) || "(no oversight scan stored; run `bb oversight scan --write`)";
    },
  },
  {
    name: "bb_explain",
    description: "One finding in full: evidence, fix hint, actuator, and the triage derivation (why it was or was not promoted).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a) {
      const f = store.get("findings", []).find((x) => x.id === a.id || x.id.startsWith(String(a.id)));
      if (!f) return `no finding ${a.id}`;
      const m = await lazy("../detectors/index.js");
      return { finding: f, derivation: m.__missing ? null : m.explain(f) };
    },
  },
  {
    name: "bb_tokens_estimate",
    description: "Estimated tokens per file and in total, with the calibrated estimator (not chars/4).",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
    async run(a) {
      const r = estimateFiles(strs(a.paths).map(abs));
      return `total ~${human(r.total)} tokens over ${Object.keys(r.files).length} files\n` + Object.entries(r.files).sort((x, y) => y[1] - x[1]).map(([f, n]) => `  ${human(n).padStart(7)}  ${f}`).join("\n") + (r.missing.length ? `\n  missing: ${r.missing.join(", ")}` : "");
    },
  },
  {
    // Five separate calls, answered in one. `bb echos` measured 1.04 tool calls
    // per turn over 26 sessions here: every turn re-sends the whole window
    // before the next fact arrives, so this verb exists to be the one call.
    name: "bb_situation",
    description: "Where this work stands, in one call: branch and what is uncommitted, what proves a change here, which artefacts are missing or stale, the work already packed, and what the last echos run saw. Call this instead of git status + git diff + bb env + bb findings + bb echos.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const m = await lazy("../situation/index.js");
      if (m.__missing) return missing(m, "bb situation");
      return m.report(await m.situation({}));
    },
  },
  {
    name: "bb_session",
    description: "What the current or last session used (measured from the transcript) and what it was spared (cache: measured; automation: estimate range).",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } } },
    async run(a) {
      const m = await lazy("../tokens/session.js");
      if (m.__missing) return missing(m, "bb session");
      const r = await m.measure({ sessionId: a.session_id || "" });
      return r ? m.report(r) : "unknown: no transcript resolvable for this workspace";
    },
  },
];
