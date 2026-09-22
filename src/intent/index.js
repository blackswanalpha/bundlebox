// intent/index.js — which KIND of unit a prompt is, decided from a table.
//
//   behaviour labels the past -> a table is fitted offline -> the table decides
//   at prompt time, deterministically, and hands back its own derivation.
//
// What the decision buys. `kind` does exactly one thing in this tree: it picks
// the output reserve (`reserve_by_kind` in config, read by `reserveFor` in
// src/compile/context.js), and `capacity()` spends whatever the reserve leaves
// on scope. The shipped table reserves 12k for a fix and 40k for an
// investigation, so the label swings ~28k of window between room-to-write and
// code-to-read. Until this file existed `autoPinpoint` passed "fix" for every
// prompt. That is not a default: it is a wrong answer on every question asked,
// billed on every turn, and it arrives as a pile of files the turn will not
// open next to a reserve too small for the answer it will actually write.
//
// Why no model runs here. Jev is remote, probabilistic and allowed to fail —
// every failure path in src/grapple/jev.js returns null. A decision that waits
// on it is neither deterministic nor fast enough for a hook that runs on every
// turn against a 0.47s budget. So the guessing happens at FIT time, at session
// end, and what reaches the prompt path is arithmetic over a stored table.
// Same prompt plus same table gives the same kind, every time, offline.
//
// Why the derivation comes back. `triage()` in src/detectors/index.js settled
// this shape already: the rules are data, and the steps are returned, not
// hidden. A budget decision that cannot say why it chose is one nobody can
// argue with when it is wrong, and this one is wrong today on every question.
import fs from "node:fs";
import path from "node:path";
import * as store from "../core/store.js";
import * as expert from "../core/expert.js";
import { VAR } from "../core/paths.js";
import { load } from "../core/config.js";
import { out, emit } from "../core/log.js";
import { table } from "../core/util.js";
import { promptFeatures } from "../wire/hooks.js";
import * as jev from "../grapple/jev.js";

/** The five kinds `bb pinpoint --kind` accepts and `reserve_by_kind` budgets.
 *  Mirrored by `KINDS` in expert/bundlebox_expert/model.py. */
export const KINDS = ["fix", "verify", "investigate", "build", "write"];

/** What a prompt is when the table cannot say. Today's hardcoded value, kept
 *  deliberately: a fallback that changes behaviour is a second decision nobody
 *  fitted, and "no table yet" must cost exactly what it costs now. */
export const FALLBACK = "fix";

/** The window either side of the brief that counts as this prompt's work.
 *  `taskRows` in src/wire/hooks.js uses the same 60s and for the same reason:
 *  a transcript timestamp and a brief timestamp are written by two processes. */
const GRACE_MS = 60000;

/** What a one-vs-rest head has to say before its kind is taken as the answer.
 *  Below it the head is saying "not mine", which is not a vote for whatever
 *  else happens to be fitted. */
export const DECIDE_AT = 0.5;

export const HEAD = () => path.join(VAR, "intent-head.json");

const PROSE = /\.(md|mdx|txt|rst|adoc)$/i;
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const same = (a, b) => Object.keys({ ...a, ...b }).every((k) => Math.abs(Number(a[k] || 0) - Number(b[k] || 0)) < 1e-6);

let _head;
/** The fitted table, with `drift` set when its probes disagree with the
 *  featurizer this process computes.
 *
 *  The table is fitted by Python and read by JavaScript, so the two sides
 *  compute `prompt_featurize`/`promptFeatures` independently and can drift
 *  apart in a commit that touches one. A drifted table is not a slightly worse
 *  table, it is weights indexed by features that no longer mean what they meant
 *  when they were fitted, so it is dropped whole. */
export function head() {
  if (_head !== undefined) return _head;
  try {
    const h = JSON.parse(fs.readFileSync(HEAD(), "utf8"));
    if (h && typeof h === "object") h.drift = (h.probes || []).some((pr) => !same(pr.features || {}, promptFeatures(pr.prompt)));
    _head = h && typeof h === "object" ? h : null;
  } catch { _head = null; }
  return _head;
}
export const resetHead = () => { _head = undefined; };

/** The kind of this prompt, and the steps that got there.
 *
 *  Pure: a table, a string, some arithmetic. No clock, no network, no disk
 *  beyond the one cached read. Every path returns a kind — there is no failure
 *  mode where the caller has to invent a budget. */
export function classify(prompt, { head: h = head() } = {}) {
  const steps = [];
  const s = String(prompt || "");
  const fall = (why) => { steps.push(why); steps.push(`kind ${FALLBACK} (the shipped default)`); return { kind: FALLBACK, p: null, via: "default", scores: {}, steps }; };
  if (!h) return fall("no table on disk; one is fitted at session end (bb intent fit)");
  if (h.drift) return fall("table dropped: its probes disagree with promptFeatures(), so its weights index features that have changed");
  if (!h.useful) return fall(`table not useful: ${h.why || "no kind beat its base rate"}`);

  const x = promptFeatures(s);
  const scores = {};
  for (const k of KINDS) {
    const kh = h.kinds?.[k];
    if (!kh || !kh.useful) continue;
    scores[k] = Math.round(sigmoid(Object.entries(x).reduce((a, [f, v]) => a + (Number(kh.weights?.[f]) || 0) * v, 0)) * 1000) / 1000;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return fall("every kind's head is below its base rate; none may decide");
  steps.push(`${ranked.length} of ${KINDS.length} kinds may decide: ${ranked.map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // Each head answers "is it THIS kind", so the top score is only a decision
  // when it says yes. Argmax alone would hand every prompt to whichever kind
  // happened to be fitted — with one useful head that is every prompt, however
  // certain that head is that the answer is no.
  const won = ranked.filter(([, v]) => v >= DECIDE_AT);
  if (!won.length) return fall(`no kind claims this prompt (best ${ranked[0][0]} at ${ranked[0][1]}, below ${DECIDE_AT})`);

  const [kind, p] = won[0];
  const n = h.by_kind?.[kind] ?? 0;
  const acc = h.kinds?.[kind] || {};
  steps.push(`argmax ${kind} at ${p} (fitted on ${n} rows, holdout accuracy ${acc.accuracy} against base ${acc.base_accuracy})`);
  const opinion = h.by_via?.jev || 0;
  if (opinion) steps.push(`${opinion} of ${h.n} rows in this table were split by Jev, not proven by a transcript`);
  return { kind, p, via: "table", scores, steps };
}

// ── labelling the past ──────────────────────────────────────────────────────

/** What a session turned out to be, from what it did after its brief.
 *
 *  Four of the five kinds are visible here. The fifth is the whole reason this
 *  file talks to Jev at all: a `verify` session runs a suite and reads the
 *  output, and src/echos/index.js only emits an event for a Bash call when
 *  `writesFiles` says it wrote one. A test run leaves no trace in the stream,
 *  so behaviour cannot tell verify from investigate — both are "read, never
 *  wrote". Everything else it can prove:
 *
 *    no write at all                     investigate
 *    writes, all to prose files          write
 *    writes to files never read first    build   (you do not read a file that
 *                                                 does not exist yet)
 *    anything else                       fix
 *
 *  A shell write carries no path (`file: ""`), so it can never count toward
 *  `build`: the honest outcome is that a `sed -i` looks like a fix. */
export function behaviourLabel(events) {
  const ev = events || [];
  const edits = ev.filter((e) => e.kind === "edit");
  const reads = ev.filter((e) => e.kind === "read");
  if (!edits.length) return { kind: "investigate", via: "behaviour", why: `${reads.length} read(s), nothing written` };

  const named = edits.filter((e) => e.file);
  if (named.length && named.every((e) => PROSE.test(e.file))) {
    return { kind: "write", via: "behaviour", why: `${named.length} write(s), all prose` };
  }
  const firstRead = new Map();
  for (const r of reads) if (r.file && !firstRead.has(r.file)) firstRead.set(r.file, r.at || 0);
  const firstEdit = new Map();
  for (const e of named) if (!firstEdit.has(e.file)) firstEdit.set(e.file, e.at || 0);
  const fresh = [...firstEdit].filter(([f, at]) => !firstRead.has(f) || firstRead.get(f) > at);
  if (named.length && fresh.length > named.length / 2) {
    return { kind: "build", via: "behaviour", why: `${fresh.length} of ${firstEdit.size} file(s) written without being read first` };
  }
  return { kind: "fix", via: "behaviour", why: `${edits.length} write(s) over ${firstEdit.size || "unnamed"} file(s) that were read first` };
}

/** The join the table trains on: every prompt the hook located, against what
 *  that session went on to do. Both sides are already on disk. A session whose
 *  transcript this box cannot see is unlabelled, not a negative, so it is not
 *  a row — the same rule `taskRows` follows for the same reason. */
export async function rows() {
  const echos = await import("../echos/index.js");
  const brief = await import("../wire/brief.js");
  const t = echos.transcriptEvents({});
  const bySession = new Map();
  for (const e of t.events) {
    if (!e.session) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  // Each brief's window ends where the next brief in that session begins.
  // Without the upper bound every prompt in a session inherits the whole
  // session's behaviour, so one fix at the end labels the nine questions before
  // it `fix` too — which is the exact mistake this table exists to stop, moved
  // from the prompt path into the training data where it would be invisible.
  const logged = brief.logged({}).filter((r) => r.session_id && r.problem);
  const nextAt = new Map();
  const bySessionBriefs = new Map();
  for (const r of logged) {
    const sid = String(r.session_id);
    if (!bySessionBriefs.has(sid)) bySessionBriefs.set(sid, []);
    bySessionBriefs.get(sid).push(r);
  }
  for (const list of bySessionBriefs.values()) {
    list.sort((a, b) => (Date.parse(a.at || "") || 0) - (Date.parse(b.at || "") || 0));
    for (let i = 0; i < list.length - 1; i++) nextAt.set(list[i], Date.parse(list[i + 1].at || "") || Infinity);
  }

  const rs = [];
  for (const r of logged) {
    const sid = String(r.session_id);
    const ev = bySession.get(sid);
    if (!ev) continue;
    const at = Date.parse(r.at || "") || 0;
    const until = nextAt.get(r) ?? Infinity;
    const window = ev.filter((e) => (e.at || 0) >= at - GRACE_MS && (e.at || 0) < until);
    // A prompt whose window holds nothing at all is unlabelled, not an
    // investigation: the session may simply have ended, or the transcript may
    // stop here. `investigate` has to be a session that looked and chose not to
    // write, which is a different claim from a session that did nothing.
    if (!window.length) continue;
    rs.push({ prompt: String(r.problem), at: r.at || "", session: sid, ...behaviourLabel(window) });
  }
  return { rows: rs, unseen: t.unseen || [] };
}

/** The one split behaviour cannot make, asked of Jev once per candidate row.
 *
 *  Only `investigate` rows are asked, because those are the ones that read and
 *  never wrote, and a verify session is hiding among exactly those. A row Jev
 *  does not answer for stays `investigate`: the fallback is the behaviour
 *  label, never a guess. Rows it does move are stamped `via: "jev"` so the
 *  fitted table can report how much of itself rests on an opinion.
 *
 *  This runs at fit time. Nothing on the prompt path waits on it. */
export function splitVerify(rs, { ask = jev.probabilities, threshold = 0.65 } = {}) {
  const cand = rs.filter((r) => r.kind === "investigate" && r.prompt);
  // `available()` gates the DEFAULT asker only. A caller that hands its own in
  // has already decided that one can answer, and a test is exactly that caller.
  const live = ask !== jev.probabilities || jev.available();
  if (!cand.length || !live) return { asked: 0, answered: 0, moved: 0, available: jev.available() };
  let asked = 0, answered = 0, moved = 0;
  for (const batch of chunk(cand)) {
    const state = batch.map((r, i) => `### p${i}\n${r.prompt}`).join("\n\n");
    const questions = {};
    for (let i = 0; i < batch.length; i++) {
      questions[`p${i}`] = { type: "noul", instructions: `Prompt p${i} asks for existing behaviour to be CHECKED or PROVEN — a test run, a build, a verification that something still holds — rather than explained, described or investigated.` };
    }
    asked += batch.length;
    const r = ask(state, questions);
    if (!r) continue;
    for (let i = 0; i < batch.length; i++) {
      const p = r.by[`p${i}`];
      if (typeof p !== "number") continue;
      answered++;
      if (p >= threshold) { batch[i].kind = "verify"; batch[i].via = "jev"; batch[i].why = `Jev puts P(verify) at ${p}`; batch[i].p = p; moved++; }
    }
  }
  return { asked, answered, moved, available: true };
}

/** Batches whose prompts fit under Jev's state ceiling. A batch that would
 *  overflow is split, never truncated: half a prompt is a different question. */
function chunk(rs, ceiling = jev.STATE_TOKENS) {
  const batches = [];
  let cur = [], spent = 0;
  for (const r of rs) {
    const cost = Math.ceil(String(r.prompt).length / 3);
    if (cur.length && spent + cost > ceiling) { batches.push(cur); cur = []; spent = 0; }
    cur.push(r);
    spent += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Fit the table and write it, useful or not: a table that says "n=7, need 12"
 *  is what `bb intent` prints, and `FALLBACK` keeps deciding until it says
 *  otherwise. Same contract as `fitTaskHead`. */
export async function fit({ write = true, useJev = true } = {}) {
  const { rows: rs, unseen } = await rows();
  const split = useJev ? splitVerify(rs) : { asked: 0, answered: 0, moved: 0, available: jev.available() };
  const m = expert.call("model-train-intent", { rows: rs });
  if (!m) return { useful: false, n: rs.length, why: expert.lastError || "python3 required", jev: split };
  m.fitted_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  m.unseen = unseen.length;
  m.sessions = new Set(rs.map((r) => r.session)).size;
  m.jev = split;
  if (write) { try { fs.writeFileSync(HEAD(), JSON.stringify(m)); } catch { /* the next session end writes it */ } }
  resetHead();
  return m;
}

/** What the table decided for one session, so the calibrator can group by it.
 *
 *  `reserveSamples` in src/tokens/calibrate.js groups measured output tokens by
 *  the kind of unit that ran, and a prompt-located session is not a unit — no
 *  lane packed it, so it has no episode and no kind. Without this row the
 *  reserve table can only ever be checked against the sessions a lane ran,
 *  which are the `fix` ones, which is the half of the table nobody doubted. */
export function record({ session_id = "", kind = "", p = null, via = "" } = {}) {
  if (!session_id || !kind) return null;
  const row = { at: new Date().toISOString(), session_id: String(session_id), kind: String(kind), p, via: String(via) };
  try { store.append("intent", row); } catch { return null; }
  return row;
}

// ── bb intent ───────────────────────────────────────────────────────────────

function headText(h) {
  if (!h) return "  no table yet. It is fitted at session end, or now with `bb intent fit`.";
  const lines = [`  INTENT — ${h.n ?? 0} labelled rows over ${h.sessions ?? "?"} sessions, fitted ${h.fitted_at || "?"}`, ""];
  if (h.drift) lines.push("  ! this table is DROPPED: its probes disagree with promptFeatures(). Refit it.", "");
  lines.push(table(KINDS.map((k) => {
    const kh = h.kinds?.[k] || {};
    return [k, String(h.by_kind?.[k] ?? 0), kh.useful ? "yes" : "no", String(kh.accuracy ?? "—"), String(kh.base_accuracy ?? "—"), String(kh.auc ?? "—"), kh.useful ? "" : (kh.why || "")];
  }), { header: ["kind", "rows", "decides", "acc", "base", "auc", "why not"] }).split("\n").map((l) => "  " + l).join("\n"));
  const via = h.by_via || {};
  lines.push("", `  labels: ${via.behaviour || 0} proven by transcript, ${via.jev || 0} split by Jev${h.jev && !h.jev.available ? " (Jev off: no TYPESAFE_API_KEY)" : ""}`);
  if (!h.useful) lines.push(`  nothing decides yet: ${h.why}. Every prompt gets \`${FALLBACK}\`, as before.`);
  return lines.join("\n");
}

async function cmd({ _, flags }) {
  const sub = _[0] || "";
  if (sub === "fit") {
    const m = await fit({ useJev: flags.jev !== false });
    if (flags.json) { emit(m); return m.useful ? 0 : 0; }
    out(headText(m.kinds ? m : head()));
    if (m.jev && m.jev.asked) out(`  jev: asked ${m.jev.asked}, answered ${m.jev.answered}, moved ${m.jev.moved} to verify`);
    if (!m.kinds) out(`  ${m.why}`);
    return 0;
  }
  if (sub === "rows") {
    const { rows: rs } = await rows();
    if (flags.json) { emit({ rows: rs }); return 0; }
    out(table(rs.slice(0, 40).map((r) => [r.at.slice(0, 19), r.kind, r.via, r.prompt.replace(/\s+/g, " ").slice(0, 48)]),
      { header: ["at", "kind", "via", "prompt"] }).split("\n").map((l) => "  " + l).join("\n"));
    return 0;
  }
  const q = _.join(" ").trim();
  if (q) {
    const r = classify(q);
    if (flags.json) { emit(r); return 0; }
    const cfg = load();
    const reserve = cfg.budget?.reserve_by_kind?.[r.kind] ?? cfg.budget?.reserve_output;
    out(`  ${r.kind}  (${r.via}${r.p == null ? "" : `, p ${r.p}`})   reserves ${reserve} tokens for output`);
    for (const s of r.steps) out(`    ${s}`);
    return 0;
  }
  const h = head();
  if (flags.json) { emit(h || { useful: false }); return 0; }
  out(headText(h));
  return 0;
}

export const commands = {
  intent: {
    help: "what KIND of unit a prompt is, and the table that decides it (0 model tokens)",
    usage: "bb intent [\"<prompt>\"] | bb intent fit [--no-jev] | bb intent rows [--json]",
    long: [
      "  bb intent              the fitted table: rows per kind, which kinds may decide, accuracy against base",
      "  bb intent \"<prompt>\"   the kind this prompt gets, the reserve that buys, and the derivation",
      "  bb intent fit          refit from the transcripts on disk and write the table",
      "  bb intent rows         the join the table trains on: prompt -> what that session actually did",
      "",
      "`kind` picks the output reserve, and the reserve is what is NOT spent on scope: 12k for a fix,",
      "40k for an investigation. Before this table every located prompt was passed `fix`, so a question",
      "arrived with ~28k of file content it would not open and under a third of the room it needed.",
      "",
      "The table is fitted at session end from what sessions did, not from what a model thought they",
      "meant: no write is an investigation, writes to files that were never read first are a build.",
      "Only verify is invisible that way — a test run that writes nothing leaves no event — and that",
      "is the one split Jev is asked to make, offline, on rows that are already labelled. Nothing on",
      "the prompt path waits on a network call, and the same prompt against the same table always",
      "gets the same kind.",
    ].join("\n"),
    run: cmd,
  },
};
