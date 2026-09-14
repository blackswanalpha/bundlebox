// expert.js — the bridge to the Python expert system (`bundlebox_expert`).
//
// Rules, confidence, transcript signals, the process model and memory are
// expert-system and ML work, and Python (stdlib only) is where that code is
// readable and testable. Every verb reads JSON on stdin and writes JSON on
// stdout. With no python3 the caller gets null and reports "python3 required";
// nothing in the zero-token path (scan → compile → route) depends on it.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PKG_ROOT } from "./paths.js";

const PKG_DIR = path.join(PKG_ROOT, "expert");
let _py;
export function python() {
  if (_py !== undefined) return _py;
  for (const cand of [process.env.BB_PYTHON, "python3", "python"].filter(Boolean)) {
    const r = spawnSync(cand, ["-c", "import sys; print(sys.version_info[0]*100+sys.version_info[1])"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && Number(r.stdout.trim()) >= 309) { _py = cand; return _py; }
  }
  _py = null;
  return _py;
}
export const available = () => Boolean(python());
export let lastError = null;
export function call(verb, payload = {}, { timeout = 600000 } = {}) {
  const py = python();
  if (!py) { lastError = "python3 >= 3.9 not found"; return null; }
  const r = spawnSync(py, ["-m", "bundlebox_expert", verb], { input: JSON.stringify(payload), encoding: "utf8", timeout,
    env: { ...process.env, PYTHONPATH: PKG_DIR + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""), PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) { lastError = `${verb}: ${r.error ? r.error.message : (r.stderr || "").trim().split("\n").slice(-3).join(" | ") || `rc ${r.status}`}`; return null; }
  try { return JSON.parse(r.stdout); } catch (e) { lastError = `${verb}: bad json (${e.message})`; return null; }
}
export function version() {
  const r = call("version");
  return r ? r.version : null;
}
