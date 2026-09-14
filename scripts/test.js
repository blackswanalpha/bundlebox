#!/usr/bin/env node
// Runs every test/*.test.js with node:test. Explicit paths, because `node --test
// test/` is a directory on one Node version and a glob on another, and a runner
// that finds zero files reports a green suite.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const dir = path.join(process.cwd(), "test");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join(dir, f));
if (!files.length) { console.error("no test files found"); process.exit(1); }
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
