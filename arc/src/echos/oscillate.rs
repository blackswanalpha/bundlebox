//! oscillate — a file returning to a value it already had.
//!
//! Distinct from spinning, and worse. A session that edits `a.js` to A, then to
//! B, then back to A has not made a mistake it can see: each edit was
//! reasonable when it was made. What it has done is pay for three edits and
//! land where it started, and the only way to know that is to have kept the
//! hashes.
//!
//! This box already keeps them. Every edit event carries a content hash, so a
//! return is an exact equality test against a value this file has held before —
//! never a similarity score, because "nearly the same" is a normal refactor and
//! reporting it would bury the real thing.
//!
//! Counted per FILE and per session. Across sessions is a different claim: a
//! file that goes back to last week's value may be a revert somebody decided
//! on, and this echo has no way to tell that from thrash.
use super::{Event, Finding, Thresholds};

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut looked = 0usize;
    for (session, events) in grouped {
        // file -> (hashes seen in order, how many times it came back)
        let mut seen: Vec<(String, Vec<String>, usize)> = Vec::new();
        for e in events {
            if e.kind != "edit" || e.file.is_empty() || e.hash.is_empty() {
                continue;
            }
            looked += 1;
            let i = match seen.iter().position(|(f, _, _)| *f == e.file) {
                Some(i) => i,
                None => { seen.push((e.file.clone(), Vec::new(), 0)); seen.len() - 1 }
            };
            let (_, hashes, flips) = &mut seen[i];
            // Only a RETURN counts: the same hash arriving twice in a row is one
            // edit the harness reported twice, not a round trip.
            if hashes.last().map(|h| h == &e.hash).unwrap_or(false) {
                continue;
            }
            if hashes.iter().any(|h| h == &e.hash) {
                *flips += 1;
            }
            hashes.push(e.hash.clone());
        }
        for (file, hashes, flips) in seen {
            if flips < th.oscillate_flips {
                continue;
            }
            out.push(Finding {
                id: "oscillate",
                verdict: "hit",
                session: session.clone(),
                support: flips,
                severity: if flips >= th.oscillate_flips * 2 { "high" } else { "medium" },
                detail: format!(
                    "{} came back to a value it already had {} time(s) across {} edit(s) in one session. Each edit was paid for and the file is where it started; something in the work is undoing itself.",
                    file, flips, hashes.len()
                ),
                evidence: vec![format!("file={}", file), format!("returns={}", flips), format!("distinct_states={}", hashes.len()), format!("threshold={}", th.oscillate_flips)],
            });
        }
    }
    if looked == 0 {
        return vec![Finding::unknown("oscillate", "no edit event carries a content hash; nothing can say whether a file came back to a value it had")];
    }
    if out.is_empty() {
        out.push(Finding::ok("oscillate", &format!("no file returned to an earlier value {} times in one session", th.oscillate_flips)));
    }
    out
}
