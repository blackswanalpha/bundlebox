#!/usr/bin/env node
// `node --check` over every source file. A Node script, not a shell loop:
// npm runs scripts through cmd.exe on Windows, where `for f in $(...)` is text.
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const files = [path.join(process.cwd(), "bin/bb.js")];
const stack = [path.join(process.cwd(), "src"), path.join(process.cwd(), "scripts"), path.join(process.cwd(), "test")];
while (stack.length) { const d = stack.pop(); for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) stack.push(p); else if (p.endsWith(".js")) files.push(p); } }
let bad = 0;
for (const f of files) { const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }); if (r.status !== 0) { bad++; process.stderr.write(r.stderr); } }
console.log(`${files.length} files checked, ${bad} with errors`);
process.exit(bad ? 1 : 0);
