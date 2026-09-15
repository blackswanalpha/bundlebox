// auditor/brief.js — the instruction pack handed over BEFORE the first edit.
//
// This is the module's reason to exist. Everything else in the factory answers
// "what is wrong with what was written". This answers "what does correct look
// like, and what may I not do", and it answers it while changing the code is
// still cheap.
//
// The brief is assembled, not written. Every section comes from something
// already derived — the charter, the detectors, the world model, the declared
// gate — so the pack costs nothing to produce and cannot disagree with the rest
// of the box. The one thing it adds is ORDER: a sequence of phases with a gate
// between each, so a session cannot reach code generation without having stated
// the objective, bound it to a criterion, and named the invariants in play.
//
// Phases are from AAS-SDF (an agentic reading of DO-178B): mission framing,
// operating domain, requirements, architecture, generation, verification,
// hardening, baseline, review, handoff. They add sequence and evidence. They do
// not add rules — every rule in the pack is a standard from the charter.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as genesis from "../genesis/index.js";
import { OUT, rel } from "../core/paths.js";
import { writeJson } from "../core/config.js";
import { now, human, slug } from "../core/util.js";
import { text as estimateText } from "../tokens/estimate.js";
import * as charter from "./charter.js";
import { ADAL } from "./standards.js";

/** The ten phases, each with the gate that must hold before the next begins.
 *  `skip_at` drops a phase for a level that does not warrant it, so a C-level
 *  change is not made to write a threat model. */
export const PHASES = [
  { id: "P0", name: "Mission framing",
    does: "State the objective in one measurable sentence. Confirm it sits inside the scope above. Name the standards in play and the invariants they imply.",
    gate: "Intent lock — the objective is one sentence, the scope is confirmed, the standards are named." },
  { id: "P1", name: "Operating domain",
    does: "Confirm what you are working in: the files, the language, the build, the command that proves a change. Verify every API and dependency you intend to use exists — open it, do not assume it.",
    gate: "Domain confirmed — every file you will touch exists and you have read its shape." },
  { id: "P2", name: "Requirements",
    does: "Turn the objective into acceptance criteria: checkable statements, each of which becomes one test. A criterion nobody can check is not a criterion.",
    gate: "Requirements frozen — the criteria are enumerated and each one names its test." },
  { id: "P3", name: "Architecture",
    does: "Choose the shape before writing it: which module owns this, what crosses the boundary, what the failure mode is. Record the choice and the alternative you rejected.",
    gate: "Architecture recorded — one paragraph naming the choice and what it costs.", skip_at: ["C"] },
  { id: "P4", name: "Generation",
    does: "Interfaces first, then the test that fails, then the code that makes it pass. Small increments. Refuse the prohibited list on every line.",
    gate: "Code quality — nothing on the prohibited list is present and no file exceeds the tree's own limit." },
  { id: "P5", name: "Verification",
    does: "Write the tests the criteria named, including the illegal path of any state machine you touched. Meet the coverage floor on the paths the standards name.",
    gate: "Verification sufficient — every criterion has a test that would have failed before the change." },
  { id: "P6", name: "Adversarial pass",
    does: "Attack your own change: authorisation bypass, replay, injection, concurrent writers, and the failure of every external call.",
    gate: "Red-team clear — each attack is either impossible here, with the reason, or fixed.", skip_at: ["C"] },
  { id: "P7", name: "Baseline",
    does: "Migrations travel with the model change. Contracts are published. Commits are one logical change each and carry no secret.",
    gate: "Baseline locked — the change is a coherent set of commits and the tree is otherwise clean." },
  { id: "P8", name: "Review",
    does: "Run the declared gate. Read your own diff as if someone else wrote it. Open the change for review; do not merge past the human.",
    gate: "Go-live approved — the gate is green and a reviewer who is not the author has signed." },
  { id: "P9", name: "Handoff",
    does: "Write down what shipped, what it produced, which gates ran, what is still open, and what the next piece of work can now build on.",
    gate: "Handoff recorded — the next session starts from a clean, stated baseline." },
];

/** What a session would otherwise spend turns finding out. Handing it over is
 *  the difference between a brief and a lecture. */
function context(area, ch) {
  const w = genesis.world(genesis.current());
  const surface = (w?.surfaces || []).find((s) => s.id === area.id) || null;
  const open = ch.assurance.already_computed;
  return { surface, open, gates: ch.assurance.gates };
}

export function build(area, ch, { objective = "", kind = "build" } = {}) {
  const c = context(area, ch);
  const lvl = ch.adal;
  const phases = PHASES.filter((p) => !(p.skip_at || []).includes(lvl.level));
  const L = [];

  L.push(`# Work brief — \`${ch.area}\``, "");
  if (objective) L.push(`**The work:** ${objective}`, "");
  L.push(`This is handed over **before** the first edit. It is the scope, the bar, the decision rights and the evidence rule for this area, plus the order the work happens in. Everything in it is derived; nothing here is an opinion you have to take on trust.`, "");
  L.push(`| | |`, `|---|---|`,
    `| area | \`${ch.area}\` — ${ch.scope.files} file(s), about ${human(ch.scope.tokens)} tokens |`,
    `| assurance level | **${lvl.level}** (${lvl.title}) — ${lvl.why} |`,
    `| standards in force | ${ch.standards.length}, across ${[...new Set(ch.standards.map((s) => s.domain))].join(", ")} |`,
    `| coverage floor | ${lvl.coverage}% on the paths those standards name |`,
    `| independent review | ${lvl.independent_review ? "required" : "not required at this level"} |`,
    `| the gate | ${c.gates.length ? c.gates.map((g) => `\`${g.cmd}\``).join(" · ") : "**none declared — see SHIP-1**"} |`, "");

  L.push(`## The boundary`, "",
    `In scope: everything under \`${ch.area}\`.`, "", "```", ...ch.scope.in_scope.slice(0, 30),
    ch.scope.more || ch.scope.in_scope.length > 30 ? `… ${ch.scope.files - Math.min(30, ch.scope.in_scope.length)} more` : "", "```", "");
  L.push(`Out of scope: ${ch.scope.out_of_scope.join("; ")}.`, "",
    `If the work turns out to need something outside this list, **stop and say so**. Finishing it "while you are in there" is the drift this document exists to prevent, and it is the one failure mode nobody catches in review.`, "");

  if (c.surface) L.push(`## What this surface is supposed to do`, "",
    `The world model says: ${c.surface.title || c.surface.id}${c.surface.detail ? ` — ${c.surface.detail}` : ""}.`, "");

  L.push(`## The bar`, "",
    `Each row is a standard in force here. Where a detector already computes part of it, its output is below — do not spend turns re-deriving it.`, "",
    "| id | what good looks like | proof it needs |", "|---|---|---|");
  for (const s of ch.standards) L.push(`| **${s.id}** | ${s.bar} | ${s.evidence} |`);
  L.push("");

  if (c.open.length) {
    L.push(`### Already found here — these are given, not homework`, "");
    for (const f of c.open.slice(0, 20)) L.push(`- **[${f.severity}] ${f.detector}** — ${f.title}${f.path ? ` (\`${f.path}\`)` : ""}`);
    if (c.open.length > 20) L.push(`- … ${c.open.length - 20} more, in \`bb scan --json\``);
    L.push("");
  } else {
    L.push(`### Already found here`, "", `Nothing open. That is a fact about the detectors, not a verdict on the area.`, "");
  }

  L.push(`## The order`, "",
    `A phase's gate must hold before the next begins. This is the part that makes the work auditable: a change that reaches code generation without a stated criterion cannot be verified afterwards, only argued about.`, "");
  L.push("| | phase | what you do | gate |", "|---|---|---|---|");
  for (const p of phases) L.push(`| ${p.id} | ${p.name} | ${p.does} | **${p.gate}** |`);
  L.push("");
  if (phases.length < PHASES.length) {
    L.push(`${PHASES.filter((p) => (p.skip_at || []).includes(lvl.level)).map((p) => p.id).join(", ")} are not required at level ${lvl.level}. Raise the level and they come back.`, "");
  }

  L.push(`## Refuse these`, "");
  for (const p of ch.prohibited) L.push(`- ${p}`);
  L.push("");
  L.push(`## Never · Always`, "", "**Never**", "");
  for (const x of ch.bcr.never) L.push(`- ${x}`);
  L.push("", "**Always**", "");
  for (const x of ch.bcr.always) L.push(`- ${x}`);
  L.push("");

  L.push(`## What this brief does not accept`, "",
    "| what it is tempting to do instead | why it does not apply here |", "|---|---|",
    "| \"I'll read the tree first to get oriented\" | The file list is above and the open findings are above. Orientation is already paid for. |",
    "| \"I'll widen slightly, it's related\" | Out of scope is out of scope. Say what you found and let the scope be changed deliberately. |",
    "| \"the tests are slow, I'll add them after\" | A test written after the code tests the code, not the criterion. P5 is a gate, not a phase. |",
    "| \"the gate is failing for an unrelated reason, I'll skip it\" | Then the tree has two problems. Say so. Never weaken a gate to reach green. |",
    "| \"I'm confident this is right\" | Confidence is not evidence. Every claim in the handoff names the file, the line, or the command that produced it. |", "");

  L.push(`## Done when`, "", "```bash",
    ...(c.gates.length ? c.gates.map((g) => g.cmd) : ["# no gate declared in this workspace — bb init writes one"]),
    `bb auditor gate ${ch.area}`, "```", "",
    `\`bb auditor gate\` re-reads this area against this charter and prints which standards now have evidence and which do not. Run it and report what it printed, not what you expect it to print.`, "");

  return L.join("\n");
}

export function pack(area, ch, opts = {}) {
  const text = build(area, ch, opts);
  const dir = path.join(OUT, "auditor");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${slug(ch.area)}-brief.md`);
  fs.writeFileSync(f, text);
  return { area: ch.area, file: rel(f), est_tokens: estimateText(text, "prose"),
    standards: ch.standards.length, adal: ch.adal.level, at: now() };
}
