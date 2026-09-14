// gears.js — the built-in pipelines, declared.
//
//   intake    what is wrong        scan → oversight scan → compile → route
//   orient    what a session gets  snapgen build → oversight guidelines → learn recommend
//   measure   what it all cost     tokens ledger → session list → learn episodes
//   ops       is the box healthy   doctor → scan --only worktree-hygiene
//   learn     train on all of it   learn signals → learn rules → learn memory
//   factory   one tick             intake → orient → measure → learn (chained)
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
      { verb: "oversight", args: ["guidelines"], flags: { build: true }, skip_if_fresh: true, inputs: source, optional: true, description: "the guidelines block" },
      { verb: "learn", args: ["recommend"], description: "the fired rules, as lines a person can paste" },
    ],
  }),
  gear({
    name: "measure", description: "what sessions cost and what the local path displaced",
    on: ["cron", "session-end", "hand"],
    stages: [
      { verb: "tokens", args: ["ledger"], description: "fold the transcripts into the ledger" },
      { verb: "session", args: ["list"], description: "the sessions measured so far" },
      { verb: "learn", args: ["episodes"], description: "turns displaced per verb" },
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
    name: "learn", description: "train the process model on everything above",
    on: ["cron", "hand"],
    stages: [
      { verb: "learn", args: ["signals"], description: "per-session signals off the transcripts" },
      { verb: "learn", args: ["rules"], description: "which signals crossed a threshold" },
      { verb: "learn", args: ["memory"], description: "what the factory came to believe" },
    ],
  }),
  gear({
    name: "factory", description: "one tick of the whole free path: intake, orient, measure, learn",
    on: ["cron"],
    stages: [],
    chain: ["intake", "orient", "measure", "learn"],
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
