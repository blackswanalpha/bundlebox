//! diminishing — the second half of a session costing more per change than the
//! first.
//!
//! Every long session gets more expensive per unit of work, because the window
//! is re-sent on every turn and it only grows. That much is arithmetic and is
//! not a finding. What IS a finding is the RATE: when the late half of a
//! session costs 1.6x the early half per file changed, the session has crossed
//! from doing work to carrying context, and the cheap move — which nothing in
//! this box will make for you — is to close it and open a new one with a brief.
//!
//! Halves, not a regression. A fitted slope over a dozen turns is a number with
//! error bars nobody prints, and the decision it feeds is binary. Two halves
//! and a ratio can be checked by hand from the same evidence lines.
use super::{human, Event, Finding, Thresholds};

/// Edits each half needs before a per-edit cost is a rate rather than one
/// sample. Three, because two gives a ratio that one unusually large edit
/// decides.
const MIN_EDITS_PER_HALF: usize = 3;

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut looked = 0usize;
    for (session, events) in grouped {
        let turns: Vec<&&Event> = events.iter().filter(|e| e.kind == "turn").collect();
        // Six turns is three per half, which is the fewest that can carry a
        // ratio worth printing.
        if turns.len() < 6 {
            continue;
        }
        looked += 1;
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
        // division by whatever that single edit happened to cost, and the first
        // run of this echo reported "7,685,770 tokens per edit" off a 355-turn
        // session with two edits in it — a true number that describes drift,
        // not diminishing returns. `drift` is the echo for that shape.
        if edits_early < MIN_EDITS_PER_HALF || edits_late < MIN_EDITS_PER_HALF || early_cost <= 0.0 {
            continue;
        }
        let per_early = early_cost / edits_early as f64;
        let per_late = late_cost / edits_late as f64;
        let ratio = per_late / per_early;
        if ratio < th.diminishing_ratio {
            continue;
        }
        out.push(Finding {
            id: "diminishing",
            verdict: "hit",
            session: session.clone(),
            support: turns.len(),
            severity: if ratio >= th.diminishing_ratio * 1.5 { "medium" } else { "low" },
            detail: format!(
                "the late half of this session cost {:.1}x the early half per file changed ({} tokens of window per edit, against {}). Past that point the window IS the work: it is re-sent on every turn, so a fresh session with `bb pinpoint` on what is left starts at the brief instead of at everything read so far.",
                ratio, human(per_late), human(per_early)
            ),
            evidence: vec![
                format!("turns={}", turns.len()),
                format!("early_window_per_edit={}", per_early.round() as i64),
                format!("late_window_per_edit={}", per_late.round() as i64),
                format!("ratio={:.2}", ratio),
                format!("threshold={}", th.diminishing_ratio),
            ],
        });
    }
    if looked == 0 {
        return vec![Finding::unknown("diminishing", "no session has six folded turns; there is no early half to compare a late half against")];
    }
    if out.is_empty() {
        out.push(Finding::ok("diminishing", &format!("no session's late half cost {}x its early half per change", th.diminishing_ratio)));
    }
    out
}
