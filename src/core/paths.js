// paths.js — where things are. The workspace root is the nearest git root above
// cwd (or cwd itself), and every derived artefact lives under <root>/.bundlebox/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findRoot(start = process.cwd()) {
  if (process.env.BB_ROOT) return path.resolve(process.env.BB_ROOT);
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, ".bundlebox", "config.json"))) return d;
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

export const ROOT = findRoot();
export const BB_DIR = path.join(ROOT, ".bundlebox");
export const VAR = path.join(BB_DIR, "var");
export const OUT = path.join(BB_DIR, "out");
export const HOME = path.join(os.homedir(), ".bundlebox");
export const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

// Workspace-relative paths are ALWAYS forward-slash: they are finding ids,
// store keys and brief text, and a key that differs by OS is two findings.
export const rel = (p) => {
  const r = path.relative(ROOT, path.resolve(p)).split(path.sep).join("/");
  return r.startsWith("..") ? path.resolve(p) : r || ".";
};
export const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
export function ensureDirs() {
  for (const d of [BB_DIR, VAR, OUT, HOME]) fs.mkdirSync(d, { recursive: true });
}
