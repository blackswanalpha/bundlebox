//! diminishing — a session costing far more per change than this workspace's
//! sessions usually do.
//!
//! Every long session gets more expensive per unit of work, because the window
//! is re-sent on every turn and it only grows. That much is arithmetic and is
//! not a finding — and the first version of this echo measured exactly that.
//! An absolute threshold of 1.6 fired on 15 of 15 eligible sessions here, with
//! the ratios clustering between 1.62 and 3.25 around a median of 2.24. A rule
//! that fires on the middle of a distribution is describing the distribution.
//!
//! So the comparison is against the workspace itself, which is the move
//! `bb oversight` already makes when it says a file is "2.6x this tree's median
//! of 135", and the one `bb tokens calibrate` makes by fitting per repo instead
//! of shipping one box's constant. `diminishing_ratio` is a MULTIPLE OF THE
//! MEDIAN now: at the shipped 1.6 and a median of 2.24, a session has to reach
//! 3.58 before it is a finding, which is the tail rather than the body.
//!
//! Halves, not a regression. A fitted slope over a dozen turns is a number with
//! error bars nobody prints, and the decision it feeds is binary. Two halves
//! and a ratio can be checked by hand from the same evidence lines.
use super::{human, Event, Finding, Thresholds};

/// Edits each half needs before a per-edit cost is a rate rather than one
/// sample. Three, because two gives a ratio that one unusually large edit
/// decides.
const MIN_EDITS_PER_HALF: usize = 3;

/// Sessions needed before this workspace HAS a typical ratio. Below it there is
/// no median worth comparing against, and the answer is `unknown` rather than a
/// comparison against a constant somebody typed.
const MIN_SESSIONS: usize = 5;

struct Row {
    session: String,
    turns: usize,
    per_early: f64,
    per_late: f64,
    ratio: f64,
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if v.is_empty() {
        return 0.0;
    }
    let mid = v.len() / 2;
    if v.len() % 2 == 1 { v[mid] } else { (v[mid - 1] + v[mid]) / 2.0 }
}

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let mut rows: Vec<Row> = Vec::new();
    for (session, events) in grouped {
        let turns: Vec<&&Event> = events.iter().filter(|e| e.kind == "turn").collect();
        // Six turns is three per half, which is the fewest that can carry a
        // ratio worth printing.
        if turns.len() < 6 {
            continue;
        }
        let mid = turns.len() / 2;
        let cost = |slice: &[&&Event]| -> f64 { slice.iter().map(|e| e.tokens).sum() };
        let early_cost = cost(&turns[..mid]);
        let late_cost = cost(&turns[mid..]);
        // Changes are counted in the same two halves, by time, since an edit is
        // not a turn and the two streams interleave.
        let split_at = turns[mid].at;
        let edits_early = events.iter().filter(|e| e.kind == "edit" && e.at < split_at).count();
        let edits_late = events.iter().filter(|e| e.kind == "edit" && e.at >= split_at).count();
        // Three edits a half, not one. With one edit in a half the ratio is a
        // division by whatever that single edit happened to cost, and an early
        // run of this echo reported "7.7M tokens per edit" off a 355-turn
        // session with two edits in it — a true number describing drift rather
        // than diminishing returns. `drift` is the echo for that shape.
        if edits_early < MIN_EDITS_PER_HALF || edits_late < MIN_EDITS_PER_HALF || early_cost <= 0.0 {
            continue;
        }
        let per_early = early_cost / edits_early as f64;
        let per_late = late_cost / edits_late as f64;
        rows.push(Row { session: session.clone(), turns: turns.len(), per_early, per_late, ratio: per_late / per_early });
    }

    if rows.len() < MIN_SESSIONS {
        return vec![Finding::unknown(
            "diminishing",
            &format!(
                "{} session(s) carry six turns and three edits a half; {} are needed before this workspace has a typical cost per change to compare one against",
                rows.len(), MIN_SESSIONS
            ),
        )];
    }

    let mid = median(rows.iter().map(|r| r.ratio).collect());
    let bar = mid * th.diminishing_ratio;
    let mut out: Vec<Finding> = Vec::new();
    for r in rows.iter().filter(|r| r.ratio >= bar) {
        out.push(Finding {
            id: "diminishing",
            verdict: "hit",
            session: r.session.clone(),
            support: r.turns,
            severity: if r.ratio >= bar * 1.5 { "medium" } else { "low" },
            detail: format!(
                "the late half of this session cost {:.1}x the early half per file changed ({} tokens of window per edit, against {}) — {:.1}x what a session in this workspace usually does ({:.1}x, median of {}). Past that point the window IS the work: it is re-sent on every turn, so a fresh session with `bb pinpoint` on what is left starts at the brief instead of at everything read so far.",
                r.ratio, human(r.per_late), human(r.per_early), r.ratio / mid, mid, rows.len()
            ),
            evidence: vec![
                format!("turns={}", r.turns),
                format!("early_window_per_edit={}", r.per_early.round() as i64),
                format!("late_window_per_edit={}", r.per_late.round() as i64),
                format!("ratio={:.2}", r.ratio),
                format!("workspace_median={:.2}", mid),
                format!("bar={:.2}", bar),
                format!("multiple_of_median={}", th.diminishing_ratio),
            ],
        });
    }
    if out.is_empty() {
        out.push(Finding::ok(
            "diminishing",
            &format!("no session reached {:.1}x this workspace's median cost per change ({:.1}x over {} sessions)", bar, mid, rows.len()),
        ));
    }
    out
}
