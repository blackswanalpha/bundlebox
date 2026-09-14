// scaffold.js — what `bb designlabs init` writes. The studio's source of truth
// is JSON: system.json and one file per screen. Everything else here is DERIVED
// from those two (doctrine 7), so tokens.css and the browser studio cannot drift
// from what the gate reads. The starting system is deliberately not the
// framework default — a scaffold that ships Inter and indigo would fail its own
// ui-generic detector on the first scan, which is the joke this toolkit exists
// to stop telling.
import fs from "node:fs";
import path from "node:path";

export const SYSTEM = {
  name: "studio",
  note: "A starting hand, not a decision. Replace the hue and both typefaces with ones you chose on purpose; the gate will keep holding the floors either way.",
  type: {
    display: { family: "Fraunces", fallback: "Georgia, serif", license: "OFL", weights: [400, 600], source: "fontsource:fraunces" },
    text: { family: "Public Sans", fallback: "Helvetica, Arial, sans-serif", license: "OFL", weights: [400, 500, 700], source: "fontsource:public-sans" },
    scale: { micro: "12px", small: "14px", body: "16px", lead: "19px", title: "25px", display: "38px" },
  },
  color: {
    tokens: {
      paper: "#FAF8F3", surface: "#F1EEE5", ink: "#14170F", muted: "#5A5F52",
      border: "#74786B", rule: "#DCD7C9", accent: "#2F5D50", danger: "#8C2F1D",
      night: "#12140F", "night-surface": "#1B1E18", "night-ink": "#EDEBE3",
      "night-muted": "#9AA091", "night-border": "#787C6E", "night-accent": "#7FBFA6",
    },
    pairs: [
      { fg: "ink", bg: "paper", use: "body text", size: "text" },
      { fg: "muted", bg: "paper", use: "secondary text", size: "text" },
      { fg: "accent", bg: "paper", use: "link and focus ring", size: "ui" },
      { fg: "paper", bg: "accent", use: "primary button label", size: "text" },
      { fg: "border", bg: "paper", use: "control boundary", size: "ui" },
      { fg: "danger", bg: "paper", use: "error text", size: "text" },
      { fg: "night-ink", bg: "night", use: "body text, dark", size: "text" },
      { fg: "night-muted", bg: "night", use: "secondary text, dark", size: "text" },
      { fg: "night-accent", bg: "night", use: "link and focus ring, dark", size: "ui" },
      { fg: "night-border", bg: "night", use: "control boundary, dark", size: "ui" },
    ],
  },
  // Non-linear on purpose: grouping is carried by the RATIO between an inner
  // gap and an outer one, and a pure 8-multiple scale has no ratios to use.
  space: [4, 8, 12, 20, 32, 52, 84],
  radius: { control: "6px", surface: "18px", pill: "999px" },
  motion: { instant: "90ms", state: "160ms", enter: "240ms", sheet: "320ms" },
  easing: { standard: "cubic-bezier(0.2, 0, 0, 1)", exit: "cubic-bezier(0.4, 0, 1, 1)" },
  targets: { row: "56px", "icon-button": "44px", chip: "44px", "list-item": "48px" },
  elevation: { resting: "none", raised: "0 1px 2px rgba(20,23,15,0.10), 0 0 0 1px rgba(20,23,15,0.05)", floating: "0 12px 32px rgba(20,23,15,0.18)" },
};

export const SCREEN = {
  id: "worklist",
  area: "home",
  title: "Worklist",
  lede: "Everything that needs a decision today, ranked, with the reason it is here.",
  primary: "resolve",
  secondary: ["filter", "snooze", "open-source"],
  disclosure_depth: 1,
  accents: 1,
  states: {
    rest: { label: "Rest", note: "Five rows, ranked. The top row is the only accented element." },
    loading: { label: "Loading", skeleton: true, note: "Five row-shaped skeletons, so the page does not resize when data lands." },
    empty: { label: "Empty", variant: "first-run", note: "Nothing to decide before 2pm. Says what will bring rows here, not just that there are none." },
    error: { label: "Error", copy: "Couldn't reach the calendar. Retry, or work from what was cached at 06:12." },
    partial: { label: "Partial", note: "Mail arrived, calendar did not. The missing source is named in the header, not hidden." },
    offline: { label: "Offline", note: "Cached rows stay readable and every action that needs the network is disabled with a reason." },
  },
  groups: [
    { name: "row", inner: 8, outer: 20, items: 5 },
    { name: "section", inner: 20, outer: 52, items: 3 },
  ],
  destructive: [{ action: "dismiss", undo: true, note: "Undo for 8s in the same row; no dialog." }],
  audit: {
    budget: 16,
    elements: 13,
    absorbs: "ranking five heterogeneous sources into one order, and explaining the rank in one clause per row",
    transfers: "the user still picks which row to act on; the product does not act unasked",
    claim: "median time from open to first action, measured, not the number of taps",
  },
  flow: [
    { node: "open", to: ["read"] },
    { node: "read", to: ["resolve", "snooze"] },
    { node: "resolve", terminal: true, residue: "the row leaves and the count drops" },
    { node: "snooze", terminal: true, residue: "the row returns at the named time, not vaguely later" },
    { node: "source-unreachable", failure: true, residue: "cached rows remain, the header names what is missing" },
  ],
};

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

function doctrine(cards) {
  const rows = cards.map((c) => `| \`${c.rule}\` | ${c.title} | ${c.severity} | ${c.check} |`).join("\n");
  return `# Doctrine

Every rule \`bb designlabs check\` enforces, and the card that sets it. The cards
themselves ship with bundlebox under \`designlabs/principles/\`; read one with
\`bb designlabs principles <id>\`.

| rule | principle | severity | what is checked |
|---|---|---|---|
${rows}

Rules marked UNKNOWN by the gate are not failures and are not passes. They are
questions a static pass cannot settle — open \`index.html\` over http:// for the
visual ones, and read the flow for the rest.
`;
}

/** [{path, text}] — every file init writes, so a dry run can list them without
 *  touching the disk. */
export function files(cards) {
  const screenFile = `screens/${SCREEN.id}.json`;
  return [
    { path: "system.json", text: JSON.stringify(SYSTEM, null, 2) + "\n" },
    { path: screenFile, text: JSON.stringify(SCREEN, null, 2) + "\n" },
    { path: "screens/index.json", text: JSON.stringify([`${SCREEN.id}.json`], null, 2) + "\n" },
    { path: "styles/tokens.css", text: css(SYSTEM) },
    { path: "scripts/studio.js", text: studioJs },
    { path: "index.html", text: indexHtml },
    { path: "selftest/contract.mjs", text: selftest },
    { path: "selftest/states.html", text: statesHtml },
    { path: "DOCTRINE.md", text: doctrine(cards) },
    { path: "corpus/README.md", text: `# corpus/

What \`bb designlabs collect\` and \`bb designlabs intake\` write. One JSON file per
reference, in the shape \`bb designlabs intake\` validates:

    { "id", "source", "url", "captured", "kind", "observed": [], "taken": [], "refused": [], "license" }

\`observed\` is what is actually on the page. \`taken\` is what you are carrying into
this system and why. \`refused\` is what you looked at and decided against — the
most useful field, and the one that stops a corpus becoming a mood board.
` },
  ];
}

/** Writes the scaffold. Returns [{path, state:"written"|"kept"}]. */
export function write(dir, cards, { force = false } = {}) {
  const rows = [];
  for (const f of files(cards)) {
    const p = path.join(dir, f.path);
    if (fs.existsSync(p) && !force) { rows.push({ path: f.path, state: "kept" }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text);
    rows.push({ path: f.path, state: "written" });
  }
  return rows;
}
