//! drift — turns passing and nothing changing.
//!
//! The quietest of the four, because it looks like work from inside: files are
//! being read, searches are running, the window is filling. What is not
//! happening is an edit. A session with thirty turns and no write is either
//! investigating — which is a legitimate kind of work and has a unit kind of
//! its own — or it is lost, and the difference is whether anybody asked for an
//! investigation.
//!
//! So this reports the SHAPE and not a judgement. It says how many turns went
//! by and how many files were opened without one being written, and it leaves
//! the reading of that to whoever knows what the session was for. An echo that
//! tried to guess the intent would be wrong on every investigate lane in the
//! workspace.
use super::{human, Event, Finding, Thresholds};

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut looked = 0usize;
    let mut dark = 0usize;
    for (session, events) in grouped {
        let turns = events.iter().filter(|e| e.kind == "turn").count();
        let edits = events.iter().filter(|e| e.kind == "edit").count();
        let reads = events.iter().filter(|e| e.kind == "read").count();
        let shapes = events.iter().filter(|e| e.kind == "shape").count();
        if turns == 0 {
            continue;
        }
        // A session whose transcript carries turns but NO tool use of any kind
        // is one this box could not look inside — some adapters record usage
        // without the call detail. Reporting "not one edit" there would be
        // reporting a zero for something that was never checked, which is the
        // one thing this tree does not print.
        if reads == 0 && shapes == 0 && edits == 0 {
            dark += 1;
            continue;
        }
        looked += 1;
        if edits > 0 || turns < th.drift_turns {
            continue;
        }
        // The window grew by this much for no change to the tree. It is the
        // number that makes the finding actionable rather than interesting.
        let window: f64 = events.iter().filter(|e| e.kind == "turn").map(|e| e.tokens).sum();
        out.push(Finding {
            id: "drift",
            verdict: "hit",
            session: session.clone(),
            support: turns,
            severity: if turns >= th.drift_turns * 2 { "medium" } else { "low" },
            detail: format!(
                "{} turns, {} file(s) opened, {} command(s) run, and not one edit. Either this is an investigation — which is a kind of work with its own budget — or the session is looking for something it is not going to find this way. {} tokens of window went by.",
                turns, reads, shapes, human(window)
            ),
            evidence: vec![
                format!("turns={}", turns),
                format!("reads={}", reads),
                format!("shells={}", shapes),
                format!("edits=0"),
                format!("window_tokens={}", window.round() as i64),
                format!("threshold={}", th.drift_turns),
            ],
        });
    }
    if looked == 0 {
        return vec![Finding::unknown(
            "drift",
            &format!("no session carries a tool call this box can read ({} had turns and nothing else); `bb tokens ledger` folds them off the transcripts", dark),
        )];
    }
    if out.is_empty() {
        out.push(Finding::ok("drift", &format!("every session of {} turns or more changed at least one file", th.drift_turns)));
    }
    if dark > 0 {
        out.push(Finding::unknown("drift", &format!("{} session(s) recorded turns but no tool call at all; they were not checked, which is not the same as passing", dark)));
    }
    out
}
