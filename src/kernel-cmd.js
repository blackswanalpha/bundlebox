// kernel-cmd.js — `bb kernel`: is the Rust kernel here, build it, or fetch it.
import fs from "node:fs";
import path from "node:path";
import * as kernel from "./core/kernel.js";
import { HOME, PKG_ROOT } from "./core/paths.js";
import { run, which } from "./core/exec.js";
import { out, warn, emit } from "./core/log.js";
import { currentVersion } from "./update/index.js";

const exe = process.platform === "win32" ? "bbk.exe" : "bbk";

/** One cheap call per op. The probe must be real work: a version string proves
 *  the binary runs, it does not prove `symbols` is wired to it. */
export const OPS = [
  ["walk", () => kernel.call("walk", { base: PKG_ROOT, ignore: ["node_modules", "target", ".git"], suffixes: [".json"], max_bytes: 2000000 })],
  ["fingerprint", () => kernel.call("fingerprint", { root: PKG_ROOT, inputs: [path.join(PKG_ROOT, "package.json")] })],
  ["estimate", () => kernel.call("estimate", { paths: [path.join(PKG_ROOT, "package.json")], prose_suffix: [".md"] })],
  ["dupes", () => kernel.call("dupes", { paths: [], window: 6, min_shared_lines: 6, min_distinct_ratio: 0.5 })],
  ["symbols", () => kernel.call("symbols", { paths: [path.join(PKG_ROOT, "src", "index.js")] })],
  ["anchor", () => kernel.call("anchor", { path: path.join(PKG_ROOT, "src", "cli.js"), symbol: "loadCommands" })],
  ["gate", () => kernel.call("gate", { cmd: process.platform === "win32" ? "cd" : "true", cwd: PKG_ROOT, timeout: 10, cap_bytes: 256 })],
  ["sha1", () => kernel.call("sha1", { text: "bundlebox" })],
  // The scenario ops make no request here: an empty corpus and an empty target
  // list prove the op is served without touching a service. A probe that needed
  // a running system would report the service, not the kernel.
  ["scenario", () => kernel.call("scenario", { base: "http://127.0.0.1:1", scenarios: [], rpm: 0 })],
  ["probe", () => kernel.call("probe", { targets: [] })],
  ["rx", () => kernel.call("rx", { pattern: "^a+$", subject: "aaa" })],
];
const dest = () => path.join(HOME, "bin", exe);

async function download(url, to) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, Buffer.from(await r.arrayBuffer()));
  fs.chmodSync(to, 0o755);
}

export const commands = {
  kernel: {
    help: "the Rust kernel: status, build from source, or install a release binary",
    usage: "bb kernel [status|ops|build|install [--version v]]",
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      if (sub === "status") {
        const b = kernel.binary();
        const row = { binary: b, version: b ? kernel.version() : null, target: kernel.target(), cargo: which("cargo") };
        if (flags.json) { emit(row); return 0; }
        out(b ? `  kernel ${row.version} at ${b}` : "  kernel: not installed; JS fallbacks are active for walk, estimate, dupes, gate");
        out(`  target ${row.target}; cargo ${row.cargo ? "present: bb kernel build" : "absent: bb kernel install"}`);
        return 0;
      }
      if (sub === "ops") {
        // Which runtime actually served each op, proved by running it, not by
        // asserting the binary exists. An op that silently fell back to JS is
        // the thing this verb is for.
        const rows = OPS.map(([op, probe]) => {
          const t0 = Date.now();
          const r = probe();
          return { op, via: r === null ? "js (fallback)" : "kernel", ms: Date.now() - t0, why: r === null ? kernel.lastError || "" : "" };
        });
        if (flags.json) { emit({ binary: kernel.binary(), ops: rows }); return 0; }
        out(`  ${"op".padEnd(16)} ${"served by".padEnd(14)} ms   note`);
        for (const r of rows) out(`  ${r.op.padEnd(16)} ${r.via.padEnd(14)} ${String(r.ms).padStart(3)}   ${r.why}`);
        const js = rows.filter((r) => r.via !== "kernel").length;
        out(`  ${rows.length - js} of ${rows.length} ops served by the kernel${js ? `; ${js} fell back to JS` : ""}`);
        return js ? 1 : 0;
      }
      if (sub === "build") {
        if (!which("cargo")) { warn("cargo not found; install Rust from https://rustup.rs or run `bb kernel install`"); return 2; }
        out("  cargo build --release (first build takes a minute)");
        const r = run(["cargo", "build", "--release"], { cwd: path.join(PKG_ROOT, "kernel"), timeout: 600000 });
        if (r.rc !== 0) { warn(r.err.trim().split("\n").slice(-6).join("\n")); return 1; }
        fs.mkdirSync(path.dirname(dest()), { recursive: true });
        fs.copyFileSync(path.join(PKG_ROOT, "kernel", "target", "release", exe), dest());
        fs.chmodSync(dest(), 0o755);
        out(`  installed ${dest()}`);
        return 0;
      }
      if (sub === "install") {
        const v = flags.version || currentVersion();
        const asset = `bbk-${kernel.target()}${process.platform === "win32" ? ".exe" : ""}`;
        const url = `https://github.com/blackswanalpha/bundlebox/releases/download/v${v}/${asset}`;
        out(`  fetching ${url}`);
        try { await download(url, dest()); } catch (e) { warn(`download failed: ${e.message}. Try: bb kernel build`); return 1; }
        out(`  installed ${dest()}`);
        return 0;
      }
      warn(`unknown: bb kernel ${sub}`); return 2;
    },
  },
};
