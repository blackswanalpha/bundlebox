//! converge — the work has stopped moving, and that is the good outcome.
//!
//! The other four echos report trouble. This one reports a STOP condition, and
//! it is the piece the rest of the loop was missing: `bb pinpoint` locates a
//! task and writes a brief with a scope; run it again and again on the same
//! problem and the scope either keeps moving — the problem is not understood —
//! or it settles on the same handful of files. Once it has settled, re-locating
//! is a cost with no information in it.
//!
//! The rule is Ouroboros's ontology-convergence test with the scope standing in
//! for the ontology: Jaccard similarity between consecutive briefs, and
//! convergence declared when it holds at or above the threshold for N
//! consecutive pairs. N and not one pair, because two briefs agreeing once is
//! how any two locates of the same sentence behave.
//!
//! Reported as a `hit` like the others, because the action it implies is just
//! as concrete: stop re-locating and start closing. A loop with no stop
//! condition runs until somebody gets bored, which is not a budget.
use super::{Event, Finding, Thresholds};

/// Jaccard over two file sets: shared / union. The scope is a set of paths and
/// this is the measure for sets — no weighting by size, because a brief naming
/// six files and one naming five that are all in the six is the same work.
pub fn similarity(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let shared = a.iter().filter(|x| b.contains(x)).count() as f64;
    let union = (a.len() + b.len()) as f64 - shared;
    if union <= 0.0 { 0.0 } else { shared / union }
}

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    // Across sessions, not within one. A brief is written once per task prompt,
    // so the interesting sequence is the workspace's, not a session's, and the
    // question is whether successive attempts at the same work are landing in
    // the same place.
    let mut briefs: Vec<&Event> = Vec::new();
    for (_, events) in grouped {
        for e in events {
            if e.kind == "brief" && !e.scope.is_empty() {
                briefs.push(e);
            }
        }
    }
    briefs.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    if briefs.len() < th.converge_runs + 1 {
        return vec![Finding::unknown(
            "converge",
            &format!("{} brief(s) with a scope on file; {} consecutive pairs are needed before convergence is a measurement rather than a coincidence", briefs.len(), th.converge_runs),
        )];
    }

    let mut streak = 0usize;
    let mut best = 0usize;
    let mut sims: Vec<f64> = Vec::new();
    let mut at: Option<&Event> = None;
    for w in briefs.windows(2) {
        let s = similarity(&w[0].scope, &w[1].scope);
        sims.push(s);
        if s >= th.converge_similarity {
            streak += 1;
            if streak > best { best = streak; at = Some(w[1]); }
        } else {
            streak = 0;
        }
    }
    if best < th.converge_runs {
        let last = sims.last().copied().unwrap_or(0.0);
        return vec![Finding::ok(
            "converge",
            &format!("the located scope is still moving: {} consecutive pair(s) at or above {}, {} needed. Last pair {:.2}.", best, th.converge_similarity, th.converge_runs, last),
        )];
    }
    let e = at.unwrap_or(briefs[briefs.len() - 1]);
    vec![Finding {
        id: "converge",
        verdict: "hit",
        session: e.session.clone(),
        support: best,
        severity: "info",
        detail: format!(
            "the last {} briefs located the same {} file(s) — similarity at or above {} every time. Re-locating this work is no longer producing information; what is left is closing it. The scope is: {}.",
            best + 1, e.scope.len(), th.converge_similarity, e.scope.join(", ")
        ),
        evidence: vec![
            format!("briefs={}", briefs.len()),
            format!("streak={}", best),
            format!("threshold={}", th.converge_similarity),
            format!("runs_needed={}", th.converge_runs),
            format!("scope={}", e.scope.join(",")),
        ],
    }]
}
