// custom.js — the escape hatch: `lanes.custom_command` from config, with
// {prompt_file}, {prompt}, {cwd} and {model} substituted per token. A token
// that is exactly `{prompt}` becomes one argv entry holding the whole prompt,
// so a multi-line brief never gets re-split on whitespace.
import { load } from "../core/config.js";
import { which } from "../core/exec.js";
import { promptText } from "./index.js";

/** Shell-ish tokenizer: single and double quotes group, backslash escapes inside double quotes. */
export function tokenize(s) {
  const out = [];
  let cur = "", q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && c === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += c; continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

export default {
  name: "custom",
  bin: null,
  instructionsFile: null,
  mcpConfig: null,

  detect() {
    const t = load().lanes?.custom_command;
    if (!t) return null;
    const bin = tokenize(String(t))[0] || "";
    return { name: "custom", bin, path: which(bin), version: null };
  },
  leanFlags() { return []; },

  buildCmd(o = {}) {
    const tmpl = String(load().lanes?.custom_command || "");
    if (!tmpl) return { argv: null, stdin: null, env: {}, note: "lanes.custom_command is not set" };
    const vars = { prompt_file: String(o.promptFile || ""), prompt: promptText(o), cwd: String(o.cwd || ""), model: String(o.model || "") };
    const argv = tokenize(tmpl).map((t) => (t === "{prompt}" ? vars.prompt : t.replace(/\{(prompt_file|prompt|cwd|model)\}/g, (_, k) => vars[k])));
    return { argv, stdin: null, env: {}, note: "custom template; nothing about it is verified" };
  },

  parseEvent() { return null; },
  transcriptDirs() { return null; },
  readTranscript() { return null; },
};
