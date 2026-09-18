// promote.js — the lathe pipe: grapple events in, lathe proposals out.
//
// Three things a repeated record earns:
//   detector   a clarification answered identically across enough units was
//              never uncertainty. Proposal only — ratify before it lands.
//   retire     an override recurring against one finding class retires the rule.
//   monitor    a drift signature recurring becomes a monitor dimension fitted
//              to this workspace.
//
// "Enough" is not a constant written here. The expert's `promote` blends the
// count through `confidence.py`'s SHRINKAGE, the documented answer to "three
// samples cannot override the method". Without an interpreter the counts are
// reported and nothing is promoted: a promotion this file decided on its own
// would be a second threshold.
//
// The blind spot, kept open on purpose: lathe can only promote from what
// grapple recorded, and grapple only records what it detected. `sample()` is
// the selective verification draw and it is OUTSIDE this pipe — a class with
// no detector is drawn as often as one with ten, whatever was promoted.
import { sha1, now } from "../core/util.js";
import * as expert from "../core/expert.js";
import * as gs from "./store.js";

/** The per-class counts, off the log, where support is DISTINCT UNITS and
 *  never events: an answer re-given for the same key is one opinion, a drift
 *  signature seen by one session on four observe passes is one session. A
 *  count that a repeated `bb grapple status` could raise is not evidence, and
 *  the SHRINKAGE bar downstream assumes it is. */
export function tally(events = gs.events()) {
  const answers = {}, overrides = {}, drifts = {};
  for (const e of events) {
    if (e.kind === "answered" && e.shape === "pattern") {
      const k = `${e.detector || ""}|${e.value}`;
      answers[k] = answers[k] || { detector: e.detector || "", value: e.value, keys: new Set(), question: e.question || "" };
      answers[k].keys.add(e.key);
    } else if (e.kind === "override") {
      const k = String(e.detector || e.class || "");
      overrides[k] = overrides[k] || { detector: k, keys: new Set() };
      overrides[k].keys.add(String(e.key || ""));
    } else if (e.kind === "drift") {
      const k = String(e.signature || "none");
      if (k === "none" || !e.session_id) continue;
      drifts[k] = drifts[k] || { signature: k, sessions: new Set() };
      drifts[k].sessions.add(String(e.session_id));
    }
  }
  const done = (o, field) => Object.values(o).map((x) => ({ ...x, [field]: undefined, support: x[field].size }));
  return {
    answers: done(answers, "keys").map((a) => ({ key: `${a.detector}=${a.value}`, detector: a.detector, value: a.value, support: a.support, question: a.question })),
    overrides: done(overrides, "keys"),
    drifts: done(drifts, "sessions"),
  };
}

/** Proposals in lathe's row shape — `items`, `support`, `confidence` — so the
 *  actuator that already reads that shape can read these. */
export function run({ events = gs.events(), phase = "observe" } = {}) {
  const t = tally(events);
  const r = expert.call("grapple", { op: "promote", tally: t });
  const via = r && Array.isArray(r.rows) ? "expert" : "fallback";
  const rows = via === "expert" ? r.rows : [
    ...t.answers.map((a) => ({ kind: "detector", items: [a.key, a.value], support: a.support, confidence: null, promote: false, why: "no interpreter: counts only" })),
    ...t.overrides.map((o) => ({ kind: "retire", items: [o.detector], support: o.support, confidence: null, promote: false, why: "no interpreter: counts only" })),
    ...t.drifts.map((d) => ({ kind: "monitor", items: [d.signature], support: d.support, confidence: null, promote: false, why: "no interpreter: counts only" })),
  ];
  // Nothing here applies anything. A detector proposal is ratified before it
  // lands, by design; the retire and monitor rows MAY auto-apply in phase 3
  // and no actuator for them exists yet, so past the bar they are `proposed`
  // and never claimed as done. `phase` is recorded so the file says what the
  // box was allowed to do when it wrote it.
  const out = rows.map((x) => ({ ...x, id: sha1(`${x.kind}:${(x.items || []).join(" ")}`).slice(0, 12), phase, state: x.promote ? "proposed" : "counted" }));
  gs.writeJsonOut("proposals.json", { at: now(), via, rows: out });
  gs.writeText("proposals.md", [
    "# grapple — what the log has earned", "", `${out.length} class(es) counted, ${out.filter((x) => x.state !== "counted").length} past the bar (${via}).`, "",
    "| state | kind | items | support | confidence | why |", "|---|---|---|---|---|---|",
    ...out.map((x) => `| ${x.state} | ${x.kind} | \`${(x.items || []).join(" ")}\` | ${x.support} | ${x.confidence ?? "-"} | ${x.why || ""} |`), "",
  ].join("\n"));
  gs.record("promoted", { rows: out.length, past_bar: out.filter((x) => x.state !== "counted").length, via });
  return { via, rows: out };
}

/** Selective verification: which failure class to sample this round.
 *
 *  A rotation over the FULL class list, keyed by round, so every class comes
 *  up once per `classes.length` rounds whether or not a detector exists for it
 *  and whatever was promoted in between. Deterministic: the same round draws
 *  the same class, and a test can assert the undetected one is reached. */
export function sample(classes, { round = 0, k = 1 } = {}) {
  const all = [...new Set((classes || []).map(String))].sort();
  if (!all.length) return [];
  const out = [];
  for (let i = 0; i < Math.min(k, all.length); i++) out.push(all[(round + i) % all.length]);
  return out;
}
