// commandcenter/script.js — everything the page computes in the browser.
//
// It renders from a state object and nothing else, so the live server and the
// static build share one code path: `bb commandcenter build` embeds the state
// and opens with no server; `bb commandcenter` serves the same page and is
// pushed to. A second renderer would be a second opinion about what the numbers
// mean, and the two would drift.
//
// No import, no CDN, no framework. Three fragments, joined here:
//
//   helpers   escaping, formatting, one table builder
//   charts    how a number is drawn            (charts.js)
//   render    what each section of the page is (below)
//   live      how the page stays current       (live.js)
import { charts } from "./charts.js";
import { live } from "./live.js";

const helpers = `

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
`;

const render = `
function render(s){
  document.title = s.workspace+" — bundlebox command centre";
  $("#ws").textContent = s.workspace;
  $("#stamp").textContent = "v"+s.version+" · "+when(s.at);
  $("#stamp").title = s.at;
  $("#pipeline").innerHTML = pipeline(s.pipeline);
  document.querySelectorAll(".stage").forEach(el=>el.onclick=()=>{
    const st=s.pipeline.stages[+el.dataset.i];
    $("#stage-detail").outerHTML='<div class="detail" data-state="'+st.state+'" id="stage-detail"><h3>'+esc(st.title)
      +' <span class="pill '+st.state+'">'+st.state+"</span></h3><p class=\\"note\\">"+esc(st.why)+"</p>"
      +(st.state==="ok"?"":"<p>Closed by <code>"+esc(st.fix)+"</code></p>")+"</div>";
  });
  $("#pipeline-note").textContent = s.pipeline.ok+" of "+s.pipeline.of+" stages hold right now"
    + (s.pipeline.next?". The first that does not is "+s.pipeline.next.title.toLowerCase()+".":". Nothing is waiting.");

  const b = s.bench || {state:"never run"};
  $("#savings").innerHTML = benchCards(b, s);
  $("#savings-chart").innerHTML = benchChart(b);
  $("#savings-trend").innerHTML = benchTrend(b);
  $("#savings-note").textContent = b.state==="measured"
    ? b.method + ". Bare reads " + b.bare_read_cap + " files; raise or lower it with bb bench run --cap N."
    : "Run bb bench run to put a measured number here.";

  $("#window").innerHTML = windowCard(s.window)
    + '<div class="card"><div class="k">Displaced by the local path<span class="tag est">estimate</span></div><div class="stat">'+human(s.saved.turns)
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
`;

export const script = [helpers, charts, render, live].join("\n");
