// console/index.js — one page for a workspace: where the pipeline is,
// what the current window has left, and what every session cost against what
// the local path had already done for it.
//
// Two ways to read it and one renderer behind both:
//
//   bb console          serve it at 127.0.0.1 and push changes as they land
//   bb console build    write a single HTML file with the state embedded
//
// The server binds to loopback and has no write route. It reads the same store
// every verb reads and calls nothing: a dashboard that could change the factory
// is a second way to change the factory, and this one exists to be left open.
// "No write route" is a claim the code has to keep — so `state()` is asked for
// a read-only snapshot, and the one query parameter that used to trigger a fold
// of every transcript is gone.
//
// ── why it pushes instead of polling ────────────────────────────────────────
//
// Every client used to refetch on a 10s timer. That is wrong in both
// directions: a run that finishes at t+1s is invisible for nine seconds, and a
// workspace nobody is touching recomputes the whole state six times a minute
// per open tab. The store is files, so the filesystem already knows when
// something changed. `/api/stream` watches it, recomputes ONCE per change
// whatever the number of clients, and pushes.
//
// The state is computed behind a cache with a single in-flight computation, so
// twenty tabs opening at once do one traversal, not twenty. A client that
// cannot hold an EventSource falls back to `/api/state` on a timer, which is
// why that route still exists.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OUT, VAR, PKG_ROOT, rel } from "../core/paths.js";
import { load as loadCfg, readJson } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { state, benchState } from "./state.js";
import { html } from "./page.js";

const VERSION = () => readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0"; // a package.json with no version is a dev checkout

export const FILE = () => path.join(OUT, "console", "index.html");

// A recompute is a full traversal of the store. These bound it: never more than
// once per MIN_INTERVAL however fast the disk churns, and never served older
// than MAX_AGE even if the watcher is silent (a network mount may not emit).
export const MIN_INTERVAL = 900;
export const MAX_AGE = 30000;
export const MAX_CLIENTS = 64;

export function build({ file = "", sessions = 25 } = {}) {
  const s = state({ sessions });
  const target = file ? path.resolve(file) : FILE();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html(s, { live: false }));
  return { rc: 0, file: rel(target), bytes: fs.statSync(target).size, state: s };
}

/** One computation for every reader.
 *
 *  `inflight` is the part that matters: `state()` is synchronous and takes tens
 *  of milliseconds, and without it N simultaneous requests each pay for it. The
 *  cache is invalidated by the watcher, not by a timer, so the page is fresh
 *  because something changed rather than because a clock ticked. */
function makeCache({ sessions }) {
  let value = null, at = 0, serial = 0;
  const compute = () => {
    // `write:false` keeps the promise in the header honest: serving this page
    // must not write the session-title cache back to disk.
    value = state({ sessions, write: false });
    at = Date.now();
    serial += 1;
    return value;
  };
  return {
    get() { return !value || Date.now() - at > MAX_AGE ? compute() : value; },
    invalidate() { at = 0; },
    fresh() { return compute(); },
    get serial() { return serial; },
    get at() { return at; },
  };
}

/** Changes under `.bundlebox/var` and `.bundlebox/out`, debounced.
 *
 *  Recursive watching is not available everywhere and a watcher that throws must
 *  not take the server with it, so a failure here degrades to the MAX_AGE timer
 *  rather than to a crash — and `/health` says which mode it is in, because a
 *  dashboard that has silently stopped noticing changes looks exactly like a
 *  workspace where nothing is happening. */
function watchStore(onChange) {
  const watchers = [];
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, MIN_INTERVAL); if (timer.unref) timer.unref(); };
  let ok = false;
  for (const dir of [VAR, OUT]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, { recursive: true, persistent: false }, fire);
      w.on("error", () => { /* a watcher that dies leaves the MAX_AGE timer */ });
      watchers.push(w);
      ok = true;
    } catch { /* not supported here; MAX_AGE covers it */ }
  }
  return { ok, close: () => { clearTimeout(timer); for (const w of watchers) { try { w.close(); } catch { /* already gone */ } } } };
}

export function serve({ port = 0, host = "127.0.0.1", sessions = 25 } = {}) {
  const cfg = loadCfg().console || {};
  const p = port || cfg.port || 7788;
  const h = host || cfg.host || "127.0.0.1";
  const cache = makeCache({ sessions });
  const clients = new Set();

  const push = () => {
    if (!clients.size) { cache.invalidate(); return; }
    let body;
    try { body = JSON.stringify(cache.fresh()); }
    catch (e) { body = JSON.stringify({ error: String(e.message || e) }); }
    const frame = `event: state\ndata: ${body}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
  };
  const watcher = watchStore(push);

  const server = http.createServer((req, res) => {
    // Loopback, but the headers are cheap and the page embeds no remote asset,
    // so there is no reason to leave a tab on this origin able to load one.
    const base = { "cache-control": "no-store", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" };
    const send = (code, type, body) => { res.writeHead(code, { ...base, "content-type": type }); res.end(body); };
    try {
      const url = new URL(req.url, `http://${h}:${p}`);
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "read-only");

      // `/health` is the one route that must answer without reading the store:
      // a health probe that fails because a ledger is mid-write reports the
      // service down when it is up, and `bb runbook` believes it.
      if (url.pathname === "/health") return send(200, "application/json", JSON.stringify({
        ok: true, service: "bundlebox-console", version: VERSION(), at: new Date().toISOString(),
        clients: clients.size, live: watcher.ok,
        mode: watcher.ok ? "pushed on change" : `polled every ${MAX_AGE / 1000}s — this box has no recursive watcher` }));

      if (url.pathname === "/api/state") return send(200, "application/json", JSON.stringify(cache.get()));
      if (url.pathname === "/api/bench") return send(200, "application/json", JSON.stringify(benchState()));

      if (url.pathname === "/api/stream") {
        if (clients.size >= MAX_CLIENTS) return send(503, "text/plain", `at ${MAX_CLIENTS} streams`);
        res.writeHead(200, { ...base, "content-type": "text/event-stream", connection: "keep-alive",
          "x-accel-buffering": "no" });
        // `retry` tells the browser's own reconnect how long to wait, so the
        // client does not have to reimplement backoff for the ordinary case.
        res.write(`retry: 3000\n\n`);
        res.write(`event: state\ndata: ${JSON.stringify(cache.get())}\n\n`);
        clients.add(res);
        // A comment frame keeps the connection off every idle-timeout on the
        // path, and is what tells the PAGE it is still connected. Without it a
        // silent workspace and a dead server look identical.
        const beat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closing */ } }, 20000);
        if (beat.unref) beat.unref();
        const done = () => { clearInterval(beat); clients.delete(res); };
        req.on("close", done);
        req.on("error", done);
        res.on("error", done);
        return undefined;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") return send(200, "text/html; charset=utf-8", html(null, { live: true }));
      return send(404, "text/plain", "not found");
    } catch (e) { send(500, "text/plain", String(e.message || e)); }
  });
  // A request that never finishes its headers must not hold a socket open
  // forever. The stream route is exempt by design, so the body timeout is off
  // and only the header timeout applies.
  server.headersTimeout = 10000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65000;

  return new Promise((resolve) => {
    server.on("error", (e) => resolve({ rc: 2, why: e.code === "EADDRINUSE" ? `port ${p} is in use; --port <n>` : String(e.message || e) }));
    server.listen(p, h, () => resolve({ rc: 0, url: `http://${h}:${p}/`, server, live: watcher.ok,
      close: () => { watcher.close(); for (const c of clients) { try { c.end(); } catch { /* gone */ } } clients.clear(); server.close(); } }));
  });
}

async function cmd({ _, flags }) {
  const sub = _[0] || "serve";
  const sessions = Number(flags.sessions) || 25;
  if (sub === "build") {
    const r = build({ file: flags.file ? String(flags.file) : "", sessions });
    if (flags.json) { emit({ file: r.file, bytes: r.bytes }); return 0; }
    out(`  ${r.file}  (${Math.round(r.bytes / 1024)} kB, state embedded — opens with no server)`);
    out(`  It carries every session title, which is the first line a person typed. Read it before sharing it.`);
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
    out(`  console on ${r.url}   (read-only, loopback, ${r.live ? "pushed as the store changes" : "refreshed on a timer — no recursive watcher on this box"})`);
    out("  ctrl-c to stop");
    const stop = () => { r.close(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
    return 0;
  }
  warn(`unknown console sub-verb: ${sub}. serve | build | state`);
  return 2;
}

export const commands = {
  console: {
    help: "one page for this workspace: the pipeline, the window, every session and what it saved",
    usage: "bb console [serve] [--port 7788] | build [--file out.html] | state [--json]",
    long: [
      "  bb console                 serve on 127.0.0.1:7788 and push every change as it lands",
      "  bb console build           a single self-contained HTML file with the state embedded",
      "",
      "Routes: /  /health  /api/state  /api/stream  /api/bench",
      "Read-only, loopback, no write route. Nothing on the page calls a model.",
      "The page opens an EventSource on /api/stream and falls back to polling /api/state if it cannot.",
    ].join("\n"),
    run: cmd,
  },
};
