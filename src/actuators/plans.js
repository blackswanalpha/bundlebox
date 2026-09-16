// plans.js — the seven actuators whose finding names a decision.
//
// `bb fix` could not touch these before, so each one sat in the worklist until
// a session opened it, and the first thing every one of those sessions did was
// re-derive something already on disk: which callers use which half of a god
// file, which lines two files actually share, what a test for this module would
// be called. That derivation is a set difference. It is free. Only the decision
// on top of it costs anything.
//
// So each actuator here computes the derivable half and writes it where the
// session will find it. None of them edits a file and none of them closes a
// finding: `planned` is not `changed`, and every result carries `keeps_open`.
import fs from "node:fs";
import path from "node:path";
import { langOf } from "../core/fs.js";
import { abs } from "../core/paths.js";
import { human } from "../core/util.js";
import * as estimate from "../tokens/estimate.js";
import { makeCtx } from "../detectors/index.js";
import { idents, importGraph } from "../detectors/_shared.js";
import { planned, quoteRange } from "./_plan.js";

const readOr = (r, fallback = "") => { try { return fs.readFileSync(abs(r), "utf8"); } catch { return fallback; } };
const linesOf = (r) => readOr(r).split("\n");

/** Top-level declarations and the span each one owns, by the next declaration.
 *  Regex, not a parser: a span that is one line long where the real one is
 *  three costs a brief three lines of context, and a parser per language costs
 *  this box a dependency it does not have. */
const DECL = {
  js: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  ts: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  py: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
  go: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  rust: /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
};
export function topLevelSpans(text, lang) {
  const re = DECL[lang];
  if (!re) return [];
  const lines = String(text).split("\n");
  const marks = [];
  lines.forEach((l, i) => { const m = re.exec(l); if (m) marks.push({ name: m[1], line: i + 1 }); });
  return marks.map((m, i) => ({ ...m, end: i + 1 < marks.length ? marks[i + 1].line - 1 : lines.length }));
}

/** Which of a file's exported names each importer actually mentions. The seam
 *  the fix_hint names: two symbols whose caller sets are disjoint were already
 *  two modules, and the import graph has been saying so the whole time. */
export function importSeam(ctx, target) {
  const { edges } = importGraph(ctx);
  const ids = idents(ctx);
  const names = [];
  for (const s of topLevelSpans(readOr(target), langOf(target))) {
    if (/^\s*export\b/.test(linesOf(target)[s.line - 1] || "")) names.push(s.name);
  }
  const importers = [];
  for (const [r, targets] of edges) if (r !== target && targets.has(target)) importers.push(r);
  const bySymbol = new Map();
  for (const n of names) {
    const users = [];
    for (const r of importers) if (ids.get(r)?.has(n)) users.push(r);
    bySymbol.set(n, users);
  }
  const groups = new Map();
  for (const [n, users] of bySymbol) {
    const sig = users.length ? users.slice().sort().join("|") : "(nothing in this tree)";
    if (!groups.has(sig)) groups.set(sig, { users, symbols: [] });
    groups.get(sig).symbols.push(n);
  }
  return { importers, groups: [...groups.values()].sort((a, b) => b.symbols.length - a.symbols.length) };
}

// ── god-file ────────────────────────────────────────────────────────────────

/** The split, as the import graph already draws it. Each group is a set of
 *  exports used by exactly the same callers, which is the definition of a
 *  module that was never separated out. */
export function planFileSplit(f, { apply = false } = {}) {
  return planned("plan-file-split", f, () => {
    const r = f.path;
    const ctx = makeCtx();
    const { importers, groups } = importSeam(ctx, r);
    if (!importers.length) {
      return { declined: [{ path: r, reason: `nothing in this tree imports ${r}; there is no caller partition to read a seam from` }], why: "no importers" };
    }
    const rows = [`\`${r}\` — ${f.evidence?.lines ?? "?"} lines, ${f.evidence?.functions ?? "?"} functions, imported by ${importers.length} file(s).`, ""];
    groups.forEach((g, i) => {
      rows.push(`## Group ${i + 1} — ${g.symbols.length} symbol(s), ${g.users.length} caller(s)`, "");
      rows.push(`  exports: ${g.symbols.join(", ")}`);
      rows.push(`  callers: ${g.users.length ? g.users.join(", ") : "none in this tree"}`, "");
    });
    return {
      rows, files: [r],
      title: `Split seam for ${r}`,
      why: "Every group below is a set of exports used by exactly the same callers. A group whose callers touch no other group can move to its own file without changing a single import site. Groups with overlapping callers are the decision this cannot make.",
      footer: groups.length < 2
        ? "One group: every caller uses every export, so the import graph shows no seam. Whatever splits this file, it is not the callers."
        : `${groups.length} groups. Moving group 1 to its own module rewrites ${groups[0].users.length} import line(s).`,
      why_count: groups.length,
    };
  }, { apply });
}

// ── big-file ────────────────────────────────────────────────────────────────

/** The region table, so the brief for this file quotes a range instead of the
 *  file. The fix_hint offers two fixes and this is the second one: "write the
 *  brief so the session reads a region". */
export function planFileRegions(f, { apply = false } = {}) {
  return planned("plan-file-regions", f, () => {
    const r = f.path;
    const text = readOr(r);
    const spans = topLevelSpans(text, langOf(r));
    if (!spans.length) {
      return { declined: [{ path: r, reason: `no top-level declaration found in ${r}; a file with no seams has no regions to quote` }], why: "no declarations" };
    }
    const lines = text.split("\n");
    const rows = [`\`${r}\` — ${human(f.evidence?.tokens ?? estimate.text(text, "code"))} tokens, ${lines.length} lines, ${f.evidence?.pct ?? "?"}% of one working window.`, "",
      "| region | lines | ~tokens |", "|---|---|---|"];
    for (const s of spans) {
      const body = lines.slice(s.line - 1, s.end).join("\n");
      rows.push(`| \`${s.name}\` | ${s.line}-${s.end} | ${human(estimate.text(body, "code"))} |`);
    }
    return {
      rows, files: [r],
      title: `Regions of ${r}`,
      why: "Reading this file whole costs a third of a window before any work happens. Every row below is a range a brief can quote instead. `bb pinpoint` takes an offset and a limit.",
      footer: `${spans.length} regions. The largest is \`${spans.slice().sort((a, b) => (b.end - b.line) - (a.end - a.line))[0].name}\`.`,
    };
  }, { apply });
}

// ── duplicate-blocks ────────────────────────────────────────────────────────

/** The shared block, quoted once, with both anchors. Lifting it is a decision
 *  about where the shared thing lives; knowing exactly what it is, is not. */
export function planBlockLift(f, { apply = false } = {}) {
  return planned("plan-block-lift", f, () => {
    const first = f.evidence?.first;
    if (!first?.a) return { declined: [{ path: f.path, reason: "the finding carries no anchor for the shared window" }], why: "no anchor" };
    const parse = (s) => { const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(String(s)); return m ? { r: m[1], from: Number(m[2]), to: Number(m[3] || m[2]) } : null; };
    const a = parse(first.a), b = parse(first.b);
    if (!a || !b) return { declined: [{ path: f.path, reason: "the anchors are not in `path:line-line` form" }], why: "unparsable anchor" };
    const text = readOr(a.r);
    if (!text) return { declined: [{ path: a.r, reason: `${a.r} is not readable` }], why: "unreadable" };
    const rows = [
      `\`${a.r}:${a.from}-${a.to}\` and \`${b.r}:${b.from}\` — ${f.evidence?.shared_lines ?? "?"} shared lines in total.`, "",
      "## The block, as it reads in the first file", "",
      ...quoteRange(text, a.from, a.to, langOf(a.r)), "",
    ];
    const other = readOr(b.r);
    if (other) rows.push("## The same window in the second file", "", ...quoteRange(other, b.from, b.from + (a.to - a.from), langOf(b.r)), "");
    return {
      rows, files: [a.r, b.r],
      title: `Shared block between ${a.r} and ${b.r}`,
      why: "Both copies are quoted below so the diff between them is readable without opening either file. Where the lifted version lives, and whether the two are meant to diverge, is the decision this leaves alone.",
      footer: "If they are meant to diverge, the fix is a comment at each saying so, and this finding closes on the next scan.",
    };
  }, { apply });
}

// ── orphan-files ────────────────────────────────────────────────────────────

/** What is actually known about each orphan: its size, its language and when
 *  git last touched it. Delete or import is the decision; how cold the file is,
 *  is a fact, and it is the fact the decision turns on. */
export function planOrphanDisposition(f, { apply = false } = {}) {
  return planned("plan-orphan-disposition", f, () => {
    const ctx = makeCtx();
    const files = f.evidence?.files || [];
    if (!files.length) return { declined: [{ path: f.path, reason: "the finding names no file" }], why: "no files" };
    const rows = [`${files.length} file(s) under \`${f.path}\` that nothing in this tree imports or names.`, "",
      "| file | lines | language | last touched |", "|---|---|---|---|"];
    for (const r of files) {
      const log = ctx.git(["log", "-1", "--format=%as %s", "--", r]);
      const when = log.rc === 0 && log.out.trim() ? log.out.trim().slice(0, 60) : "never committed";
      rows.push(`| \`${r}\` | ${f.evidence?.lines?.[r] ?? linesOf(r).length} | ${langOf(r) || "?"} | ${when} |`);
    }
    return {
      rows, files: files.slice(0, 20),
      title: `Orphans under ${f.path}`,
      why: "Nothing imports, requires or names any of these. The detector is heuristic on purpose: a framework that loads a file by convention leaves no import for it to see. The date is what separates a file nobody finished from a file nobody needs.",
      footer: "To delete: `git rm <file>`. To keep: import it, or name the convention in `.bundlebox/config.json` so the next scan stops asking.",
    };
  }, { apply });
}

// ── swallowed-errors ────────────────────────────────────────────────────────

/** Every discarding catch with the line above it, which is the operation whose
 *  failure is being dropped. The one-clause comment the fix_hint asks for is a
 *  sentence about THAT operation, and this is the list of them. */
export function planCatchReasons(f, { apply = false } = {}) {
  return planned("plan-catch-reasons", f, () => {
    const r = f.path;
    const lines = linesOf(r);
    const hits = f.evidence?.hits || [];
    if (!hits.length) return { declined: [{ path: r, reason: "the finding names no catch site" }], why: "no hits" };
    const rows = [`${hits.length} catch site(s) in \`${r}\` that discard the error with no reason on the line.`, ""];
    for (const h of hits) {
      const at = h.line - 1;
      rows.push(`### ${r}:${h.line}`, "", ...quoteRange(lines.join("\n"), Math.max(1, at - 1), Math.min(lines.length, at + 3), langOf(r)), "");
    }
    return {
      rows, files: [r],
      title: `Catches to explain in ${r}`,
      why: "Each block below is quoted with the operation above it, because the sentence this needs is about that operation: why its failure is safe to drop here. This tree already writes them that way, and the detector goes quiet on the ones that do.",
      footer: "The form: `} catch { /* the file is not there yet */ }`. Handling the error instead closes it the same way.",
    };
  }, { apply });
}

// ── ui-generic ──────────────────────────────────────────────────────────────

/** The tells, in the order the fix_hint says to work them. Ranking is the
 *  cheapest part of a design review and the part a session re-derives every
 *  time, because the order is stated in prose rather than in the finding. */
const LEVERAGE = ["typeface", "font", "palette", "hex", "colour", "color", "space", "spacing", "radius", "shadow", "state", "hover", "focus", "disabled", "empty", "copy", "emoji", "grid"];
export function planUiLeverage(f, { apply = false } = {}) {
  return planned("plan-ui-leverage", f, () => {
    const tells = f.evidence?.tells || (f.evidence?.tell ? [f.evidence.tell] : []);
    if (!tells.length) return { declined: [{ path: f.path, reason: "the finding names no tell; this actuator serves the per-area count row" }], why: "no tells" };
    const rank = (t) => { const i = LEVERAGE.findIndex((w) => String(t).toLowerCase().includes(w)); return i < 0 ? LEVERAGE.length : i; };
    const ordered = tells.slice().sort((a, b) => rank(a) - rank(b));
    const rows = [`${tells.length} generic tell(s) in \`${f.evidence?.area || f.path}\`, ordered by leverage.`, "",
      "| # | tell |", "|---|---|"];
    ordered.forEach((t, i) => rows.push(`| ${i + 1} | \`${t}\` |`));
    return {
      rows, files: f.files || [f.path],
      title: `Leverage order for ${f.evidence?.area || f.path}`,
      why: "Typeface first, then palette, then spacing rhythm, then state coverage. The order matters because the first two decide what the rest of the choices are reacting to, and reversing it means redoing them.",
      footer: "`bb designlabs principles anti-generic` holds the reasoning behind the order.",
    };
  }, { apply });
}

// ── missing-tests ───────────────────────────────────────────────────────────

/** The exact path the next scan looks for, and a body listing what the file
 *  exports. The test is the judgement; its filename, its imports and the list
 *  of things that have no assertion yet are not. */
const TEST_PATH = {
  js: (r) => r.replace(/\.([cm]?js)$/, ".test.$1"), ts: (r) => r.replace(/\.([cm]?tsx?)$/, ".test.$1"),
  py: (r) => r.replace(/([^/]+)\.py$/, "test_$1.py"), go: (r) => r.replace(/\.go$/, "_test.go"),
  rust: (r) => r.replace(/\.rs$/, "_test.rs"), ruby: (r) => r.replace(/([^/]+)\.rb$/, "$1_spec.rb"),
};
export function scaffoldTest(f, { apply = false } = {}) {
  return planned("scaffold-test", f, () => {
    const files = f.evidence?.files || [];
    if (!files.length) return { declined: [{ path: f.path, reason: "the finding names no file" }], why: "no files" };
    const rows = [`${files.length} recently changed file(s) under \`${f.path}\` that no test names.`, ""];
    const declined = [];
    for (const r of files) {
      const lang = langOf(r);
      const to = TEST_PATH[lang]?.(r);
      if (!to || to === r) { declined.push({ path: r, reason: `no test-file convention is known for a ${lang || "?"} file; the next scan looks for a name this cannot predict` }); continue; }
      if (fs.existsSync(abs(to))) { declined.push({ path: r, reason: `${to} already exists; the scan did not see it name ${r}` }); continue; }
      const spans = topLevelSpans(readOr(r), lang);
      const exported = [];
      const src = linesOf(r);
      for (const s of spans) if (/^\s*export\b|^\s*(?:pub\s+)?(?:def|func|fn)\b/.test(src[s.line - 1] || "")) exported.push(s.name);
      rows.push(`### \`${to}\``, "");
      rows.push(...(lang === "py"
        ? ["```python", `from ${r.replace(/\.py$/, "").split("/").join(".")} import *   # noqa`, "", ...exported.map((n) => `def test_${n}():\n    raise NotImplementedError("${n}")`), "```"]
        : ["```js", `import { ${exported.slice(0, 12).join(", ")} } from "${path.posix.relative(path.posix.dirname(to), r).startsWith(".") ? path.posix.relative(path.posix.dirname(to), r) : "./" + path.posix.relative(path.posix.dirname(to), r)}";`,
          'import { test } from "node:test";', "",
          ...(exported.length ? exported.map((n) => `test.todo("${n}");`) : [`test.todo("${r} exports nothing this can name");`]), "```"]));
      rows.push("");
    }
    if (!rows.length) return { declined, why: `${declined.length} declined` };
    return {
      rows, declined, files,
      title: `Test scaffolds for ${f.path}`,
      why: "Each heading is the exact path the next scan looks for, and each body lists what the file exports with no assertion attached. `test.todo` neither passes nor fails, so adopting one of these cannot turn a red suite green.",
      footer: "The assertions are the work. Nothing here was written to disk.",
    };
  }, { apply });
}

// ── silent-fallback, quiet-degrade, fault-mask ──────────────────────────────

/** Every failure branch quoted with what it tells its caller. The fix is one
 *  clause per branch and the clause is a judgement; finding the branches, and
 *  showing what each one claims, is not. All three detectors share this plan
 *  because all three name the same edit in different words. */
export function planFallbackContracts(f, { apply = false } = {}) {
  return planned("plan-fallback-contracts", f, () => {
    const r = f.path;
    const lines = linesOf(r);
    const hits = f.evidence?.hits || [];
    if (!hits.length) return { declined: [{ path: r, reason: "the finding names no branch" }], why: "no hits" };
    const rows = [`${hits.length} failure branch(es) in \`${r}\`.`, "",
      "| line | branch | tells the caller |", "|---|---|---|"];
    for (const h of hits) rows.push(`| ${h.line} | ${h.kind} | \`${h.value || h.claim || h.off || "?"}\` |`);
    rows.push("");
    for (const h of hits) {
      rows.push(`### ${r}:${h.line}`, "", ...quoteRange(lines.join("\n"), Math.max(1, h.line - 1), Math.min(lines.length, h.line + 4), langOf(r)), "");
    }
    return {
      rows, files: [r],
      title: `Failure contracts in ${r}`,
      why: "Each branch below runs because something failed. The column says what the caller is told instead. Two fixes close any of them: return the failure so the caller can see it, or write one clause on the line saying why hiding it is right here.",
      footer: "This tree already writes the second form — `} catch { /* the file is not there yet */ }` — and all three detectors go quiet on a branch that carries one.",
    };
  }, { apply });
}
