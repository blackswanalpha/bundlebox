//! arc — the bundlebox index compiler.
//!
//! `arc <op>` reads one JSON object on stdin and writes one JSON object on
//! stdout. Exit 0 on success, 2 on a bad op or bad input. Nothing else ever
//! reaches stdout. Same contract as the kernel's `bbk`, so `src/core/kernel.js`
//! drives both through one bridge and every caller keeps a JavaScript fallback.
//!
//! What it compiles and why: `bb`'s PreToolUse search guard asks "is this name
//! declared, and where" on every tool call a session makes. The answer is
//! already on disk as six `symbols-*.md` tables — about 20,000 lines here — and
//! answering from them costs a full read plus a regex per line, per tool call,
//! to return at most fourteen rows. `arc build` turns them into one binary
//! index; `arc lookup` answers exact, prefix and suffix queries with two binary
//! searches and no full read.
mod index;
mod json;

use std::io::{Read, Write};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const OPS: &[&str] = &["version", "build", "lookup", "stat"];

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn op_build(input: &json::Json) -> json::Json {
    let t0 = Instant::now();
    let out = input.string("out", "");
    let tables = input.str_list("tables");
    let mut o = json::Json::obj();
    if out.is_empty() || tables.is_empty() {
        o.set("error", "build needs { out, tables: [path...] }".into());
        return o;
    }
    let mut rows: Vec<index::Row> = Vec::new();
    let mut read = Vec::new();
    for t in &tables {
        match std::fs::read_to_string(t) {
            Ok(text) => {
                let n = rows.len();
                rows.extend(index::parse_table(&text));
                read.push((t.clone(), rows.len() - n));
            }
            // A table that is not there is not an error: the set of tables is
            // whatever snapgen has built, and it grows.
            Err(_) => continue,
        }
    }
    match index::build(&out, &rows, now()) {
        Ok((count, bytes)) => {
            o.set("symbols", (count as f64).into());
            o.set("bytes", (bytes as f64).into());
            o.set(
                "tables",
                json::Json::Arr(
                    read.into_iter()
                        .map(|(t, n)| {
                            let mut r = json::Json::obj();
                            r.set("table", t.into());
                            r.set("symbols", (n as f64).into());
                            r
                        })
                        .collect(),
                ),
            );
            o.set("ms", (t0.elapsed().as_secs_f64() * 1000.0).into());
        }
        Err(e) => {
            o.set("error", format!("{}", e).into());
        }
    }
    o
}

fn op_lookup(input: &json::Json) -> json::Json {
    let t0 = Instant::now();
    let path = input.string("index", "");
    let terms = input.str_list("terms");
    let under = input.string("under", "");
    let cap = input.num("cap", 14.0).max(1.0) as usize;
    // `shapes` is what the caller will accept: the guard uses exact, prefix and
    // suffix, and asking for fewer is how a caller keeps a lookup precise.
    let shapes = {
        let s = input.str_list("shapes");
        if s.is_empty() { vec!["exact".to_string(), "prefix".to_string(), "suffix".to_string()] } else { s }
    };
    let mut o = json::Json::obj();
    let mut reader = match index::Reader::open(&path) {
        Ok(r) => r,
        Err(e) => {
            o.set("error", format!("{}: {}", path, e).into());
            return o;
        }
    };
    let want = |k: &str| shapes.iter().any(|s| s == k);
    let mut ids: Vec<u32> = Vec::new();
    for term in &terms {
        let t = term.to_lowercase();
        if t.is_empty() {
            continue;
        }
        // Prefix subsumes exact, so it is one walk when both are wanted.
        if want("prefix") || want("exact") {
            if let Ok(v) = reader.prefix(&t, false, cap * 4) {
                ids.extend(v);
            }
        }
        if want("suffix") {
            if let Ok(v) = reader.prefix(&t, true, cap * 4) {
                ids.extend(v);
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    let mut hits = Vec::new();
    for id in ids {
        let Ok(row) = reader.row(id) else { continue };
        let low = row.symbol.to_lowercase();
        // The exact-only caller gets exactly that; the walk above was wider.
        if !want("prefix") && !want("suffix") && !terms.iter().any(|t| t.to_lowercase() == low) {
            continue;
        }
        if !under.is_empty() && !row.file.starts_with(&under) {
            continue;
        }
        let mut r = json::Json::obj();
        r.set("symbol", row.symbol.into());
        r.set("file", row.file.into());
        r.set("line", (row.line as f64).into());
        hits.push(r);
        if hits.len() >= cap {
            break;
        }
    }
    o.set("hits", json::Json::Arr(hits));
    o.set("symbols", (reader.count as f64).into());
    o.set("ms", (t0.elapsed().as_secs_f64() * 1000.0).into());
    o
}

fn op_stat(input: &json::Json) -> json::Json {
    let path = input.string("index", "");
    let mut o = json::Json::obj();
    match index::Reader::open(&path) {
        Ok(r) => {
            o.set("symbols", (r.count as f64).into());
            o.set("pool_bytes", (r.pool_len as f64).into());
            o.set("built", (r.built as f64).into());
            o.set("age_seconds", ((now().saturating_sub(r.built)) as f64).into());
        }
        Err(e) => {
            o.set("error", format!("{}: {}", path, e).into());
        }
    }
    o
}

fn main() {
    let op = std::env::args().nth(1).unwrap_or_default();
    if op == "version" {
        println!("arc {} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::ARCH);
        return;
    }
    if op.is_empty() || op == "help" || op == "--help" {
        eprintln!("arc <op>  ops: {}", OPS.join(" "));
        std::process::exit(if op.is_empty() { 2 } else { 0 });
    }
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        eprintln!("arc: could not read stdin");
        std::process::exit(2);
    }
    let input = match json::parse(if raw.trim().is_empty() { "{}" } else { &raw }) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("arc: bad input json: {}", e);
            std::process::exit(2);
        }
    };
    let out = match op.as_str() {
        "build" => op_build(&input),
        "lookup" => op_lookup(&input),
        "stat" => op_stat(&input),
        _ => {
            eprintln!("arc: unknown op {}. ops: {}", op, OPS.join(" "));
            std::process::exit(2);
        }
    };
    let mut so = std::io::stdout();
    let _ = so.write_all(out.to_string().as_bytes());
    let _ = so.write_all(b"\n");
    let _ = so.flush();
    if out.get("error").is_some() {
        std::process::exit(2);
    }
}
