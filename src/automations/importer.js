// automations/importer.js — automations somebody else wrote, taken in at a
// pinned commit and judged before anything can run them.
//
// Two sources in a GitHub repository become records: every `run:` job in
// `.github/workflows/*.yml`, and every entry in the root `package.json`
// `scripts`. A `uses:` step is not imported: it is an action, it runs on a
// runner, and there is nothing local to execute.
//
// The trust gate is the point of this file, and it is three layers.
//
//   pin       the ref must be a full 40-hex commit SHA. A tag or a branch is a
//             name somebody can move after the import was judged. The commit
//             must also be reachable from the default branch: a fork's commit
//             resolves under the parent's name (zizmor `impostor-commit`).
//   content   each file's git blob SHA-1 is recomputed from the bytes that
//             arrived and compared with the tree's; a mismatch refuses the
//             import. A SHA-256 per record is what `trust` is bound to, so a
//             re-import that changes one byte of a command voids its trust.
//   rules     each command is checked for the patterns GitHub's hardening guide
//             and zizmor name — expression injection, `curl | sh`, destructive
//             one-liners, secrets — and a `block` finding makes the record
//             unrunnable, with no override. `warn` findings are shown and
//             leave the decision to the person running `bb automations trust`.
//
// Nothing here runs anything. Fetching is injectable so the tests need no
// network, and nothing but the CLI calls `importRepo`: an agent can list and
// run records, it cannot take in new ones or trust them.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { BB_DIR } from "../core/paths.js";
import { readJson, writeJson } from "../core/config.js";
import { now } from "../core/util.js";

export const DIR = () => path.join(BB_DIR, "automations", "imports");
export const TRUST = () => path.join(BB_DIR, "automations", "trust.json");
export const MAX_BYTES = 1_000_000;
export const MAX_FILES = 50;

const SHA40 = /^[0-9a-f]{40}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** The id git gives a blob: SHA-1 over `blob <len>\0` and the bytes. */
export const blobSha = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

/** `owner/repo@sha` → parts, or a reason. */
export function parseRef(ref) {
  const m = /^([\w.-]+)\/([\w.-]+)@([0-9a-fA-F]+)$/.exec(String(ref || "").trim());
  if (!m) return { why: "expected owner/repo@<40-hex commit sha>" };
  const sha = m[3].toLowerCase();
  if (!SHA40.test(sha)) return { why: `\`${m[3]}\` is not a full commit SHA: a short SHA, tag or branch can be moved after the import was judged` };
  return { owner: m[1], repo: m[2], sha };
}

// ── rules ───────────────────────────────────────────────────────────────────

/** Each rule: an id, a severity, and a test over one command body. */
export const RULES = [
  { id: "expression", severity: "block", test: (c) => /\$\{\{/.test(c),
    detail: "uses ${{ }} expressions, which only an Actions runner evaluates" },
  { id: "template-injection", severity: "block", test: (c) => /\$\{\{[^}]*(github\.event\.|github\.head_ref|inputs\.)/.test(c),
    detail: "interpolates attacker-controllable context into a shell (GitHub hardening guide; zizmor template-injection)" },
  { id: "secrets", severity: "block", test: (c) => /\bsecrets\.\w+/.test(c),
    detail: "reads a repository secret" },
  { id: "pipe-to-shell", severity: "block", test: (c) => /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(c),
    detail: "downloads code and runs it unpinned" },
  { id: "destructive", severity: "block", test: (c) => /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{/.test(c),
    detail: "can destroy data outside the workspace" },
  { id: "publishes", severity: "block", test: (c) => /\b(npm publish|git push|gh release|docker push|twine upload|cargo publish|mcp-publisher publish)\b/.test(c),
    detail: "publishes or pushes; run here it would ship this workspace" },
  { id: "runner-env", severity: "warn", test: (c) => /\$\{?(GITHUB_(ENV|OUTPUT|STEP_SUMMARY|PATH)|RUNNER_\w+)\b/.test(c),
    detail: "writes to files only an Actions runner provides" },
  { id: "sudo", severity: "warn", test: (c) => /(^|[\s;&|])sudo\s/.test(c), detail: "asks for root" },
  { id: "network", severity: "warn", test: (c) => /\b(curl|wget|npx|pip install|npm (i|ci|install)\b|git clone)\b/.test(c),
    detail: "reaches the network when it runs" },
];

export function judge(cmd) {
  return RULES.filter((r) => r.test(cmd)).map(({ id, severity, detail }) => ({ rule: id, severity, detail }));
}

// ── workflows ───────────────────────────────────────────────────────────────

const indentOf = (l) => l.length - l.trimStart().length;
const unquote = (s) => { const t = s.trim(); return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t; };

/** The subset of a workflow this needs: triggers, and per job its steps' name,
 *  run and uses. Block scalars (`|`, `>`) are kept verbatim. Anything outside
 *  the subset is skipped, not guessed; a job with no readable step imports as
 *  nothing, which is the safe failure. */
export function parseWorkflow(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const on = new Set();
  const jobs = [];
  let section = "", job = null, step = null, stepIndent = -1, stepsAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const ind = indentOf(line);
    const t = line.trim();
    if (ind === 0) {
      const m = /^("?on"?|jobs|permissions)\s*:\s*(.*)$/.exec(t);
      section = m ? m[1].replace(/"/g, "") : "";
      if (section === "on" && m[2]) for (const x of m[2].replace(/[[\]]/g, "").split(",")) if (x.trim()) on.add(unquote(x));
      job = null; step = null;
      continue;
    }
    if (section === "on") {
      const m = /^-?\s*([\w-]+)\s*:?/.exec(t);
      if (m && ind <= 2) on.add(m[1]);
      continue;
    }
    if (section !== "jobs") continue;
    if (ind === 2 && /^[\w-]+\s*:\s*$/.test(t)) { job = { id: t.replace(/\s*:\s*$/, ""), steps: [] }; jobs.push(job); step = null; stepsAt = -1; continue; }
    if (!job) continue;
    // Only items under the job's own `steps:` key are steps; `needs:` and a
    // matrix are lists too. YAML lets the dash sit at the key's own column.
    if (stepsAt < 0 || ind < stepsAt || (ind === stepsAt && !t.startsWith("- "))) {
      stepsAt = /^steps\s*:\s*$/.test(t) ? ind : -1;
      step = null; stepIndent = -1;
      continue;
    }
    const item = /^-\s+(.*)$/.exec(t);
    if (item && (stepIndent < 0 || ind === stepIndent)) {
      stepIndent = ind;
      step = {};
      job.steps.push(step);
      i = field(lines, i, item[1], ind + 2, step);
      continue;
    }
    // A step's own keys sit two past its dash; anything deeper is `with:` or
    // `env:`, whose `name:` is not the step's.
    if (step && ind === stepIndent + 2) i = field(lines, i, t, ind, step);
  }
  return { on: [...on], jobs };
}

/** One `key: value` of a step, reading a block scalar to its end. */
function field(lines, i, t, ind, step) {
  const m = /^([\w-]+)\s*:\s*(.*)$/.exec(t);
  if (!m || !["name", "run", "uses", "shell", "working-directory"].includes(m[1])) return i;
  const [, key, rest] = m;
  if (/^[|>][-+]?\s*$/.test(rest)) {
    const body = [];
    let j = i + 1, base = -1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) { body.push(""); continue; }
      const li = indentOf(l);
      if (li <= ind) break;
      if (base < 0) base = li;
      body.push(l.slice(base));
    }
    while (body.length && !body[body.length - 1]) body.pop();
    step[key] = rest.startsWith(">") ? body.join(" ") : body.join("\n");
    return j - 1;
  }
  step[key] = unquote(rest);
  return i;
}

// ── records ─────────────────────────────────────────────────────────────────

const DANGEROUS_TRIGGERS = new Set(["pull_request_target", "workflow_run"]);
const INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish"]);

function record(src, { origin, file, name, title, cmd, extra = [] }) {
  const id = `gh:${src.owner}/${src.repo}@${src.sha.slice(0, 7)}:${origin}:${name}`;
  const findings = [...judge(cmd), ...extra];
  const blocked = findings.filter((f) => f.severity === "block");
  return { id, kind: "imported", origin, title, file, cmd, sha256: sha256(cmd),
    source: `${src.owner}/${src.repo}@${src.sha}`, findings,
    runnable: blocked.length === 0, why: blocked.length ? blocked.map((f) => f.rule).join(", ") : "" };
}

/** Workflow text → one record per job that has at least one `run:` step. */
export function workflowRecords(src, file, text) {
  const wf = parseWorkflow(text);
  const trig = wf.on.filter((t) => DANGEROUS_TRIGGERS.has(t))
    .map((t) => ({ rule: "dangerous-trigger", severity: "warn", detail: `the workflow runs on ${t}, which can execute fork code with write access` }));
  const out = [];
  for (const job of wf.jobs) {
    const runs = job.steps.filter((s) => s.run);
    if (!runs.length) continue;
    const uses = job.steps.filter((s) => s.uses).map((s) => s.uses);
    const unpinned = uses.filter((u) => !u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u) && !/@sha256:/.test(u));
    const extra = [...trig];
    if (uses.length) extra.push({ rule: "skipped-actions", severity: "warn", detail: `the job's ${uses.length} \`uses:\` step(s) are not run locally: ${uses.join(", ")}` });
    if (unpinned.length) extra.push({ rule: "unpinned-uses", severity: "warn", detail: `actions not pinned to a commit SHA: ${unpinned.join(", ")}` });
    const cmd = runs.map((s) => (s["working-directory"] ? `(cd ${JSON.stringify(s["working-directory"])} && ${s.run})` : s.run)).join("\n");
    const stem = path.basename(file).replace(/\.ya?ml$/, "");
    out.push(record(src, { origin: "workflow", file, name: `${stem}/${job.id}`,
      title: `${stem} › ${job.id}: ${runs.map((s) => s.name || s.run.split("\n")[0]).join(" → ").slice(0, 120)}`, cmd, extra }));
  }
  return out;
}

/** package.json text → one record per script. The body is imported as-is:
 *  `npm run x` here would run THIS repository's x, not the one judged. */
export function packageRecords(src, file, text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return []; }
  return Object.entries(pkg?.scripts || {}).filter(([, v]) => typeof v === "string").map(([name, cmd]) =>
    record(src, { origin: "package", file, name, title: `npm script \`${name}\`: ${cmd.slice(0, 100)}`, cmd,
      extra: INSTALL_HOOKS.has(name) ? [{ rule: "install-hook", severity: "warn", detail: "an npm lifecycle hook runs without being asked for" }] : [] }));
}

// ── fetching ────────────────────────────────────────────────────────────────

/** The default fetcher: GitHub's REST API for metadata, raw for bytes.
 *  GITHUB_TOKEN is sent when set, to lift the anonymous rate limit. */
export function githubFetcher({ token = process.env.GITHUB_TOKEN || "", timeout = 20000 } = {}) {
  const get = async (url, accept) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "bundlebox", Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(t); }
  };
  const api = (p) => get(`https://api.github.com${p}`, "application/vnd.github+json").then((b) => JSON.parse(b.toString("utf8")));
  return {
    repo: (o, r) => api(`/repos/${o}/${r}`),
    compare: (o, r, base, head) => api(`/repos/${o}/${r}/compare/${encodeURIComponent(base)}...${head}`),
    tree: (o, r, sha) => api(`/repos/${o}/${r}/git/trees/${sha}?recursive=1`),
    raw: (o, r, sha, p) => get(`https://raw.githubusercontent.com/${o}/${r}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`, "*/*"),
  };
}

/** Fetch, verify, judge. Returns the import document; `apply` writes it. */
export async function importRepo(ref, { fetcher = githubFetcher(), apply = false } = {}) {
  const src = parseRef(ref);
  if (src.why) return { rc: 2, why: src.why };
  const { owner, repo, sha } = src;
  // Reachability: a commit only a fork holds still resolves under the parent.
  const meta = await fetcher.repo(owner, repo);
  const cmp = await fetcher.compare(owner, repo, meta.default_branch, sha);
  if (!["identical", "behind"].includes(cmp.status)) {
    return { rc: 1, why: `${sha.slice(0, 12)} is not on ${meta.default_branch} (compare says \`${cmp.status}\`): refusing a commit the default branch does not contain (impostor-commit)` };
  }
  const tree = await fetcher.tree(owner, repo, sha);
  if (tree.truncated) return { rc: 1, why: "the tree listing is truncated; this repository is too large to import whole" };
  const wanted = (tree.tree || []).filter((e) => e.type === "blob" &&
    (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.path) || e.path === "package.json"));
  if (wanted.length > MAX_FILES) return { rc: 1, why: `${wanted.length} files to import; the ceiling is ${MAX_FILES}` };
  const files = [], records = [], refused = [];
  for (const e of wanted) {
    if (e.size > MAX_BYTES) { refused.push({ path: e.path, why: `${e.size} bytes, over ${MAX_BYTES}` }); continue; }
    const buf = await fetcher.raw(owner, repo, sha, e.path);
    const got = blobSha(buf);
    if (got !== e.sha) return { rc: 1, why: `${e.path}: the bytes that arrived hash to ${got}, the tree says ${e.sha}. Refusing the whole import` };
    const text = buf.toString("utf8");
    files.push({ path: e.path, blob: e.sha, sha256: sha256(buf), bytes: buf.length });
    records.push(...(e.path === "package.json" ? packageRecords(src, e.path, text) : workflowRecords(src, e.path, text)));
  }
  const doc = { source: { owner, repo, sha, default_branch: meta.default_branch, fetched_at: now() }, files, refused, records };
  const file = path.join(DIR(), `${owner}__${repo}@${sha.slice(0, 12)}.json`);
  if (apply) { fs.mkdirSync(DIR(), { recursive: true }); writeJson(file, doc); }
  return { rc: 0, file, wrote: apply, ...doc };
}

// ── the stored side ─────────────────────────────────────────────────────────

/** Every imported record on disk, each with its trust resolved. */
export function records() {
  let names = [];
  try { names = fs.readdirSync(DIR()).filter((n) => n.endsWith(".json")); } catch { return []; }
  const trust = readJson(TRUST(), {}) || {};
  const out = [];
  for (const n of names.sort()) {
    const d = readJson(path.join(DIR(), n), null);
    for (const r of d?.records || []) out.push({ ...r, trusted: Boolean(trust[r.id] && trust[r.id].sha256 === r.sha256) });
  }
  return out;
}

/** A person's decision that this exact command may run here. Bound to the
 *  command's SHA-256, so a re-import that changes it is untrusted again. */
export function trust(id, { revoke = false } = {}) {
  const r = records().find((x) => x.id === id);
  if (!r) return { rc: 2, why: `no imported record \`${id}\`: bb automations list --source import` };
  const t = readJson(TRUST(), {}) || {};
  if (revoke) { delete t[id]; writeJson(TRUST(), t); return { rc: 0, id, trusted: false }; }
  if (!r.runnable) return { rc: 1, why: `\`${id}\` has blocking findings (${r.why}); it cannot be trusted` };
  t[id] = { sha256: r.sha256, at: now() };
  fs.mkdirSync(path.dirname(TRUST()), { recursive: true });
  writeJson(TRUST(), t);
  return { rc: 0, id, trusted: true };
}
