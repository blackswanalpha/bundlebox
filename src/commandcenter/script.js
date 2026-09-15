// commandcenter/script.js — everything the page computes in the browser.
//
// It renders from a state object and nothing else, so the live server and the
// static build share one code path: `bb commandcenter build` embeds the state
// and opens with no server; `bb commandcenter` serves the same page and
// refetches. A second renderer would be a second opinion about what the numbers
// mean, and the two would drift.
//
// No import, no CDN, no framework. The charts are inline SVG for the same
// reason the rest of the box has no dependencies: a chart that needs a network
// is a blank rectangle on the machine this page is designed for.
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

/* ── What the factory saved ────────────────────────────────────────────────
   Two numbers on this page answer "what did bundlebox save", and they are not
   the same kind of number. The bench is MEASURED: the same task, packed and
   bare, both counted by the same estimator over text on disk. Displaced turns
   are an ESTIMATE. The cards carry their label so neither has to be trusted on
   the reader's memory of which was which. */
function benchCards(b, s){
  if(!b || b.state!=="measured")
    return '<div class="card"><div class="k">What the factory saved</div><p class="empty">'
      + 'Nothing measured yet. Run <span class="mono">' + esc((b&&b.how)||"bb bench run") + '</span>.</p></div>'
      + '<div class="card"><div class="k">Displaced by the local path</div><div class="stat">'+human(s.saved.turns)
      + ' <small>agent turns</small><span class="tag est">estimate</span></div></div>'
      + '<div class="card"><div class="k">Open findings</div><div class="stat">'+s.findings.open+"</div></div>"
      + '<div class="card"><div class="k">Units ready</div><div class="stat">'+s.units.ready+"</div></div>";
  return '<div class="card hero"><div class="k">Context saved<span class="tag">measured</span></div>'
    + '<div class="stat">'+b.saved_pct+'% <small>of the bare arm</small></div>'
    + '<div class="meter"><i style="width:'+Math.min(b.saved_pct,100)+'%"></i></div>'
    + '<div class="note">'+b.tasks_measured+" task"+(b.tasks_measured===1?"":"s")+" in "+esc(b.suite)+" · "+when(b.at)+"</div></div>"
    + '<div class="card"><div class="k">Tokens saved<span class="tag">measured</span></div><div class="stat">'+human(b.saved)
    + ' <small>tokens</small></div><div class="note">'+human(b.bare)+" bare · "+human(b.packed)+" packed</div></div>"
    + '<div class="card"><div class="k">Context ratio<span class="tag">measured</span></div><div class="stat">'
    + (b.ratio==null?"—":b.ratio+"x") + ' <small>less to read</small></div><div class="note">bare opens the top '
    + b.bare_read_cap + " files whole; packed is one pinpoint prompt</div></div>"
    + '<div class="card"><div class="k">Displaced turns<span class="tag est">estimate</span></div><div class="stat">'
    + human(s.saved.turns) + ' <small>agent turns</small></div><div class="note">'
    + (b.losses ? b.losses+" bench task(s) cost MORE packed than bare — shown below, not dropped" : "no task cost more packed than bare")
    + "</div></div>";
}

/* Grouped horizontal bars, one pair per task. SVG and nothing else: a chart
   that needs a CDN is a chart that is blank on the box with no network, which
   is the box this page is designed for. */
function benchChart(b){
  const t = (b.tasks||[]).filter(x=>!x.error);
  if(!t.length) return '<p class="empty">No measured task to plot.</p>';
  const max = Math.max(...t.map(x=>x.bare), 1);
  const rowH = 34, padL = 190, padR = 62, w = 1000, h = t.length*rowH + 26;
  const bars = t.map((x,i)=>{
    const y = i*rowH + 6;
    const bw = (w-padL-padR) * (x.bare/max);
    const pw = Math.max((w-padL-padR) * (x.packed/max), 2);
    const name = (x.title||x.id).length>30 ? (x.title||x.id).slice(0,29)+"…" : (x.title||x.id);
    return '<text class="lbl" x="'+(padL-10)+'" y="'+(y+16)+'" text-anchor="end">'+esc(name)+"</text>"
      + '<rect class="bar-bare" x="'+padL+'" y="'+y+'" width="'+bw.toFixed(1)+'" height="11" rx="2"><title>'
      + esc(name)+" — bare "+human(x.bare)+" tokens</title></rect>"
      + '<rect class="bar-packed" x="'+padL+'" y="'+(y+14)+'" width="'+pw.toFixed(1)+'" height="11" rx="2"><title>'
      + esc(name)+" — packed "+human(x.packed)+" tokens</title></rect>"
      + '<text x="'+(w-padR+8)+'" y="'+(y+16)+'">'+x.saved_pct+"%</text>";
  }).join("");
  return '<div class="legend"><span><i class="bare"></i>bare — search, then read the top '+b.bare_read_cap
    + ' files whole</span><span><i class="packed"></i>packed — one <span class="mono">bb pinpoint</span> prompt</span>'
    + '<span>right column: share of the bare arm not spent</span></div>'
    + '<div class="chart"><svg viewBox="0 0 '+w+" "+h+'" role="img" aria-label="Tokens per task, bare against packed">'
    + '<line class="axis" x1="'+padL+'" y1="0" x2="'+padL+'" y2="'+(h-18)+'"/>'
    + bars
    + '<text x="'+padL+'" y="'+(h-4)+'">0</text><text x="'+(w-padR)+'" y="'+(h-4)+'" text-anchor="end">'
    + human(max)+' tokens</text></svg></div>';
}

/* Every bench run this workspace has recorded. One run is a measurement; a
   line of them is the only way to see the number move when the tree changes. */
function benchTrend(b){
  const r = (b.runs||[]).filter(x=>x.saved_pct!=null);
  if(r.length<2) return "";
  const w=1000,h=120,padL=44,padB=22;
  const xs = i => padL + (w-padL-10) * (r.length===1?0:i/(r.length-1));
  const ys = v => 8 + (h-padB-8) * (1 - Math.min(Math.max(v,0),100)/100);
  const pts = r.map((x,i)=>xs(i).toFixed(1)+","+ys(x.saved_pct).toFixed(1));
  return '<div class="chart"><svg viewBox="0 0 '+w+" "+h+'" role="img" aria-label="Share of context saved, per bench run">'
    + '<polygon class="spark-fill" points="'+padL+","+(h-padB)+" "+pts.join(" ")+" "+xs(r.length-1).toFixed(1)+","+(h-padB)+'"/>'
    + '<polyline class="spark" points="'+pts.join(" ")+'"/>'
    + '<line class="axis" x1="'+padL+'" y1="'+(h-padB)+'" x2="'+(w-10)+'" y2="'+(h-padB)+'"/>'
    + '<text x="0" y="14">100%</text><text x="0" y="'+(h-padB)+'">0%</text>'
    + '<text x="'+padL+'" y="'+(h-6)+'">'+when(r[0].at)+'</text>'
    + '<text x="'+(w-10)+'" y="'+(h-6)+'" text-anchor="end">'+when(r[r.length-1].at)+' · '+r[r.length-1].saved_pct+'%</text>'
    + "</svg></div>";
}

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

async function load(){ try{ const r = await fetch("/api/state",{cache:"no-store"}); render(await r.json()); }catch(e){} }
if (window.__STATE__) render(window.__STATE__);
if (window.__LIVE__) { load(); setInterval(load, 10000); }
`;
