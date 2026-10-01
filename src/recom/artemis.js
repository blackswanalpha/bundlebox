// artemis.js — is there a mobile driver on this box, and is there a device for
// it to drive.
//
// ARTEMIS (github.com/google/artemis) turns a sentence into Android automation
// and reports 99%+ on AndroidWorld. bundlebox cannot do that and should not try:
// driving a phone from natural language is a model call per step, and this
// factory's whole claim is that it never makes one.
//
// What bundlebox has instead is the decision NOT to drive. A record of a run,
// with the facts its answer rests on re-probed on every read, answers "has this
// already been done, and does the answer still hold" for 176ms and no tokens —
// against roughly ten minutes and twenty-four thousand tokens for the drive. So
// ARTEMIS is the expensive verb and `bb recom gate` is what stands in front of
// it.
//
// **This module does not install anything.** ARTEMIS's own
// `uv run artemis mcp --install <client>` writes an entry carrying an absolute
// interpreter path, a PYTHONPATH and a cwd that only it knows:
//
//   {"command": "<python>", "args": ["-m", "mcp_server"],
//    "env": {"PYTHONUNBUFFERED": "1", "PYTHONPATH": "<project>", ...},
//    "cwd": "<project>"}
//
// A second implementation of that guess would write a config whose server never
// starts, and an agent with a dead MCP server sees no tools rather than an
// error — a silent failure, which is the one kind this codebase refuses to
// ship. So bundlebox READS those files and reports what it finds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../core/paths.js";
import { run as execRun, which } from "../core/exec.js";

export const TOOLS = ["mobile_run_task", "mobile_manage_task", "mobile_get_device_state", "mobile_inspect_trace", "mobile_diagnose"];

const home = (...p) => path.join(os.homedir(), ...p);

/** Every file bundlebox already knows an agent keeps MCP servers in. Read-only
 *  here: the same paths `bb wire` writes its own entry into, asked a different
 *  question. */
const CONFIGS = () => [
  { agent: "claude", file: path.join(ROOT, ".mcp.json"), keys: ["mcpServers"] },
  { agent: "claude", file: home(".claude.json"), keys: ["mcpServers"] },
  { agent: "gemini", file: home(".gemini", "settings.json"), keys: ["mcpServers"] },
  { agent: "gemini", file: home(".gemini", "config", "mcp_config.json"), keys: ["mcpServers"] },
  { agent: "gemini", file: path.join(ROOT, ".gemini", "settings.json"), keys: ["mcpServers"] },
  { agent: "cursor", file: path.join(ROOT, ".cursor", "mcp.json"), keys: ["mcpServers"] },
  { agent: "copilot", file: path.join(ROOT, ".vscode", "mcp.json"), keys: ["servers", "mcp.servers"] },
  { agent: "opencode", file: path.join(ROOT, "opencode.json"), keys: ["mcp"] },
  { agent: "opencode", file: home(".config", "opencode", "opencode.json"), keys: ["mcp"] },
];

const at = (obj, dotted) => dotted.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

/** Where an `artemis` MCP server is registered, and what it points at. Never
 *  throws: a torn config is a row saying so, not a crash of the verb. */
export function wired() {
  const found = [];
  for (const { agent, file, keys } of CONFIGS()) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }  // agent not installed, or config unparseable: no entry
    for (const key of keys) {
      const entry = at(doc, key)?.artemis;
      if (!entry) continue;
      const cwd = entry.cwd || entry.env?.PYTHONPATH || "";
      // Two shapes in the wild: `{command: "python", args: [...]}` and
      // opencode's `{command: ["python", ...]}`. Both render to one line.
      const argv = Array.isArray(entry.command) ? entry.command : [entry.command, ...(entry.args || [])];
      found.push({
        agent, file, key,
        command: argv.filter(Boolean).join(" "),
        cwd,
        // The one check worth making on somebody else's config: the project it
        // points at either exists or the server will not start, and an agent
        // with a dead MCP server sees no tools rather than an error.
        project_exists: cwd ? fs.existsSync(cwd) : null,
      });
    }
  }
  // Codex keeps servers in TOML, which bundlebox reads as text rather than
  // adding a parser for one lookup.
  for (const file of [home(".codex", "config.toml"), path.join(ROOT, ".codex", "config.toml")]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }  // codex not configured
    if (/^\s*\[mcp_servers\.artemis\]/m.test(text)) found.push({ agent: "codex", file, key: "mcp_servers.artemis", command: "", cwd: "", project_exists: null });
  }
  return found;
}

/** Attached devices, by serial and state. `adb` absent is not an error: it is
 *  the answer to "can anything be driven here". */
export function devices() {
  if (!which("adb")) return { adb: false, devices: [], why: "adb is not on PATH" };
  const r = execRun(["adb", "devices", "-l"], { timeout: 8000 });
  if (r.rc !== 0) return { adb: true, devices: [], why: (r.err || r.out).trim().slice(-200) };
  const rows = r.out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const kv = Object.fromEntries(rest.map((x) => x.split(":")).filter((p) => p.length === 2));
    return { serial, state, model: kv.model || "", device: kv.device || "" };
  });
  return { adb: true, devices: rows, why: rows.length ? "" : "no device attached" };
}

/** What this box can do about a phone, in one object. */
export function status() {
  const w = wired();
  const d = devices();
  return {
    wired: w,
    driver: w.length ? "artemis" : null,
    ...d,
    ready: w.length > 0 && d.devices.some((x) => x.state === "device"),
  };
}

/** The probes a record about THIS device should declare.
 *
 *  Measured from the live device rather than typed, for the same reason a
 *  fingerprint is: a hand-written probe list is a claim about a world nobody
 *  read. `pkg` is the app under test; without it the record depends on the
 *  device being attached and on nothing about the build, which is a record that
 *  stays fresh through a reinstall. */
export function dependsFor(serial, pkg = "") {
  const out = [`adb_state:${serial}`];
  if (pkg) out.push(`adb_package:${serial}/${pkg}`);
  return out;
}
