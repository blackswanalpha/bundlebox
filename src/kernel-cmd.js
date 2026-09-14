// kernel-cmd.js — `bb kernel`: is the Rust kernel here, build it, or fetch it.
import fs from "node:fs";
import path from "node:path";
import * as kernel from "./core/kernel.js";
import { HOME, PKG_ROOT } from "./core/paths.js";
import { run, which } from "./core/exec.js";
import { out, warn, emit } from "./core/log.js";
import { currentVersion } from "./update/index.js";

const exe = process.platform === "win32" ? "bbk.exe" : "bbk";
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
    usage: "bb kernel [status|build|install [--version v]]",
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
