// viewport/index.js — the ports this workspace is served by, as a page.
//
// `bb runbook status` answers for a terminal and for the declaration. This
// answers the question a person actually has open in a browser: what is running
// right now, on which port, for which directory of this codebase, and is it
// answering. It writes plain files under `.bundlebox/viewport/` so the answer
// survives the session that produced it and can be opened without a server.
import fs from "node:fs";
import path from "node:path";
import { BB_DIR, ROOT, rel, ensureDirs } from "../core/paths.js";
import { out, emit, warn } from "../core/log.js";
import { human } from "../core/util.js";
import { run, which } from "../core/exec.js";
import { ports } from "./ports.js";
import { index, detail } from "./page.js";

export const DIR = () => path.join(BB_DIR, "viewport");

/** One port, one checkout per path. Every served page hangs under the name of
 *  this directory, so a second workspace on the same port answers somewhere
 *  else instead of overwriting the first answer. */
export const BASE = () => `/${path.basename(ROOT)}/`;
export const PORT = 65432;

/** Write the index and one page per declared service. Returns what it wrote, so
 *  the caller reports files rather than claiming success. */
export function build() {
  const m = ports();
  ensureDirs();
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const write = (name, html) => { const f = path.join(dir, name); fs.writeFileSync(f, html); files.push(rel(f)); };
  write("index.html", index(m));
  for (const r of m.services) write(`${r.id}.html`, detail(m, r));
  fs.writeFileSync(path.join(dir, "ports.json"), JSON.stringify(m, null, 2));
  files.push(rel(path.join(dir, "ports.json")));
  return { model: m, files, dir: rel(dir) };
}

function say(m) {
  out(`  VIEWPORT — ${m.up} of ${m.of} declared port(s) listening, ${m.observed} listener(s) on this box`);
  if (!m.how) warn(m.why || "no socket reader on this box; the state column is the declaration, not a measurement");
  out("");
  out(`  ${"port".padEnd(7)}${"service".padEnd(10)}${"supports".padEnd(14)}${"state".padEnd(16)}${"http".padEnd(6)}${"latency".padEnd(9)}memory`);
  out(`  ${"-".repeat(7)}${"-".repeat(10)}${"-".repeat(14)}${"-".repeat(16)}${"-".repeat(6)}${"-".repeat(9)}${"-".repeat(8)}`);
  for (const r of m.services) {
    const state = r.listening && r.answering === "up" ? "answering"
      : r.held_by_other ? "held, not by us"
      : r.listening ? "listening"
      : r.process_state === "up" ? "up, no socket" : "down";
    out(`  ${String(r.port ?? "—").padEnd(7)}${r.id.padEnd(10)}${String(r.supports).slice(0, 13).padEnd(14)}${state.padEnd(16)}${String(r.http ?? "").padEnd(6)}${(r.ms === null || r.ms === undefined ? "" : `${r.ms}ms`).padEnd(9)}${r.memory_bytes === null ? "" : `${human(r.memory_bytes)}b`}`);
  }
  if (m.strays.length) {
    out("");
    out("  listening from this tree, undeclared:");
    for (const s of m.strays) out(`  ${String(s.port).padEnd(7)}${(s.proc || "?").padEnd(10)}${s.supports}`);
    out("  nothing declares these; a stray on a declared port is why that service reads down.");
  }
  const held = m.services.filter((r) => r.held_by_other);
  if (held.length) { out(""); out(`  ! ${held.map((r) => `${r.id} (${r.port})`).join(", ")} — the port is held by a process this workspace did not start.`); }
}

/** Serve the pages, rebuilt on every request. A viewport whose whole subject is
 *  what is running now must not serve a page that was true when it was written;
 *  the served copy carries a refresh, the written copy deliberately does not. */
async function serve(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`${port} is not a port: a TCP port is 1-65535. Default is ${PORT}.`);
    return 2;
  }
  const base = BASE();
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    // `/` and `/<dirname>` both mean the index, but only `/<dirname>/` makes the
    // relative links on the page resolve, so send the browser there first.
    if (url.pathname === "/" || `${url.pathname}/` === base) {
      res.writeHead(302, { location: base });
      return res.end();
    }
    if (!url.pathname.startsWith(base)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(`this port serves ${path.basename(ROOT)}, at ${base}`);
    }
    const m = ports();
    const rest = url.pathname.slice(base.length);
    if (rest === "api/ports") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(m));
    }
    const name = rest.replace(/\.html$/, "");
    const row = name && name !== "index" ? m.services.find((r) => r.id === name) : null;
    if (name && name !== "index" && !row) { res.writeHead(404, { "content-type": "text/plain" }); return res.end(`no service ${name}`); }
    const html = (row ? detail(m, row) : index(m)).replace("</head>", '<meta http-equiv="refresh" content="10"></head>');
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.on("error", (e) => { warn(`cannot serve on ${port}: ${e.message}`); resolve(2); });
    server.listen(port, "127.0.0.1", () => {
      out(`  viewport on http://127.0.0.1:${port}${base} — rebuilt on every request, the page refreshes every 10s. Ctrl-C to stop.`);
    });
  });
}

function openIn(file) {
  const bin = ["xdg-open", "open", "start"].find((b) => which(b));
  if (!bin) { warn(`no opener on this box; the page is at ${rel(file)}`); return 2; }
  const r = run([bin, file], { timeout: 8000 });
  if (r.rc !== 0) { warn(`${bin} exited ${r.rc}; the page is at ${rel(file)}`); return r.rc; }
  out(`  opened ${rel(file)}`);
  return 0;
}

export const commands = {
  viewport: {
    help: "the ports this workspace is served by, as a page: what is listening, for which directory, and whether it answers (0 tokens)",
    usage: "bb viewport [status] [--json] | bb viewport build | bb viewport serve [--port 65432] | bb viewport open",
    long: [
      "  `bb runbook status` answers for the declared system. This one reads the socket table and",
      "  joins it to the declaration, so it can report the case runbook cannot: a declared service",
      "  that is down because something else already holds its port.",
      "",
      "  Three sets come out of that join. A declared service that is listening. A declared service",
      "  that is not. And a listener nobody declared whose process is working inside this tree — the",
      "  one no other verb reports, and usually the reason for the second.",
      "",
      "  `build` writes .bundlebox/viewport/index.html, one page per service, and ports.json.",
      "  `serve` rebuilds on every request; the written copy carries no refresh, because a file on",
      "  disk should not pretend to be live. It answers on 127.0.0.1:65432 under the name of this",
      "  directory — http://127.0.0.1:65432/<dirname>/ — so a viewport in another checkout can hold",
      "  the same port and still be a different page.",
    ].join("\n"),
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      if (sub === "status") {
        const m = ports();
        if (flags.json) { emit(m); return 0; }
        say(m);
        out("");
        out(`  \`bb viewport build\` writes the page; \`bb viewport serve\` keeps it live.`);
        return 0;
      }
      if (sub === "build") {
        const r = build();
        if (flags.json) { emit(r); return 0; }
        say(r.model);
        out("");
        out(`  ${r.files.length} file(s) under ${r.dir}: ${r.files.map((f) => path.basename(f)).join(", ")}`);
        return 0;
      }
      if (sub === "serve") return serve(flags.port === undefined ? PORT : Number(flags.port));
      if (sub === "open") {
        const f = path.join(DIR(), "index.html");
        if (!fs.existsSync(f)) build();
        return openIn(f);
      }
      warn(`unknown sub-verb: ${sub}. ${commands.viewport.usage}`);
      return 2;
    },
  },
};
