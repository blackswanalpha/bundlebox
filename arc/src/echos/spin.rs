//! spin — the same command, again, with nothing changed in between.
//!
//! The cheapest failure in agent work to see and the easiest to miss from
//! inside it: `npm test` runs, fails, and runs again unchanged. Each run is a
//! tool result in the window, each result is re-sent on every later turn, and
//! none of them can produce a different answer because nothing between them
//! touched a file.
//!
//! The rule is deliberately narrow and that narrowness is the whole value. Two
//! filters, and both were measured on this box's own history.
//!
//! A repeat is only counted when NO edit happened between the two runs. `npm
//! test ; edit ; npm test` is how work is done and must never be reported;
//! `npm test ; npm test ; npm test` is a session waiting for a different answer
//! from the same question.
//!
//! And a repeat has to be a repeat. A command whose answer depends on
//! something outside this tree — `gh`, `curl`, a git subcommand that reaches a
//! remote — returns a different answer each time by design, and running it
//! again is waiting rather than spinning. A shape whose ARGUMENT selects what
//! it acts on (`git show <rev>`, `npm run <script>`) is a different command
//! each time for the same reason. Both are marked `polls` by the JS feed.
//!
//! And the shape has to NAME the work. A recorded shape drops the arguments, so
//! ten `cat`s in a row are ten different files and `grep` four times is four
//! different searches — the first run of this echo reported `cat x10`, `ls x8`
//! and `sed x4` as spinning, which is a description of reading. The JS side
//! filters those out before the events arrive (`record.names`), and the count
//! below is over what is left.
use super::{Event, Finding, Thresholds};

pub fn run(grouped: &[(String, Vec<&Event>)], th: &Thresholds) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut looked = 0usize;
    for (session, events) in grouped {
        let mut runs: Vec<(String, usize)> = Vec::new();   // shape -> consecutive, edit-free
        let mut last: Option<String> = None;
        let mut streak = 0usize;
        let mut edited_since = false;
        for e in events {
            if e.kind == "edit" {
                edited_since = true;
                continue;
            }
            if e.kind != "shape" || e.shape.is_empty() {
                continue;
            }
            // Counted before the `polls` check: a polled shape is still
            // evidence the recorder is working, and skipping it from the COUNT
            // as well as from the streak made a session of nothing but `gh pr`
            // report "no command shape has been recorded".
            looked += 1;
            // A command whose answer this box does not control is not spinning
            // when it repeats: it is polling. Every `spin` hit on this
            // workspace's first run was one — `gh pr` in four sessions, `curl`
            // in one — because the rule asked "did a file change between these
            // two runs" of a command that was never about a file.
            if e.polls {
                continue;
            }
            match &last {
                Some(prev) if *prev == e.shape && !edited_since => streak += 1,
                _ => { streak = 1; last = Some(e.shape.clone()); }
            }
            edited_since = false;
            if streak >= th.spin_repeats {
                match runs.iter_mut().find(|(s, _)| *s == e.shape) {
                    Some(r) => r.1 = r.1.max(streak),
                    None => runs.push((e.shape.clone(), streak)),
                }
            }
        }
        for (shape, n) in runs {
            out.push(Finding {
                id: "spin",
                verdict: "hit",
                session: session.clone(),
                support: n,
                severity: if n >= th.spin_repeats * 2 { "high" } else { "medium" },
                detail: format!(
                    "`{}` ran {} times in a row with no file edited between them. The same question cannot return a different answer, and every run of it is a tool result the window carries for the rest of the session.",
                    shape, n
                ),
                evidence: vec![format!("shape={}", shape), format!("consecutive={}", n), format!("threshold={}", th.spin_repeats)],
            });
        }
    }
    if looked == 0 {
        return vec![Finding::unknown("spin", "no command shape has been recorded; `lathe.record_shapes` writes them from the PostToolUse hook")];
    }
    if out.is_empty() {
        out.push(Finding::ok("spin", &format!("no command repeated {} times without an edit between", th.spin_repeats)));
    }
    out
}
