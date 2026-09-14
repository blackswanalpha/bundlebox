// page.js — the command centre, as one file.
//
// The page renders entirely from a state object, so the live server and the
// static build share one code path: `bb commandcenter build` embeds the state
// and opens without a server; `bb commandcenter` serves the same page and
// refetches. A second renderer would be a second opinion about what the numbers
// mean, and the two would drift.
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
header.bar .wrap{display:flex;align-items:baseline;gap:18px;height:58px}
.brand{font-weight:700;letter-spacing:-.02em;font-size:16px}
.brand span{color:var(--muted);font-weight:400}
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
`;

export const script = `
const $ = (s,r=document)=>r.querySelector(s);
const esc = s => String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const human = n => { n=Number(n)||0; const a=Math.abs(n);
  return a>=1e9?(n/1e9).toFixed(1)+"B":a>=1e6?(n/1e6).toFixed(1)+"M":a>=1e3?(n/1e3).toFixed(1)+"k":String(Math.round(n)); };
const usd = n => n==null?"—":"$"+(Number(n)||0).toFixed(Number(n)>=10?2:3);
const hm = m => m==null?"—":m>=60?Math.floor(m/60)+"h "+(m%60)+"m":m+"m";
const when = t => { if(!t) return "—"; const d=new Date(t); if(isNaN(d)) return "—";
  const mins=Math.round((Date.now()-d.getTime())/60000);
  return mins<1?"just now":mins<60?mins+"m ago":mins<1440?Math.floor(mins/60)+"h ago":d.toISOString().slice(0,10); };
const rows = (arr,cols,empty) => arr.length
  ? "<table><thead><tr>"+cols.map(c=>'<th class="'+(c.num?"num":"")+'">'+esc(c.h)+"</th>").join("")+"</tr></thead><tbody>"
    + arr.map(r=>"<tr>"+cols.map(c=>'<td class="'+(c.num?"num ":"")+(c.cls||"")+'">'+(c.f?c.f(r):esc(r[c.k]??""))+"</td>").join("")+"</tr>").join("")
    + "</tbody></table>"
  : '<p class="empty">'+esc(empty)+"</p>";

function pipeline(p){
  const flow = p.stages.map((s,i)=>
    '<div class="stage" data-state="'+s.state+'" data-i="'+i+'"><div class="n"><i class="dot"></i>'+esc(s.title)+'</div><div class="q">'+esc(s.question)+"</div></div>").join("");
  const pick = s => '<div class="detail" data-state="'+s.state+'"><h3>'+esc(s.title)+' <span class="pill '+s.state+'">'+s.state+"</span></h3>"
    + '<p class="note">'+esc(s.why)+"</p>"
    + (s.state==="ok" ? "" : "<p>Closed by <code>"+esc(s.fix)+"</code></p>");
  return '<div class="flow">'+flow+'</div><div id="stage-detail">'+pick(p.next||p.stages[0])+"</div>";
}

function windowCard(w){
  if(!w || w.state==="indeterminate" && !w.block)
    return '<div class="card"><div class="k">Current window</div><p class="empty">'+esc(w&&w.why||"nothing folded yet")+"</p></div>";
  const l=w.limit||{}, pct=l.pct==null?null:Math.min(l.pct,100);
  const cls = w.state==="hit"?"hit":w.state==="near"?"near":"";
  return '<div class="card"><div class="k">Current five-hour block</div>'
    + '<div class="stat">'+(l.pct==null?"—":l.pct+"%")+' <small>of '+(l.limit?human(l.limit):"an unknown limit")+" · "+esc(l.source)+"</small></div>"
    + '<div class="meter '+cls+'"><i style="width:'+(pct==null?0:pct)+'%"></i></div>'
    + '<div class="note">'+human(l.used)+" used"+(l.left!=null?" · "+human(l.left)+" left":"")
    + (w.block?" · "+hm(w.block.minutes_left)+" on the clock":"")
    + (w.burn&&w.burn.per_minute?" · "+human(w.burn.per_minute)+"/min":"")
    + (w.runs_out_in_minutes!=null?" · budget runs out in "+hm(w.runs_out_in_minutes):"")+"</div>"
    + (l.why?'<div class="note">'+esc(l.why)+"</div>":"")+"</div>";
}

function render(s){
  document.title = s.workspace+" — bundlebox command centre";
  $("#ws").textContent = s.workspace;
  $("#stamp").textContent = "v"+s.version+" · "+when(s.at);
  $("#pipeline").innerHTML = pipeline(s.pipeline);
  document.querySelectorAll(".stage").forEach(el=>el.onclick=()=>{
    const st=s.pipeline.stages[+el.dataset.i];
    $("#stage-detail").outerHTML='<div class="detail" data-state="'+st.state+'" id="stage-detail"><h3>'+esc(st.title)
      +' <span class="pill '+st.state+'">'+st.state+"</span></h3><p class=\\"note\\">"+esc(st.why)+"</p>"
      +(st.state==="ok"?"":"<p>Closed by <code>"+esc(st.fix)+"</code></p>")+"</div>";
  });
  $("#pipeline-note").textContent = s.pipeline.ok+" of "+s.pipeline.of+" stages hold right now"
    + (s.pipeline.next?". The first that does not is "+s.pipeline.next.title.toLowerCase()+".":". Nothing is waiting.");

  $("#window").innerHTML = windowCard(s.window)
    + '<div class="card"><div class="k">Displaced by the local path</div><div class="stat">'+human(s.saved.turns)
    + ' <small>agent turns</small></div><div class="note">'+esc(s.saved.note)+'</div></div>'
    + '<div class="card"><div class="k">Open findings</div><div class="stat">'+s.findings.open
    + " <small>of "+s.findings.total+" ever</small></div><div class=\\"note\\">"
    + Object.entries(s.findings.by_severity).map(([k,v])=>v+" "+k).join(" · ")+"</div></div>"
    + '<div class="card"><div class="k">Packed and budgeted</div><div class="stat">'+s.units.ready
    + " <small>units ready</small></div><div class=\\"note\\">"
    + (Object.entries(s.units.by_verdict).map(([k,v])=>v+" "+k).join(" · ")||"nothing compiled")+"</div></div>";

  $("#sessions").innerHTML = rows(s.sessions,[
    {h:"Session",f:r=>'<div>'+esc(r.title||"(untitled)")+'</div><div class="mono muted">'+esc(r.session.slice(0,8))+" · "+esc(r.agent||"?")+"</div>",cls:""},
    {h:"Turns",num:1,f:r=>r.turns},
    {h:"Tokens",num:1,f:r=>human(r.tokens)},
    {h:"Cache read",num:1,f:r=>human(r.cache_read)},
    {h:"Cost",num:1,f:r=>usd(r.usd)},
    {h:"Turns displaced",num:1,f:r=>r.turns_saved?human(r.turns_saved):"—"},
    {h:"Last",num:1,f:r=>when(r.last)},
  ],"No sessions measured yet. Run bb tokens ledger.");

  $("#boards").innerHTML = rows(s.boards,[
    {h:"Corpus",f:r=>'<div>'+esc(r.corpus)+'</div><div class="mono muted">'+esc(r.base||r.state||"")+"</div>"},
    {h:"Scenarios",num:1,f:r=>r.scenarios??"—"},
    {h:"Passed",num:1,f:r=>r.passed??"—"},
    {h:"Red",num:1,f:r=>r.red?'<span style="color:var(--red)">'+r.red+"</span>":"0"},
    {h:"Blocked",num:1,f:r=>r.blocked??"—"},
    {h:"Engine",num:1,f:r=>esc(r.engine||"")},
    {h:"Ran",num:1,f:r=>when(r.at)},
  ],"No corpus has been run. bb genesis <doc> seeds one; bb cookbook run executes it.");

  const worst = s.boards.flatMap(b=>(b.worst||[]).map(w=>({...w,corpus:b.corpus})));
  $("#red").innerHTML = rows(worst,[
    {h:"Scenario",f:r=>'<div>'+esc(r.id)+'</div><div class="mono muted">'+esc(r.corpus)+" · "+esc(r.surface||"")+"</div>"},
    {h:"Severity",f:r=>esc(r.severity||"")},
    {h:"What the system did",f:r=>'<span class="muted">'+esc(r.why)+"</span>"},
  ],"Nothing red on the last board.");

  $("#findings").innerHTML = rows(s.findings.top,[
    {h:"Finding",f:r=>'<div>'+esc(r.title)+'</div><div class="mono muted">'+esc(r.detector)+(r.path?" · "+esc(r.path):"")+"</div>"},
    {h:"Severity",f:r=>esc(r.severity)},
    {h:"Kind",f:r=>esc(r.kind||"")},
  ],"Nothing open.");

  $("#agents").innerHTML = rows(s.agents,[
    {h:"Call",f:r=>'<div>'+esc(r.problem||"")+'</div><div class="mono muted">'+esc(r.id)+"</div>"},
    {h:"Reason",f:r=>esc(r.reason||"")},
    {h:"State",f:r=>'<span class="pill '+(r.state==="done"?"ok":r.state==="refused"?"gap":"unknown")+'">'+esc(r.state||"?")+"</span>"},
    {h:"Agent",f:r=>esc(r.agent||"—")},
    {h:"Brief",num:1,f:r=>human(r.est_tokens)+" tok"},
    {h:"When",num:1,f:r=>when(r.at)},
  ],"No calls. That is the good state: a call is the local path admitting it could not finish.");

  $("#episodes").innerHTML = rows(s.episodes.by_verb,[
    {h:"Verb",f:r=>'<span class="mono">'+esc(r.verb)+"</span>"},
    {h:"Runs",num:1,f:r=>r.runs},
    {h:"Produced",num:1,f:r=>r.produced},
    {h:"Seconds",num:1,f:r=>Math.round(r.seconds)},
    {h:"Turns displaced",num:1,f:r=>human(r.turns_saved)},
  ],"No episodes recorded.");

  $("#sims").innerHTML = s.simulations.length ? s.simulations.map(r=>
    '<div class="card"><div class="k">'+esc(r.profile)+" · "+esc(r.request||"")+"</div>"
    + rows(r.levels,[{h:"Concurrency",num:1,f:x=>x.concurrency},{h:"Rate",num:1,f:x=>x.rps+"/s"},
        {h:"p95",num:1,f:x=>x.p95+"ms"},{h:"Errors",num:1,f:x=>x.error_pct+"%"}],"")
    + '<div class="note">floor '+(r.floor_ms??"—")+"ms · budget "+(r.budget_ms??"—")+"ms · "+r.findings+" finding(s) · "+when(r.at)+"</div></div>"
  ).join("") : '<p class="empty">Nothing simulated. bb simulate run smoke --base &lt;url&gt;</p>';
}

async function load(){ try{ const r = await fetch("/api/state",{cache:"no-store"}); render(await r.json()); }catch(e){} }
if (window.__STATE__) render(window.__STATE__);
if (window.__LIVE__) { load(); setInterval(load, 10000); }
`;

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
<style>${style}</style>
</head><body>
<header class="bar"><div class="wrap">
  <div class="brand">bundlebox <span id="ws"></span></div>
  <div class="spacer"></div>
  <div class="meta" id="stamp"></div>
</div></header>
<section><div class="wrap"><div class="grid g4" id="window"></div></div></section>
${body}
<footer><div class="wrap">Measured off the transcripts and the store. Nothing on this page called a model.</div></footer>
<script>window.__LIVE__=${live ? "true" : "false"};window.__STATE__=${live ? "null" : JSON.stringify(state)};</script>
<script>${script}</script>
</body></html>`;
}
