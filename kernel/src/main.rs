//! bbk — the bundlebox kernel. `bbk <op>` reads one JSON object on stdin and
//! writes one JSON object on stdout. Exit 0 on success, 2 on a bad op or bad
//! input. Never prints anything else on stdout.
mod json; mod sha1; mod walk; mod fingerprint; mod estimate; mod dupes; mod symbols; mod gate; mod worktree;
use std::io::{Read, Write};

const OPS: &[&str] = &["version", "walk", "fingerprint", "estimate", "dupes", "symbols", "anchor", "gate", "worktree", "worktree-prune", "sha1"];

fn main() {
    let op = std::env::args().nth(1).unwrap_or_default();
    if op == "version" { println!("bbk {} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::ARCH); return; }
    if op.is_empty() || op == "help" || op == "--help" { eprintln!("bbk <op>  ops: {}", OPS.join(" ")); std::process::exit(if op.is_empty() { 2 } else { 0 }); }
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() { eprintln!("bbk: could not read stdin"); std::process::exit(2); }
    let input = match json::parse(if raw.trim().is_empty() { "{}" } else { &raw }) { Ok(v) => v, Err(e) => { eprintln!("bbk: bad input json: {}", e); std::process::exit(2); } };
    let out = match op.as_str() {
        "walk" => walk::op_walk(&input),
        "fingerprint" => fingerprint::op_fingerprint(&input),
        "estimate" => estimate::op_estimate(&input),
        "dupes" => dupes::op_dupes(&input),
        "symbols" => symbols::op_symbols(&input),
        "anchor" => symbols::op_anchor(&input),
        "gate" => gate::op_gate(&input),
        "worktree" => worktree::op_worktree(&input),
        "worktree-prune" => worktree::op_worktree_prune(&input),
        "sha1" => { let mut o = json::Json::obj(); o.set("sha1", sha1::sha1(input.string("text", "").as_bytes()).into()); o }
        _ => { eprintln!("bbk: unknown op {}. ops: {}", op, OPS.join(" ")); std::process::exit(2); }
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.to_string().as_bytes());
    let _ = stdout.write_all(b"\n");
}
