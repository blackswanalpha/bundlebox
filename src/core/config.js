// config.js — the factory's only knobs. DEFAULTS here, overrides in
// <root>/.bundlebox/config.json, measured values in .bundlebox/var/calibration.json.
// Nothing else in the tree hides a constant that changes behaviour.
import fs from "node:fs";
import path from "node:path";
import { BB_DIR, VAR, ROOT } from "./paths.js";
import { deepMerge } from "./util.js";

export const DEFAULTS = {
  workspace: {
    root: ROOT,
    // Sub-trees that carry their own git. A lane can only get a worktree in one of these.
    // Empty = the root itself is the only repo.
    subrepos: [],
    // Paths this workspace lived at before. Agents name transcript dirs after cwd,
    // so a move silently resets the factory's memory unless these are listed.
    prior_roots: [],
    ignore: ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
             "target", "vendor", "__pycache__", ".venv", "venv", ".bundlebox", ".dart_tool",
             ".gradle", "Pods", ".idea", ".vscode", "*.min.js", "*.lock", "*.log"],
  },
  budget: {
    // The window one operation is allowed to occupy. Sized to the model's
    // context, not to the task; a 200k window with 60k of priming is 140k of work.
    min_tokens: 120000,
    max_tokens: 160000,
    // Held back for the model's own output and thinking. Per-kind overrides below.
    reserve_output: 30000,
    // Every file a session opens gets read, often edited, sometimes re-read.
    // Measured near 2.4 on real transcripts; `bb tokens calibrate` refits it.
    churn_factor: 2.4,
    // Fraction of the REST of an anchored file a unit is budgeted to also read.
    anchor_widen: 0.45,
    // What opening a session costs before any work. 0 = not measured, use floor.
    overhead_tokens: 0,
    overhead_lean: 0,
    reserve_by_kind: { fix: 12000, verify: 8000, investigate: 40000, build: 8000, write: 20000 },
    // Past this fraction of the window the harness starts compacting.
    tight_at: 0.78,
  },
  tokens: {
    // tokens ~= w*words + p*punct + s*indent_runs. Shipped fit; refit by calibrate.
    code_w: 1.35, code_p: 0.72, code_s: 0.35,
    prose_w: 1.18, prose_p: 0.55, prose_s: 0.25,
  },
  lanes: {
    agent: "auto",            // claude | codex | gemini | aider | opencode | cursor | copilot | custom | auto
    max_parallel: 4,
    model: "",                // empty = the agent's default
    fallback_model: "",
    lean_session: true,
    permission_mode: "acceptEdits",
    max_turns: 120,
    max_budget_usd: 0,        // per lane; 0 disables
    daily_budget_usd: 0,      // across all lanes; 0 disables
    custom_command: "",       // for agent=custom: "{prompt_file}" and "{cwd}" are substituted
  },
  detectors: {
    enabled: ["doc-links", "todo-census", "secret-scan", "big-file", "merge-markers",
              "worktree-hygiene", "dead-exports", "duplicate-blocks", "god-file",
              "orphan-files", "dead-deps", "doc-drift", "lockfile-drift", "stale-evidence",
              "missing-tests", "debug-leftovers", "ui-generic", "anti-slop",
              "swallowed-errors", "dead-config", "silent-fallback", "quiet-degrade",
              "fault-mask"],
    promote_at: "medium",
  },
  designlabs: {
    // Where a project's design studio lives, relative to the workspace root.
    dir: "designlabs",
    // How many generic tells a tree may carry before `bb designlabs check` fails.
    generic_max: 2,
    // Floors before a tell is worth reporting at all: a four-line stylesheet
    // has one radius and one shadow because it is four lines, not because
    // nobody decided. Data, so a tiny tree can lower them.
    generic_min: { palette: 6, radius: 5, shadow: 5, space: 20 },
    // The interaction floor this toolkit holds. WCAG 2.2 SC 2.5.8 says 24;
    // both mobile platforms say 44, and that is the number worth failing on.
    min_target_px: 44,
    // Doherty: under 400ms the user stays in the loop. Over it, they leave.
    max_motion_ms: 400,
    // The six a screen must draw before it is a screen and not a picture.
    required_states: ["rest", "loading", "empty", "error", "partial", "offline"],
    // Sources bb may fetch itself. Everything else in sources.json is `web`
    // and needs an agent holding a web tool; bb never scrapes what forbids it.
    fetch_allow: ["fontsource", "wcag", "lawsofux", "motion-dev"],
  },
  git: {
    allow_push: true,
    allow_merge: false,
    draft_pr: true,
    branch_prefix: "bb/",
    conventional_commits: true,
    protected: ["main", "master", "develop", "release"],
  },
  remote: { enabled: false, ttl_min: 30, fetch_timeout: 120, pr_limit: 30, stale_pr_days: 14 },
  kernel: {
    // What PROVES a change. Auto-detected from package.json/Makefile/pyproject when empty.
    gates: {},
    gate_timeout: 1800,
  },
  headroom: { enabled: false, port: 8787, host: "127.0.0.1" },
  sieve: {
    // The input axis: a tool result shrunk before it enters the window.
    //
    // ON by default since the replay settled the argument. `bb sieve replay`
    // pushes every tool result already on disk through the identical pure
    // transform, and what it reports on this box is log, probe and test output:
    // Bash, Task, WebFetch, Grep. Read, Edit and Write are absent from
    // SAFE_TOOLS by construction, so the text a later exact-match edit is
    // written against is never touched — which is the one way this could cost a
    // session anything.
    //
    // The lossy tier stays bounded rather than trusted: an elided payload is
    // spilled to `var/sieve/` first and the marker carries the path, so
    // recovery is a grep. `bb sieve replay` still measures before and after,
    // and `sieve.enabled: false` in .bundlebox/config.json turns it all off.
    enabled: true,
    // The share of the WORKING window (max_tokens - reserve_output) one tool
    // result may occupy before its middle is cut. A share, not a constant: the
    // same log is 6% of a 130k window and 1.5% of a 500k one.
    max_share: 0.02,
    head_lines: 60,          // kept from the top: the command and what it opened with
    tail_lines: 40,          // kept from the bottom: the result, and how it ended
    // Empty = the built-in allowlist (see src/sieve/compress.js). Naming tools
    // here replaces it entirely, including the mcp__ prefix rule.
    tools: [],
  },
  bridge: {
    enabled: false,          // nothing leaves this box until somebody sets it
    daily_budget_usd: 0,     // across every call; 0 disables the ceiling, not the guard
    acceptance: "bb scan --json",
    window_guard: true,      // refuse to open an agent while the 5-hour block is nearly spent
    allow_near: false,       // ...unless this is set, or --allow-near is passed
  },
  monitor: {
    plan: "custom",          // pro | max5 | max20 | custom (this account's own P90 block)
  },
  cookbook: {
    default: "",             // which corpus a bare `bb cookbook run` means; empty = the first with a base
    thresholds: {},          // overrides for the board rules; `bb frames`/expert holds the defaults
  },
  simulate: { thresholds: {} },
  mainboard: {
    // `bugbash` measures a RENDERED page, so it needs to be told which pages.
    // Empty on purpose and never inferred: a view that guesses a URL probes
    // something nobody asked about and files findings against a page that is
    // not the product. `routes` are paths joined to --base, or absolute URLs.
    // `banned` is copy this workspace has committed against — it is a fact
    // about one product, so there is no default list.
    // `base` is the UI's own origin. The board's --base is the API the corpus
    // calls, and those are two services on two ports: joining a screen path to
    // the API base probes its 404 page and files findings about it.
    bugbash: { base: "", routes: [], banned: [], narrow: 390, max_routes: 24, settle: 8000, host: "127.0.0.1", port: 9222 },
    // How many stored boards `turntables` compares. Two is a replay; ten is
    // enough history to tell a scenario that changed its mind from one that
    // changed once and stayed.
    turntables: { window: 10 },
  },
  console: { port: 7788, host: "127.0.0.1" },
  wire: {
    // Which agents `bb wire` installs into. auto = every one detected on this box.
    agents: ["auto"],
    // SessionStart: a session that opens where no `.bundlebox` exists gets one
    // written before it does anything else, and a detached `bb env up --apply`
    // builds the artefacts behind it. Every other surface here assumes the
    // environment is present; in a workspace nobody inited, all of them are
    // absent and none of them says so, so the session searches the tree. Only
    // fires over a directory with positive evidence of being a project — a git
    // worktree, or a manifest at the root or one level down.
    auto_init: true,
    inject_context: true,   // SessionStart/UserPromptSubmit: hand the agent the snapgen INDEX
    measure_sessions: true, // SessionEnd: measure used/saved
    guard_reads: true,      // PreToolUse(Read): warn on files past the window
    // ── the enforcement axis ──────────────────────────────────────────────
    //
    // Everything above is ADVISORY, and `bb uptake` measured what that is
    // worth on this workspace: the MCP tools fired in 0 of 15 sessions,
    // pinpoint in 3 of the 13 that opened five or more distinct files, the
    // snapgen tables in 5 of the 15 that ran a search. Those 13 sessions
    // opened between 30 and 598 files each. A surface the model may decline
    // on a hunch is a surface that gets declined.
    //
    // So these three move the work to the side that does it for nothing:
    auto_pinpoint: true,    // UserPromptSubmit: RUN pinpoint on a task-shaped prompt, inject the map
    serve_from_brief: true, // PreToolUse: deny a read the brief already quotes, and hand back the quote
    guard_searches: true,   // PreToolUse: deny a declaration search the symbol tables already answer
    // How stale a brief may be before the guards stop answering from it. A
    // guard quoting a region located for a different task is the janitor's
    // dead-anchor mistake with a faster clock.
    brief_max_age_min: 45,
    // Below this share of the working window a whole-file read is too cheap to
    // argue about, so the quote is not served and the read goes through.
    serve_min_share: 0.02,
    // ── enforcement past Claude Code ──────────────────────────────────────
    //
    // The guards above are PreToolUse handlers, and PreToolUse is Claude
    // Code's. Every other agent on the box gets the instructions block, which
    // is advice, and `bb uptake` says what advice is worth. Two answers:
    //
    //   agent_hooks   write each agent's own pre-read/pre-search guard where
    //                 that agent has a hook system. Shapes are per agent and
    //                 most of them are UNVERIFIED (see wire/agents.js), so
    //                 this is off until somebody on that agent turns it on.
    //   proxy         `bb proxy -- <agent command>` packs the prompt, serves
    //                 the located regions and sieves the output at the
    //                 DOORWAY, for an agent with no hook system at all. It is
    //                 what `lanes.custom_command` is meant to hold.
    agent_hooks: false,
    // Which bullets of the instructions block are installed. Empty = all of
    // them. `bb wire trim --apply` writes the ids of the ones `bb uptake`
    // measured nobody reaching for: every line here is billed on every prompt
    // of every session whether it is used or not.
    trim: [],
    // The same, for MCP tools. A tool's name, description and input schema all
    // sit in the system prompt of a session that has the server wired. Trimmed
    // tools are dropped from `tools/list` and still DISPATCH if something asks
    // for one by name: hiding a capability is a saving, breaking one is not.
    trim_tools: [],
  },
  janitor: {
    // What the hooks do with a compiled heap. Every one of these reads an
    // artefact `bb janitor compile` already wrote; no hook ever runs the
    // compiler, because a handler that fires on every prompt cannot afford to.
    //
    // The two injection points are the two this box has EVIDENCE for:
    // SessionStart and UserPromptSubmit both deliver additionalContext and both
    // are observable in a transcript. PreCompact is used only to record that a
    // compaction happened; nothing is emitted from it, because whether its
    // stdout reaches the window is not documented and a hook built on a guess
    // is a hook that silently does nothing.
    notify: true,           // SessionStart: name the memory whose anchors no longer resolve
    restate_rules: true,    // UserPromptSubmit after a compaction: state the rules again, in full
    // PreCompact freezes what the session was doing — task, scope, files
    // edited, last commands, unmet gates, open questions — from the record on
    // disk, and SessionStart(compact) or the next prompt puts it back. The
    // summary keeps what looked important; the record keeps the work.
    narrative: true,
    refresh: true,          // SessionEnd: recompile the heap while the transcript is fresh
    // How stale an emitted artefact may be before the hooks stop quoting it. A
    // janitor that asserts a stale fact about staleness has failed twice.
    max_age_hours: 168,
  },
  grapple: {
    // The handoff layer: what the box cannot settle, asked once and stored.
    // `observe` runs every detector and injects nothing — the queue is
    // written, the harvest runs, and every event says what the other phases
    // would have done. `enforce` adds ONE blocking check, the pre-write scope
    // guard, and lets the queue reach the window. The phase moves when the
    // bench arms say the guard earned it, not before.
    enabled: true,
    phase: "observe",
    ask_per_session: 2,       // past this a queue is an interruption
    question_ttl_hours: 72,   // an open question past this is `expired-unanswered`, never `answered`
    ratify_batch: 10,         // yes/no rows per proposal: one decision moment
    min_labels: 10,           // below this the harvest reports `unknown`, not a rate
    drift_at: 0.67,           // the drift score that counts as no progress
  },
  foreman: {
    // A responsibility policy over the coding agent (`bb foreman`). Jev answers
    // the checks when TYPESAFE_API_KEY is set, the box's own evidence when not.
    // `thresholds` overrides a bar by check key, e.g.
    // "core.worker-health__worker_stuck": 0.7; `disabled` drops a responsibility.
    enabled: true,
    thresholds: {},
    disabled: [],
    max_steers: 1,            // a second warning after a steer is a stop
    steer_grace_turns: 5,     // turns after a steer before another warning counts
    max_iterations: 50,       // assessments per run before a person is asked
    max_retries: 2,           // stop and resume cycles before a person is asked
    verify: "",               // the verification command; empty is `npm test` when there is a test script
    // The PostToolUse watcher. `observe` records what it would have said and
    // injects nothing; `steer` puts the steer or stop into the agent's window;
    // `off` skips it. Move to `steer` once `bb foreman replay` over the labelled
    // observe rows says the bars are right.
    hook: "observe",
    hook_every: 10,           // tool calls between assessments, per session
    hook_jev: false,          // a Jev call here is paid inside the session
  },
  sentinel: {
    // The overseer (`bb sentinel`): the free path first, agents for the rest.
    gate: "npm run lint && npm test",  // what an auto-fix branch must pass before a PR
    base: "",                 // the branch fixes start from and PRs target; empty = origin's HEAD
    top: 5,                   // findings handed to lanes per run (A6)
    max_rounds: 3,            // review-feedback lanes per PR before it waits for a person (A3)
    autonomy_after: 5,        // clean merges in a row before a fix type may auto-merge (A5)
  },
  ironguard: {
    // The security gate every Sentinel branch passes before a push. Paths are
    // prefixes or globs over the diff; a hit in `protected` blocks, always.
    protected: [".github/workflows/", ".bundlebox/config.json", ".env", "*.pem", "*.key", "id_rsa", ".npmrc"],
    max_files: 40,            // a diff wider than this is not an unattended change
    max_lines: 800,
  },
  lathe: {
    // The automation engine's input. The PostToolUse hook appends the SHAPE of
    // each shell command — `git commit`, never the message — because mining the
    // same order out of the transcripts took four minutes of wall clock for
    // 4.8 seconds of CPU on this box: 1.4GB of JSONL, parsed in full to recover
    // one string per tool call.
    record_shapes: true,
    max_rows: 20000,        // the oldest half is dropped past this
    // SessionEnd: re-learn and re-emit while the session's own shapes are
    // fresh. 1.4s measured, because it reads the recorded shapes rather than
    // the transcripts they came from.
    learn_on_end: true,
    // ── the actuator ──────────────────────────────────────────────────────
    //
    // Everything above PROPOSES. `bb lathe apply` is the half that closes the
    // loop: a habit at or over `apply_at` becomes a tagged script in
    // `scripts/`, with a recom record behind it so the script goes stale when
    // the tree it was learned from moves.
    //
    // Higher than MIN_SUPPORT on purpose. Three occurrences is enough to call
    // something a habit and print it; writing a file into the repository is a
    // stronger claim, and the extra two occurrences are what pays for it.
    apply_at: 5,
    // Applied scripts are re-judged on this clock. A script whose habit has not
    // recurred since it was written displaced nothing, and it is the same dead
    // wiring `bb uptake` measures everywhere else.
    reach_days: 21,
    reach_min: 1,             // occurrences since it was applied, below which it is tombstoned
    apply_on_end: false,      // SessionEnd may propose; writing into scripts/ stays a decision
    script_lang: "py",        // applied scripts: py (python3 runs each step under bash -o pipefail) or sh
  },
  bench: {
    // `bb bench run` prints the tasks where packed costs MORE than bare. This
    // turns that report into a gate: a task that loses is opted out of packing
    // by the router rather than packed and lost again.
    gate: true,
    // How much packed has to win by before the router trusts it. 0 = any win.
    // A task inside this band is routed bare, because a 2% win does not pay for
    // the locate.
    min_win_pct: 2,
    // Past this age the last run is not evidence about the tree as it is now.
    max_age_hours: 336,
  },
  echos: {
    // The session-level agents: what the WORK looks like from outside it.
    // Every other detector reads the tree; an echo reads the record of what
    // sessions did to it, and reports the four shapes that mean a loop is not
    // converging (arc/src/echos.rs).
    enabled: true,
    on_session_end: true,     // SessionEnd: run them while the session's own rows are fresh
    // Thresholds, as data. Each is the floor at which a shape stops being a
    // coincidence of one session; `bb echos --json` prints every one it used.
    spin_repeats: 4,          // identical command shape, this many times in a row
    oscillate_flips: 3,       // a file's content returning to a value it already had
    drift_turns: 12,          // turns in a session before "no file changed" is a finding
    diminishing_ratio: 1.6,   // late-window cost per change over early-window cost
    converge_similarity: 0.95,// brief-to-brief scope overlap at which the work has stabilised
    converge_runs: 3,         // consecutive briefs that must hold it
  },
  finish: {
    // `bb finish`: the acceptance ledger. The Stop hook is a STRUCTURAL
    // backstop and executes no check — it reports a declared gate that is
    // still unmet when a session is about to say it is done. Silent in a
    // workspace with no GATES.md, because a tree that declared no bar has not
    // failed to meet one.
    stop_hook: true,
  },
  slop: {
    // The prose the AGENT writes. `bb slop` has always run over every brief,
    // commit message and PR body this factory emits; what it never saw was the
    // markdown the model writes into the tree, which the next session re-reads
    // and is billed for again. Advisory only: a hedge is sometimes the honest
    // word, and a hook that rewrites somebody's sentence unasked is worse than
    // the sentence.
    guard_writes: true,
    floor: 3,               // fewer hits than this is a word, not a habit
    max_hits: 5,            // lines named in the one band it emits
  },
  recom: {
    // Every repeatable surface in this box re-drives on a schedule today: the
    // cron line, each pipeline stage, a cookbook board, a genesis coverage
    // check. `bb recom gate` already knows how to not run something whose
    // answer still holds; this points it at those four.
    //
    // A fact-record is written the first time each one runs and re-probed
    // afterwards, so a stage whose inputs have not moved is SKIPPED rather
    // than re-derived. That kills whole sessions, not tokens inside one.
    auto_facts: true,
    // Written for a surface only once it has actually produced something. A
    // record made from a failed run would gate on a fact about nothing.
    record_on_success: true,
  },
  cron: { sweep_every_min: 30, autonomous_fix: false },
};

let _cache = null;
export const configPath = () => path.join(BB_DIR, "config.json");
export const calibrationPath = () => path.join(VAR, "calibration.json");

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/** Config with overrides and calibration folded in. Cached per process. */
export function load({ fresh = false } = {}) {
  if (_cache && !fresh) return _cache;
  let cfg = structuredClone(DEFAULTS);
  const user = readJson(configPath(), {});
  if (user && typeof user === "object") cfg = deepMerge(cfg, user);
  const cal = readJson(calibrationPath(), {});
  if (cal && typeof cal === "object") {
    if (cal.tokens) cfg.tokens = { ...cfg.tokens, ...cal.tokens };
    if (cal.churn_factor) cfg.budget.churn_factor = cal.churn_factor;
    if (cal.overhead_tokens) cfg.budget.overhead_tokens = cal.overhead_tokens;
    if (cal.overhead_lean) cfg.budget.overhead_lean = cal.overhead_lean;
    // Fitted per repo by `bb tokens calibrate --apply`, alongside churn. They
    // were shipped constants that nothing ever refitted, so every brief in
    // every workspace was budgeted with one box's numbers.
    if (cal.anchor_widen) cfg.budget.anchor_widen = cal.anchor_widen;
    if (cal.reserve_by_kind) cfg.budget.reserve_by_kind = { ...cfg.budget.reserve_by_kind, ...cal.reserve_by_kind };
  }
  cfg.workspace.root = ROOT;
  _cache = cfg;
  return cfg;
}
export function save(user) { writeJson(configPath(), user); _cache = null; }
export function userConfig() { return readJson(configPath(), {}) || {}; }
