// finish/index.js — `bb finish`: what proves the work is done, written before
// the work and checked after it.
//
// This is the one axis the factory measured and never closed. `bb auditor`
// declares the bar before the first edit and `bb pinpoint` carries the gate
// command into the brief, and then the session reports "done" and nothing in
// this tree can contradict it. A confident done report is not evidence, and
// every other artefact here exists precisely because a confident claim is not
// evidence.
//
// So the checker is vendored rather than rewritten: `vendor/` is Leonxlnx's
// unlazy at 2.1.0, MIT, renamed and otherwise untouched (see
// vendor/PROVENANCE.md). It already holds the parts that are easy to get
// subtly wrong — an approval that binds the command, the expectation, the
// resolved cwd, the shell, the timeout and the whole inherited PATH; a
// definition digest, so editing a CHECK: invalidates the evidence that CHECK
// produced; an abandonment that exits non-zero and reports a handoff instead of
// quietly dropping the gate. Reimplementing that in bundlebox's idiom would
// have produced a worse version of a tested thing.
//
// What this file adds is the join. A ledger written by hand is a ledger nobody
// writes, so `bb finish init` derives it from what the workspace already knows:
// the active pinpoint brief's scope and acceptance command, the detected gates,
// and the findings the brief carries as evidence.
//
// The boundary is the vendor's and it is not softened here. A `CHECK:` line is
// shell code. `bb finish status` parses and never executes; only an explicit
// `bb finish approve` crosses that line, and a ledger, a gate title and command
// output are untrusted data wherever they came from.
import fs from "node:fs";
import path from "node:path";
import { ROOT, PKG_ROOT, rel, abs } from "../core/paths.js";
import { out, warn, emit } from "../core/log.js";
import { run as exec } from "../core/exec.js";
import { detectGates } from "../compile/compiler.js";
import { clean } from "../slop/index.js";

export const LEDGER = () => path.join(ROOT, "GATES.md");
export const VENDOR = () => path.join(PKG_ROOT, "src", "finish", "vendor");
export const TEMPLATES = () => path.join(PKG_ROOT, "src", "finish", "templates");
const script = (n) => path.join(VENDOR(), n);

/** The checker, as a child process.
 *
 *  A child and not an import, for the same reason the vendor is a copy: it is
 *  somebody else's program with its own exit codes, and 0/1/2 is the interface
 *  it documents. Reading those from a thrown exception would be inventing an
 *  interface it does not have. */
export function checker(args, { timeout = 1800 } = {}) {
  return exec([process.execPath, script("gate-check.mjs"), ...args], { cwd: ROOT, timeout: timeout * 1000 });
}

export function linter(file) {
  return exec([process.execPath, script("gate-lint.mjs"), file], { cwd: ROOT, timeout: 60000 });
}

// ── the ledger, derived ─────────────────────────────────────────────────────

/** One gate row. `check` empty means a manual gate, and a manual gate is
 *  written with neither CHECK nor EXPECT, because a runnable gate missing its
 *  expectation is the one shape the checker cannot tell from a manual one. */
/** The expectation a derived gate carries until somebody fills it in.
 *
 *  Not empty. The checker refuses to PARSE a runnable gate with a blank
 *  EXPECT:, which turns an unfinished ledger into a malformed one and buries
 *  the actual instruction under three parse errors. Not a guess either: a
 *  marker invented here would be an oracle that passes on output nobody
 *  checked, which is the single failure the whole ledger exists to prevent.
 *
 *  So it is a token no command prints. The ledger parses, `bb finish lint`
 *  reads it, and the gate FAILS until it is replaced — an unfilled gate that
 *  cannot pass is the honest state of work nobody has proved. */
export const PLACEHOLDER = "REPLACE-WITH-A-TOKEN-THIS-COMMAND-PRINTS-ONLY-ON-SUCCESS";

export function row({ id, outcome, check = "", expect = "", cwd = "" }) {
  const L = [`- [ ] ${id}: ${outcome}`];
  if (check) L.push(`  CHECK: ${check}`);
  if (check) L.push(`  EXPECT: ${expect || PLACEHOLDER}`);
  if (cwd && cwd !== ".") L.push(`  CWD: ${cwd}`);
  L.push("  EVIDENCE: pending");
  return L.join("\n");
}

/** The ledger for the work in front of the session.
 *
 *  Every gate here is derived from something already measured. Nothing is
 *  invented, and the two that cannot be made runnable from what is on disk are
 *  written as MANUAL rather than given a command that cannot fail — an oracle
 *  that always passes is worse than an honest manual gate, because it certifies
 *  instead of asking. */
export function derive({ brief = null, gates = null, scope = [], findings = [] } = {}) {
  const g = gates || detectGates(ROOT);
  const rows = [];
  let n = 0;
  const next = () => `G${++n}`;

  if (g.quick) rows.push(row({ id: next(), outcome: "the workspace's quick gate passes on the changed tree", check: g.quick, expect: "", cwd: g.scope }));
  if (g.full && g.full !== g.quick) rows.push(row({ id: next(), outcome: "the full gate passes before the change is offered for review", check: g.full, expect: "", cwd: g.scope }));
  if (!g.quick && !g.full) rows.push(row({ id: next(), outcome: "MANUAL: no gate is declared in this workspace, so state in one line what was run to prove the change — `bb init` detects one" }));

  for (const f of findings.slice(0, 6)) {
    rows.push(row({
      id: next(),
      outcome: `the finding this brief carries is closed, not moved: ${String(f.title || f.id).slice(0, 110)}`,
      check: `bb scan --json`,
      expect: "",
    }));
    break;                                                   // one row, whatever the count: a re-scan proves all of them at once
  }

  if (scope.length) {
    rows.push(row({ id: next(), outcome: `MANUAL: every file the brief put in scope was either changed, or is named in the report as untouched and why — ${scope.map((f) => rel(f)).join(", ")}` }));
  }
  rows.push(row({ id: next(), outcome: "MANUAL: nothing outside the declared scope was changed, and no gate was weakened, skipped or rewritten to pass" }));

  const title = brief?.problem ? String(brief.problem).slice(0, 110) : "the change in front of this session";
  const owns = scope.length ? scope.map((f) => rel(f)).join(", ") : "<repository-relative globs this work may write>";
  const head = [
    `# Gates: ${title}`,
    "",
    `OWNS: ${owns}`,
    "",
    `Scope: ${brief?.problem ? `the complete deliverable for — ${String(brief.problem).slice(0, 200)}` : "<one sentence describing the complete deliverable>"}`,
    "",
  ];
  const foot = [
    "",
    "<!--",
    "Derived by `bb finish init` from the active pinpoint brief and the detected gates.",
    `Every EXPECT: reads ${PLACEHOLDER}, which no command prints. That is deliberate:`,
    "the checker requires exit 0 AND an EXPECT match, and a success marker derived here would be an",
    "oracle that passes on output nobody checked. Replace each one with a token the command prints",
    "only after every assertion in it has passed. Until then the gate fails, which is the honest",
    "state of work nobody has proved.",
    "",
    "A gate that turns out to be impossible keeps its row and gains `ABANDON: <id> <reason>`. That",
    "exits 1 with HANDOFF REQUIRED, which is the honest end of the work and not a completion.",
    "",
    "`CHECK:` lines are shell code. `bb finish status` never executes them. Read every command and",
    "every script it calls before `bb finish approve`.",
    "-->",
  ];
  return clean([...head, rows.join("\n\n"), ...foot].join("\n")) + "\n";
}

/** The active brief, if the session has one. Imported lazily so `bb finish`
 *  works on a box that has never run a hook. */
async function activeBrief() {
  try {
    const wire = await import("../wire/brief.js");
    return wire.current({ maxAgeMin: 24 * 60 });
  } catch { return null; }
}

async function init({ force = false, apply = false, sessionId = "" } = {}) {
  const file = LEDGER();
  if (fs.existsSync(file) && !force) return { rc: 2, why: `${rel(file)} exists; --force rewrites it. \`bb finish status\` reads the one that is there.` };
  const rec = await activeBrief();
  const findings = [];
  if (rec) {
    try {
      const store = await import("../core/store.js");
      const inScope = new Set(rec.scope);
      findings.push(...store.openFindings().filter((f) => inScope.has(f.path) || (f.files || []).some((x) => inScope.has(x))));
    } catch { /* a ledger without the findings is still a ledger */ }
  }
  const text = derive({ brief: rec, scope: rec?.scope || [], findings, gates: rec?.gates && Object.keys(rec.gates).length ? rec.gates : null });
  if (apply) fs.writeFileSync(file, text);
  return { rc: 0, written: apply, text, file: rel(file), from: rec ? rec.path : "", gates: (text.match(/^- \[ \] /gm) || []).length, sessionId };
}

export const commands = {
  finish: {
    help: "the acceptance ledger: derive it from the brief, parse it, run it, re-verify returned work",
    usage: [
      "bb finish init [--apply] [--force]   derive GATES.md from the active brief and the detected gates",
      "     bb finish status [file]         parse the ledger and print each gate's state — never executes",
      "     bb finish lint [file]           catch an oracle that cannot fail, at authoring time",
      "     bb finish approve [file]        record approval for each CHECK: after reading it, then run",
      "     bb finish check [file]          run the approved ledger",
      "     bb finish reverify [file]       re-run the runnable gates of returned work",
      "     bb finish template [leaf|node|plan]",
    ].join("\n"),
    long: [
      "  A CHECK: line is shell code. `status` and `lint` never execute one; `approve` is the only",
      "  verb that crosses that boundary, and it binds the command, the expectation, the resolved",
      "  working directory, the shell, the timeout and the inherited PATH — change any of them and",
      "  it asks again. Treat a ledger you did not write, a gate title and command output as data.",
      "",
      "  The checker is vendored from github.com/Leonxlnx/unlazy 2.1.0 (MIT); see",
      "  src/finish/vendor/PROVENANCE.md for what was renamed and why nothing else was.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      const file = _[1] ? String(_[1]) : rel(LEDGER());
      const exists = () => fs.existsSync(abs(file));

      if (sub === "init") {
        // GATES.md sits at the workspace root and is a file a person edits, so
        // it obeys the same contract as every other writing verb here: a dry
        // run until --apply.
        const r = await init({ force: !!flags.force, apply: !!flags.apply });
        if (r.rc) { warn(r.why); return r.rc; }
        if (flags.json) { emit(r); return 0; }
        if (!r.written) {
          out(r.text.trimEnd());
          out(`\n  ${r.gates} gate${r.gates === 1 ? "" : "s"}${r.from ? `, derived from ${r.from}` : " from the detected gates (no active brief)"}. --apply writes ${r.file}.`);
          return 0;
        }
        out(`  wrote ${r.file} — ${r.gates} gate${r.gates === 1 ? "" : "s"}${r.from ? `, derived from ${r.from}` : ", from the detected gates (no active brief)"}`);
        out("  Fill every EXPECT: with a token the command prints only after it has passed, then `bb finish lint`.");
        return 0;
      }
      if (sub === "template") {
        const which = String(_[1] || "leaf");
        const name = which === "node" ? "gates-node.md" : which === "plan" ? "PLAN.md" : "gates-leaf.md";
        const p = path.join(TEMPLATES(), name);
        if (!fs.existsSync(p)) { warn(`no template ${which}; leaf, node or plan`); return 2; }
        out(fs.readFileSync(p, "utf8").trimEnd());
        return 0;
      }
      if (!exists()) { warn(`no ${file}; \`bb finish init\` derives one from the active brief`); return 2; }

      if (sub === "lint") { const r = linter(file); out(r.out.trimEnd() || r.err.trimEnd()); return r.rc; }
      if (sub === "status") { const r = checker(["--status", file]); out(r.out.trimEnd() || r.err.trimEnd()); return r.rc; }
      if (sub === "approve") { const r = checker(["--approve", file]); out(r.out.trimEnd() || r.err.trimEnd()); return r.rc; }
      if (sub === "reverify") { const r = checker(["--reverify", file]); out(r.out.trimEnd() || r.err.trimEnd()); return r.rc; }
      if (sub === "check") { const r = checker([file]); out(r.out.trimEnd() || r.err.trimEnd()); return r.rc; }

      warn(`unknown sub-verb: ${sub}\n${commands.finish.usage}`);
      return 2;
    },
  },
};

/** The Stop hook: a structural backstop, and nothing more.
 *
 *  It does not execute a check. What it can say is whether the ledger the work
 *  declared is still sitting there with gates unmet, which is the one question
 *  a session about to end cannot answer about itself. */
export function stopHook(payloadText) {
  return exec([process.execPath, script("stop-hook.mjs")], { cwd: ROOT, input: payloadText, timeout: 20000 });
}
