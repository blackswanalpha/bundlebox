// _shared.js — what every detector reads once. One corpus, one identifier index,
// one import graph: sixteen detectors reading the tree sixteen times is how a
// scan stops being free, and two import parsers is how orphan-files and god-file
// disagree about who imports whom. Not a detector; index.js never registers it.
import fs from "node:fs";
import path from "node:path";
import { isGenerated, langOf, walk } from "../core/fs.js";
import { load } from "../core/config.js";
import { gitOk } from "../core/exec.js";
import * as filecache from "../core/filecache.js";
import { rel } from "../core/paths.js";
import { sha1 } from "../core/util.js";

export const CODE_LANGS = new Set(["js", "ts", "py", "dart", "go", "rust", "java", "kotlin", "ruby", "php",
  "csharp", "swift", "c", "cpp", "h", "hpp", "scala", "ex", "exs", "lua", "zig", "vue", "svelte"]);
export const isCode = (p) => CODE_LANGS.has(langOf(p));

// A test file is never dead, never an orphan and never a debug leak: it is
// referenced by the runner, not by an import.
export const TEST_RE = /(^|\/)(tests?|__tests__|specs?|testing|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$|_test\.(go|py|rb|dart|rs|ex|exs)$|_spec\.rb$|Tests?\.(java|kt|cs|swift)$/;
export const isTest = (p) => TEST_RE.test(String(p).replace(/\\/g, "/"));
// Config and entry files are loaded by a tool, not imported by code.
export const CONFIG_RE = /(^|\/)([^/]*\.config\.[cm]?[jt]s|[^/]*rc\.[cm]?js|tsconfig[^/]*\.json|package\.json|pyproject\.toml|setup\.py|setup\.cfg|manage\.py|conftest\.py|Cargo\.toml|pubspec\.yaml|Makefile|Dockerfile)$/;
export const ENTRY_RE = /(^|\/)(index|main|mod|lib|app|server|cli|__init__|__main__)\.[a-z]+$/;

/** Text offset -> 1-based line. Binary search over line starts, built once per text. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= idx) lo = m; else hi = m - 1; }
    return lo + 1;
  };
}

/** Same text with every fenced block blanked, line count preserved so the line
 *  numbers a detector reports still point into the real document. */
export function blankFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { out.push(""); if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; continue; }
    if (m) { fence = m[1]; out.push(""); continue; }
    out.push(line);
  }
  return out.join("\n");
}
export function inFence(text, lineNo) {
  const lines = text.split("\n");
  let fence = null;
  for (let i = 0; i < Math.min(lineNo, lines.length); i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; }
    else if (m) fence = m[1];
  }
  return fence !== null;
}

export function cache(ctx, key, build) {
  ctx._cache ??= {};
  if (!(key in ctx._cache)) ctx._cache[key] = build();
  return ctx._cache[key];
}
/** rel -> text for every walked file. */
export function corpus(ctx) {
  return cache(ctx, "corpus", () => {
    const m = new Map();
    for (const p of ctx.files) m.set(rel(p), ctx.readText(p));
    return m;
  });
}
/** sha1 of a file's text, once per scan. The key filecache entries are read by. */
export function shaOf(ctx, r, text) {
  const m = cache(ctx, "sha", () => new Map());
  if (!m.has(r)) m.set(r, sha1(text));
  return m.get(r);
}
/** The filecache kind for a token count: the coefficients are part of it, so a
 *  recalibration re-counts instead of serving counts made with the old ones. */
export const tokenKind = (kind) => `tokens:${kind}:${sha1(JSON.stringify(load().tokens || {})).slice(0, 10)}`;
/** A set of words stored as one space-joined string: none of them holds a
 *  space, and one string parses far faster than an array of thousands. */
export const wordSet = (joined) => new Set(joined ? joined.split(" ") : []);
export function wordsOf(re, text) {
  const s = new Set();
  re.lastIndex = 0;
  let x;
  while ((x = re.exec(text))) s.add(x[0]);
  return [...s].join(" ");
}

const IDENT = /[A-Za-z_$][\w$]*/g;
/** rel -> Set of identifiers. A word-boundary search per symbol over the whole
 *  corpus is O(symbols × bytes); a set per file is O(bytes) once. */
export function idents(ctx) {
  return cache(ctx, "idents", () => {
    const m = new Map();
    for (const [r, t] of corpus(ctx)) m.set(r, wordSet(filecache.derived(r, shaOf(ctx, r, t), "idents", () => wordsOf(IDENT, t))));
    return m;
  });
}
/** identifier -> up to two files that hold it. Two is enough: usedElsewhere
 *  only asks whether a file other than `self` holds the name, and walking every
 *  file's set per symbol was 3 s of a django scan. */
function holders(ctx) {
  return cache(ctx, "holders", () => {
    const m = new Map();
    for (const [r, s] of idents(ctx)) for (const name of s) {
      const h = m.get(name);
      if (!h) m.set(name, [r]); else if (h.length < 2) h.push(r);
    }
    return m;
  });
}
export function usedElsewhere(ctx, name, self) {
  const h = holders(ctx).get(name);
  return Boolean(h) && (h.length > 1 || h[0] !== self);
}

// ── import graph ────────────────────────────────────────────────────────────
const JS_SPEC = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_SPEC = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([\w*]+)|^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;
const DART_SPEC = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm;
const RUST_SPEC = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;|^\s*(?:pub\s+)?use\s+crate::([\w:]+)/gm;
const RUBY_SPEC = /require_relative\s+['"]([^'"]+)['"]/g;
const PHP_SPEC = /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g;
const JS_EXT = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".json"];

/** Raw import specifiers of one file: [{spec, kind:"rel"|"pkg"|"abs"}]. */
export function specsOf(r, text) {
  const lang = langOf(r);
  const out = [];
  const all = (re, pick) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) out.push(pick(m)); };
  if (lang === "js" || lang === "ts" || lang === "vue" || lang === "svelte") {
    all(JS_SPEC, (m) => { const s = m[1] || m[2] || m[3]; return { spec: s, kind: s.startsWith(".") || s.startsWith("/") ? "rel" : "pkg" }; });
  } else if (lang === "py") {
    all(PY_SPEC, (m) => {
      if (m[1]) return { spec: m[1], sub: m[2], kind: m[1].startsWith(".") ? "rel" : "abs" };
      return { spec: m[3].split(/\s*,\s*/)[0], kind: "abs", multi: m[3].split(/\s*,\s*/) };
    });
  } else if (lang === "dart") {
    all(DART_SPEC, (m) => ({ spec: m[1], kind: m[1].startsWith("package:") || m[1].startsWith("dart:") ? "pkg" : "rel" }));
  } else if (lang === "rust") {
    all(RUST_SPEC, (m) => (m[1] ? { spec: m[1], kind: "mod" } : { spec: m[2], kind: "crate" }));
  } else if (lang === "ruby") {
    all(RUBY_SPEC, (m) => ({ spec: m[1], kind: "rel" }));
  } else if (lang === "php") {
    all(PHP_SPEC, (m) => ({ spec: m[1], kind: "rel" }));
  }
  return out;
}

/** specsOf through the filecache: every caller that parses a file's imports
 *  shares one entry, so a detector that calls specsOf itself re-parses nothing. */
export const cachedSpecs = (ctx, r, text) => filecache.derived(r, shaOf(ctx, r, text), "specs", () => specsOf(r, text));

const norm = (p) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
function first(cands, fileSet) { for (const c of cands) { const n = norm(c); if (fileSet.has(n)) return n; } return null; }

/** Resolve one specifier from `fromRel` to a walked rel path, or null. Real
 *  resolution: a basename match was how the original called `util/log.js` and
 *  `core/log.js` the same file. */
export function resolveSpec(fromRel, s, fileSet) {
  const dir = path.posix.dirname(fromRel);
  const lang = langOf(fromRel);
  if (lang === "js" || lang === "ts" || lang === "vue" || lang === "svelte") {
    if (s.kind !== "rel") return null;
    const base = norm(path.posix.join(dir, s.spec.split("?")[0]));
    const cands = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => base + "/index" + e)];
    // TS sources import `./x.js` and mean `./x.ts`.
    if (/\.[cm]?js$/.test(base)) cands.push(base.replace(/\.[cm]?js$/, ".ts"), base.replace(/\.[cm]?js$/, ".tsx"));
    return first(cands, fileSet);
  }
  if (lang === "py") {
    const mods = [];
    if (s.kind === "rel") {
      const dots = s.spec.match(/^\.+/)[0].length;
      let d = dir;
      for (let i = 1; i < dots; i++) d = path.posix.dirname(d);
      const tail = s.spec.slice(dots).replace(/\./g, "/");
      mods.push(norm(path.posix.join(d, tail)));
      if (s.sub && s.sub !== "*") mods.push(norm(path.posix.join(d, tail, s.sub)));
    } else {
      const m = s.spec.replace(/\./g, "/");
      // An absolute module can sit at the root, under src/, or beside the
      // importer's own package: try each rather than guess one layout.
      const bases = new Set(["", "src", "lib", "app"]);
      let d = dir;
      while (d && d !== ".") { bases.add(d); d = path.posix.dirname(d); }
      for (const b of bases) { mods.push(norm(path.posix.join(b, m))); if (s.sub && s.sub !== "*") mods.push(norm(path.posix.join(b, m, s.sub))); }
    }
    const cands = [];
    for (const m of mods) cands.push(m + ".py", m + "/__init__.py");
    return first(cands, fileSet);
  }
  if (lang === "dart") {
    if (s.kind === "rel") return first([path.posix.join(dir, s.spec)], fileSet);
    const m = /^package:[^/]+\/(.+)$/.exec(s.spec);
    return m ? first(["lib/" + m[1]], fileSet) : null;
  }
  if (lang === "rust") {
    if (s.kind === "mod") return first([path.posix.join(dir, s.spec + ".rs"), path.posix.join(dir, s.spec, "mod.rs")], fileSet);
    const parts = s.spec.split("::");
    const cands = [];
    for (let i = parts.length; i > 0; i--) { const p = "src/" + parts.slice(0, i).join("/"); cands.push(p + ".rs", p + "/mod.rs"); }
    return first(cands, fileSet);
  }
  if (lang === "ruby") return first([path.posix.join(dir, s.spec), path.posix.join(dir, s.spec + ".rb")], fileSet);
  if (lang === "php") return first([path.posix.join(dir, s.spec)], fileSet);
  return null;
}

/** { edges: rel -> Set(rel), fanIn: rel -> n, pkgs: Set of package names imported }. */
export function importGraph(ctx) {
  return cache(ctx, "imports", () => {
    const files = corpus(ctx);
    const fileSet = new Set(files.keys());
    const edges = new Map(), fanIn = new Map(), pkgs = new Set();
    for (const [r, text] of files) {
      if (!isCode(r)) continue;
      const targets = new Set();
      // The specs are this file's alone; resolving them reads the file set, so
      // only the parse is cached.
      for (const s of cachedSpecs(ctx, r, text)) {
        if (s.kind === "pkg") { pkgs.add(pkgName(s.spec)); continue; }
        const t = resolveSpec(r, s, fileSet);
        if (t && t !== r) targets.add(t);
      }
      edges.set(r, targets);
      for (const t of targets) fanIn.set(t, (fanIn.get(t) || 0) + 1);
    }
    return { edges, fanIn, pkgs };
  });
}
/** `@scope/name/deep` -> `@scope/name`; `name/deep` -> `name`; `node:fs` -> null. */
export function pkgName(spec) {
  if (spec.startsWith("node:") || spec.startsWith("dart:")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Finding-ish with the defaults every detector would otherwise repeat. */
export function finding(o) {
  const files = o.files || [];
  return { severity: "low", detail: "", evidence: {}, fix_hint: "", auto_fix: null, kind: "fix",
    ...o, files, path: o.path ?? files[0] ?? ".", key: o.key ?? o.path ?? files[0] ?? o.title };
}
export const snippet = (line, n = 120) => String(line ?? "").trim().slice(0, n);
export { rel };

// ── additions: git presence, manifests, basename index ──────────────────────

/** True only when the root is a git work tree the binary can read. A detector
 *  that needs git returns [] without this, never a guess from the file tree. */
export function gitAvailable(ctx) {
  return cache(ctx, "gitAvailable", () => fs.existsSync(path.join(ctx.root, ".git")) && gitOk(ctx.root));
}
/** Parsed root package.json or null. One parse; five detectors read it. */
export function packageJson(ctx) {
  return cache(ctx, "packageJson", () => {
    try { return JSON.parse(fs.readFileSync(path.join(ctx.root, "package.json"), "utf8")); } catch { return null; }
  });
}
/** basename -> [rel] over EVERY file in the tree (no suffix filter), because a
 *  document may cite an svg or a shell script the source walk never lists. */
export function basenameIndex(ctx) {
  return cache(ctx, "basenames", () => {
    const idx = new Map();
    for (const p of walk(ctx.root, { suffixes: null })) {
      const r = rel(p), b = path.posix.basename(r.replace(/\\/g, "/"));
      if (!idx.has(b)) idx.set(b, []);
      idx.get(b).push(r);
    }
    return idx;
  });
}
/** Walked code files as rel paths, generated files excluded. */
export function codeRels(ctx, { tests = true } = {}) {
  return cache(ctx, `codeRels:${tests}`, () => {
    const out = [];
    for (const [r, t] of corpus(ctx)) {
      if (!isCode(r)) continue;
      if (!tests && isTest(r)) continue;
      if (isGeneratedText(r, t)) continue;
      out.push(r);
    }
    return out;
  });
}
// The header markers live in core/fs.js and are read from there: two lists of
// what "generated" looks like is how a document counts as derived for one
// detector and hand-written for the next.
const GEN_NAME = /\.min\.(js|css)$|(^|\/)(vendor|third_party|public)\//;
export function isGeneratedText(r, text) {
  return GEN_NAME.test(r) || isGenerated(r, text.slice(0, 600));
}
/** Number of the line a 1-based `lineNo` sits on, trimmed to 120 chars. */
export function lineAt(text, lineNo) { return snippet(text.split("\n")[lineNo - 1]); }
/** Text of a root-relative file the walk may not list (a lockfile, a dotfile). */
export function readTextAt(ctx, r) { return ctx.readText(path.join(ctx.root, r)); }
