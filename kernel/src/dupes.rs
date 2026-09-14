//! Duplicate blocks as file PAIRS with a union-of-covered-lines count.
//! Normalise (strip comments, blank string contents, collapse whitespace),
//! 8-line sliding windows hashed, files with a distinct-line ratio under 0.25
//! skipped (data tables and generated code duplicate legitimately).
use crate::json::Json;
use crate::sha1::sha1;
use std::collections::{BTreeMap, BTreeSet, HashMap};
#[allow(unused_imports)]
use std::collections::BTreeSet as _BTreeSet;
use std::fs;

fn strip_strings(s: &str) -> String {
    // "..." -> "", '...' -> '', `...` -> `` with backslash escapes honoured, as the JS regexes do.
    let cs: Vec<char> = s.chars().collect(); let mut out = String::new(); let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '"' || c == '\'' || c == '`' {
            let mut j = i + 1; let mut closed = false;
            while j < cs.len() { if cs[j] == '\\' { j += 2; continue; } if cs[j] == c { closed = true; break; } j += 1; }
            if closed { out.push(c); out.push(c); i = j + 1; continue; }
        }
        out.push(c); i += 1;
    }
    out
}
/// The JS `normalise()` exactly: strip string contents, strip comments (`#` for
/// hash-comment languages, else `//` and `/* */`), remove ALL whitespace, drop
/// empty and trivial punctuation-only lines. Two implementations that differ
/// would report different findings depending on whether the kernel is present.
pub fn normalise(line: &str, hash_comment: bool) -> String {
    let mut l = strip_strings(line);
    if hash_comment { if let Some(i) = l.find('#') { l.truncate(i); } }
    else {
        if let Some(i) = l.find("//") { l.truncate(i); }
        while let (Some(a), Some(b)) = (l.find("/*"), l.find("*/")) { if b > a { l.replace_range(a..b + 2, ""); } else { break; } }
    }
    let t: String = l.chars().filter(|c| !c.is_whitespace()).collect();
    if t.is_empty() || t.chars().all(|c| "{}()[];,".contains(c)) { String::new() } else { t }
}

pub fn op_dupes(input: &Json) -> Json {
    let win = input.num("window", 8.0) as usize;
    let min_shared = input.num("min_shared_lines", 24.0) as usize;
    let min_distinct = input.num("min_distinct_ratio", 0.25);
    let mut index: HashMap<String, Vec<(usize, usize)>> = HashMap::new(); // hash -> (file idx, line)
    let files = input.str_list("paths");
    let hash_langs = input.str_list("hash_comment_paths");
    let is_hash: std::collections::BTreeSet<&String> = hash_langs.iter().collect();
    let mut kept: Vec<usize> = Vec::new();
    let mut norm: Vec<Vec<(usize, String)>> = Vec::new();
    for (fi, p) in files.iter().enumerate() {
        let text = match fs::read(p) { Ok(b) => String::from_utf8_lossy(&b).to_string(), Err(_) => { norm.push(vec![]); continue; } };
        let hc = is_hash.contains(p);
        let lines: Vec<(usize, String)> = text.lines().enumerate().map(|(i, l)| (i + 1, normalise(l, hc))).filter(|(_, l)| !l.is_empty()).collect();
        if lines.len() >= win {
            let distinct: BTreeSet<&String> = lines.iter().map(|(_, l)| l).collect();
            if (distinct.len() as f64) / (lines.len() as f64) >= min_distinct { kept.push(fi); }
        }
        norm.push(lines);
    }
    for &fi in &kept {
        let lines = &norm[fi];
        for i in 0..=lines.len() - win {
            let joined: Vec<&str> = lines[i..i + win].iter().map(|(_, l)| l.as_str()).collect();
            let h = sha1(joined.join("\n").as_bytes());
            index.entry(h).or_default().push((fi, i));
        }
    }
    // pair -> covered normalised-line indexes on each side, plus the first shared window
    let mut pairs: BTreeMap<(usize, usize), (BTreeSet<usize>, BTreeSet<usize>, (usize, usize))> = BTreeMap::new();
    for locs in index.values() {
        if locs.len() < 2 { continue; }
        for a in 0..locs.len() { for b in a + 1..locs.len() {
            let (fa, ia) = locs[a]; let (fb, ib) = locs[b];
            if fa == fb { continue; }
            let (k, la, lb) = if fa < fb { ((fa, fb), ia, ib) } else { ((fb, fa), ib, ia) };
            let e = pairs.entry(k).or_insert_with(|| (BTreeSet::new(), BTreeSet::new(), (la, lb)));
            for x in 0..win { e.0.insert(la + x); e.1.insert(lb + x); }
            if la < e.2 .0 { e.2 = (la, lb); }
        } }
    }
    let mut out_pairs = Vec::new();
    for ((fa, fb), (ca, cb, (la, lb))) in pairs {
        let shared = ca.len() + cb.len();
        if shared < min_shared { continue; }
        let mut o = Json::obj();
        o.set("a", files[fa].clone().into()); o.set("b", files[fb].clone().into());
        o.set("shared_lines", shared.into());
        o.set("a_line", norm[fa][la].0.into()); o.set("b_line", norm[fb][lb].0.into());
        o.set("a_end", norm[fa][(la + win - 1).min(norm[fa].len() - 1)].0.into());
        o.set("window", Json::Arr(norm[fa][la..la + win].iter().map(|(_, l)| Json::from(l.clone())).collect()));
        out_pairs.push(o);
    }
    out_pairs.sort_by(|x, y| y.num("shared_lines", 0.0).partial_cmp(&x.num("shared_lines", 0.0)).unwrap());
    let mut out = Json::obj();
    out.set("pairs", Json::Arr(out_pairs)); out.set("files_considered", kept.len().into());
    out
}
