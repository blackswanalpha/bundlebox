// grapple — every point where the deterministic system hands off to a person,
// and takes the answer back.
//
//   bb grapple observe   run every detector, record, inject nothing
//   bb grapple ask       the queue; --answer <key> --value yes|no --reason "..."
//   bb grapple ratify    one batched proposal; <id> --confirm k,k --reject k,k
//   bb grapple harvest   the labels nobody was asked for, with their n
//   bb grapple promote   what the event log has earned, as lathe proposals
//   bb grapple status    phase, queue, collisions, drift, labels
//
// No model call, no hosted judge, no harness assumption: everything here reads
// what `bb hook` already receives and the artefacts the scan already wrote.
// `phase` in config decides what leaves this directory. `observe` records what
// it would have done and changes no session behaviour; that is the phase the
// base rates for the other two come from.
import { load } from "../core/config.js";
import { out, emit as emitJson } from "../core/log.js";
import { table } from "../core/util.js";
import * as expert from "../core/expert.js";
import * as brief from "../wire/brief.js";
import * as gs from "./store.js";
import * as detect from "./detect.js";
import * as ask from "./ask.js";
import * as ratify from "./ratify.js";
import * as harvest from "./harvest.js";
import * as promote from "./promote.js";

export { gs as store, detect, ask, ratify, harvest, promote };

export const PHASES = gs.PHASES;
export const settings = (cfg = load()) => gs.settings(cfg);

/** Score one session's window: the expert's `drift`, or the raw counters.
 *  A window is ONE session's turns. With no session named, the newest session
 *  on the log is the window; every session's turns folded together is not a
 *  window and would count every repeat across the workspace as one loop. */
export function drift({ session = "", rec = null, events = gs.events(), cfg = load() } = {}) {
  const sid = session || [...events].reverse().find((e) => e.kind === "tool" && e.session_id)?.session_id || "";
  const w = detect.windowOf(events, { scope: rec?.scope || [], session: sid });
  const c = detect.counters(w.turns, w.scope);
  const r = expert.call("grapple", { op: "drift", window: w });
  const d = r && typeof r.score === "number" ? { score: r.score, signature: String(r.signature || "none"), counters: c, via: "expert" } : detect.fallbackDrift(c);
  return { ...d, session: sid, no_progress: detect.noProgress(d, Number(settings(cfg).drift_at) || 0.67) };
}

/** Every detector, once. Records what it saw; injects nothing. */
export function observe({ session = "", cfg = load() } = {}) {
  const g = settings(cfg);
  const rec = brief.current({ maxAgeMin: Number(cfg.wire?.brief_max_age_min) || 45, sessionId: session });
  const col = detect.collisions();
  for (const c of col) gs.record("collision", { ...c, session_id: session });
  const expired = gs.expire({ ttlHours: g.question_ttl_hours });
  const d = drift({ session, rec, cfg });
  if (d.signature !== "none" && d.session) gs.record("drift", { session_id: d.session, score: d.score, signature: d.signature, via: d.via, would_correct: d.no_progress });
  const q = ask.emit({ rec, cap: g.ask_per_session, session });
  const h = harvest.run({ minLabels: g.min_labels });
  const p = promote.run({ phase: g.phase });
  const qs = Object.values(gs.questions());
  const answeredQ = qs.filter((x) => x.state === "answered").length;
  const status = { at: new Date().toISOString(), phase: g.phase, brief: rec ? rec.path : "", collisions: col.length, expired: expired.length,
    // The fifth bench metric, measurable without a bench: labels produced per
    // question answered. Per row it would be 1; per pattern it is the reach.
    questions: { open: qs.filter((x) => x.state === "open").length, answered: answeredQ, expired: qs.filter((x) => x.state === "expired-unanswered").length,
      labels_per_answer: answeredQ ? Math.round((h.answered / answeredQ) * 100) / 100 : null },
    drift: { score: d.score, signature: d.signature, via: d.via }, queue: { open: q.asked.length, head: q.head.map((x) => x.key), via: q.via },
    labels: { n: h.n, closures: h.closures, survived_edit: h.survived_edit, backfilled: h.backfilled, answered: h.answered, defect_rate: h.defect_rate }, proposals: { counted: p.rows.length, past_bar: p.rows.filter((x) => x.state !== "counted").length, via: p.via },
    python: expert.available() ? expert.pythonName() : null };
  gs.mirror({ status });
  return status;
}

/** What the hook records on every tool call: sixty bytes, no decision. The
 *  hook imports `detect` and `store` directly and calls this same pair; this
 *  export is the CLI's and the tests' way in. */
export function observeTool(payload) { return detect.observeTool(payload); }

function render(s) {
  out(`  grapple  phase ${s.phase}${s.python ? `  expert ${s.python}` : "  no interpreter: fallback order"}`);
  out(`  brief    ${s.brief || "none active"}`);
  out(`  lanes    ${s.collisions} collision(s)`);
  out(`  drift    ${s.drift.score} (${s.drift.signature}, ${s.drift.via})`);
  out(`  queue    ${s.queue.open} open, next ${s.queue.head.join(", ") || "-"} (${s.queue.via})`);
  out(`  asked    ${s.questions.answered} answered, ${s.questions.expired} expired unanswered; ${s.questions.labels_per_answer ?? "-"} label(s) per answer`);
  out(`  labels   n=${s.labels.n}: ${s.labels.closures} closure(s), ${s.labels.survived_edit} survived an edit, ${s.labels.backfilled} backfilled, ${s.labels.answered} answered; defect rate ${s.labels.defect_rate}`);
  out(`  earned   ${s.proposals.past_bar} of ${s.proposals.counted} class(es) past the bar (${s.proposals.via})`);
  out(`  files    ${gs.DIR()}`);
}

async function cmd({ _, flags }) {
  const sub = _[0] || "status";
  const cfg = load();
  const g = settings(cfg);
  if (sub === "observe" || sub === "status") {
    const s = observe({ session: String(flags.session || ""), cfg });
    if (flags.json) emitJson(s); else render(s);
    return 0;
  }
  if (sub === "ask") {
    if (flags.reopen) {
      const r = gs.reopen(String(flags.reopen));
      if (!r) { out(`  ${flags.reopen} is not an expired question`); return 1; }
      gs.mirror();
      out(`  reopened ${flags.reopen}`);
      return 0;
    }
    if (flags.answer) {
      const r = ask.answer(String(flags.answer), { value: String(flags.value || "yes"), reason: String(flags.reason || "") });
      if (r.error) { out(`  ${r.error}`); return 1; }
      gs.mirror();
      if (flags.json) emitJson(r); else out(`  answered ${flags.answer} = ${r.answer.value}; reaches ${r.reaches} row(s)`);
      return 0;
    }
    const rec = brief.current({ maxAgeMin: Number(cfg.wire?.brief_max_age_min) || 45, sessionId: String(flags.session || "") });
    const q = ask.emit({ rec, cap: g.ask_per_session });
    gs.mirror();
    if (flags.json) { emitJson(q); return 0; }
    if (!q.asked.length) { out("  nothing to ask: every unsettled item has a live answer"); return 0; }
    out(table(q.asked.slice(0, Number(flags.limit) || 20).map((x) => [x.key, x.shape, String(x.reaches || 1), String(x.ev ?? "-"), String(x.text || "").slice(0, 90)]), { header: ["key", "shape", "reaches", "ev", "question"] }).split("\n").map((l) => "  " + l).join("\n"));
    out(`  ${q.asked.length} open (${q.via}); answer one: bb grapple ask --answer <key> --value yes|no --reason "..."`);
    return 0;
  }
  if (sub === "ratify") {
    const id = _[1] || "";
    if (id) {
      const p = ratify.current();
      if (!p || p.id !== id) { out(`  no open proposal ${id}; run bb grapple ratify for the current one`); return 1; }
      const split = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
      const r = ratify.decide(p, { confirm: split(flags.confirm), reject: split(flags.reject), reason: String(flags.reason || "") });
      gs.mirror();
      if (flags.json) emitJson(r); else out(`  ${r.confirmed.length} confirmed, ${r.rejected.length} rejected, ${r.untouched.length} left open; ${r.labels} label(s)`);
      return 0;
    }
    const rec = brief.current({ maxAgeMin: Number(cfg.wire?.brief_max_age_min) || 45 });
    const p = ratify.propose({ open: Object.keys(rec?.seen?.reads || {}), batch: g.ratify_batch });
    if (flags.json) emitJson(p); else out(ratify.render(p));
    return 0;
  }
  if (sub === "harvest") {
    const h = harvest.run({ minLabels: g.min_labels });
    if (flags.json) emitJson(h); else out(`  n=${h.n} label(s): ${h.closures} closure(s), ${h.survived_edit} survived an edit, ${h.git_unanswerable} git could not answer; defect rate ${h.defect_rate}`);
    return 0;
  }
  if (sub === "backfill") {
    const rev = String(_[1] || flags.rev || "");
    if (!rev) { out("  bb grapple backfill <rev>   — scan at that commit, label each contested row by what git did to it since"); return 1; }
    const r = harvest.backfill({ rev, log: (m) => out(`  ${m}`) });
    if (r.error) { out(`  ${r.error}`); return 1; }
    if (flags.json) emitJson(r); else out(`  ${rev}: ${r.then} contested row(s) then, ${r.n} label(s) now (${r.unchanged} untouched since, ${r.unanswerable} git could not answer)`);
    return 0;
  }
  if (sub === "priors") {
    if (flags.fit) {
      const r = harvest.fit();
      if (flags.json) emitJson(r); else out(`  fitted ${Object.keys(r.by).length} detector(s) from ${r.n} label(s); ${gs.DIR()}/priors.json (copy it to ${harvest.SHIPPED()} to ship it)`);
      return 0;
    }
    const p = harvest.priors();
    if (flags.json) { emitJson(p); return 0; }
    if (!Object.keys(p.by).length) { out("  no priors: bb grapple priors --fit"); return 0; }
    out(`  priors: ${p.via}${p.from ? ` (fitted on ${p.from}, ${p.at})` : ""}`);
    out(table(Object.entries(p.by).map(([k, v]) => [k, String(v.held), String(v.broken), String(v.n), String(v.hold_rate ?? "-")]), { header: ["detector", "defect", "not", "n", "hold rate"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }
  if (sub === "promote") {
    const p = promote.run({ phase: g.phase });
    if (flags.json) emitJson(p); else out(`  ${p.rows.filter((x) => x.state !== "counted").length} of ${p.rows.length} class(es) past the bar (${p.via}); ${gs.DIR()}/proposals.md`);
    return 0;
  }
  out(`  unknown grapple verb ${sub}`);
  return 1;
}

export const commands = {
  grapple: {
    help: "the handoff layer: what the box cannot settle, asked once and stored (0 tokens)",
    usage: "bb grapple [observe|status|ask|ratify|harvest|promote|backfill <rev>|priors] [--json]",
    long: [
      "  bb grapple observe             every detector once; records, injects nothing",
      "  bb grapple ask                 the queue, pattern questions first",
      "  bb grapple ask --answer <key> --value yes|no --reason \"...\"   |   ask --reopen <key>",
      "  bb grapple ratify              one batched proposal; then ratify <id> --confirm k,k --reject k,k",
      "  bb grapple harvest             labels from closures and edit-conditioned survival, with n",
      "  bb grapple promote             what the event log has earned, in lathe's row shape",
      "  bb grapple backfill <rev>      scan at an old commit; label each contested row by what git did since",
      "  bb grapple priors [--fit]      the fitted prior per contested detector, local or shipped",
      "",
      "Two key shapes: an INSTANCE answer is about one place and expires when its fingerprint moves;",
      "a PATTERN answer is about a shape and reaches every row of it. The queue asks tens of questions,",
      "not one per row. `grapple.phase` is observe by default: nothing blocks and nothing is injected",
      "until the base rates exist.",
    ].join("\n"),
    run: cmd,
  },
};
