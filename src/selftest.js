// selftest.js — is the factory still able to read the tree?
//
// Not a unit-test suite. Every check here targets a failure that is SILENT:
// a parser that returns nothing reads like a clean tree, a degraded dependency
// that returns [] reads like a clean bill of health, an estimator that drifted
// resizes every lane. Each check prints its measurement even when it passes,
// because `ok` with no number cannot tell you it has started measuring nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { PKG_ROOT } from "./core/paths.js";
import { out, emit } from "./core/log.js";
import { human } from "./core/util.js";

const checks = [];
const check = (label, fn) => checks.push({ label, fn });

check("every module imports", async () => {
  const files = [];
  const stack = [path.join(PKG_ROOT, "src")];
  while (stack.length) { const d = stack.pop(); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else if (p.endsWith(".js")) files.push(p); } }
  const failed = [];
  for (const f of files) { try { await import(f); } catch (e) { failed.push(`${path.relative(PKG_ROOT, f)}: ${String(e.message).split("\n")[0]}`); } }
  return [!failed.length, failed.length ? failed.join("; ") : `${files.length} modules`];
});

check("estimator sane (chars/token in 2..6)", async () => {
  const { text } = await import("./tokens/estimate.js");
  const rows = [];
  for (const [f, kind] of [["README.md", "prose"], ["src/cli.js", "code"]]) {
    const s = fs.readFileSync(path.join(PKG_ROOT, f), "utf8");
    rows.push([f, s.length / Math.max(1, text(s, kind))]);
  }
  return [rows.every(([, r]) => r >= 2 && r <= 6), rows.map(([f, r]) => `${f} ${r.toFixed(2)}`).join(", ")];
});

check("anchors locate a region, and the region is a fraction of the file", async () => {
  const { locate } = await import("./compile/anchors.js");
  const p = path.join(PKG_ROOT, "src/cli.js");
  const a = locate(p, "loadCommands");
  if (!a) return [false, "locate returned null for loadCommands"];
  const ratio = (a.line_end - a.line_start + 1) / fs.readFileSync(p, "utf8").split("\n").length;
  return [ratio > 0 && ratio < 0.6, `loadCommands lines ${a.line_start}-${a.line_end}, ${(ratio * 100).toFixed(0)}% of the file`];
});

check("paths survive this OS: PKG_ROOT resolves, workspace paths are forward-slash", async () => {
  const { rel, PKG_ROOT: PR } = await import("./core/paths.js");
  // PKG_ROOT was built from `new URL(import.meta.url).pathname`, which is a URL
  // path: on Windows that is "/C:/Users/..." and resolves to a directory that
  // does not exist, taking every module path with it. A check that the package
  // root contains this package's own manifest catches that on the OS it breaks.
  const hasManifest = fs.existsSync(path.join(PR, "package.json"));
  const deep = rel(path.join(PKG_ROOT, "src", "core", "paths.js"));
  const forward = !deep.includes("\\") && deep.endsWith("src/core/paths.js");
  return [hasManifest && forward, `PKG_ROOT ${hasManifest ? "has package.json" : "MISSING package.json"}; rel() -> ${deep}`];
});

check("kernel == js on estimate and fingerprint", async () => {
  const kernel = await import("./core/kernel.js");
  if (!kernel.available()) return [true, "kernel absent, js only (bb kernel install)"];
  const est = await import("./tokens/estimate.js");
  const cache = await import("./kit/cache.js");
  const { load } = await import("./core/config.js");
  const files = ["package.json", "src/cli.js", "src/core/fs.js", "README.md", "kernel/src/main.rs"].map((f) => path.join(PKG_ROOT, f));
  const js = est.filesJs(files);
  const k = kernel.call("estimate", { paths: files, ...load().tokens });
  const same = k && files.every((f) => k.files[f] === js.files[path.relative(process.cwd(), f)] || k.files[f] === js.files[f] || Object.values(js.files).includes(k.files[f]));
  const fp = kernel.call("fingerprint", { root: PKG_ROOT, inputs: files });
  const fpSame = fp && fp.fingerprint === cache.fingerprintJs(files);
  return [Boolean(same && fpSame), `${kernel.version()}: estimate total ${js.total} vs ${k?.total}, fingerprint ${fpSame ? "equal" : "DIFFERS"}`];
});

check("kernel walk == js walk, file for file", async () => {
  const kernel = await import("./core/kernel.js");
  if (!kernel.available()) return [true, "kernel absent, js only (bb kernel install)"];
  const { walk, walkJs } = await import("./core/fs.js");
  const k = walk(PKG_ROOT), j = walkJs(PKG_ROOT);
  const ks = new Set(k), jss = new Set(j);
  const onlyK = k.filter((x) => !jss.has(x)), onlyJ = j.filter((x) => !ks.has(x));
  return [!onlyK.length && !onlyJ.length,
    `${k.length} files both ways${onlyK.length || onlyJ.length ? `; kernel-only ${onlyK.length}, js-only ${onlyJ.length}` : ""}`];
});

check("every kernel op is served by the kernel, not a silent fallback", async () => {
  const kernel = await import("./core/kernel.js");
  if (!kernel.available()) return [true, "kernel absent, js fallbacks active (bb kernel install)"];
  const { OPS } = await import("./kernel-cmd.js");
  const fell = OPS.filter(([, probe]) => probe() === null).map(([op]) => op);
  return [!fell.length, `${OPS.length - fell.length} of ${OPS.length} kernel-served${fell.length ? `; fell back: ${fell.join(", ")}` : ""}`];
});

check("expert == js on throttle", async () => {
  const expert = await import("./core/expert.js");
  const throttle = await import("./compile/throttle.js");
  const decisions = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, detector: "dead-exports", promote: true, priority: 3, ev: 10, est_tokens: 5000 })),
    { id: "g", detector: "god-file", promote: true, priority: 0, ev: 90, est_tokens: 4000 },
    { id: "h", detector: "orphan-files", promote: false, priority: 3, ev: 1, est_tokens: 100 },
  ];
  const js = throttle.apply(decisions, {}, {});
  if (!expert.available()) return [true, `python3 absent, js throttle only: ${js.summary}`];
  const py = expert.call("throttle", { decisions, cfg: {}, history: {} });
  if (!py) return [false, expert.lastError];
  const same = py.summary === js.summary
    && py.promoted.map((d) => d.id).join() === js.promoted.map((d) => d.id).join()
    && py.deferred.map((d) => d.throttle_reason).join() === js.deferred.map((d) => d.throttle_reason).join();
  return [same, same ? js.summary : `js "${js.summary}" vs py "${py.summary}"`];
});

check("expert == js on triage", async () => {
  const expert = await import("./core/expert.js");
  if (!expert.available()) return [true, "python3 absent, js triage only"];
  const { triage } = await import("./detectors/index.js");
  const cfg = { detectors: { promote_at: "medium" } };
  const fs_ = [{ detector: "doc-links", severity: "medium", precision: "exact", est_tokens: 800 }, { detector: "big-file", severity: "critical", precision: "exact", est_tokens: 90000 }, { detector: "god-file", severity: "medium", precision: "exact", est_tokens: 120000 }];
  const py = expert.call("triage", { findings: fs_, cfg });
  if (!py) return [false, expert.lastError];
  const diff = fs_.filter((f, i) => py[i].promote !== triage(f, cfg).promote || py[i].ev !== triage(f, cfg).ev);
  return [!diff.length, `${fs_.length} findings, ${diff.length} disagreements`];
});

check("degrades to unknown: no agents on an empty PATH, no transcripts for a missing root", async () => {
  const { detect } = await import("./adapters/index.js");
  const claude = (await import("./adapters/claude.js")).default;
  const saved = process.env.PATH; process.env.PATH = "";
  let n; try { n = detect().length; } finally { process.env.PATH = saved; }
  // null = the agent's transcript home does not exist (could not look);
  // [] = it exists and nothing matched (looked, found none). Both must hold.
  const dirs = claude.transcriptDirs("/nonexistent/root/for/bb", []);
  const looked = dirs === null || (Array.isArray(dirs) && dirs.length === 0);
  return [n === 0 && looked, `agents on empty PATH: ${n}; transcriptDirs(missing root): ${dirs === null ? "null (no transcript home)" : "[] (home exists, no match)"}`];
});

check("an unknown model has tokens and no cost", async () => {
  const prices = await import("./tokens/prices.js");
  const c = prices.cost("mystery-model-9", { inp: 1000 });
  const k = prices.cost("claude-sonnet-5", { inp: 1_000_000 });
  return [c === null && k && k.input === 2, `unknown -> ${c}; sonnet 1M input -> $${k?.input}`];
});

check("findings: a vanished finding closes, a returning one re-opens", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-self-"));
  const script = `process.env.BB_ROOT=${JSON.stringify(root)};const s=await import(${JSON.stringify(path.join(PKG_ROOT, "src/core/store.js"))});
const f={detector:"x",path:"a",key:"k",title:"t",severity:"low",files:["a"],evidence:{}};
const a=s.mergeFindings([f],{detectors:new Set(["x"])});const b=s.mergeFindings([],{detectors:new Set(["x"])});const c=s.mergeFindings([f],{detectors:new Set(["x"])});
console.log(JSON.stringify([a[0].status,b[0].status,c[0].status,c[0].seen_count]))`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const got = r.stdout.trim();
  return [got === '["open","resolved","open",2]', got || r.stderr.slice(-200)];
});

check("MCP server answers initialize and tools/list", async () => {
  const { serve } = await import("./mcp/server.js");
  const input = new PassThrough(), output = new PassThrough();
  let buf = ""; output.on("data", (d) => (buf += d));
  const done = serve({ input, output, name: "t", version: "0" });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await new Promise((r) => setTimeout(r, 200)); input.end(); await done;
  const lines = buf.trim().split("\n").map((l) => JSON.parse(l));
  const tools = lines[1]?.result?.tools || [];
  return [lines[0]?.result?.protocolVersion && tools.length >= 8 && tools.every((t) => t.inputSchema), `${tools.length} tools, protocol ${lines[0]?.result?.protocolVersion}`];
});

check("hooks exit 0 on empty and garbage stdin", async () => {
  const bb = path.join(PKG_ROOT, "bin/bb.js");
  const rcs = ["", "garbage", '{"tool_input":{"file_path":"/nope"}}'].map((inp) => spawnSync(process.execPath, [bb, "hook", "pre-read"], { input: inp, encoding: "utf8", timeout: 20000 }).status);
  return [rcs.every((c) => c === 0), `exit codes ${rcs.join(",")}`];
});

check("git guards refuse force flags, hook bypass, secret paths and an empty scope", async () => {
  const g = await import("./git/index.js");
  const refused = ["--force-with-lease=x", "-c core.hooksPath=/dev/null", "--no-verify"].map((f) => { try { g.guardArgs([f]); return false; } catch { return true; } });
  const sweep = g.secretSweep([".env", ".env.example", "config/credentials.json"]);
  const swept = Array.isArray(sweep) ? sweep : sweep?.refused || [];
  const empty = g.commit({ cwd: PKG_ROOT, scope: [], apply: false });
  return [refused.every(Boolean) && swept.includes(".env") && !swept.includes(".env.example") && empty && empty.ok === false, `refused ${refused.filter(Boolean).length}/3 flags; swept ${swept.join(",")}; empty scope: ${empty?.why || "?"}`];
});

check("session report labels MEASURED and ESTIMATE", async () => {
  const src = fs.readFileSync(path.join(PKG_ROOT, "src/tokens/session.js"), "utf8");
  const m = src.includes("MEASURED") && src.includes("ESTIMATE");
  return [m, m ? "both labels present in the report" : "a label is missing"];
});

check("bb help lists every verb", async () => {
  const { loadCommands } = await import("./cli.js");
  const { table, broken } = await loadCommands();
  const n = Object.keys(table).length;
  return [n >= 25 && !broken.length, `${n} verbs${broken.length ? `, ${broken.length} modules not loadable: ${broken.map((b) => b.group).join(",")}` : ""}`];
});

// ── the scenario half ───────────────────────────────────────────────────────

check("every shipped eval and playbook entry validates without reading data", async () => {
  const frames = await import("./frames/index.js");
  const failsafe = await import("./failsafe/index.js");
  const bad = frames.evals().flatMap(frames.checkOne);
  const fs2 = failsafe.check();
  const ok = !bad.length && fs2.ok;
  return [ok, ok ? `${frames.evals().length} evals, ${fs2.failures} failures, ${fs2.ops} ops`
    : [...bad, ...fs2.errors].slice(0, 3).join("; ")];
});

check("every corpus on this box asserts something", async () => {
  const corpus = await import("./cookbook/corpus.js");
  const ids = corpus.ids();
  if (!ids.length) return [true, "no corpora on this box (bb genesis <doc> seeds one)"];
  const bad = [];
  let scenarios = 0;
  for (const id of ids) {
    const c = corpus.load(id);
    scenarios += c.scenarios.length;
    const r = corpus.check(c);
    if (!r.ok) bad.push(`${id}: ${r.errors[0]}`);
  }
  return [!bad.length, bad.length ? bad.join("; ") : `${ids.length} corpora, ${scenarios} scenarios, all validate`];
});

check("every mainboard view declares a question and a category in the taxonomy", async () => {
  const mb = await import("./mainboard/index.js");
  const r = mb.check();
  return [r.ok, r.ok ? `${r.views} views, ${r.categories} categories` : r.errors.slice(0, 2).join("; ")];
});

check("every pipeline stage answers ok, gap or unknown and names its fix", async () => {
  const stages = await import("./pipeline/stages.js");
  const g = stages.gaps();
  const bad = g.stages.filter((s) => !["ok", "gap", "unknown"].includes(s.state) || !s.why || !s.fix);
  return [!bad.length, bad.length ? `${bad.map((s) => s.id).join(", ")} returned nothing usable`
    : `${g.ok} of ${g.of} hold${g.next ? `, first gap ${g.next.id}` : ""}`];
});

check("the kernel's pattern subset agrees with JavaScript", async () => {
  const kernel = await import("./core/kernel.js");
  if (!kernel.available()) return [true, "no kernel on this box; the JS engine serves every pattern"];
  const cases = [["^it-[0-9]+$", "it-12"], ["^it-[0-9]+$", "it-"], ["err(or)?s?", "errs"], ["\\d+ items", "3 items"], ["a.c", "abc"]];
  const bad = [];
  for (const [pattern, subject] of cases) {
    const k = kernel.call("rx", { pattern, subject });
    if (!k || k.supported !== true || k.match !== new RegExp(pattern).test(subject)) bad.push(`/${pattern}/ on ${subject}`);
  }
  const refused = kernel.call("rx", { pattern: "^[a-f]{8}$", subject: "abcdefab" });
  if (!refused || refused.supported !== false || refused.match !== undefined) bad.push("a pattern outside the subset was answered instead of refused");
  return [!bad.length, bad.length ? bad.join("; ") : `${cases.length} patterns agree, one refused by name`];
});

check("the window guard can answer, and never blocks on an unknown", async () => {
  const monitor = await import("./monitor/index.js");
  const g = monitor.guard({ plan: "custom" });
  const ok = typeof g.ok === "boolean" && Boolean(g.why) && (g.state !== "indeterminate" || g.ok === true);
  return [ok, `${g.state}: ${g.why}`];
});

export async function runAll() {
  const results = [];
  for (const c of checks) {
    const t0 = Date.now();
    let ok = false, note = "";
    try { [ok, note] = await c.fn(); } catch (e) { note = `threw: ${String(e.message || e).split("\n")[0]}`; }
    results.push({ label: c.label, ok: Boolean(ok), note, ms: Date.now() - t0 });
  }
  return results;
}

export const commands = {
  selftest: {
    help: "the silent-failure checks; each prints its measurement",
    usage: "bb selftest [--json]",
    run: async ({ flags }) => {
      const results = await runAll();
      const failed = results.filter((r) => !r.ok).length;
      if (flags.json) { emit({ results, failed }); return failed ? 1 : 0; }
      for (const r of results) out(`  ${r.ok ? "ok  " : "FAIL"}  ${r.label}\n        ${r.note}  (${r.ms} ms)`);
      out(`\n  ${results.length} checks, ${failed} failed`);
      return failed ? 1 : 0;
    },
  },
};
