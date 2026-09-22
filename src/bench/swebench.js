// bench/swebench.js — bundlebox on a public benchmark, measuring the thing
// bundlebox actually does.
//
// ── what this measures, and what it does not ────────────────────────────────
//
// SWE-bench Verified is 500 real GitHub issues with the maintainer's own patch
// as ground truth. The headline number people quote from it is RESOLVE RATE:
// run an agent, apply its patch, run the repo's tests. That number requires a
// model, a Docker image per repo, and the official harness. This file does not
// produce it and does not estimate it, because an estimated resolve rate is a
// made-up number with a real benchmark's name attached, and that is the exact
// thing the rest of this tree exists to refuse.
//
// What it measures instead is the half bundlebox is responsible for, on the
// same public instances:
//
//   LOCALISATION   given only the issue text, does the context bundlebox packs
//                  contain the files the maintainer actually changed? Scored
//                  against `patch`, which is the ground truth shipped with the
//                  dataset. Recall, precision, and the exact instance ids.
//
//   CONTEXT COST   what the same task costs to put in a window, packed against
//                  bare. Both arms counted by the same estimator over text on
//                  disk, on a real checkout at the instance's own base commit.
//
// Neither arm calls a model. Every input is public: the dataset over the
// Hugging Face datasets-server, the repository over git. The run writes the
// instance ids it used, so the number can be reproduced or contradicted.
//
// A localisation score is not a resolve rate and this file never converts one
// into the other. What it supports is the narrower claim bundlebox can actually
// defend: the packed window contains the right files, and it is smaller.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BB_DIR, HOME, PKG_ROOT, rel } from "../core/paths.js";
import { MAX_FILES } from "../pinpoint/index.js";
import { readJson, writeJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { human, now, stamp, table } from "../core/util.js";
import * as store from "../core/store.js";

export const DATASET = "princeton-nlp/SWE-bench_Verified";
export const ROWS_API = "https://datasets-server.huggingface.co/rows";
export const DIR = () => path.join(BB_DIR, "bench", "swebench");
export const REPOS = () => path.join(HOME, "swebench");
export const INSTANCES = () => path.join(DIR(), "instances.json");
export const LATEST = () => path.join(DIR(), "latest.json");

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/** The instance metadata, from the public datasets-server. No token, no login;
 *  the endpoint serves the same rows the dataset viewer shows. Cached, because
 *  a benchmark that re-downloads its own inputs on every run is a benchmark
 *  whose inputs can change underneath it. */
export async function fetchInstances({ limit = 100, offset = 0, refresh = false } = {}) {
  const cached = readJson(INSTANCES(), null);
  if (cached && !refresh && cached.rows.length >= offset + limit) return cached;
  const rows = cached && !refresh ? [...cached.rows] : [];
  // The API caps a page at 100.
  for (let at = rows.length; at < offset + limit; at += 100) {
    const url = `${ROWS_API}?dataset=${encodeURIComponent(DATASET)}&config=default&split=test&offset=${at}&length=${Math.min(100, offset + limit - at)}`;
    const res = await fetch(url);
    if (!res.ok) return { rc: 2, why: `${url} → HTTP ${res.status}. The dataset server is public; this is a network or rate-limit problem, not an auth one.` };
    const body = await res.json();
    for (const r of body.rows || []) {
      const x = r.row;
      rows.push({ instance_id: x.instance_id, repo: x.repo, base_commit: x.base_commit,
        problem_statement: x.problem_statement, difficulty: x.difficulty || "",
        gold_files: goldFiles(x.patch), test_files: goldFiles(x.test_patch) });
    }
    if (!body.rows || !body.rows.length) break;
  }
  const doc = { dataset: DATASET, at: now(), total: 500, rows };
  fs.mkdirSync(DIR(), { recursive: true });
  writeJson(INSTANCES(), doc);
  return doc;
}

/** The files the maintainer's own patch touched. This is the ground truth, and
 *  it is read from the dataset rather than inferred from anything. */
export function goldFiles(patch) {
  const out = new Set();
  for (const m of String(patch || "").matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) out.add(m[2]);
  return [...out];
}

const gitq = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });

/** A checkout of one instance's repository at its base commit.
 *
 *  Blobless (`--filter=blob:none`): the history's trees come down, the file
 *  contents are fetched on checkout. That is the difference between 12MB and
 *  several hundred for a repository like requests, and it is why this is
 *  runnable on a laptop rather than only in CI. */
export function checkout(inst, { log = () => {} } = {}) {
  const dir = path.join(REPOS(), inst.repo.replace("/", "__"));
  fs.mkdirSync(REPOS(), { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    log(`    cloning ${inst.repo} (blobless)`);
    const r = gitq(["clone", "--filter=blob:none", "--no-checkout", "--quiet", `https://github.com/${inst.repo}.git`, dir]);
    if (r.status !== 0) return { rc: 2, why: `clone ${inst.repo}: ${(r.stderr || "").trim().split("\n").pop()}` };
  }
  const head = gitq(["rev-parse", "HEAD"], dir);
  if (head.status === 0 && head.stdout.trim().startsWith(inst.base_commit)) return { rc: 0, dir, reused: true };
  let co = gitq(["checkout", "--quiet", "--force", inst.base_commit], dir);
  if (co.status !== 0) {
    const f = gitq(["fetch", "--quiet", "origin", inst.base_commit], dir);
    if (f.status !== 0) return { rc: 2, why: `fetch ${inst.base_commit}: ${(f.stderr || "").trim().split("\n").pop()}` };
    co = gitq(["checkout", "--quiet", "--force", inst.base_commit], dir);
  }
  if (co.status !== 0) return { rc: 2, why: `checkout ${inst.base_commit}: ${(co.stderr || "").trim().split("\n").pop()}` };
  return { rc: 0, dir, reused: false };
}

/** Both arms, run INSIDE the checkout by the same `bb` that is running here.
 *
 *  A child process rather than an in-process call because the workspace root is
 *  resolved once per process; running the arms against another tree means being
 *  another process rooted there. That is also what makes the measurement
 *  honest — it is the same code path a person gets by running `bb` in that
 *  repository. */
export function arms(dir, task, { timeout = 600000 } = {}) {
  const taskFile = path.join(dir, ".bundlebox", "swebench-task.json");
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  writeJson(taskFile, task);
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "bin", "bb.js"), "bench", "arm", "--file", taskFile, "--json"],
    { cwd: dir, encoding: "utf8", timeout, maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, BB_ROOT: dir } });
  if (r.status !== 0) return { rc: 2, why: `bb bench arm in ${rel(dir)}: ${(r.stderr || "").trim().split("\n").slice(-2).join(" | ") || `rc ${r.status}`}` };
  try { return { rc: 0, ...JSON.parse(r.stdout) }; }
  catch (e) { return { rc: 2, why: `bb bench arm returned unparseable json: ${e.message}` }; }
}

/** Did the packed window contain the files the maintainer changed?
 *
 *  Recall is the number that matters: a window missing the file the fix belongs
 *  in cannot produce the fix, whatever else it contains. Precision is reported
 *  beside it because a window that contains everything trivially recalls
 *  everything, and a benchmark that only reported recall would reward that. */
export function score(found, gold) {
  const f = new Set(found), g = new Set(gold);
  const hit = [...g].filter((x) => f.has(x));
  return { gold: gold.length, found: found.length, hit: hit.length,
    recall: pct(hit.length, gold.length), precision: pct(hit.length, Math.max(found.length, 1)),
    missed: [...g].filter((x) => !f.has(x)) };
}

export async function run({ n = 12, offset = 0, repos = "", cap = 10, maxFiles = MAX_FILES, write = true, log = out } = {}) {
  const all = await fetchInstances({ limit: Math.max(n * 4, 100), offset });
  if (all.rc) return all;
  let rows = all.rows.slice(offset);
  if (repos) { const want = repos.split(",").map((s) => s.trim()); rows = rows.filter((r) => want.some((w) => r.repo.includes(w))); }
  const picked = rows.slice(0, n);
  if (!picked.length) return { rc: 2, why: `no instance matched (offset ${offset}, repos "${repos}")` };

  const t0 = Date.now();
  const results = [];
  for (const [i, inst] of picked.entries()) {
    log(`  [${i + 1}/${picked.length}] ${inst.instance_id}`);
    const co = checkout(inst, { log });
    if (co.rc) { results.push({ ...meta(inst), error: co.why }); log(`    !! ${co.why}`); continue; }
    const a = arms(co.dir, { id: inst.instance_id, problem: inst.problem_statement.slice(0, 4000), cap, maxFiles });
    if (a.rc) { results.push({ ...meta(inst), error: a.why }); log(`    !! ${a.why}`); continue; }
    const packed = score(a.packed_files || [], inst.gold_files);
    const named = score(a.packed_named || a.packed_files || [], inst.gold_files);
    const bare = score(a.bare_files || [], inst.gold_files);
    results.push({ ...meta(inst), bare: a.bare, packed: a.packed,
      saved: a.bare - a.packed, saved_pct: pct(a.bare - a.packed, a.bare),
      localisation: packed, named_localisation: named, bare_localisation: bare, seconds: a.seconds,
      bare_ms: a.bare_ms ?? null, packed_ms: a.packed_ms ?? null,
      // prompt4.md W3: was the target's symbol space built before pinpoint ranked
      // it? A run where it was not is the baseline, and the two must not be
      // averaged together as one number.
      space: a.space || null });
    log(`    packed ${human(a.packed)} tok · bare ${human(a.bare)} tok · gold ${packed.hit}/${packed.gold} in scope, ${named.hit}/${named.gold} named${a.space?.built ? ` · space ${a.space.rows} rows` : a.space?.why ? ` · no space (${a.space.why})` : ""}`);
  }

  const ok = results.filter((r) => !r.error);
  const totals = {
    instances: results.length, measured: ok.length, errors: results.length - ok.length,
    bare: ok.reduce((s, r) => s + r.bare, 0), packed: ok.reduce((s, r) => s + r.packed, 0),
    gold: ok.reduce((s, r) => s + r.localisation.gold, 0), hit: ok.reduce((s, r) => s + r.localisation.hit, 0),
    bare_hit: ok.reduce((s, r) => s + r.bare_localisation.hit, 0),
    named_hit: ok.reduce((s, r) => s + r.named_localisation.hit, 0),
    named_all: ok.filter((r) => r.localisation.gold && r.named_localisation.hit === r.localisation.gold).length,
    any: ok.filter((r) => r.localisation.hit > 0).length,
    all: ok.filter((r) => r.localisation.gold && r.localisation.hit === r.localisation.gold).length,
    space_built: ok.filter((r) => r.space?.built).length,
    bare_ms: ok.reduce((s, r) => s + (r.bare_ms || 0), 0),
    packed_ms: ok.reduce((s, r) => s + (r.packed_ms || 0), 0),
  };
  totals.saved = totals.bare - totals.packed;
  totals.saved_pct = pct(totals.saved, totals.bare);
  totals.recall = pct(totals.hit, totals.gold);
  totals.bare_recall = pct(totals.bare_hit, totals.gold);
  totals.named_recall = pct(totals.named_hit, totals.gold);
  totals.ratio = totals.packed > 0 ? Math.round((totals.bare / totals.packed) * 10) / 10 : null;

  const result = {
    benchmark: "SWE-bench Verified", dataset: DATASET, at: now(),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    measures: "file-level localisation and context cost. NOT a resolve rate: no model was called and no test was run.",
    localisation_note: "IN SCOPE means the brief budgets the file to be read. NAMED means the brief also points at it as a ranked candidate the session may open. The two are reported separately because they cost differently — naming a file is about fifteen tokens, budgeting one is its whole size times the churn factor.",
    method: [
      "For each instance: clone the repository at the instance's own base_commit (blobless),",
      "hand bb only the issue text, and take two arms — BARE (search the tree, open the top N files whole)",
      "and PACKED (one `bb pinpoint` prompt). Score both file sets against the files the maintainer's",
      "own patch touched, which ships with the dataset. Both token counts come from bb's estimator",
      "over text on disk. Neither arm called a model.",
    ].join(" "),
    not_measured: "resolve rate, test pass rate, patch correctness. Those need the official harness and a model.",
    bare_read_cap: cap, max_files: maxFiles, offset, repos: repos || "(any)",
    reproduce: `bb bench swebench run --n ${n}${offset ? ` --offset ${offset}` : ""}${repos ? ` --repos ${repos}` : ""}`,
    instance_ids: picked.map((p) => p.instance_id),
    totals, instances: results,
  };
  if (write) {
    fs.mkdirSync(DIR(), { recursive: true });
    writeJson(path.join(DIR(), `${stamp()}.json`), result);
    writeJson(LATEST(), result);
    store.append("bench", { suite: "swebench", bare: totals.bare, packed: totals.packed, saved: totals.saved,
      saved_pct: totals.saved_pct, tasks: totals.measured, losses: ok.filter((r) => r.saved <= 0).length,
      recall: totals.recall });
  }
  return { rc: 0, ...result };
}

const meta = (i) => ({ id: i.instance_id, repo: i.repo, difficulty: i.difficulty,
  gold_files: i.gold_files, base_commit: i.base_commit });

export const latest = () => readJson(LATEST(), null);

export function report(r) {
  const t = r.totals;
  const L = [`  ${r.benchmark} — ${t.measured} instance(s) in ${r.seconds}s`, ""];
  L.push(table(r.instances.map((x) => [
    x.id.slice(0, 28), x.difficulty.slice(0, 12),
    x.error ? "—" : human(x.bare), x.error ? "—" : human(x.packed),
    x.error ? x.error.slice(0, 24) : `${x.saved_pct}%`,
    x.error ? "" : `${x.localisation.hit}/${x.localisation.gold}`,
    x.error ? "" : `${x.named_localisation.hit}/${x.named_localisation.gold}`,
    x.error ? "" : `${x.bare_localisation.hit}/${x.bare_localisation.gold}`,
  ]), { header: ["instance", "difficulty", "bare", "packed", "saved", "in scope", "named", "bare hit"] }));
  L.push("", `  LOCALISATION  in scope (budgeted to be read):  ${t.hit} of ${t.gold} gold file(s) — ${t.recall}%`);
  L.push(`                named  (in scope, or pointed at):  ${t.named_hit} of ${t.gold} — ${t.named_recall}%`);
  L.push(`                bare   (top ${r.bare_read_cap} files read whole):  ${t.bare_hit} of ${t.gold} — ${t.bare_recall}%`);
  L.push(`                ${t.all} instance(s) had every gold file in scope; ${t.named_all} had every one named`);
  L.push(`  CONTEXT       ${human(t.packed)} packed against ${human(t.bare)} bare — ${t.saved_pct}% less${t.ratio ? `, ${t.ratio}x` : ""}`);
  L.push(`  SPACE         symbol space built in ${t.space_built ?? 0} of ${t.measured} target(s) before ranking${(t.space_built ?? 0) === 0 ? " — this run is the baseline arm" : (t.space_built ?? 0) < t.measured ? " — a mixed run, not comparable to either arm" : ""}`);
  if (t.errors) L.push(`  ${t.errors} instance(s) could not be measured; they are in the table with the reason.`);
  L.push("", `  ${r.measures}`);
  if (r.localisation_note) L.push(`  ${r.localisation_note}`);
  L.push(`  NOT measured: ${r.not_measured}`);
  L.push(`  Reproduce:    ${r.reproduce}`);
  L.push(`  Instances:    ${r.instance_ids.join(" ")}`);
  return L.join("\n");
}
