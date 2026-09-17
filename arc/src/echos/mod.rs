//! echos — the agents that watch the work instead of the tree.
//!
//! Every detector in this box reads the SOURCE: what is on disk, what it
//! imports, how long it is. None of them could answer the other question, which
//! is whether the work being done to that source is going anywhere. A session
//! that has run `npm test` eleven times, edited one file back to what it was an
//! hour ago and grown its window by 40k tokens without changing a line is a
//! session in trouble, and nothing here could see it.
//!
//! An echo is what comes back off the work. Six of them, and they are borrowed
//! deliberately: the stagnation family (spin, oscillate, drift, diminishing) is
//! from Ouroboros, where the same four patterns gate an evolution loop, and the
//! convergence rule is its ontology-similarity stop condition. What is new here
//! is the input — this box already records every one of those signals as a
//! by-product of running, so an echo costs a read and never a model call.
//!
//! In Rust, in `arc`, for the reason `arc` exists at all: this runs over every
//! event a workspace has ever recorded, which on this box is tens of thousands
//! of rows, and it runs at session end where the budget is seconds. The JS side
//! (`src/echos/index.js`) carries an identical fallback so a box with no
//! compiled binary still gets the answer, and `bb echos --json` is the contract
//! both implement.
//!
//! Every echo obeys the same three rules as everything else here:
//!
//!   1. A shape with too little support is not reported. Each threshold is an
//!      input, printed with the result, never a constant hidden in the code.
//!   2. Something that cannot be measured returns `unknown`, never `ok`.
//!   3. Every finding names the evidence that produced it, so it can be argued
//!      with rather than believed.
use crate::json::Json;

mod batching;
mod converge;
mod diminishing;
mod drift;
mod oscillate;
mod spin;
mod stray;

/// One event, as the JS side hands it over. Flat on purpose: this is a stream
/// of tens of thousands of rows and a nested shape would cost a parse per row
/// for fields most echos never read.
#[derive(Clone, Debug, Default)]
pub struct Event {
    /// Milliseconds since the epoch. 0 when the row carried no readable time.
    pub at: f64,
    pub session: String,
    /// What happened: "shape" (a command ran), "edit", "read", "turn", "brief".
    pub kind: String,
    /// The command shape, for `kind == "shape"`.
    pub shape: String,
    /// The path, for an edit or a read.
    pub file: String,
    /// A content hash, for an edit. This is what makes oscillation visible.
    pub hash: String,
    /// Window or output tokens, for `kind == "turn"`.
    pub tokens: f64,
    /// Tool calls this turn made, for `kind == "turn"`. Every call, not only the
    /// ones that produced an event: a Grep is a round trip exactly as a Read is.
    pub tools: f64,
    /// The located scope, for `kind == "brief"`: which files the work is about.
    pub scope: Vec<String>,
    /// Does this command's answer depend on something outside this tree?
    ///
    /// Set by the JS feed, which owns the vocabulary (`src/echos/index.js`).
    /// A `gh pr` or a `curl` run six times is a session WAITING for a remote to
    /// change, and `spin`'s claim — that the same question cannot return a
    /// different answer — is false for it. The event still counts as a command
    /// run, because it was one; only the repeat rule ignores it.
    pub polls: bool,
}

impl Event {
    fn from(v: &Json) -> Event {
        Event {
            at: v.num("at", 0.0),
            session: v.string("session", ""),
            kind: v.string("kind", ""),
            shape: v.string("shape", ""),
            file: v.string("file", ""),
            hash: v.string("hash", ""),
            tokens: v.num("tokens", 0.0),
            tools: v.num("tools", 0.0),
            scope: v.str_list("scope"),
            polls: v.get("polls").and_then(|x| x.as_bool()).unwrap_or(false),
        }
    }
}

/// The thresholds, all of them, with the shipped defaults. Read off the input
/// so `bb echos --json` can print exactly what decided each verdict.
#[derive(Clone, Debug)]
pub struct Thresholds {
    pub spin_repeats: usize,
    pub oscillate_flips: usize,
    pub drift_turns: usize,
    pub diminishing_ratio: f64,
    pub converge_similarity: f64,
    pub converge_runs: usize,
    /// Share of edited files outside the located scope before `stray` reports.
    pub stray_share: f64,
    /// Edits to a named file a brief needs before its window is scored at all.
    pub stray_edits: usize,
    /// Scored windows needed before an aim is a measurement, not one odd task.
    pub stray_briefs: usize,
    /// Calls per turn at or under which a session is reported as serial.
    pub batching_ratio: f64,
    /// Calls a session needs before its ratio is a habit and not its shape.
    pub batching_calls: usize,
    /// Sessions over the call floor before a pooled ratio is a habit.
    pub batching_sessions: usize,
}

impl Thresholds {
    pub fn from(v: &Json) -> Thresholds {
        Thresholds {
            spin_repeats: v.num("spin_repeats", 4.0).max(2.0) as usize,
            oscillate_flips: v.num("oscillate_flips", 3.0).max(2.0) as usize,
            drift_turns: v.num("drift_turns", 12.0).max(2.0) as usize,
            diminishing_ratio: v.num("diminishing_ratio", 1.6).max(1.0),
            converge_similarity: v.num("converge_similarity", 0.95).clamp(0.0, 1.0),
            converge_runs: v.num("converge_runs", 3.0).max(2.0) as usize,
            stray_share: v.num("stray_share", 0.5).clamp(0.0, 1.0),
            stray_edits: v.num("stray_edits", 4.0).max(1.0) as usize,
            stray_briefs: v.num("stray_briefs", 2.0).max(1.0) as usize,
            batching_ratio: v.num("batching_ratio", 1.5).max(1.0),
            batching_calls: v.num("batching_calls", 20.0).max(1.0) as usize,
            batching_sessions: v.num("batching_sessions", 3.0).max(1.0) as usize,
        }
    }
    fn to_json(&self) -> Json {
        let mut o = Json::obj();
        o.set("spin_repeats", (self.spin_repeats as f64).into());
        o.set("oscillate_flips", (self.oscillate_flips as f64).into());
        o.set("drift_turns", (self.drift_turns as f64).into());
        o.set("diminishing_ratio", self.diminishing_ratio.into());
        o.set("converge_similarity", self.converge_similarity.into());
        o.set("converge_runs", (self.converge_runs as f64).into());
        o.set("stray_share", self.stray_share.into());
        o.set("stray_edits", (self.stray_edits as f64).into());
        o.set("stray_briefs", (self.stray_briefs as f64).into());
        o.set("batching_ratio", self.batching_ratio.into());
        o.set("batching_calls", (self.batching_calls as f64).into());
        o.set("batching_sessions", (self.batching_sessions as f64).into());
        o
    }
}

/// What one echo found. `verdict` is `ok`, `hit` or `unknown`, and the third is
/// not a soft pass: it is the answer for an echo whose input was not there, and
/// printing it as `ok` would be reporting that nothing was wrong when nothing
/// was checked.
#[derive(Clone, Debug)]
pub struct Finding {
    pub id: &'static str,
    pub verdict: &'static str,
    pub session: String,
    pub support: usize,
    pub severity: &'static str,
    pub detail: String,
    pub evidence: Vec<String>,
}

impl Finding {
    pub fn unknown(id: &'static str, why: &str) -> Finding {
        Finding { id, verdict: "unknown", session: String::new(), support: 0, severity: "info", detail: why.to_string(), evidence: Vec::new() }
    }
    pub fn ok(id: &'static str, why: &str) -> Finding {
        Finding { id, verdict: "ok", session: String::new(), support: 0, severity: "info", detail: why.to_string(), evidence: Vec::new() }
    }
    fn to_json(&self) -> Json {
        let mut o = Json::obj();
        o.set("id", self.id.into());
        o.set("verdict", self.verdict.into());
        o.set("session", self.session.clone().into());
        o.set("support", (self.support as f64).into());
        o.set("severity", self.severity.into());
        o.set("detail", self.detail.clone().into());
        o.set("evidence", Json::Arr(self.evidence.iter().map(|e| Json::Str(e.clone())).collect()));
        o
    }
}

/// A token count a person can read. 33374161 in a sentence is a number nobody
/// checks; 33.4M is one they can. Mirrors `human` in src/core/util.js closely
/// enough for prose, which is the only place either is used.
pub fn human(n: f64) -> String {
    let a = n.abs();
    if a >= 1e9 { format!("{:.1}B", n / 1e9) }
    else if a >= 1e6 { format!("{:.1}M", n / 1e6) }
    else if a >= 1e3 { format!("{:.1}k", n / 1e3) }
    else { format!("{}", n.round() as i64) }
}

/// Events grouped by session, each in the order they happened.
///
/// Order is the whole point of every echo here — a count cannot tell `test then
/// edit` from `edit then test` — so rows with no readable time keep the order
/// they arrived in rather than being dropped or sorted to the front.
pub fn by_session(events: &[Event]) -> Vec<(String, Vec<&Event>)> {
    let mut keys: Vec<String> = Vec::new();
    let mut groups: Vec<Vec<&Event>> = Vec::new();
    for e in events {
        let key = if e.session.is_empty() { "unknown".to_string() } else { e.session.clone() };
        match keys.iter().position(|k| *k == key) {
            Some(i) => groups[i].push(e),
            None => { keys.push(key); groups.push(vec![e]); }
        }
    }
    for g in groups.iter_mut() {
        // A stable sort: equal or missing timestamps keep arrival order, which
        // for an append-only log IS the order.
        g.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    }
    keys.into_iter().zip(groups).collect()
}

/// The registry. Adding an echo is one line here and one file beside this one,
/// which is the same shape `src/detectors/index.js` uses for the tree-side
/// detectors — one place that lists what runs, so nothing can be written and
/// silently never called.
type Echo = fn(&[(String, Vec<&Event>)], &Thresholds) -> Vec<Finding>;
pub const REGISTRY: &[(&str, Echo)] = &[
    ("spin", spin::run),
    ("oscillate", oscillate::run),
    ("drift", drift::run),
    ("diminishing", diminishing::run),
    ("converge", converge::run),
    ("stray", stray::run),
    ("batching", batching::run),
];

pub fn names() -> Vec<&'static str> { REGISTRY.iter().map(|(n, _)| *n).collect() }

/// `arc echos` — one JSON object in, one out. Same contract as every other op.
pub fn op(input: &Json) -> Json {
    let t0 = std::time::Instant::now();
    let events: Vec<Event> = input
        .get("events")
        .and_then(|v| v.as_arr())
        .map(|a| a.iter().map(Event::from).collect())
        .unwrap_or_default();
    let th = Thresholds::from(input.get("thresholds").unwrap_or(&Json::Null));
    let only = input.str_list("only");

    let grouped = by_session(&events);
    let mut findings: Vec<Finding> = Vec::new();
    for (name, run) in REGISTRY {
        if !only.is_empty() && !only.iter().any(|o| o == name) {
            continue;
        }
        findings.extend(run(&grouped, &th));
    }

    let mut o = Json::obj();
    o.set("echos", Json::Arr(findings.iter().map(Finding::to_json).collect()));
    o.set("events", (events.len() as f64).into());
    o.set("sessions", (grouped.len() as f64).into());
    o.set("thresholds", th.to_json());
    o.set("registry", Json::Arr(names().iter().map(|n| Json::Str(n.to_string())).collect()));
    o.set("hits", (findings.iter().filter(|f| f.verdict == "hit").count() as f64).into());
    o.set("ms", (t0.elapsed().as_secs_f64() * 1000.0).into());
    o
}
