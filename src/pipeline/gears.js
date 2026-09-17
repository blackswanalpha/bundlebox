// gears.js — the built-in pipelines, declared.
//
//   intake    what is wrong        scan → oversight scan → compile → route
//   orient    what a session gets  snapgen build → oversight guidelines → buckmaster recommend
//   measure   what it all cost     tokens ledger → session list → buckmaster episodes
//   ops       is the box healthy   doctor → scan --only worktree-hygiene
//   buckmaster train on all of it   buckmaster signals → buckmaster rules → buckmaster memory
//   factory   one tick             intake → orient → measure → buckmaster (chained)
//   pr        ship what routed     git status → run --pr (dry)
//
// Every stage here is free and local. Nothing in a built-in gear spends a
// token or touches the network: `run --pr` stays a dry run because the gear
// never passes --apply, and a cron tick has to be a gear that cannot do
// anything it would need permission for. The one thing every gear writes is
// the episode table, which is how the model trains by the factory being used.
import { gear } from "./spec.js";
import { walk } from "../core/fs.js";
import { ROOT } from "../core/paths.js";

// One walker (doctrine 6): the workspace's source files, honouring its ignores.
const source = () => walk(ROOT);

export const GEARS = [
  gear({
    name: "intake", description: "what is wrong, found locally; ends holding lanes, the last point before anything spends",
    on: ["cron", "post-commit", "hand"],
    stages: [
      { verb: "scan", description: "every detector" },
      { verb: "oversight", args: ["scan"], flags: { write: true }, when: "open_findings > 0", skip_if_fresh: true, inputs: source, optional: true,
        description: "size and fan-in, only when something was found" },
      // Gated on what is OPEN in the store, not on what this run's scan returned:
      // a gear run against a store that already holds findings still has work.
      { verb: "compile", flags: { write: true }, when: "open_findings > 0", description: "findings -> units packed to a window" },
      { verb: "route", flags: { write: true }, when: "units_ready > 0", description: "units -> lanes. Stops here: running them is a decision" },
    ],
  }),
  gear({
    name: "orient", description: "what a session gets handed instead of searching",
    on: ["cron", "session-start", "hand"],
    stages: [
      { verb: "snapgen", args: ["build"], skip_if_fresh: true, inputs: source, description: "the reference tables" },
      // The index the PreToolUse guards read on every tool call. It is derived
      // from the tables above, so it belongs directly after them: 1.80ms from
      // the markdown, 0.14ms from here.
      { verb: "arc", args: ["build"], skip_if_fresh: true, inputs: source, optional: true, description: "the tables, compiled to one binary index" },
      { verb: "oversight", args: ["guidelines"], flags: { build: true }, skip_if_fresh: true, inputs: source, optional: true, description: "the guidelines block" },
      // Every measured gap, located and budgeted before a session sees it. Only
      // when something is open: a worklist over an empty store is an empty file.
      { verb: "pinpoint", args: ["gaps"], when: "open_findings > 0", optional: true, description: "each finding and unproven standard, as a located brief" },
      { verb: "buckmaster", args: ["recommend"], description: "the fired rules, as lines a person can paste" },
    ],
  }),
  gear({
    name: "measure", description: "what sessions cost, what the local path displaced, and what packing a task is worth",
    on: ["cron", "session-end", "hand"],
    stages: [
      { verb: "tokens", args: ["ledger"], description: "fold the transcripts into the ledger" },
      { verb: "session", args: ["list"], description: "the sessions measured so far" },
      { verb: "buckmaster", args: ["episodes"], description: "turns displaced per verb" },
      // The ablation runs on the tick, not by hand, because it is the one
      // number on the page that is MEASURED on both sides and it goes stale the
      // moment the tree moves. `init` is re-derived first: a suite whose tasks
      // are last week's findings measures last week's tree.
      { verb: "bench", args: ["init"], when: "open_findings > 0", description: "a suite from the findings that name a file" },
      { verb: "bench", args: ["run"], when: "open_findings > 0", skip_if_fresh: true, inputs: source,
        description: "both arms, per task; the packed arm against a search and a read" },
      // Refit the budget's own constants on the tick, for the same reason the
      // ablation runs here. `churn_factor`, `anchor_widen` and the reserve
      // table were shipped numbers that nothing on any box ever moved, so every
      // brief in every workspace was budgeted with one machine's measurement
      // from one afternoon. This reads stored rows and transcripts and calls
      // nothing; a factor with too few samples keeps its shipped value and the
      // report says so.
      { verb: "tokens", args: ["calibrate"], flags: { apply: true }, description: "refit churn, widen and the reserve table from this workspace's own history" },
      // The other axis: what the WORK looked like, not what it cost. Reads the
      // recorded shapes, the folded turns and the brief scopes — all three of
      // which the stages above just refreshed — and files a finding per hit.
      { verb: "echos", description: "spin, oscillate, drift, diminishing, converge over the sessions on disk" },
    ],
  }),
  gear({
    name: "ops", description: "is this box healthy",
    on: ["cron", "hand"],
    stages: [
      { verb: "doctor", description: "binaries, kernel, python, config" },
      { verb: "scan", flags: { only: "worktree-hygiene" }, description: "stale worktrees and branches" },
    ],
  }),
  gear({
    name: "buckmaster", description: "train the process model on everything above, then turn it into automation",
    on: ["cron", "hand"],
    stages: [
      { verb: "buckmaster", args: ["signals"], description: "per-session signals off the transcripts" },
      { verb: "buckmaster", args: ["rules"], description: "which signals crossed a threshold" },
      { verb: "buckmaster", args: ["memory"], description: "what the factory came to believe" },
      // LATHE-1, after the models it reads. `learn` is 1.4s because it reads the
      // recorded command shapes rather than the transcripts they came from.
      { verb: "lathe", args: ["learn"], optional: true, description: "the habits, from the recorded shapes and the episodes" },
      { verb: "lathe", args: ["build"], flags: { apply: true }, optional: true, description: "scripts, snippets, boilerplate and completions" },
    ],
  }),
  gear({
    name: "situation", description: "what is happening right now: services, what is failing, and what the detectors see",
    on: ["cron", "hand"],
    stages: [
      { verb: "runbook", args: ["status"], when: "services > 0", optional: true, description: "is anything listening" },
      { verb: "viewport", args: ["build"], when: "services > 0", optional: true, description: "the port table as a page: what is listening, for which directory, and what holds a port we declared" },
      { verb: "scan", description: "every detector over what is on disk" },
      { verb: "failsafe", args: ["why"], description: "each failure matched against the playbook: cause, op, doc" },
    ],
  }),
  gear({
    name: "genesis", description: "the inlet: what the world declares that no scenario touches, packed to briefs",
    on: ["hand"],
    stages: [
      { verb: "genesis", args: ["plan"], when: "world > 0", description: "the coverage set difference" },
      { verb: "genesis", args: ["pack"], when: "world > 0", description: "one brief per surface, carrying the derived half. Stops here: sending is a decision" },
    ],
  }),
  gear({
    name: "scenarios", description: "run the corpus against the running system and read what it means",
    on: ["cron", "hand"],
    stages: [
      { verb: "cookbook", args: ["check"], when: "corpora > 0", description: "the corpus asserts something — no server, no requests" },
      { verb: "cookbook", args: ["run"], when: "corpus_base == 1 and scenarios > 0", description: "the kernel executes it; red steps become findings" },
      { verb: "mainboard", args: ["run"], flags: { only: "scoreyard,turntables,cyberrender" }, when: "corpora > 0", optional: true, description: "what the board means, whether the same scenario still answers the same way, and what it still does not cover" },
      { verb: "frames", args: ["eval"], description: "every eval; a red one becomes a finding under `eval`" },
    ],
  }),
  gear({
    name: "audit", description: "which areas have no current audit, and the briefs that would produce one",
    on: ["hand"],
    stages: [
      { verb: "auditor", args: ["drift"], optional: true, description: "charters that need re-deriving and reviews describing a tree that has moved" },
      { verb: "auditor", args: ["plan"], description: "areas with no declared bar, and reviews worth writing, ranked" },
      { verb: "auditor", args: ["pack"], description: "the briefs. Stops here: sending is a decision" },
    ],
  }),
  gear({
    name: "watch", description: "fold what was spent, and rebuild the one page that shows it",
    on: ["cron", "session-end", "hand"],
    stages: [
      { verb: "tokens", args: ["ledger"], description: "fold every transcript into the ledger" },
      { verb: "monitor", args: ["status"], description: "the current block, the burn rate, and which clock runs out first" },
      { verb: "console", args: ["build"], description: "the page, with the state embedded" },
    ],
  }),
  gear({
    name: "bootstrap", description: "bring a fresh workspace up: find what is wrong, build what a session reads, rebuild the page",
    on: ["hand"],
    stages: [],
    // `measure` is deliberately absent: it folds transcripts, and a workspace
    // being bootstrapped has none. Everything here is derived from the tree.
    chain: ["intake", "orient", "buckmaster", "watch"],
  }),
  gear({
    name: "factory", description: "one tick of the whole free path: intake, orient, measure, buckmaster, watch",
    on: ["cron"],
    stages: [],
    // `watch` last, and it used to be missing entirely: the cron tick folded the
    // ledger and rebuilt nothing, so the one page this workspace has showed the
    // state of whenever somebody last ran `bb console build` by hand.
    chain: ["intake", "orient", "measure", "buckmaster", "watch"],
  }),
  gear({
    name: "full", description: "the whole pipeline: what is happening, what is wrong, what a session gets, what the system does, what it cost",
    on: ["cron"],
    stages: [],
    chain: ["situation", "intake", "orient", "scenarios", "watch", "buckmaster"],
  }),
  gear({
    name: "pr", description: "what routed, and what a PR run would do (dry)",
    on: ["hand"],
    stages: [
      { verb: "git", args: ["status"], description: "the tree and its branches" },
      { verb: "run", flags: { pr: true }, description: "the plan as it would run with --pr; nothing spawns without --apply" },
    ],
  }),
];
