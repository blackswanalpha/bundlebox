# bundlebox — internal conventions (for contributors and for the build agents)

Node >= 20, ESM, **zero runtime dependencies**. `node --check` and `node --test test/` must pass.
No network at import time. No TypeScript. No build step. Every module is plain `.js` under `src/`.

## Core API (already written — import, do not duplicate)

| module | exports |
|---|---|
| `src/core/paths.js` | `ROOT` (workspace root: nearest `.git` or `.bundlebox/config.json` above cwd, or `BB_ROOT`), `BB_DIR` (`<root>/.bundlebox`), `VAR` (`.bundlebox/var`), `OUT` (`.bundlebox/out`), `HOME` (`~/.bundlebox`), `PKG_ROOT`, `rel(p)`, `abs(p)`, `ensureDirs()` |
| `src/core/config.js` | `DEFAULTS`, `load()` (defaults ⊕ `.bundlebox/config.json` ⊕ `var/calibration.json`), `save(userCfg)`, `userConfig()`, `readJson(p, fallback)`, `writeJson(p, obj)` (atomic) |
| `src/core/fs.js` | `walk(base, {suffixes, maxBytes})` → sorted absolute paths honouring `workspace.ignore` + root `.gitignore`; `readText(p, fallback)`; `isGenerated(p)`; `kindOf(p)` → `prose|code`; `langOf(p)`; `PROSE_SUFFIX`, `CODE_SUFFIX`, `SOURCE_SUFFIX`; `isIgnored(name)` |
| `src/core/exec.js` | `run(argv, {cwd, timeout, input, env})` → `{rc, out, err, missing}` (never throws); `which(bin)`; `git(args, cwd)`; `gitOk(cwd)`; `stream(argv, {cwd, env, input, onLine, onErr, timeout})` → Promise `{rc, seconds, stderr}` (stderr is drained, so no pipe deadlock) |
| `src/core/store.js` | JSON docs: `get(name, fallback)`, `put(name, value)`; JSONL logs: `append(name, row)`, `rows(name, {limit})`; `findingId(f)`, `mergeFindings(fresh, {detectors: Set})`, `openFindings()` |
| `src/core/util.js` | `now()`, `stamp()`, `sha1()`, `shortId()`, `human(n)` (12.3k), `usd(n)`, `pad`, `median`, `sum`, `uniq`, `clamp`, `slug`, `deepMerge`, `table(rows, {header})` |
| `src/core/args.js` | `parse(argv)` → `{_, flags, rest}` (`--max-files 6` → `flags.maxFiles === 6`) |
| `src/core/log.js` | `out()`, `warn()`, `emit(obj)` (JSON mode), `setMode({quiet,json})`, `isJson()`, `hr()` |
| `src/tokens/estimate.js` | `text(s, kind)`, `file(p)`, `files(paths)` → `{files:{rel:n}, total, bytes, missing}`, `tree(base)`, `features(s)`, `fromBytes(bytes, kind)` |
| `src/tokens/prices.js` | `PER_MTOK`, `normalise(model)`, `known(model)`, `cost(model, {inp, out, cache_write, cache_read})` → `{input, cache_write, cache_read, output, total, cache_saved}` or `null`, `table()` |
| `src/update/index.js` | `currentVersion()`, `latestVersion()`, `checkCached()`, `update({apply})` |
| `src/mcp/server.js` | `serve({name, version})` — reads tools from `src/mcp/tools.js` (`export const TOOLS = [{name, description, inputSchema, run(args)}]`) |

## Command registration

Every feature module exports `commands`:

```js
export const commands = {
  scan: {
    help: "run the local detectors (no tokens)",
    usage: "bb scan [--only a,b] [--json] [--write]",
    run: async ({ _, flags }) => { /* ...; return exit code (0) */ },
  },
};
```
`src/cli.js` merges every module's `commands` into one table. A verb with sub-verbs takes `_[0]` as the sub-verb.
Print with `out()`; when `flags.json` is set print one JSON object with `emit()` and nothing else.

## Data shapes (the whole contract between stages)

**Finding** (`store.get("findings")`):
```js
{ id, detector, severity: "info|low|medium|high|critical", precision: "exact|probe|heuristic",
  title, path /* primary file, rel */, files: [rel], key /* stable subject for the id */,
  detail /* <=1500 chars, the payload a brief pastes */, evidence: { /* concrete: lines, counts, snippets */ },
  fix_hint, auto_fix: "actuator-name"|null, kind: "fix|verify|investigate|build|write",
  est_tokens, status: "open|resolved|fixed|wontfix", first_seen, last_seen, seen_count }
```
A finding **must** carry evidence. `key` must be stable across runs (path + symbol, not line numbers).

**Detector** (`src/detectors/<name>.js`):
```js
export default { name: "doc-links", precision: "exact", severity: "low", description: "...",
  run(ctx) { /* ctx = { root, cfg, files /* walked source abs paths */, readText, git(args) } */ return [finding-ish objects without id/status]; } }
```
`src/detectors/index.js` exports `REGISTRY` (name → detector) and `runAll({only}) → { findings, ran: [{name, ms, count, error}] }`. A detector that throws becomes a row, never a crash.

**Unit** (`store.get("units")`): `{ id, kind, rule, title, finding_ids, scope: [rel], anchors: [{path, symbol, line_start, line_end, tokens}], brief, acceptance, est_tokens, projected, verdict: "FITS|TIGHT|SPLIT|HEAVY", priority, model, status: "ready|assigned|done|failed|local" }`

**Lane** (`store.get("lanes")`): `{ id: "L01", run_id, session_id, unit_ids, files, est_tokens, cwd, worktree, branch, wave, agent, model, slots, status, rc, why, peak, started, ended }`

**Episode** (`store.append("episodes", row)`): `{ kind: "stage|script|call|lane|hook|actuator", verb, prev, features: { /* only what was knowable BEFORE */ }, rc, seconds, produced, reads, turns_saved, run_id, useful: -1|0|1 }`
`turns_saved` is counted, never guessed: `files_read + commands + searches + floor(rows/40)`.

**Session usage row** (`store.append("usage", row)`): `{ session_id, msg_id, agent, model, input, output, cache_write, cache_read, ts, run_id, lane_id }` — keyed `(session_id, msg_id)` last-wins; never double count.

## Doctrine (the rules that make the numbers true)
1. If the answer is a set difference, a path check, a count or a parse, it is a detector and costs nothing.
2. Degrade to **unknown**, never to a plausible answer: return `null` when you could not look, `[]` only when you looked and found nothing.
3. A measured number and an estimate are never added and never printed the same way. Label rows MEASURED / ESTIMATE.
4. A model this tool has no price for is reported with tokens and no cost.
5. Every verb defaults to dry-run; `--apply` spends or mutates. Write the artefact (prompt, command) before spawning.
6. One implementation per fact (one fingerprint, one walker, one estimator).
7. Derived artefacts are never edited by hand; they are fingerprinted `(count:sha1(path,mtime_ns,size))`.
8. Never print a green that means "nothing was checked". Skipped ≠ passed. `unproven` is a state.
9. Thresholds are data, relative to the tree's own median where possible.
10. The tool never inherits the whole parent env into a spawned agent; pass an allowlist.
