// index.js — the adapter contract, and the only place a binary is looked up.
//
// An adapter is a plain object, not a class: the thing that varies between
// agents is flags and file layouts, and a dict entry is easier to audit than a
// subclass. Every flag an adapter emits was either read off `<bin> --help` on
// a box that has the binary (`verified`) or copied from vendor docs for a
// binary this box does not have (`note: "unverified"`). Nothing is invented.
//
//   {
//     name, bin, detect() -> {name, bin, path, version|null} | null,
//     leanFlags() -> [..],
//     buildCmd({promptFile, prompt, cwd, model, maxTurns, permissionMode,
//               sessionId, budgetUsd, allowedTools, name})
//               -> {argv|null, stdin: "prompt"|null, env, note},
//     parseEvent(line) -> {msgId, model, input, output, cacheWrite, cacheRead,
//                          isResult, resultUsage?} | null,
//     transcriptDirs(root, priorRoots) -> [abs dir] | null   (null = cannot look),
//     readTranscript(file) -> {sessionId, cwd, model, turns:[..]} | null,
//     instructionsFile, mcpConfig: {file, key, shape(serverSpec)} | null
//   }
//
// The shared helpers below are `function` declarations on purpose: adapters
// import them from here while this file imports the adapters, and hoisted
// function declarations are the one binding kind that is safe across that
// cycle at link time.
import fs from "node:fs";
import path from "node:path";
import { run, which } from "../core/exec.js";
import { load } from "../core/config.js";
import claude from "./claude.js";
import codex from "./codex.js";
import gemini from "./gemini.js";
import opencode from "./opencode.js";
import aider from "./aider.js";
import cursor from "./cursor.js";
import copilot from "./copilot.js";
import custom from "./custom.js";
import file from "./file.js";

// `auto` resolution order. Claude first because it is the only one whose
// transcript and stream shapes were verified end to end on a real session.
export const ORDER = ["claude", "codex", "gemini", "opencode", "aider", "cursor", "copilot"];
export const ADAPTERS = { claude, codex, gemini, opencode, aider, cursor, copilot, custom, file };

export function get(name) { return ADAPTERS[name] || null; }

/** Every adapter whose binary resolves on PATH, in ORDER. `file` is never listed: it is not an agent. */
export function detect() {
  const out = [];
  for (const name of ORDER) {
    const d = ADAPTERS[name].detect();
    if (d) out.push(d);
  }
  return out;
}

/** The adapter `bb run` spawns with. An explicit name is honoured even when the
 *  binary is missing, so the lane fails with rc 127 and says why, rather than
 *  silently running under a different agent than the one configured. */
export function pick(cfg = load()) {
  const want = String(cfg.lanes?.agent || "auto");
  if (want !== "auto") return get(want) || file;
  for (const name of ORDER) if (ADAPTERS[name].detect()) return ADAPTERS[name];
  if (cfg.lanes?.custom_command) return custom;
  return file;
}

// ── shared helpers ──────────────────────────────────────────────────────────

export function detectBin(name, bin, versionArgs = ["--version"]) {
  const p = which(bin);
  if (!p) return null;
  const r = run([p, ...versionArgs], { timeout: 8000 });
  const line = (r.rc === 0 ? (r.out || r.err) : "").trim().split("\n").pop() || "";
  return { name, bin, path: p, version: line ? line.slice(0, 60) : null };
}

export function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

export function parseJson(line) {
  const s = String(line || "").trim();
  if (!s.startsWith("{")) return null;
  try { return JSON.parse(s); } catch { return null; } // not JSON: the caller skips the line
}

/** Parsed objects of a JSONL file, or null when the file could not be read. A
 *  torn line is skipped, never a crash. */
export function jsonLines(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; } // null is the documented "could not read"
  const out = [];
  for (const line of text.split("\n")) { const o = parseJson(line); if (o) out.push(o); }
  return out;
}

export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } // missing or torn: null, and callers test for it
}

/** The prompt text an argv-style agent needs inline. */
export function promptText(o) {
  if (o.prompt != null) return String(o.prompt);
  if (!o.promptFile) return "";
  return fs.readFileSync(o.promptFile, "utf8");
}

export function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } } // absent is not a directory
export function listFiles(dir, suffix) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().map((f) => path.join(dir, f)); } catch { return []; } // no directory, no files
}

/** Text of a tool result block, whatever container the agent used. */
export function blockText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === "object" ? x.text || "" : String(x ?? ""))).join("\n");
  if (c && typeof c === "object") return JSON.stringify(c);
  return "";
}

/** A usage-shaped turn with every count coerced, so readers agree on zeros. */
export function turn(o) {
  return {
    msgId: String(o.msgId ?? ""), ts: o.ts || null, model: o.model || "",
    input: num(o.input), output: num(o.output), cacheWrite: num(o.cacheWrite), cacheRead: num(o.cacheRead),
    thinking: num(o.thinking), toolUses: o.toolUses || [], toolResults: o.toolResults || [], text: o.text || "",
  };
}
