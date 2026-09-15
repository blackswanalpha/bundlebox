// commandcenter/page.js — the document: which sections exist, in what order,
// and what each one is for.
//
// The style and the client script live beside it (style.js, script.js); this
// file is the shell that joins them, and the list below is the page's table of
// contents. Adding a section is a row here and a `$("#id")` there.
import { style } from "./style.js";
import { script } from "./script.js";
import { mark, faviconHref } from "./brand.js";

export { style } from "./style.js";
export { script } from "./script.js";

const SECTIONS = [
  ["The pipeline", "pipeline", "Every stage before the agent is free. A pipeline fails by skipping, not by erroring, so each stage is judged on whether its exit criterion holds now — not on whether it ran once."],
  ["Sessions", "sessions", "What each session was asked to do, what it used, and what the local path had already done for it. Tokens are measured off the transcript; displaced turns are an estimate and the two are never added."],
  ["Boards", "boards", "A corpus run against the running system. A detector asks what the files say; these ask what the service does."],
  ["What went red", "red", ""],
  ["Open findings", "findings", ""],
  ["Agents", "agents", "The one doorway out of free. A drafted call costs nothing and is still useful: it is a precise statement of what is stuck."],
  ["Simulations", "sims", "The same request at rising concurrency. Budgets are a multiple of the floor measured in that run, so a slower box is not a regression."],
  ["What the local path did", "episodes", ""],
];

export function html(state, { live = false } = {}) {
  const body = SECTIONS.map(([title, id, lede]) =>
    `<section><div class="wrap"><h2>${title}</h2>${lede ? `<p class="lede">${lede}</p>` : ""}` +
    (id === "pipeline" ? `<div id="pipeline"></div><p class="note" id="pipeline-note"></p>`
      : id === "sims" ? `<div class="grid g2" id="sims"></div>`
      : `<div id="${id}"></div>`) + `</div></section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bundlebox command centre</title>
<link rel="icon" href="${faviconHref()}">
<link rel="apple-touch-icon" href="${faviconHref()}">
<meta name="color-scheme" content="light dark">
<style>${style}</style>
</head><body>
<header class="bar"><div class="wrap">
  <a class="brand" href="/" aria-label="bundlebox command centre">${mark(22)}<b>bundlebox</b> <span id="ws"></span></a>
  <div class="spacer"></div>
  <div class="link" id="link" title="connection to the workspace"><i></i><span>connecting</span></div>
  <div class="meta" id="stamp"></div>
</div></header>
<section><div class="wrap">
  <h2>What the factory saved</h2>
  <p class="lede">The same task, measured twice: once with the factory in front of it and once without.
  Bare searches the tree and reads what comes back; packed is the one prompt <span class="mono">bb pinpoint</span> writes
  for that task. Neither arm called a model, so the difference is reproducible rather than claimed.</p>
  <div class="statrow" id="savings"></div>
  <div id="savings-chart"></div>
  <div id="savings-trend"></div>
  <p class="note" id="savings-note"></p>
</div></section>
<section><div class="wrap"><div class="grid g4" id="window"></div></div></section>
${body}
<footer><div class="wrap">Measured off the transcripts and the store. Nothing on this page called a model.</div></footer>
<script>window.__LIVE__=${live ? "true" : "false"};window.__STATE__=${live ? "null" : JSON.stringify(state)};</script>
<script>${script}</script>
</body></html>`;
}
