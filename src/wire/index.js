// wire/index.js — `bb wire`: put bundlebox in front of every agent on this box.
//
// Instructions block, MCP server entry, and (Claude Code) the hooks that hand a
// session the snapgen index at start and measure it at end. Dry run by default:
// it lists every file it would create or change with a preview, and only
// `--apply` writes. Every edit is a pure text transform applied to the file's
// current content, so applying twice is byte-identical and `unwire` removes
// exactly the pieces this module added and nothing the user wrote.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel } from "../core/paths.js";
import { load } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { AGENTS, ORDER, INSTRUCTIONS, instructions, START, END, CLAUDE_HOOKS, isOurHook, detectAgents } from "./agents.js";
import { wired as artemisWired } from "../recom/artemis.js";
import { commands as proxyCommands } from "./proxy.js";

// Whether this box has a mobile driver registered decides whether the block
// carries the sentence about one. Read once per process rather than per file:
// `bb wire --apply` writes the same block into ten files and they must not
// differ because a device was unplugged between two of them.
let _mobile = null;
export function mobileWired() {
  if (_mobile !== null) return _mobile;
  _mobile = artemisWired().length > 0;
  return _mobile;
}
export const setMobileWired = (v) => { _mobile = Boolean(v); };
/** The block as this workspace has it: mobile line if there is a phone, minus
 *  whatever `bb wire trim --apply` measured nobody reaching for. */
const block = () => instructions({ mobile: mobileWired(), trim: load().wire?.trim || [] });

// ── edit transforms: (before | null) -> after | null (null = delete/absent) ──

export function addBlock(before) {
  const cur = before || "";
  const text = block();
  // A block trimmed down to nothing is not written as an empty block: a heading
  // with no bullets under it is pure cost in every window. Adding nothing IS
  // removing what is there.
  if (!text) return removeBlock(before);
  const i = cur.indexOf(START), j = cur.indexOf(END);
  if (i >= 0 && j > i) return cur.slice(0, i) + text + cur.slice(j + END.length);
  if (!cur.trim()) return text + "\n";
  return cur.replace(/\s*$/, "") + "\n\n" + text + "\n";
}
export function removeBlock(before) {
  if (before == null) return null;
  const i = before.indexOf(START), j = before.indexOf(END);
  if (i < 0 || j < i) return before;
  const after = (before.slice(0, i).replace(/\n+$/, "") + before.slice(j + END.length).replace(/^\n+/, "\n")).replace(/^\n+/, "");
  return after.trim() ? (after.endsWith("\n") ? after : after + "\n") : null;
}

const parseJson = (s) => { if (!s || !s.trim()) return {}; return JSON.parse(s); };
const dumpJson = (o) => JSON.stringify(o, null, 2) + "\n";

/** `<key>.bundlebox = shape()`; the rest of the document is untouched. */
export function addMcp(before, { key, shape }) {
  const o = parseJson(before);
  o[key] = o[key] && typeof o[key] === "object" ? o[key] : {};
  o[key].bundlebox = shape();
  return dumpJson(o);
}
export function removeMcp(before, { key }) {
  if (before == null) return null;
  let o; try { o = parseJson(before); } catch { return before; }
  if (!o[key] || typeof o[key] !== "object" || !("bundlebox" in o[key])) return before;
  delete o[key].bundlebox;
  if (!Object.keys(o[key]).length) delete o[key];
  return Object.keys(o).length ? dumpJson(o) : null;
}

/** Claude Code hooks. Our entries are recognised by their command, so a user
 *  hook on the same event (even the same matcher) survives both directions. */
export function addClaudeHooks(before) {
  const o = parseJson(before);
  o.hooks = o.hooks && typeof o.hooks === "object" ? o.hooks : {};
  // Strip every previous copy ONCE PER EVENT, before anything is added, so a
  // changed timeout does not leave two rows behind.
  //
  // Per event, not per row. It used to strip inside the loop, which was
  // invisible while each event had exactly one handler and silently wrong the
  // moment one had two: PreToolUse(Read) was installed by the first row and
  // then stripped again by the second, so `bb wire --apply` shipped a settings
  // file with the read guard missing and no diff to say so.
  const seen = new Set();
  for (const h of CLAUDE_HOOKS) {
    const list = Array.isArray(o.hooks[h.event]) ? o.hooks[h.event] : [];
    if (!seen.has(h.event)) {
      seen.add(h.event);
      o.hooks[h.event] = list.map((g) => ({ ...g, hooks: (g.hooks || []).filter((x) => !isOurHook(x)) })).filter((g) => g.hooks.length);
    }
    const kept = o.hooks[h.event];
    const entry = { type: "command", command: `bb hook ${h.cmd}`, timeout: h.timeout, ...(h.statusMessage ? { statusMessage: h.statusMessage } : {}) };
    const group = { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [entry] };
    // Same-matcher group already present: join it rather than adding a twin.
    const twin = kept.find((g) => (g.matcher || "") === (h.matcher || ""));
    if (twin) twin.hooks.push(entry); else kept.push(group);
  }
  return dumpJson(o);
}
export function removeClaudeHooks(before) {
  if (before == null) return null;
  let o; try { o = parseJson(before); } catch { return before; }
  if (!o.hooks || typeof o.hooks !== "object") return before;
  for (const ev of Object.keys(o.hooks)) {
    if (!Array.isArray(o.hooks[ev])) continue;
    o.hooks[ev] = o.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((x) => !isOurHook(x)) })).filter((g) => g.hooks.length);
    if (!o.hooks[ev].length) delete o.hooks[ev];
  }
  if (!Object.keys(o.hooks).length) delete o.hooks;
  return Object.keys(o).length ? dumpJson(o) : null;
}

/** Another agent's hooks file, which is a flat `{version, hooks: {event: [...]}}`
 *  rather than Claude Code's matcher groups.
 *
 *  Ours are recognised by the same rule as everywhere else — the command starts
 *  with `bb hook` — so a user's own entry on the same event survives both
 *  directions. That rule is the whole reason `bb unwire` can be trusted: this
 *  box never owns a file it did not create, only the rows inside it that name
 *  its own binary. */
export function addAgentHooks(before, { shape }) {
  const o = parseJson(before);
  const want = shape();
  o.version = o.version || want.version || 1;
  o.hooks = o.hooks && typeof o.hooks === "object" ? o.hooks : {};
  for (const [event, entries] of Object.entries(want.hooks || {})) {
    const kept = (Array.isArray(o.hooks[event]) ? o.hooks[event] : []).filter((x) => !isOurHook(x));
    o.hooks[event] = [...kept, ...entries];
  }
  return dumpJson(o);
}
export function removeAgentHooks(before) {
  if (before == null) return null;
  let o; try { o = parseJson(before); } catch { return before; }
  if (!o.hooks || typeof o.hooks !== "object") return before;
  for (const ev of Object.keys(o.hooks)) {
    if (!Array.isArray(o.hooks[ev])) continue;
    o.hooks[ev] = o.hooks[ev].filter((x) => !isOurHook(x));
    if (!o.hooks[ev].length) delete o.hooks[ev];
  }
  if (!Object.keys(o.hooks).length) delete o.hooks;
  // `version` alone is a file we wrote and nothing else: it goes with the rows.
  if (Object.keys(o).length === 1 && "version" in o) return null;
  return Object.keys(o).length ? dumpJson(o) : null;
}

/** TOML: one `[section]` block, appended or replaced by text. No TOML parser
 *  exists in a zero-dependency package, so the edit is a section-bounded
 *  splice: from our header to the next `[` header or EOF. */
const tomlSection = (text, section) => {
  const re = new RegExp(`(^|\\n)\\[${section.replace(/\./g, "\\.")}\\]\\s*\\n`);
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + (m[1] ? 1 : 0);
  const rest = text.slice(start + m[0].length - (m[1] ? 0 : 0));
  const bodyStart = start + (m[0].length - (m[1] ? 1 : 0));
  const next = /\n\[/.exec(text.slice(bodyStart));
  const end = next ? bodyStart + next.index + 1 : text.length;
  void rest;
  return { start, end };
};
export function addToml(before, { section, body }) {
  const cur = before || "";
  const block = `[${section}]\n${body}\n`;
  const s = tomlSection(cur, section);
  if (s) return cur.slice(0, s.start) + block + (s.end < cur.length ? "\n" : "") + cur.slice(s.end).replace(/^\n+/, "");
  if (!cur.trim()) return block;
  return cur.replace(/\s*$/, "") + "\n\n" + block;
}
export function removeToml(before, { section }) {
  if (before == null) return null;
  const s = tomlSection(before, section);
  if (!s) return before;
  const after = (before.slice(0, s.start).replace(/\n+$/, "\n") + before.slice(s.end).replace(/^\n+/, "")).replace(/^\n+/, "");
  return after.trim() ? after : null;
}

/** Aider `.aider.conf.yml`: a `read:` list entry inside a marked block. When the
 *  user already has a `read:` key we do not merge into it (no YAML parser);
 *  the row says `manual` and names the line to add. */
const YSTART = "# bundlebox:start", YEND = "# bundlebox:end";
export function addYamlRead(before, { entry }) {
  const cur = before || "";
  const block = `${YSTART}\nread:\n  - ${entry}\n${YEND}\n`;
  const i = cur.indexOf(YSTART), j = cur.indexOf(YEND);
  if (i >= 0 && j > i) return cur.slice(0, i) + block + cur.slice(j + YEND.length).replace(/^\n/, "");
  if (/^\s*read\s*:/m.test(cur)) return { manual: `add \`- ${entry}\` under the existing \`read:\` key` };
  if (!cur.trim()) return block;
  return cur.replace(/\s*$/, "") + "\n\n" + block;
}
export function removeYamlRead(before) {
  if (before == null) return null;
  const i = before.indexOf(YSTART), j = before.indexOf(YEND);
  if (i < 0 || j < i) return before;
  const after = (before.slice(0, i).replace(/\n+$/, "\n") + before.slice(j + YEND.length).replace(/^\n+/, "")).replace(/^\n+/, "");
  return after.trim() ? after : null;
}

// ── planning ────────────────────────────────────────────────────────────────

const readOrNull = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const absOf = (p, root) => (path.isAbsolute(p) ? p : path.join(root, p));

function transform(f, before, mode) {
  try {
    switch (f.kind) {
      case "block": return mode === "add" ? addBlock(before) : removeBlock(before);
      case "owned": return mode === "add" ? f.content : null;
      case "json": {
        if (f.edit === "claude-hooks") return mode === "add" ? addClaudeHooks(before) : removeClaudeHooks(before);
        if (f.edit === "agent-hooks") return mode === "add" ? addAgentHooks(before, f) : removeAgentHooks(before);
        return mode === "add" ? addMcp(before, f) : removeMcp(before, f);
      }
      case "toml": return mode === "add" ? addToml(before, f) : removeToml(before, f);
      case "yaml-read": return mode === "add" ? addYamlRead(before, f) : removeYamlRead(before);
      // A file copied from the package: a skill document. The whole file is
      // ours, so `add` is its current contents and `remove` is deletion —
      // unlike every other kind here, which owns a marked block inside a file
      // somebody else also writes to.
      case "copy": return mode === "add" ? fs.readFileSync(f.from, "utf8") : null;
      default: return { manual: `unknown edit kind ${f.kind}` };
    }
  } catch (e) {
    // A file we cannot parse is a file we do not touch. The row says so.
    return { manual: `could not parse: ${String(e.message || e).slice(0, 80)}` };
  }
}

/** Resolve `--agents`: explicit list, or every agent detected on the box. */
export async function resolveAgents(spec, cfg = load()) {
  let names = typeof spec === "string" ? spec.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(spec) ? spec : [];
  if (!names.length) names = Array.isArray(cfg.wire?.agents) ? cfg.wire.agents : ["auto"];
  if (names.includes("auto")) names = [...new Set([...names.filter((n) => n !== "auto"), ...(await detectAgents())])];
  const unknown = names.filter((n) => !AGENTS[n]);
  return { names: names.filter((n) => AGENTS[n]), unknown };
}

/** Every file each agent needs, with the before/after and an action. */
export function plan(names, { root = ROOT, scope = "project", mode = "add" } = {}) {
  const rows = [];
  for (const name of names) {
    const a = AGENTS[name];
    const files = a.files(scope);
    if (!files.length) { rows.push({ agent: name, path: "", action: "skip", note: `${a.label}: no ${scope} location` }); continue; }
    for (const f of files) {
      const p = absOf(f.path, root);
      const before = readOrNull(p);
      if (mode === "remove" && before == null) { rows.push({ agent: name, path: p, action: "absent" }); continue; }
      const after = transform(f, before, mode);
      let action;
      if (after && typeof after === "object" && after.manual) action = "manual";
      else if (after == null) action = before == null ? "absent" : "delete";
      else if (before == null) action = "create";
      else if (after === before) action = "unchanged";
      else action = "modify";
      rows.push({ agent: name, path: p, kind: f.kind, action, before, after: action === "manual" ? null : after,
        note: action === "manual" ? after.manual : a.verified ? "" : "unverified shape", verified: Boolean(a.verified) });
    }
  }
  return rows;
}

export function applyPlan(rows) {
  let n = 0;
  for (const r of rows) {
    if (r.action === "create" || r.action === "modify") {
      fs.mkdirSync(path.dirname(r.path), { recursive: true });
      fs.writeFileSync(r.path, r.after);
      n++;
    } else if (r.action === "delete") {
      try { fs.unlinkSync(r.path); n++; } catch { /* already gone */ }
    }
  }
  return n;
}

/** Per agent: which of its files carry our pieces right now. */
export function status(names, { root = ROOT, scope = "project" } = {}) {
  return names.map((name) => {
    const rows = plan([name], { root, scope, mode: "add" }).filter((r) => r.path);
    const wired = rows.filter((r) => r.action === "unchanged").length;
    return { agent: name, label: AGENTS[name].label, files: rows.length, wired, state: !rows.length ? "n/a" : wired === rows.length ? "wired" : wired ? "partial" : "unwired",
      verified: Boolean(AGENTS[name].verified), paths: rows.map((r) => ({ path: rel(r.path), ok: r.action === "unchanged" })) };
  });
}

function preview(r, root) {
  const p = path.isAbsolute(r.path) && !r.path.startsWith(root) ? r.path : rel(r.path);
  const lines = [`  ${r.action.padEnd(9)} ${p}${r.note ? `   (${r.note})` : ""}`];
  if (r.action === "create" || r.action === "modify") {
    const body = r.kind === "block" ? block() : r.after;
    const shown = String(body).split("\n").slice(0, r.kind === "block" ? 3 : 8);
    for (const l of shown) lines.push(`             | ${l}`);
    if (String(body).split("\n").length > shown.length) lines.push("             | ...");
  }
  return lines.join("\n");
}

// ── commands ────────────────────────────────────────────────────────────────

export const commands = {
  wire: {
    help: "install the instructions block, MCP entry and hooks into each agent",
    usage: "bb wire [--agents claude,codex,...|auto] [--apply] [--global] [--json] | bb wire status | bb wire trim [--apply]",
    long: `  Dry run lists every file it would create or modify, with a preview.
  --apply writes, idempotently, between <!-- bundlebox:start/end --> markers.
  --global targets the per-user files (~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode).

  \`bb wire trim\` reads \`bb uptake\` and names the instruction lines that were installed, had the
  chance to fire at least three times, and fired none. Every line of the block is billed in every
  window of every session, so a line nothing reaches for is not neutral. --apply writes the ids
  into \`wire.trim\`; \`bb wire --apply\` then rewrites the files from it.

  Agents: ${ORDER.join(", ")}.`,
    run: async ({ _, flags }) => {
      const cfg = load();
      const scope = flags.global ? "global" : "project";
      const { names, unknown } = await resolveAgents(flags.agents, cfg);
      if (unknown.length) warn(`unknown agent(s): ${unknown.join(", ")}; known: ${ORDER.join(", ")}`);
      if (_[0] === "trim") {
        const [{ plan: trimPlan, apply: trimApply }, uptake, mcp] = await Promise.all([
          import("./trim.js"), import("../uptake/index.js"), import("../mcp/tools.js"),
        ]);
        const report = uptake.report({ cfg });
        const p = trimPlan({ cfg, report, mcpTools: mcp.TOOLS });
        if (flags.json) { emit({ ...p, block_after: undefined }); return 0; }
        out(`  uptake over ${report.sessions.length} session(s) — what sits in every window, and what reached for it\n`);
        out("  instructions block — billed on every prompt of every session\n");
        for (const r of p.rows) {
          out(`    ${r.verdict.padEnd(11)} ${r.id.padEnd(10)} ~${String(r.tokens).padStart(3)} tok${r.already ? "  (already trimmed)" : ""}   ${r.why}`);
        }
        out("\n  MCP tools — name, description and input schema, in the system prompt of every wired session\n");
        for (const r of p.tools) {
          out(`    ${r.verdict.padEnd(11)} ${r.name.padEnd(18)} ~${String(r.tokens).padStart(3)} tok${r.already ? "  (already trimmed)" : ""}   ${r.why}`);
        }
        if (p.tools_note) out(`    note: ${p.tools_note}`);
        out("\n  skills — reported only: a skill costs nothing until its trigger fires\n");
        for (const r of p.skills) out(`    ${"report".padEnd(11)} ${r.name.padEnd(18)} ${r.files} file(s)   ${r.why}`);
        if (!p.trim.length && !p.trim_tools.length) {
          out(`\n  nothing measured as dead. The block is ~${p.tokens_before} tokens and every line of it is billed on every prompt.`);
          return 0;
        }
        out("");
        if (p.trim.length) out(`  ${p.trim.length} instruction line(s) installed, given the chance, and reached for 0 times: ${p.trim.join(", ")}`);
        if (p.trim_tools.length) out(`  ${p.trim_tools.length} MCP tool(s) nothing has ever called: ${p.trim_tools.join(", ")}`);
        out(`  the block goes ${p.tokens_before} -> ${p.tokens_after} tokens; together that is ~${p.per_prompt} tokens off EVERY prompt of every session in this workspace.`);
        if (!flags.apply) { out("\n  dry run. --apply writes `wire.trim` and `wire.trim_tools` into .bundlebox/config.json; `bb wire --apply` then rewrites the agent files."); return 0; }
        const w = trimApply(p);
        out(`\n  wrote wire.trim = [${w.wrote.join(", ")}]${w.wrote_tools.length ? `, wire.trim_tools = [${w.wrote_tools.join(", ")}]` : ""}.`);
        out("  Run `bb wire --apply` to rewrite the agent files; the MCP server drops the trimmed tools from its next `tools/list`.");
        return 0;
      }
      if (_[0] === "status") {
        const st = status(names.length ? names : ORDER, { scope });
        if (flags.json) { emit({ scope, agents: st }); return 0; }
        for (const s of st) {
          out(`  ${s.agent.padEnd(9)} ${s.state.padEnd(8)} ${s.wired}/${s.files} files${s.verified ? "" : "   (unverified shape)"}`);
          for (const p of s.paths) out(`             ${p.ok ? "ok " : "-- "} ${p.path}`);
        }
        return 0;
      }
      if (!names.length) { warn("no agents detected on this box; name them: bb wire --agents claude,codex"); return 1; }
      const rows = plan(names, { scope, mode: "add" });
      const work = rows.filter((r) => r.action === "create" || r.action === "modify");
      const manual = rows.filter((r) => r.action === "manual");
      if (flags.json) { emit({ scope, apply: !!flags.apply, agents: names, rows: rows.map(({ before, after, ...r }) => ({ ...r, path: r.path ? rel(r.path) : "" })) }); }
      else {
        out(`  wiring ${names.join(", ")} (${scope})`);
        for (const r of rows) if (r.path) out(preview(r, ROOT)); else out(`  ${r.action.padEnd(9)} ${r.note}`);
      }
      if (!flags.apply) {
        if (!flags.json) out(`\n  ${work.length} file(s) would change${manual.length ? `, ${manual.length} need a manual edit` : ""}. Add --apply to write.`);
        return 0;
      }
      const n = applyPlan(rows);
      if (!flags.json) out(`\n  wrote ${n} file(s)${manual.length ? `; ${manual.length} need a manual edit (see rows above)` : ""}`);
      return 0;
    },
  },
  unwire: {
    help: "remove only bundlebox's blocks, MCP entries and hook rows from each agent",
    usage: "bb unwire [--agents a,b|auto] [--apply] [--global]",
    run: async ({ flags }) => {
      const scope = flags.global ? "global" : "project";
      const { names } = await resolveAgents(flags.agents || (flags.global ? "auto" : ORDER.join(",")));
      const rows = plan(names, { scope, mode: "remove" });
      const work = rows.filter((r) => ["modify", "delete"].includes(r.action));
      if (flags.json) emit({ scope, apply: !!flags.apply, rows: rows.map(({ before, after, ...r }) => ({ ...r, path: r.path ? rel(r.path) : "" })) });
      else for (const r of work) out(`  ${r.action.padEnd(9)} ${rel(r.path)}`);
      if (!work.length) { if (!flags.json) out("  nothing of ours found"); return 0; }
      if (!flags.apply) { if (!flags.json) out(`\n  ${work.length} file(s) would change. Add --apply to write.`); return 0; }
      const n = applyPlan(rows);
      if (!flags.json) out(`\n  changed ${n} file(s)`);
      return 0;
    },
  },
  // The doorway, for an agent whose hook system this box cannot write into.
  // Lives in its own module and is re-exported here so `bb wire`, `bb unwire`,
  // `bb hook` and `bb proxy` are one group in `bb --help`: they are four halves
  // of one question, which is what the agent is actually made to do.
  ...proxyCommands,
  hook: {
    help: "a Claude Code hook handler (stdin JSON in, JSON out, always exit 0)",
    usage: "bb hook session-start|prompt|pre-read|post-tool|pre-compact|session-end",
    run: async ({ _ }) => { const { handle } = await import("./hooks.js"); return handle(_[0]); },
  },
};
