// mcp/server.js — bundlebox as an MCP server over stdio, with no dependency.
//
// JSON-RPC 2.0, newline-delimited, exactly what every MCP-capable agent (Claude
// Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Cline...) speaks. The
// tools exposed are the zero-token verbs: an agent that can ask `bb_pinpoint`
// for a packed brief or `bb_snapgen` for the symbol table does not spend turns
// searching for what the factory already knows.
import { createInterface } from "node:readline";
import { TOOLS } from "./tools.js";

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
      if (method === "tools/list") return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
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
