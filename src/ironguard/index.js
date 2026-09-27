// ironguard — the security gate a branch passes before anything pushes it.
//
//   bb ironguard [check] [--base <ref>] [--cwd <dir>] [--json]
//   bb ironguard rules
//
// Reads the diff between the branch and its base, working tree included, and
// judges only what the change ADDS. Three levels:
//
//   block    nothing pushes: a secret, a protected path, a command that fetches
//            and runs code, TLS switched off, a diff too wide to be unattended
//   review   a draft PR may open, auto-merge may not: a new dependency, eval,
//            a shell spawn, a binary
//   ok       neither
//
// Sentinel calls `check` on every auto-fix branch and every lane branch before
// a push, and the A5 autonomy ladder only auto-merges a PR whose check came back
// with no `review` hit. No model, no network: a set of parses over `git diff`.
import fs from "node:fs";
import path from "node:path";
import { git } from "../core/exec.js";
import { call as kernelCall } from "../core/kernel.js";
import { load } from "../core/config.js";
import { ROOT } from "../core/paths.js";
import { out, warn, emit } from "../core/log.js";
import { table } from "../core/util.js";
import { PATTERNS, placeholder } from "../detectors/secret-scan.js";
import { baseRef } from "../sentinel/git.js";

// Code-shaped risks in an added line. The rule text is what the PR body shows.
export const RULES = [
  { id: "pipe-to-shell", level: "block", re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, note: "downloads and runs code" },
  { id: "rm-root", level: "block", re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|["'])/, note: "recursive delete of / or home" },
  { id: "tls-off", level: "block", re: /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0|rejectUnauthorized\s*:\s*false|verify\s*=\s*False\b/, note: "certificate checks switched off" },
  { id: "world-writable", level: "block", re: /\bchmod\s+(-R\s+)?0?777\b/, note: "world-writable permissions" },
  { id: "skip-hooks", level: "block", re: /--no-verify\b/, note: "skips the repository's hooks" },
  { id: "eval", level: "review", re: /(^|[^\w.])(eval|new\s+Function)\s*\(/, note: "evaluates a string as code" },
  { id: "shell-spawn", level: "review", re: /shell\s*:\s*true|\bexecSync\s*\(\s*`|os\.system\(|subprocess\.[a-z_]+\([^)]*shell\s*=\s*True/, note: "runs a command through a shell" },
];
const DEP_FILES = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|pubspec\.yaml)$/;
const LOCK_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|Gemfile\.lock|pubspec\.lock)$/;
const DEP_LINE = /^\s*"(?:@[\w.-]+\/)?[\w.-]+"\s*:\s*"[~^<>=*\d]|^\s*[\w.-]+\s*(==|>=|~=|=)\s*["']?\d/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|apk|so|dylib|exe|bin|wasm|dll)$/i;
const TEMPLATE = /\.(example|sample|template|dist)$/i;
// This file and its test hold the rules as text; judging them would block the gate itself.
const SELF = /^(src\/ironguard\/|test\/ironguard)/;

/** Does a diff path hit a `protected` entry? A trailing `/` is a prefix, a `*`
 *  a glob over the whole path or the basename, anything else the path or the
 *  basename exactly — and `.env` also covers `.env.local`, never `.env.example`. */
export function protectedHit(p, patterns) {
  const base = path.posix.basename(p);
  for (const pat of patterns || []) {
    const s = String(pat);
    if (s.endsWith("/")) { if (p.startsWith(s)) return s; continue; }
    if (s.includes("*")) {
      const re = new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
      if (re.test(p) || re.test(base)) return s;
      continue;
    }
    if (p === s || base === s) return s;
    if (s.startsWith(".") && base.startsWith(`${s}.`) && !TEMPLATE.test(base)) return s;
  }
  return null;
}

/** Unified diff -> [{ path, added: [{ line, text }], removed, binary }]. */
export function parseDiff(text) {
  const files = [];
  let cur = null, ln = 0;
  for (const raw of String(text).split("\n")) {
    if (raw.startsWith("diff --git ")) { cur = { path: (raw.match(/ b\/(.+)$/) || [])[1] || "", added: [], removed: 0, binary: false }; files.push(cur); continue; }
    if (!cur) continue;
    if (raw.startsWith("+++ ")) { if (raw !== "+++ /dev/null") cur.path = raw.slice(4).replace(/^b\//, ""); continue; }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("Binary files ")) { cur.binary = true; continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { ln = Number(h[1]); continue; }
    if (raw.startsWith("+")) { cur.added.push({ line: ln, text: raw.slice(1) }); ln += 1; }
    else if (raw.startsWith("-")) cur.removed += 1;
    else if (raw.startsWith(" ")) ln += 1;
  }
  return files;
}

/** The change under judgement: tracked edits against the merge base, plus
 *  untracked files whole, because a new file is the easiest place to add a key. */
export function collect({ cwd = ROOT, base = "", kernel = true } = {}) {
  const ref = base || baseRef(cwd);
  const mb = git(["merge-base", "HEAD", ref], cwd);
  const from = mb.rc === 0 ? mb.out.trim() : ref;
  // The kernel's `diffscan` does the spawn, the parse and the untracked reads
  // in one process; the rules below stay here either way.
  if (kernel) {
    const k = kernelCall("diffscan", { cwd, from, max_bytes: 2_000_000 });
    if (k && k.ok) return { ok: true, from, files: k.files || [], via: "kernel" };
  }
  const d = git(["diff", "--no-color", "--no-ext-diff", "-U0", from], cwd);
  if (d.rc !== 0) return { ok: false, why: `git diff ${from} failed: ${(d.err || d.out).trim().slice(0, 200)}`, files: [] };
  const files = parseDiff(d.out);
  const u = git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  for (const p of (u.rc === 0 ? u.out.split("\0").filter(Boolean) : [])) {
    if (BINARY.test(p)) { files.push({ path: p, added: [], removed: 0, binary: true }); continue; }
    let src = "";
    try { const st = fs.statSync(path.join(cwd, p)); if (!st.isFile() || st.size > 2_000_000) continue; src = fs.readFileSync(path.join(cwd, p), "utf8"); } catch { continue; }
    files.push({ path: p, added: src.split("\n").map((text, i) => ({ line: i + 1, text })), removed: 0, binary: false });
  }
  return { ok: true, from, files, via: "js" };
}

/** Judge a collected change. Pure: `files` in, verdict out. */
export function judge(files, cfg = load()) {
  const ig = cfg.ironguard || {};
  const hits = [];
  const hit = (rule, level, p, line, note) => hits.push({ rule, level, path: p, line, note });
  let added = 0, removed = 0;
  for (const f of files) {
    added += f.added.length; removed += f.removed;
    const prot = protectedHit(f.path, ig.protected);
    if (prot) hit("protected-path", "block", f.path, 0, `matches \`${prot}\``);
    if (f.binary) hit("binary", "review", f.path, 0, "a binary file changed");
    if (LOCK_FILES.test(f.path)) hit("lockfile", "review", f.path, 0, "the resolved dependency tree changed");
    if (SELF.test(f.path)) continue;
    const joined = f.added.map((a) => a.text).join("\n");
    for (const [label, re, klass] of PATTERNS) {
      for (const m of joined.matchAll(new RegExp(re.source, re.flags))) {
        if (placeholder(label, klass, joined, m, f.path)) continue;
        const line = f.added[joined.slice(0, m.index).split("\n").length - 1]?.line || 0;
        hit("secret", "block", f.path, line, `${label}: ${String(m[1] || m[0]).slice(0, 4)}****`);
      }
    }
    for (const a of f.added) {
      for (const r of RULES) if (r.re.test(a.text)) hit(r.id, r.level, f.path, a.line, r.note);
      if (DEP_FILES.test(f.path) && DEP_LINE.test(a.text)) hit("dependency", "review", f.path, a.line, `adds or moves \`${a.text.trim().slice(0, 60)}\``);
    }
  }
  const maxFiles = Number(ig.max_files) || 40, maxLines = Number(ig.max_lines) || 800;
  if (files.length > maxFiles) hit("too-wide", "block", "", 0, `${files.length} files > ironguard.max_files ${maxFiles}`);
  if (added + removed > maxLines) hit("too-long", "block", "", 0, `${added + removed} lines > ironguard.max_lines ${maxLines}`);
  const blocks = hits.filter((h) => h.level === "block"), reviews = hits.filter((h) => h.level === "review");
  return { ok: blocks.length === 0, auto_ok: blocks.length === 0 && reviews.length === 0, files: files.length, added, removed, blocks: blocks.length, reviews: reviews.length, hits };
}

/** Collect and judge. `{ ok, auto_ok, hits, ... }`; a diff that cannot be read
 *  is a block, because a gate that cannot see is not a pass. */
export function check({ cwd = ROOT, base = "", cfg = load() } = {}) {
  const c = collect({ cwd, base });
  if (!c.ok) return { ok: false, auto_ok: false, files: 0, added: 0, removed: 0, blocks: 1, reviews: 0, hits: [{ rule: "unreadable", level: "block", path: "", line: 0, note: c.why }] };
  return { from: c.from, via: c.via, ...judge(c.files, cfg) };
}

/** The verdict as markdown lines, for a PR body. */
export function summary(v) {
  if (!v.hits.length) return `ironguard: clean (${v.files} files, +${v.added} -${v.removed})`;
  return [`ironguard: ${v.blocks} block, ${v.reviews} review (${v.files} files, +${v.added} -${v.removed})`,
    ...v.hits.slice(0, 20).map((h) => `- ${h.level} \`${h.rule}\` ${h.path}${h.line ? `:${h.line}` : ""} — ${h.note}`)].join("\n");
}

export const commands = {
  ironguard: {
    help: "the security gate: judge what a branch adds before anything pushes it (no tokens)",
    usage: "bb ironguard [check] [--base <ref>] [--cwd <dir>] [--json] | rules",
    run: async ({ _, flags }) => {
      const sub = _[0] || "check";
      if (sub === "rules") {
        const cfg = load();
        if (flags.json) { emit({ rules: RULES.map((r) => ({ id: r.id, level: r.level, note: r.note })), protected: cfg.ironguard?.protected || [] }); return 0; }
        out(table([...RULES.map((r) => [r.id, r.level, r.note]), ["secret", "block", "a credential-shaped string (secret-scan's patterns)"],
          ["protected-path", "block", (cfg.ironguard?.protected || []).join(" ")], ["too-wide / too-long", "block", "past ironguard.max_files / max_lines"],
          ["dependency / lockfile", "review", "the dependency tree changed"], ["binary", "review", "a binary file changed"]], { header: ["rule", "level", "what"] }));
        return 0;
      }
      if (sub !== "check") { warn(`unknown: bb ironguard ${sub}`); return 2; }
      const v = check({ cwd: flags.cwd ? path.resolve(String(flags.cwd)) : ROOT, base: flags.base ? String(flags.base) : "" });
      if (flags.json) { emit(v); return v.ok ? 0 : 1; }
      out(`  ${summary(v).split("\n").join("\n  ")}`);
      out(v.ok ? (v.auto_ok ? "  PASS: may push, may auto-merge" : "  PASS: may push as a draft; a person merges") : "  BLOCKED: nothing pushes");
      return v.ok ? 0 : 1;
    },
  },
};
