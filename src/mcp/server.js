// mcp/server.js — bundlebox as an MCP server over stdio, with no dependency.
//
// JSON-RPC 2.0, newline-delimited, exactly what every MCP-capable agent (Claude
// Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Cline...) speaks. The
// tools exposed are the zero-token verbs: an agent that can ask `bb_pinpoint`
// for a packed brief or `bb_snapgen` for the symbol table does not spend turns
// searching for what the factory already knows.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { TOOLS } from "./tools.js";
import { load } from "../core/config.js";
import { ROOT } from "../core/paths.js";

/** Whether Claude Code in this workspace already runs pinpoint on every task
 *  prompt through `bb hook prompt`. Then the always-loaded `bb_pinpoint` schema
 *  is the same locate wired twice: about 200 tokens on every call, for a tool
 *  the agent called twice in eight Terminal-Bench trials with the brief already
 *  in its window, neither call changing what it did. Deferred, it stays one
 *  name and one search away. */
export function promptHookWired(root = ROOT) {
  for (const f of ["settings.json", "settings.local.json"]) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(root, ".claude", f), "utf8")); } catch { continue; }  // not written, or not ours to parse
    const groups = s?.hooks?.UserPromptSubmit;
    if (Array.isArray(groups) && groups.some((g) => (g?.hooks || []).some((h) => /(^|[\s/])bb(\.js)? hook prompt\b/.test(String(h?.command || ""))))) return true;
  }
  return false;
}

/** The tools this workspace advertises. Read per call rather than once: the
 *  server holds one process for the life of a session, and a trim applied
 *  during it should reach the next `tools/list` rather than the next restart. */
export function listed() {
  const off = new Set((load({ fresh: true }).wire?.trim_tools || []).map(String));
  const kept = TOOLS.filter((t) => !off.has(t.name));
  // Advertising nothing is how a server looks broken. A trim that would empty
  // the list is ignored and the full set is served, because "this server has no
  // tools" is a different claim from "these tools are not worth their window".
  return kept.length ? kept : TOOLS;
}

export const PROTOCOL_VERSION = "2025-06-18";

export function serve({ input = process.stdin, output = process.stdout, name = "bundlebox", version = "0.0.0" } = {}) {
  const send = (msg) => output.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
    const { id, method, params = {} } = msg;
    try {
      if (method === "initialize") {
        return reply(id, { protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } }, serverInfo: { name, version },
          instructions: "bundlebox: zero-token facts about this repository. Call bb_pinpoint before searching, bb_snapgen for tables, bb_context before opening a large scope." });
      }
      if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
      if (method === "ping") return reply(id, {});
      // `wire.trim_tools` is what `bb wire trim --apply` measured nobody
      // calling. Every tool listed here puts its name, description and input
      // schema into the system prompt of every session that has this server
      // wired, and it is re-sent on every turn — so a tool nothing reaches for
      // is the same tax the instructions block was.
      //
      // Listed, never CALLED-away: a trimmed tool is still dispatched if
      // something asks for it by name. Hiding a capability is a saving;
      // breaking one is not.
      if (method === "tools/list") {
        const always = new Set((load({ fresh: true }).wire?.always_load_tools || []).map(String));
        if (promptHookWired()) always.delete("bb_pinpoint");
        return reply(id, { tools: listed().map(({ name, description, inputSchema }) =>
          ({ name, description, inputSchema, ...(always.has(name) ? { _meta: { "anthropic/alwaysLoad": true } } : {}) })) });
      }
      if (method === "tools/call") {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(id, -32602, `unknown tool ${params.name}`);
        try {
          const out = await tool.run(params.arguments || {});
          return reply(id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }], isError: false });
        } catch (e) {
          return reply(id, { content: [{ type: "text", text: `error: ${e.message || e}` }], isError: true });
        }
      }
      if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
    } catch (e) { if (id !== undefined) fail(id, -32603, String(e.message || e)); }
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
