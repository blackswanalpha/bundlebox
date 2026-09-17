// console/live.js — the connection, and the page's honesty about it.
//
// The page used to refetch on a 10s timer and swallow the error. That has one
// failure mode and it is the worst one available to a dashboard: when the server
// goes away the page keeps showing the last good state, with a timestamp that
// ages quietly, and a reader has no way to tell "nothing is happening" from
// "nothing is being reported".
//
// So the connection has a state of its own and the header always says which one
// it is in: live, polling, reconnecting, or static. A number on this page is
// only worth reading if the reader can see how old it is.
export const live = `
/* ── the connection ────────────────────────────────────────────────────────
   The page used to refetch on a 10s timer and swallow the error. That has one
   failure mode and it is the worst one available to a dashboard: when the
   server goes away the page keeps showing the last good state, with a timestamp
   that ages quietly, and a reader has no way to tell "nothing is happening"
   from "nothing is being reported". So the connection has a state of its own
   and the header always says which one it is in.

   EventSource first: the server pushes when the store changes, so a run that
   finishes is on screen in under a second instead of up to ten. Browsers
   reconnect it themselves on the interval the server sends. Polling is the
   fallback for anything that cannot hold one open. */
const LINK = { live:["ok","live"], polling:["warn","polling"], lost:["bad","reconnecting"], off:["","static"] };
let lastSeen = 0;
function link(kind, detail){
  const el = $("#link"); if(!el) return;
  const [cls,label] = LINK[kind] || LINK.off;
  el.className = "link " + cls;
  el.title = detail || label;
  el.querySelector("span").textContent = label;
}

function accept(s){ lastSeen = Date.now(); render(s); }

async function poll(){
  try{
    const r = await fetch("/api/state",{cache:"no-store"});
    if(!r.ok) throw new Error("HTTP "+r.status);
    accept(await r.json());
    link("polling","this browser could not hold a stream open; refetching every 10s");
  }catch(e){ link("lost", String(e && e.message || e)); }
}

function connect(){
  if(typeof EventSource === "undefined") { poll(); setInterval(poll, 10000); return; }
  let es;
  try { es = new EventSource("/api/stream"); }
  catch(e){ poll(); setInterval(poll, 10000); return; }
  es.addEventListener("state", ev => {
    try { accept(JSON.parse(ev.data)); link("live","pushed by the workspace as the store changes"); }
    catch(e){ link("lost","the stream sent something this page could not read"); }
  });
  es.onopen = () => link("live","pushed by the workspace as the store changes");
  es.onerror = () => link("lost","the workspace is not answering — the browser is retrying");
  /* A stream that is open but silent for longer than two heartbeats is not a
     quiet workspace, it is a connection nobody has noticed is dead. */
  setInterval(() => {
    if(!lastSeen) return;
    const age = Date.now() - lastSeen;
    if(es.readyState === 1 && age > 90000) link("lost","no frame for "+Math.round(age/1000)+"s");
  }, 15000);
}

if (window.__STATE__) { render(window.__STATE__); link("off","this file was built with the state embedded; it does not update"); }
if (window.__LIVE__) connect();
`;
