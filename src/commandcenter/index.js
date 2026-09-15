// commandcenter/index.js — one page for a workspace: where the pipeline is,
// what the current window has left, and what every session cost against what
// the local path had already done for it.
//
// Two ways to read it and one renderer behind both:
//
//   bb commandcenter          serve it at 127.0.0.1 and refetch every 10s
//   bb commandcenter build    write a single HTML file with the state embedded
//
// The server binds to loopback and has no write route. It reads the same store
// every verb reads and calls nothing: a dashboard that could change the factory
// is a second way to change the factory, and this one exists to be left open.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OUT, PKG_ROOT, rel } from "../core/paths.js";
import { load as loadCfg, readJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { state, benchState } from "./state.js";
import { html } from "./page.js";

const VERSION = () => readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0";

export const FILE = () => path.join(OUT, "commandcenter", "index.html");

export function build({ file = "", sessions = 25 } = {}) {
  const s = state({ sessions });
  const target = file ? path.resolve(file) : FILE();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html(s, { live: false }));
  return { rc: 0, file: rel(target), bytes: fs.statSync(target).size, state: s };
}

export function serve({ port = 0, host = "127.0.0.1", sessions = 25 } = {}) {
  const cfg = loadCfg().commandcenter || {};
  const p = port || cfg.port || 7788;
  const h = host || cfg.host || "127.0.0.1";
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    try {
      const url = new URL(req.url, `http://${h}:${p}`);
      if (req.method !== "GET") return send(405, "text/plain", "read-only");
      // `/health` is the one route that must answer without reading the store:
      // a health probe that fails because a ledger is mid-write reports the
      // service down when it is up, and `bb runbook` believes it.
      if (url.pathname === "/health") return send(200, "application/json", JSON.stringify({ ok: true, service: "bundlebox-commandcenter", version: VERSION(), at: new Date().toISOString() }));
      if (url.pathname === "/api/state") return send(200, "application/json", JSON.stringify(state({ sessions, fold: url.searchParams.get("fold") === "1" })));
      if (url.pathname === "/api/bench") return send(200, "application/json", JSON.stringify(benchState()));
      if (url.pathname === "/" || url.pathname === "/index.html") return send(200, "text/html; charset=utf-8", html(null, { live: true }));
      return send(404, "text/plain", "not found");
    } catch (e) { send(500, "text/plain", String(e.message || e)); }
  });
  return new Promise((resolve) => {
    server.on("error", (e) => resolve({ rc: 2, why: e.code === "EADDRINUSE" ? `port ${p} is in use; --port <n>` : String(e.message || e) }));
    server.listen(p, h, () => resolve({ rc: 0, url: `http://${h}:${p}/`, server }));
  });
}

async function cmd({ _, flags }) {
  const sub = _[0] || "serve";
  const sessions = Number(flags.sessions) || 25;
  if (sub === "build") {
    const r = build({ file: flags.file ? String(flags.file) : "", sessions });
    if (flags.json) { emit({ file: r.file, bytes: r.bytes }); return 0; }
    out(`  ${r.file}  (${Math.round(r.bytes / 1024)} kB, state embedded — opens with no server)`);
    return 0;
  }
  if (sub === "state") {
    const s = state({ sessions, fold: !!flags.fold });
    if (flags.json) { emit(s); return 0; }
    out(JSON.stringify(s, null, 2));
    return 0;
  }
  if (sub === "serve") {
    const r = await serve({ port: Number(flags.port) || 0, host: String(flags.host || ""), sessions });
    if (r.rc) { warn(r.why); return r.rc; }
    out(`  command centre on ${r.url}   (read-only, loopback, refetches every 10s)`);
    out("  ctrl-c to stop");
    await new Promise(() => {});
    return 0;
  }
  warn(`unknown commandcenter sub-verb: ${sub}. serve | build | state`);
  return 2;
}

export const commands = {
  commandcenter: {
    help: "one page for this workspace: the pipeline, the window, every session and what it saved",
    usage: "bb commandcenter [serve] [--port 7788] | build [--file out.html] | state [--json]",
    long: [
      "  bb commandcenter                 serve on 127.0.0.1:7788 and refetch every 10s",
      "  bb commandcenter build           a single self-contained HTML file with the state embedded",
      "",
      "Routes: /  /health  /api/state  /api/bench",
      "Read-only, loopback, no write route. Nothing on the page calls a model.",
    ].join("\n"),
    run: cmd,
  },
};
