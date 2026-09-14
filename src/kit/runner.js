// runner.js — run the registered producers, skip what did not drift, say what happened.
//
// Not the lane runner: this spends milliseconds and never opens a session. The
// inputs and the fingerprint are computed BEFORE build() so a fresh artefact
// costs a stat pass and nothing else. A skip is a row, not silence, so the list
// does not get shorter every time the cache is right; a producer that throws is
// a row too, because one bad table must not lose the other nine. INDEX.md is
// rewritten on every build, even an all-fresh one, because it carries the token
// estimates a session reads to decide whether to open a table at all.
import fs from "node:fs";
import path from "node:path";
import { rel } from "../core/paths.js";
import { now, human, pad } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import * as cache from "./cache.js";

const metaKey = (reg, name) => `${reg.name}/${name}`;
export const metaOf = (reg, name) => cache.readMeta(metaKey(reg, name));

async function one(reg, name, force) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const job = reg.get(name);
  if (!job) return { name, state: "error", error: `no such producer; have ${reg.names().join(", ")}`, tokens: 0, ms: ms() };
  const artefact = reg.path(name);
  let inputs;
  try { inputs = await job.inputs(); } catch (e) { return { name, state: "error", error: `${e?.name || "Error"}: ${e?.message || e}`, tokens: 0, ms: ms() }; }
  const fp = cache.fingerprint(inputs);
  const old = metaOf(reg, name);
  if (!force && cache.fresh(old, artefact, fp)) {
    return { name, state: "fresh", tokens: old.tokens || 0, ms: ms(), built: old.built, inputs: cache.inputsOf(fp) };
  }
  let res;
  try { res = await job.build(); } catch (e) { return { name, state: "error", error: `${e?.name || "Error"}: ${e?.message || e}`, tokens: 0, ms: ms() }; }
  const payload = typeof res === "string" ? res : String(res?.payload ?? "");
  fs.mkdirSync(path.dirname(artefact), { recursive: true });
  fs.writeFileSync(artefact, payload.endsWith("\n") ? payload : payload + "\n");
  const tokens = estimate.text(payload, job.ext === "md" ? "prose" : "code");
  const meta = { name, group: job.group, description: job.description, built: now(), fingerprint: fp,
    inputs: cache.inputsOf(fp), bytes: Buffer.byteLength(payload), tokens, notes: res?.notes ?? null, artefact: rel(artefact) };
  cache.writeMeta(metaKey(reg, name), meta);
  return { name, state: "built", tokens, ms: ms(), inputs: meta.inputs };
}

/** Rows {name, state: built|fresh|error, tokens, ms} in the order asked for. */
export async function build(reg, { only = null, force = false } = {}) {
  fs.mkdirSync(reg.outDir, { recursive: true });
  const wanted = only && only.length ? only : reg.names();
  const rows = [];
  for (const n of wanted) rows.push(await one(reg, n, force));
  index(reg);
  return rows;
}

/** Rows {name, state: fresh|stale|missing, built, tokens} without building anything. */
export async function stale(reg, { only = null } = {}) {
  const rows = [];
  for (const name of (only && only.length ? only : reg.names())) {
    const job = reg.get(name);
    if (!job) { rows.push({ name, state: "error", error: "no such producer" }); continue; }
    let inputs;
    try { inputs = await job.inputs(); } catch (e) { rows.push({ name, state: "error", error: `${e?.name || "Error"}: ${e?.message || e}` }); continue; }
    const m = metaOf(reg, name);
    rows.push({ name, group: job.group, state: cache.state(m, reg.path(name), cache.fingerprint(inputs)), built: m.built || null, tokens: m.tokens || null });
  }
  return rows;
}

export function index(reg) {
  const L = [`# ${reg.title}`, ""];
  if (reg.blurb) L.push(reg.blurb, "");
  L.push("| artefact | what | ~tokens | built |", "|---|---|---|---|");
  for (const name of reg.names()) {
    const job = reg.get(name);
    const m = metaOf(reg, name);
    const fn = `${name}.${job.ext}`;
    if (m.built) L.push(`| [\`${fn}\`](${fn}) | ${m.description || job.description} | ${m.tokens ?? "?"} | ${String(m.built).slice(0, 16)} |`);
    else L.push(`| \`${fn}\` | ${job.description} | — | not built |`);
  }
  const p = path.join(reg.outDir, "INDEX.md");
  fs.mkdirSync(reg.outDir, { recursive: true });
  fs.writeFileSync(p, L.join("\n") + "\n");
  return p;
}

export function report(reg, rows) {
  const L = [];
  for (const r of rows) {
    if (r.state === "error") L.push(`  !! ${pad(r.name, 24)} ${r.error}`);
    else if (r.built !== undefined && r.ms === undefined) L.push(`  ${pad(r.state, 8)} ${pad(r.name, 24)} ${pad(r.tokens == null ? "-" : human(r.tokens), 7, true)} tok   ${r.built || ""}`);
    else L.push(`  ${pad(r.state, 8)} ${pad(r.name, 24)} ${pad(human(r.tokens || 0), 7, true)} tok   ${r.inputs ?? "?"} inputs   ${r.ms}ms`);
  }
  L.push("", `  index: ${rel(path.join(reg.outDir, "INDEX.md"))}`);
  return L.join("\n");
}
