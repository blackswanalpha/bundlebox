//! stray — the work landed outside the located scope.
//!
//! `converge` asks whether the scope has stopped MOVING. It can settle on the
//! wrong files and converge just as confidently, because agreeing with itself
//! is not the same as being right. This one asks the other question: of the
//! files a session actually edited after being handed a scope, how many were in
//! it?
//!
//! Both halves of that are already on disk and nothing compared them. A brief
//! records the scope it located; a transcript records every edit. The share
//! that fell outside is the locator's own error rate, measured per task, for
//! the cost of a read.
//!
//! Three things keep it honest:
//!
//!   - One window per BRIEF, not per session. A session locates several tasks,
//!     and pooling them lets a well-located task pay for a badly-located one.
//!   - An edit made through the shell carries no path, so it is counted on
//!     neither side. A write this box cannot name is not evidence of aim.
//!   - Edits before the first brief are ignored: there is nothing to have
//!     strayed from yet.
use super::{Event, Finding, Thresholds};

/// One brief and the edits that followed it, up to the next brief.
pub struct Window {
    pub session: String,
    pub scope: Vec<String>,
    pub inn: usize,
    pub out: usize,
    pub strayed: Vec<String>,
}

pub fn windows(grouped: &[(String, Vec<&Event>)]) -> Vec<Window> {
    let mut out: Vec<Window> = Vec::new();
    for (session, events) in grouped {
        let mut cur: Option<Window> = None;
        for e in events {
            if e.kind == "brief" && !e.scope.is_empty() {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
                cur = Some(Window { session: session.clone(), scope: e.scope.clone(), inn: 0, out: 0, strayed: Vec::new() });
                continue;
            }
            let w = match cur.as_mut() {
                Some(w) => w,
                None => continue,
            };
            if e.kind != "edit" || e.file.is_empty() {
                continue;
            }
            if w.scope.contains(&e.file) {
                w.inn += 1;
            } else {
                w.out += 1;
                if !w.strayed.contains(&e.file) {
                    w.strayed.push(e.file.clone());
                }
            }
        }
        if let Some(w) = cur.take() {
            out.push(w);
        }
    }
    out
}

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let wins = windows(grouped);
    let scored: Vec<&Window> = wins.iter().filter(|w| w.inn + w.out >= th.stray_edits).collect();
    if scored.len() < th.stray_briefs {
        return vec![Finding::unknown(
            "stray",
            &format!("{} brief(s) followed by {} or more edits to a named file; {} are needed before a locator's aim is a measurement rather than one odd task. A shell write carries no path and is counted on neither side.", scored.len(), th.stray_edits, th.stray_briefs),
        )];
    }
    let inn: usize = scored.iter().map(|w| w.inn).sum();
    let off: usize = scored.iter().map(|w| w.out).sum();
    let share = off as f64 / (inn + off) as f64;
    if share < th.stray_share {
        return vec![Finding::ok(
            "stray",
            &format!("the locator is landing: {} of {} edited file(s) across {} brief(s) fell outside the scope that was handed over ({:.2}, under {}).", off, inn + off, scored.len(), share, th.stray_share),
        )];
    }
    // The worst window, first one on a tie, so both implementations name the
    // same brief for the same stream.
    let mut worst = scored[0];
    for w in &scored {
        if w.out > worst.out {
            worst = w;
        }
    }
    let shown: Vec<String> = worst.strayed.iter().take(8).cloned().collect();
    let more = if worst.strayed.len() > shown.len() {
        format!(", +{} more", worst.strayed.len() - shown.len())
    } else {
        String::new()
    };
    vec![Finding {
        id: "stray",
        verdict: "hit",
        session: worst.session.clone(),
        support: scored.len(),
        severity: "medium",
        detail: format!(
            "{} of {} edits across {} brief(s) went to files the brief never named ({:.2}, at or over {}). The located scope is not where the work is, so every session it is handed to pays to find that out again. Worst brief located {} file(s) and the work touched {}{}.",
            off, inn + off, scored.len(), share, th.stray_share, worst.scope.len(), shown.join(", "), more
        ),
        evidence: vec![
            format!("briefs={}", scored.len()),
            format!("in_scope={}", inn),
            format!("strayed={}", off),
            format!("share={:.3}", share),
            format!("threshold={}", th.stray_share),
            format!("min_edits={}", th.stray_edits),
            format!("worst_scope={}", worst.scope.join(",")),
            format!("worst_strayed={}", worst.strayed.join(",")),
        ],
    }]
}
