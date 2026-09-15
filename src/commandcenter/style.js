// commandcenter/style.js — the page's one stylesheet.
//
// Separate from the markup and the client script because these are three
// different kinds of decision — how it looks, what it computes, what it is —
// and a change to any one of them should not require reading the other two.
//
// One rule runs through the palette: a MEASURED number is set in the ink or
// accent colour and an ESTIMATE is set in the muted one, so two numbers of
// different kinds can sit next to each other without the page implying they
// are the same kind.
export const style = `
:root{
  --ink:#141414; --muted:#6a6862; --faint:#94918a; --rule:#e4e1da; --bg:#faf9f6; --panel:#fff;
  --accent:#1f7a5c; --accent-soft:#e8f2ee; --red:#a8302a; --red-soft:#fbeceb;
  --amber:#8a6512; --amber-soft:#fbf3e2; --shadow:0 1px 0 rgba(20,20,20,.04);
  --sans:"Helvetica Neue",Helvetica,Arial,"Liberation Sans",sans-serif;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,"Liberation Mono",Menlo,monospace;
}
@media(prefers-color-scheme:dark){:root{
  --ink:#e9e6df; --muted:#9a968d; --faint:#6e6a62; --rule:#2a2b28; --bg:#101110; --panel:#171816;
  --accent:#4fb08a; --accent-soft:#16291f; --red:#e0776e; --red-soft:#2a1615;
  --amber:#d3a444; --amber-soft:#2a2113; --shadow:none;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);letter-spacing:-.005em}
a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding:0 28px}
header.bar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--rule)}
header.bar .wrap{display:flex;align-items:center;gap:18px;height:58px}
/* The header. The mark sits IN the type rather than beside it: aligned on the
   cap height, taking its colour from the text, so at 22px it reads as one
   lockup instead of an icon and a word that happen to be adjacent. */
.brand{display:inline-flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.02em;font-size:16px;
  text-decoration:none;color:var(--ink)}
.brand b{font-weight:700}
.brand span{color:var(--muted);font-weight:400}
.brand .mark{display:block;flex:0 0 auto;margin-top:-1px}
.brand:hover .mark{opacity:.85}

/* The connection state. A dashboard that cannot say whether it is still
   connected is worse than one that is plainly offline, because the stale
   numbers still look like numbers. */
.link{display:inline-flex;align-items:center;gap:6px;font:11px/1 var(--mono);letter-spacing:.04em;
  text-transform:uppercase;color:var(--faint)}
.link i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:0 0 auto}
.link.ok{color:var(--accent)} .link.ok i{background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.link.warn{color:var(--amber)} .link.warn i{background:var(--amber)}
.link.bad{color:var(--red)} .link.bad i{background:var(--red);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){.link.bad i{animation:none}}
.bar .spacer{flex:1}
.bar .meta{font:12px/1 var(--mono);color:var(--muted)}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:0 0 14px}
h3{font-size:15px;margin:0 0 6px;letter-spacing:-.01em}
section{padding:34px 0;border-bottom:1px solid var(--rule)}
section:last-child{border-bottom:0}
.lede{color:var(--muted);max-width:62ch;margin:-6px 0 20px}
.grid{display:grid;gap:14px}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
@media(max-width:860px){.g2,.g3,.g4{grid-template-columns:1fr}.wrap{padding:0 18px}}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:16px 18px;box-shadow:var(--shadow)}
.stat{font:600 30px/1.05 var(--sans);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.stat small{font:400 13px/1 var(--sans);color:var(--muted);letter-spacing:0}
.k{font:11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin-bottom:9px}
.note{color:var(--muted);font-size:13px;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font:11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);
  padding:0 10px 8px 0;border-bottom:1px solid var(--rule);font-weight:400}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
.mono{font-family:var(--mono);font-size:12.5px}
.muted{color:var(--muted)}
.truncate{max-width:44ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font:11px/1.6 var(--mono);border:1px solid var(--rule)}
.pill.ok{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.pill.gap{color:var(--red);background:var(--red-soft);border-color:transparent}
.pill.unknown{color:var(--amber);background:var(--amber-soft);border-color:transparent}
.flow{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}
.stage{flex:1 0 128px;border:1px solid var(--rule);border-radius:9px;padding:11px 12px;background:var(--panel);cursor:pointer;
  transition:border-color .12s ease}
.stage:hover{border-color:var(--muted)}
.stage[data-state=gap]{border-color:color-mix(in srgb,var(--red) 45%,var(--rule))}
.stage .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:7px;background:var(--accent)}
.stage[data-state=gap] .dot{background:var(--red)}
.stage[data-state=unknown] .dot{background:var(--amber)}
.stage .n{font-size:13px;font-weight:600}
.stage .q{color:var(--muted);font-size:11.5px;margin-top:5px;line-height:1.4}
.detail{margin-top:14px;border-left:2px solid var(--accent);padding:2px 0 2px 14px}
.detail[data-state=gap]{border-color:var(--red)}
.detail[data-state=unknown]{border-color:var(--amber)}
.detail code{font-family:var(--mono);font-size:12.5px;background:var(--accent-soft);color:var(--accent);padding:2px 6px;border-radius:5px}
.meter{height:8px;border-radius:999px;background:var(--rule);overflow:hidden;margin:10px 0 8px}
.meter i{display:block;height:100%;background:var(--accent);border-radius:999px}
.meter.near i{background:var(--amber)} .meter.hit i{background:var(--red)}
.empty{color:var(--faint);font-size:13px;padding:12px 0}
footer{padding:28px 0 44px;color:var(--faint);font-size:12.5px}

/* The savings block. One rule for the whole page: a MEASURED number is set in
   the ink colour and an ESTIMATE is set in the muted one, so the two can sit
   next to each other without the page implying they are the same kind. */
.statrow{display:grid;gap:14px;grid-template-columns:repeat(4,minmax(0,1fr))}
@media(max-width:900px){.statrow{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.statrow{grid-template-columns:1fr}}
.card.hero{border-color:color-mix(in srgb,var(--accent) 35%,var(--rule))}
.card.hero .stat{font-size:38px;color:var(--accent)}
.tag{display:inline-block;font:10px/1.7 var(--mono);letter-spacing:.09em;text-transform:uppercase;
  padding:0 7px;border-radius:4px;background:var(--accent-soft);color:var(--accent);margin-left:8px;vertical-align:2px}
.tag.est{background:var(--amber-soft);color:var(--amber)}
.chart{margin-top:6px}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .bar-bare{fill:var(--red);opacity:.5}
.chart .bar-packed{fill:var(--accent)}
.chart .axis{stroke:var(--rule);stroke-width:1}
.chart text{font:11px var(--mono);fill:var(--muted)}
.chart text.lbl{fill:var(--ink)}
.legend{display:flex;gap:16px;align-items:center;margin:2px 0 14px;font:12px var(--mono);color:var(--muted);flex-wrap:wrap}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.legend i.bare{background:var(--red);opacity:.5} .legend i.packed{background:var(--accent)}
.spark{stroke:var(--accent);stroke-width:2;fill:none}
.spark-fill{fill:var(--accent);opacity:.10}
`;
