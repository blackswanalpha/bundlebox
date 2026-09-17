//! batching — one tool call per turn, which is one round trip per fact.
//!
//! This is the one term of the Dream-RSI replay objective that had no count
//! here. Its score rewards a policy for the attempts it runs per decision round
//! rather than one at a time, and `bb uptake` already names the same thing as a
//! rule this workspace measured itself needing — "serial-turns-want-batching:
//! one tool per turn is one round trip per fact". Named, advised, never
//! measured.
//!
//! What a turn costs is not the call. It is the window: re-sent, re-read, and
//! paid again before the next fact arrives. Two independent calls in one turn
//! cost one of those; the same two in sequence cost two.
//!
//! Pooled across sessions and reported ONCE, because it is a habit and not an
//! incident. The first version filed one finding per session and on this
//! workspace that was 22 of 22 — a list in which every row says the same thing
//! is a list nobody reads. `diminishing` reports per session only because it
//! judges each one against the workspace median; an absolute bar has no such
//! filter and needs this one instead.
//!
//! Two things keep it from overclaiming:
//!
//!   - A turn that called no tool is thinking or answering, not a failure to
//!     batch. It is in neither the numerator nor the denominator.
//!   - The ratio a session CAN reach is bounded by how much of its work is
//!     independent — a read whose path comes out of the previous result cannot
//!     move earlier. So a low ratio is evidence worth looking at and never
//!     proof of waste, and the bar is an input like every other.
use super::{Event, Finding, Thresholds};

struct Row {
    session: String,
    turns: usize,
    calls: usize,
    ratio: f64,
}

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let mut per: Vec<Row> = Vec::new();
    for (session, events) in grouped {
        let mut turns = 0usize;
        let mut calls = 0usize;
        for e in events {
            if e.kind != "turn" {
                continue;
            }
            let n = if e.tools > 0.0 { e.tools as usize } else { 0 };
            if n == 0 {
                continue;
            }
            turns += 1;
            calls += n;
        }
        if calls >= th.batching_calls {
            per.push(Row { session: session.clone(), turns, calls, ratio: calls as f64 / turns as f64 });
        }
    }
    if per.len() < th.batching_sessions {
        return vec![Finding::unknown(
            "batching",
            &format!("{} session(s) have made {} or more tool calls with a recorded turn count; {} are needed before a ratio is a habit rather than one session's shape", per.len(), th.batching_calls, th.batching_sessions),
        )];
    }
    let calls: usize = per.iter().map(|r| r.calls).sum();
    let turns: usize = per.iter().map(|r| r.turns).sum();
    let pooled = calls as f64 / turns as f64;
    if pooled > th.batching_ratio {
        return vec![Finding::ok(
            "batching",
            &format!("{} tool call(s) over {} turn(s) across {} session(s) — {:.2} per turn, over {}", calls, turns, per.len(), pooled, th.batching_ratio),
        )];
    }
    // Lowest ratio, then most calls, then first seen: both implementations have
    // to name the same session for the same stream.
    let mut worst = &per[0];
    for r in &per {
        if r.ratio < worst.ratio || (r.ratio == worst.ratio && r.calls > worst.calls) {
            worst = r;
        }
    }
    vec![Finding {
        id: "batching",
        verdict: "hit",
        session: worst.session.clone(),
        support: calls,
        severity: "low",
        detail: format!(
            "{} tool call(s) over {} turn(s) that made one, across {} session(s) — {:.2} per turn, at or under {}. Every turn is a round trip: the window is re-sent and re-read before the next fact arrives, so two independent calls cost one turn together and two apart. Worst session {} call(s) over {} turn(s) at {:.2}.",
            calls, turns, per.len(), pooled, th.batching_ratio, worst.calls, worst.turns, worst.ratio
        ),
        evidence: vec![
            format!("calls={}", calls),
            format!("turns={}", turns),
            format!("ratio={:.2}", pooled),
            format!("sessions={}", per.len()),
            format!("worst={:.2}", worst.ratio),
            format!("threshold={}", th.batching_ratio),
            format!("min_calls={}", th.batching_calls),
        ],
    }]
}
