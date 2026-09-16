// commandcenter/charts.js — the drawing half of the page: the savings cards, the
// per-task bars, the trend line, the pipeline strip and the window meter.
//
// Inline SVG and nothing else, for the same reason the rest of the box has no
// dependencies: a chart that needs a CDN is a blank rectangle on the machine
// this page is designed for.
//
// Split out of `script.js` so that changing how a number LOOKS does not mean
// reading the code that decides what the numbers ARE. Both halves are fragments
// of one browser script; `page.js` joins them.
export const charts = `
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

/* ── What this workspace did not spend ─────────────────────────────────────
   The bench above measures ONE task both ways. This is the other kind of
   evidence: every local run this workspace has actually recorded, converted at
   its own median billed turn. Neither replaces the other — a bench is
   reproducible and small, a running total is lived and large — so they sit in
   the same section with their labels on. */
function savingsCards(v){
  if(!v || !v.avoided || !v.avoided.known)
    return '<div class="card"><div class="k">Counted over this workspace</div><p class="empty">'
      + esc((v&&v.avoided&&v.avoided.why)||"no local run recorded yet")
      + '. Run <span class="mono">bb scan</span> or <span class="mono">bb pinpoint</span>.</p></div>';
  const t = v.avoided.per_turn||{}, est = t.kind!=="MEASURED";
  const lev = v.leverage==null?null:Number(v.leverage);
  return '<div class="card hero"><div class="k">Tokens not spent<span class="tag est">estimate</span></div>'
    + '<div class="stat">'+human(v.avoided.tokens)+' <small>tokens</small></div>'
    + '<div class="note">'+human(v.avoided.turns)+" agent turns displaced by "+human(v.runs)+" local runs</div></div>"
    + '<div class="card"><div class="k">Leverage<span class="tag est">estimate</span></div><div class="stat">'
    + (lev==null?"—":lev.toFixed(lev>=10?0:1)+"\u00d7") + ' <small>per fresh token</small></div>'
    + '<div class="note">against '+human(v.spent.fresh)+" fresh tokens billed — cache reads are not in the denominator</div></div>"
    + '<div class="card"><div class="k">Valued at<span class="tag'+(est?" est":"")+'">'+(est?"estimate":"measured")+'</span></div>'
    + '<div class="stat">'+human(t.value)+' <small>tokens a turn</small></div><div class="note">'
    + (est ? "no billed turn here to take a median from" : "the median of "+human(t.n)+" billed turns in this workspace")
    + "</div></div>"
    + '<div class="card"><div class="k">Prompt cache<span class="tag">measured</span></div><div class="stat">'
    + human(v.cache.tokens_not_rebilled) + ' <small>not re-billed</small></div>'
    + '<div class="note">of '+human(v.cache.read)+" re-read tokens. That discount is the harness, not this box.</div></div>";
}

/* Where the saving came from, one bar per verb, widest first. The share is of
   the total displaced, so the chart answers "which verbs earn their place"
   without the reader adding anything up. */
function savingsVerbs(v){
  const b = ((v&&v.by_verb)||[]).filter(x=>x.turns>0).slice(0,12);
  if(!b.length) return "";
  const max = Math.max(...b.map(x=>x.turns), 1);
  const rowH = 26, padL = 170, padR = 96, w = 1000, h = b.length*rowH + 24;
  const bars = b.map((x,i)=>{
    const y = i*rowH + 5;
    const bw = Math.max((w-padL-padR) * (x.turns/max), 2);
    const name = x.verb.length>26 ? x.verb.slice(0,25)+"\u2026" : x.verb;
    return '<text class="lbl" x="'+(padL-10)+'" y="'+(y+12)+'" text-anchor="end">'+esc(name)+"</text>"
      + '<rect class="bar-packed" x="'+padL+'" y="'+y+'" width="'+bw.toFixed(1)+'" height="14" rx="2"><title>'
      + esc(name)+" \u2014 "+human(x.turns)+" turns, "+human(x.tokens)+" tokens, "+x.runs+" run(s)</title></rect>"
      + '<text x="'+(w-padR+8)+'" y="'+(y+12)+'">'+human(x.tokens)+" \u00b7 "+Math.round(x.share)+"%</text>";
  }).join("");
  return '<div class="legend"><span><i class="packed"></i>agent turns each verb displaced</span>'
    + '<span>right column: tokens, and share of everything avoided</span></div>'
    + '<div class="chart"><svg viewBox="0 0 '+w+" "+h+'" role="img" aria-label="Turns displaced per verb">'
    + '<line class="axis" x1="'+padL+'" y1="0" x2="'+padL+'" y2="'+(h-16)+'"/>'
    + bars
    + '<text x="'+padL+'" y="'+(h-3)+'">0</text><text x="'+(w-padR)+'" y="'+(h-3)+'" text-anchor="end">'
    + human(max)+' turns</text></svg></div>';
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
`;
