// viewport/page.js — the port table as a page.
//
// One file, no network, no build step: a viewport that fetched a stylesheet
// from a CDN would be broken in exactly the case it exists for, which is a box
// whose network or whose dev server is the thing under inspection.
import { human } from "../core/util.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ms = (v) => (v === null || v === undefined ? "" : `${v}ms`);
const bytes = (v) => (v === null || v === undefined ? "" : `${human(v)}b`);

const CSS = `
:root{--bg:#fbfbfa;--fg:#1a1a18;--dim:#6b6b66;--line:#e3e3df;--card:#fff;--ok:#1a7f4b;--bad:#b3261e;--warn:#9a6700;--accent:#2f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#131314;--fg:#e8e8e6;--dim:#96968f;--line:#2b2b2d;--card:#1b1b1d;--ok:#4ac48a;--bad:#f2837b;--warn:#e0b341;--accent:#7aa5ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px 16px}
main{max-width:1100px;margin:0 auto}
h1{font-size:18px;margin:0 0 2px;font-weight:600}
h2{font-size:14px;margin:28px 0 8px;font-weight:600}
.sub{color:var(--dim);margin:0 0 20px}
.sub a{color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:600;color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
td.wide{white-space:normal;word-break:break-all;color:var(--dim)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:12px;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.port{font-weight:600}
.note{color:var(--dim);margin:8px 0 0;white-space:normal}
footer{color:var(--dim);margin-top:32px;font-size:12px}
`;

const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;

function stateCell(r) {
  if (r.listening && r.answering === "up") return `<span class="pill ok">answering</span>`;
  if (r.listening && r.held_by_other) return `<span class="pill warn">held, not by us</span>`;
  if (r.listening) return `<span class="pill warn">listening</span>`;
  if (r.process_state === "up") return `<span class="pill warn">up, no socket</span>`;
  return `<span class="pill bad">down</span>`;
}

/** The index: one row per port this workspace is served by. */
export function index(m) {
  const rows = m.services.map((r) => `<tr>
<td class="port">${r.port === null ? '<span class="dim">—</span>' : esc(r.port)}</td>
<td><a href="${esc(r.id)}.html">${esc(r.id)}</a></td>
<td>${esc(r.group)}</td>
<td>${esc(r.supports)}</td>
<td>${stateCell(r)}</td>
<td>${r.http === null ? "" : esc(r.http)}</td>
<td>${esc(ms(r.ms))}</td>
<td>${esc(bytes(r.memory_bytes))}${r.cap_bytes ? ` <span style="color:var(--dim)">/ ${esc(bytes(r.cap_bytes))}</span>` : ""}</td>
<td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">open</a>` : ""}</td>
</tr>`).join("\n");

  const stray = m.strays.length
    ? `<h2>Listening from this tree, undeclared</h2>
<table><thead><tr><th>port</th><th>process</th><th>pid</th><th>working in</th><th></th></tr></thead><tbody>
${m.strays.map((s) => `<tr><td class="port">${esc(s.port)}</td><td>${esc(s.proc || "?")}</td><td>${esc(s.pid ?? "")}</td><td>${esc(s.supports)}</td><td><a href="http://127.0.0.1:${esc(s.port)}" target="_blank" rel="noreferrer">open</a></td></tr>`).join("\n")}
</tbody></table>
<p class="note">Nothing in <code>.bundlebox/runbook/services.json</code> declares these, and the process
holding each one is working inside this workspace. A stray on a declared port is why that service
reads <em>down</em>.</p>`
    : "";

  const held = m.services.filter((r) => r.held_by_other);
  const warn = held.length
    ? `<p class="note bad">${held.length} declared port${held.length > 1 ? "s are" : " is"} held by a process this
workspace did not start: ${held.map((r) => `${esc(r.id)} (${esc(r.port)})`).join(", ")}.</p>`
    : "";

  const reader = m.how
    ? `sockets read with <code>${esc(m.how)}</code>`
    : `<span class="bad">${esc(m.why || "no socket reader on this box")}</span> — the state column is the declaration, not a measurement`;

  return shell("viewport — ports", `
<h1>Viewport</h1>
<p class="sub">${esc(m.root)} · ${m.up} of ${m.of} declared port${m.of === 1 ? "" : "s"} listening ·
${m.observed} listener${m.observed === 1 ? "" : "s"} on this box · ${reader} · ${esc(m.generated)}</p>
${warn}
<table><thead><tr><th>port</th><th>service</th><th>group</th><th>supports</th><th>state</th><th>http</th><th>latency</th><th>memory</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="9" class="wide">No service declares a port. <code>bb runbook init</code> writes the table.</td></tr>`}</tbody></table>
${stray}
<footer>Written by <code>bb viewport build</code>. Every number is measured at that moment; nothing here polls.</footer>`);
}

/** One service: what it is, what holds its port, and what it costs. */
export function detail(m, r) {
  const kv = [
    ["port", r.port === null ? "not declared" : String(r.port)],
    ["group", r.group || "—"],
    ["supports", r.supports],
    ["command", r.declared || "—"],
    ["health", r.health || "—"],
    ["process", r.process_state],
    ["socket", r.listening ? `held by ${r.proc || "?"}${r.pid ? ` (pid ${r.pid})` : ""} on ${r.host || "?"}` : "nothing is listening"],
    ["answering", r.answering || "not probed"],
    ["http", r.http === null ? "—" : String(r.http)],
    ["latency", ms(r.ms) || "—"],
    ["memory", bytes(r.memory_bytes) || "—"],
    ["cap", bytes(r.cap_bytes) || "—"],
    ["cpu", r.cpu_s === null || r.cpu_s === undefined ? "—" : `${r.cpu_s}s`],
    ["log", r.log || "—"],
    ["why", r.why || "—"],
  ];
  return shell(`viewport — ${r.id}`, `
<h1>${esc(r.id)}</h1>
<p class="sub"><a href="index.html">← every port</a> · ${esc(m.root)} · ${esc(m.generated)}</p>
<table><tbody>${kv.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="wide">${esc(v)}</td></tr>`).join("\n")}</tbody></table>
${r.url ? `<p class="note"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a></p>` : ""}
<footer>Written by <code>bb viewport build</code>.</footer>`);
}
