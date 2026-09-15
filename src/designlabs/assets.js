// designlabs/assets.js — the files the studio renders itself with, every one of
// them derived from declared.js.
//
// They are template literals rather than files on disk because `bb designlabs
// init` must work from an npm install with no assets directory, and because a
// stylesheet that can be edited independently of system.json is a second
// source of truth about the same design.
import { SYSTEM, SCREEN } from "./declared.js";

const css = (sys) => `/* tokens.css — DERIVED from system.json by \`bb designlabs init\`.
   Do not edit. Change system.json and re-run \`bb designlabs init --apply\`. */
:root {
  color-scheme: light dark;
${Object.entries(sys.color.tokens).map(([k, v]) => `  --c-${k}: ${v};`).join("\n")}
${sys.space.map((n, i) => `  --s-${i}: ${n}px;`).join("\n")}
${Object.entries(sys.radius).map(([k, v]) => `  --r-${k}: ${v};`).join("\n")}
${Object.entries(sys.motion).map(([k, v]) => `  --t-${k}: ${v};`).join("\n")}
${Object.entries(sys.easing).map(([k, v]) => `  --e-${k}: ${v};`).join("\n")}
${Object.entries(sys.type.scale).map(([k, v]) => `  --f-${k}: ${v};`).join("\n")}
${Object.entries(sys.elevation).map(([k, v]) => `  --z-${k}: ${v};`).join("\n")}
  --font-display: "${sys.type.display.family}", ${sys.type.display.fallback};
  --font-text: "${sys.type.text.family}", ${sys.type.text.fallback};

  --bg: var(--c-paper); --fg: var(--c-ink); --dim: var(--c-muted);
  --panel: var(--c-surface); --edge: var(--c-border); --hair: var(--c-rule);
  --accent: var(--c-accent);
}
:root[data-theme="dark"] {
  --bg: var(--c-night); --fg: var(--c-night-ink); --dim: var(--c-night-muted);
  --panel: var(--c-night-surface); --edge: var(--c-night-border); --hair: #2A2E26;
  --accent: var(--c-night-accent);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: var(--c-night); --fg: var(--c-night-ink); --dim: var(--c-night-muted);
    --panel: var(--c-night-surface); --edge: var(--c-night-border); --hair: #2A2E26;
    --accent: var(--c-night-accent);
  }
}
/* Doherty: nothing here outlasts 400ms, and reduced motion removes it entirely. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}
/* Norman: a control with no signifier is silent, so :focus-visible is styled
   everywhere :hover is, and never removed without a replacement. */
:where(a, button, [role="button"], input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-text); font-size: var(--f-body); line-height: 1.55; }
h1, h2, h3 { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.015em; }
`;

const studioJs = `/* studio.js — renders the studio FROM system.json and screens/*.json.
   Nothing about a screen is written twice: the picker, the state pills and the
   token table are all built from the declarations the gate reads, so a screen
   and its states cannot drift apart. That property is what the self-test leans
   on and it is the only reason this file is worth having. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  async function load() {
    const system = await (await fetch('system.json')).json();
    const list = await (await fetch('screens/index.json')).json();
    const screens = await Promise.all(list.map(async (n) => (await fetch('screens/' + n)).json()));
    return { system, screens };
  }

  function renderTokens(system, host) {
    for (const [k, v] of Object.entries(system.color.tokens)) {
      const row = el('div', 'token-row');
      const sw = el('span', 'swatch'); sw.style.background = v;
      row.append(sw, el('code', null, '--c-' + k), el('span', 'dim', v));
      host.append(row);
    }
  }

  function renderScreen(s, host, stateHost) {
    host.replaceChildren();
    stateHost.replaceChildren();
    const names = Object.keys(s.states || {});
    let active = names[0];
    const draw = () => {
      const st = s.states[active] || {};
      host.replaceChildren();
      host.dataset.state = active;
      host.append(el('h2', null, s.title));
      host.append(el('p', 'dim', s.lede || ''));
      const badge = el('div', 'state-badge', active.toUpperCase());
      host.append(badge);
      host.append(el('p', null, st.copy || st.note || ''));
      if (st.skeleton) { for (let i = 0; i < 5; i++) host.append(el('div', 'skeleton')); }
    };
    for (const n of names) {
      const b = el('button', 'pill', s.states[n].label || n);
      b.setAttribute('aria-pressed', String(n === active));
      b.addEventListener('click', () => {
        active = n;
        for (const sib of stateHost.children) sib.setAttribute('aria-pressed', String(sib === b));
        draw();
      });
      stateHost.append(b);
    }
    draw();
  }

  load().then(({ system, screens }) => {
    document.title = system.name + ' — designlabs';
    renderTokens(system, $('#tokens'));
    const picker = $('#picker'), stage = $('#stage'), states = $('#states');
    screens.forEach((s, i) => {
      const b = el('button', 'pill', s.title);
      b.addEventListener('click', () => {
        for (const sib of picker.children) sib.setAttribute('aria-pressed', String(sib === b));
        renderScreen(s, stage, states);
      });
      picker.append(b);
      if (i === 0) b.click();
    });
    window.__STUDIO__ = { system, screens };
  }).catch((e) => { $('#stage').textContent = 'Could not load the studio: ' + e.message + '. Serve this over http://, not file://.'; });
})();
`;

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>designlabs</title>
<link rel="stylesheet" href="styles/tokens.css">
<style>
  .wrap { max-width: 1100px; margin: 0 auto; padding: var(--s-4) var(--s-3); }
  header { border-bottom: 1px solid var(--hair); padding-bottom: var(--s-2); margin-bottom: var(--s-4); }
  h1 { font-size: var(--f-display); margin: 0 0 var(--s-0); }
  .dim { color: var(--dim); }
  .cols { display: grid; grid-template-columns: minmax(0,1fr) 280px; gap: var(--s-5); align-items: start; }
  @media (max-width: 720px) { .cols { grid-template-columns: minmax(0,1fr); } }
  .pill { font: inherit; font-size: var(--f-small); min-height: 44px; padding: 0 var(--s-2);
          background: transparent; color: var(--fg); border: 1px solid var(--edge);
          border-radius: var(--r-pill); cursor: pointer; transition: background var(--t-state) var(--e-standard); }
  .pill:hover { background: var(--panel); }
  .pill[aria-pressed="true"] { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  #picker, #states { display: flex; flex-wrap: wrap; gap: var(--s-1); margin-bottom: var(--s-3); }
  #stage { background: var(--panel); border: 1px solid var(--hair); border-radius: var(--r-surface); padding: var(--s-4); min-height: 320px; }
  .state-badge { display: inline-block; font-size: var(--f-micro); letter-spacing: .08em; color: var(--dim); margin-bottom: var(--s-2); }
  .skeleton { height: 20px; border-radius: var(--r-control); background: var(--hair); margin-bottom: var(--s-1); }
  .token-row { display: flex; align-items: center; gap: var(--s-1); font-size: var(--f-small); margin-bottom: var(--s-0); }
  .swatch { width: 20px; height: 20px; border-radius: var(--r-control); border: 1px solid var(--hair); flex: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>designlabs</h1>
    <p class="dim">Rendered from <code>system.json</code> and <code>screens/*.json</code>. Nothing on this page is written twice.</p>
  </header>
  <div class="cols">
    <main>
      <div id="picker"></div>
      <div id="states"></div>
      <div id="stage"></div>
    </main>
    <aside>
      <h3>Tokens</h3>
      <div id="tokens"></div>
    </aside>
  </div>
</div>
<script src="scripts/studio.js"></script>
</body>
</html>
`;


const statesHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>state contract self-test</title>
<link rel="stylesheet" href="../styles/tokens.css">
<style>
  body { padding: 20px; font-family: var(--font-text); }
  #RESULT { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 13px;
            border: 1px solid var(--edge); border-radius: var(--r-control); padding: 12px; }
  .stage { border: 1px solid var(--hair); border-radius: var(--r-surface); padding: 20px; margin-bottom: 12px; }
  .skeleton { height: 20px; border-radius: var(--r-control); background: var(--hair); margin-bottom: 4px; }
  .state-badge { font-size: var(--f-micro); letter-spacing: .08em; color: var(--dim); }
</style>
</head>
<body>
<h1>State contract self-test</h1>
<p>Serve this over <code>http://</code>, not <code>file://</code>. It renders every DECLARED
state of every screen and asserts each one draws something a parse cannot see: a cell
identical to <code>rest</code> is the studio claiming a state it does not actually draw.</p>
<div id="stage" class="stage"></div>
<pre id="RESULT">running…</pre>
<script>
/* The 22 properties that carry a state. Read over the whole SUBTREE, because
   most components apply a state to their parts and not to their root. */
function fingerprint(root) {
  const parts = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const cs = getComputedStyle(el), af = getComputedStyle(el, '::after'), bf = getComputedStyle(el, '::before');
    parts.push([cs.backgroundColor, cs.backgroundImage, cs.outlineWidth, cs.outlineColor, cs.transform,
      cs.opacity, cs.borderLeftWidth, cs.borderColor, cs.boxShadow, cs.filter, cs.color, cs.pointerEvents,
      cs.fontWeight, cs.visibility, cs.animationName, cs.textDecorationLine, af.backgroundColor, af.content,
      af.animationName, bf.animationName, bf.content, bf.borderTopColor].join('|'));
  }
  return parts.join('\\n');
}

function draw(screen, name, host) {
  const st = screen.states[name] || {};
  host.replaceChildren();
  host.dataset.state = name;
  const badge = document.createElement('div');
  badge.className = 'state-badge';
  badge.textContent = name.toUpperCase();
  const body = document.createElement('p');
  body.textContent = st.copy || st.note || '';
  host.append(badge, body);
  if (st.skeleton) for (let i = 0; i < 5; i++) {
    const s = document.createElement('div'); s.className = 'skeleton'; host.append(s);
  }
}

(async () => {
  const out = [], fail = [];
  const list = await (await fetch('../screens/index.json')).json();
  const screens = await Promise.all(list.map(async (n) => (await fetch('../screens/' + n)).json()));
  const host = document.getElementById('stage');
  for (const s of screens) {
    const names = Object.keys(s.states || {});
    if (!names.includes('rest')) { fail.push(s.id + ': no rest state to compare against'); continue; }
    draw(s, 'rest', host);
    const rest = fingerprint(host);
    for (const n of names) {
      if (n === 'rest') continue;
      draw(s, n, host);
      const same = fingerprint(host) === rest;
      (same ? fail : out).push(s.id + '/' + n + (same ? ': renders identically to rest' : ': distinct'));
    }
  }
  document.getElementById('RESULT').textContent =
    out.map((l) => '  ok    ' + l).join('\\n') + (out.length && fail.length ? '\\n' : '') +
    fail.map((l) => '  FAIL  ' + l).join('\\n') +
    '\\n\\n' + out.length + ' distinct, ' + fail.length + ' indistinguishable.' +
    (fail.length ? '' : ' Every declared state draws something.');
})().catch((e) => { document.getElementById('RESULT').textContent = 'could not run: ' + e.message; });
</script>
</body>
</html>
`;

const selftest = `#!/usr/bin/env node
// contract.mjs — the structural self-test, runnable by node with no browser and
// no dependency. It asserts the studio's DECLARATIONS are internally consistent.
// What a state LOOKS like is a browser question and is not answered here; this
// file never prints a pass for something it did not measure.
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || path.join(import.meta.dirname, ".."));
const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), "utf8"));
const fail = [];
const ok = [];
const check = (cond, msg) => (cond ? ok : fail).push(msg);

const system = read("system.json");
const names = fs.readdirSync(path.join(dir, "screens")).filter((n) => n.endsWith(".json") && n !== "index.json");
const screens = names.map((n) => ({ ...read(path.join("screens", n)), _file: n }));

check(screens.length > 0, \`screens/ holds \${screens.length} screen(s)\`);
const tokens = new Set(Object.keys(system.color.tokens));
for (const p of system.color.pairs) {
  check(tokens.has(p.fg) || /^#/.test(p.fg), \`pair "\${p.use}" names a real fg token (\${p.fg})\`);
  check(tokens.has(p.bg) || /^#/.test(p.bg), \`pair "\${p.use}" names a real bg token (\${p.bg})\`);
}
const ids = new Set();
for (const s of screens) {
  check(!ids.has(s.id), \`\${s._file}: id "\${s.id}" is unique\`);
  ids.add(s.id);
  check(Object.keys(s.states || {}).length > 0, \`\${s.id}: declares states\`);
  for (const [n, st] of Object.entries(s.states || {})) {
    check(Boolean(st.label), \`\${s.id}/\${n}: has a label\`);
    check(Boolean(st.note || st.copy), \`\${s.id}/\${n}: says what it shows\`);
  }
  const nodes = new Set((s.flow || []).map((n) => n.node));
  for (const n of s.flow || []) for (const t of n.to || []) {
    check(nodes.has(t), \`\${s.id}: flow edge \${n.node} -> \${t} lands on a declared node\`);
  }
}
const idx = path.join(dir, "screens", "index.json");
if (fs.existsSync(idx)) {
  const listed = new Set(read(path.join("screens", "index.json")));
  for (const n of names) check(listed.has(n), \`screens/index.json lists \${n}\`);
}

for (const line of ok) console.log("  ok    " + line);
for (const line of fail) console.log("  FAIL  " + line);
console.log(\`\\n\${ok.length} passed, \${fail.length} failed. Visual state distinctness is a browser question and was not checked here.\`);
process.exit(fail.length ? 1 : 0);
`;

export { css, studioJs, indexHtml, statesHtml, selftest };
