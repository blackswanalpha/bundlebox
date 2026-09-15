//! digest.rs — turn a log file into the twenty facts it actually contains,
//! reading only what arrived since the last call.
//!
//! A logcat buffer is forty thousand lines and about nine facts. Printing the
//! buffer costs a session; printing the nine facts costs nothing, and the
//! buffer is still on disk when a fact turns out to need its evidence. So the
//! digest never returns log lines by default — it returns SIGNATURES with
//! counts, plus the named failures this workspace has already paid to learn.
//!
//! Three things make it cheap, and they are the whole design:
//!
//! 1. **Offset reads.** A cursor per file means the second call reads only the
//!    bytes that arrived since the first. A 40,000-line log is read once.
//! 2. **A scanner, not a regex engine.** Normalisation erases everything that
//!    varies between two occurrences of one event — timestamps, pids, uuids,
//!    hex, numbers, quoted payloads, paths. Those are all recognisable from
//!    the character in hand plus a lookahead, so one pass over the line does
//!    it with no backtracking. This is the reason the op exists in Rust: the
//!    JavaScript version runs eight global regexes over every line, and at
//!    24,000 lines that is the runbook's whole cost.
//! 3. **Named failures.** A bucket matches the RAW line and arrives as one row
//!    saying what it is, rather than as a stack trace somebody has to
//!    recognise again. Buckets use the `rx` subset, so a corpus and a digest
//!    speak one pattern language.
use crate::json::Json;
use crate::rx;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

const MAX_SIGNATURE: usize = 140;
const DEFAULT_CAP: u64 = 8 * 1024 * 1024;
const DEFAULT_TOP: usize = 40;

/// A line's level, read from the shapes real logs use: logcat's single letter
/// between the pid pair and the tag, and the words uvicorn, node and python
/// print. Empty when the line does not say.
fn level_of(line: &str) -> char {
    let b = line.as_bytes();
    // logcat: `MM-DD HH:MM:SS.mmm  1234  5678 E Tag: message`
    let mut i = 0;
    let mut fields = 0;
    while i < b.len() && fields < 7 {
        while i < b.len() && b[i] == b' ' { i += 1; }
        let start = i;
        while i < b.len() && b[i] != b' ' { i += 1; }
        if i == start { break; }
        let f = &line[start..i];
        // The level sits after the timestamp and the pid/tid pair, so it is
        // never the first field. Requiring that rank is what keeps a message
        // beginning with a bare `E` from being read as an error level.
        if fields >= 2 && f.len() == 1 {
            let c = f.as_bytes()[0];
            if matches!(c, b'V' | b'D' | b'I' | b'W' | b'E' | b'F') { return c as char; }
        }
        if fields >= 2 && !f.bytes().all(|x| x.is_ascii_digit() || x == b'.' || x == b':' || x == b'-') && f.len() > 1 { break; }
        fields += 1;
    }
    let upper: String = line.chars().take(200).flat_map(|c| c.to_uppercase()).collect();
    if upper.contains("ERROR") || upper.contains("EXCEPTION") || upper.contains("TRACEBACK") { return 'E'; }
    if upper.contains("WARN") { return 'W'; }
    ' '
}

fn is_hex(c: u8) -> bool { c.is_ascii_hexdigit() }

/// Erase everything that differs between two occurrences of the same event.
///
/// One pass, no backtracking. Each branch is chosen from the byte in hand plus
/// a bounded lookahead, and every branch consumes at least one byte, so the
/// scanner is linear in the length of the line.
pub fn signature(line: &str) -> String {
    let b = line.as_bytes();
    let mut out = String::with_capacity(line.len().min(MAX_SIGNATURE + 8));
    let mut i = 0;
    let n = b.len();

    // Leading timestamps: `MM-DD HH:MM:SS.mmm`, `2026-09-15T10:15:00.123Z`,
    // `10:15:00.123`, and the `[...]` or `(...)` some loggers wrap them in.
    let skip_ts = |i: usize| -> usize {
        let mut j = i;
        if j < n && (b[j] == b'[' || b[j] == b'(') { j += 1; }
        let start = j;
        let mut digits = 0;
        let mut seps = 0;
        while j < n {
            match b[j] {
                c if c.is_ascii_digit() => { digits += 1; j += 1; }
                b'-' | b':' | b'.' | b'/' | b'T' | b',' | b'+' => { seps += 1; j += 1; }
                b' ' if seps > 0 && digits >= 4 && j + 1 < n && b[j + 1].is_ascii_digit() => { seps += 1; j += 1; }
                b'Z' if digits >= 6 => { j += 1; break; }
                _ => break,
            }
        }
        // A timestamp is at least six digits and two separators. Anything less
        // is a number the line is about, and erasing it would lose the fact.
        if digits >= 6 && seps >= 2 && j > start {
            if j < n && (b[j] == b']' || b[j] == b')') { j += 1; }
            j
        } else { i }
    };
    i = skip_ts(i);
    while i < n && b[i] == b' ' { i += 1; }

    // logcat puts `<pid> <tid>` between the timestamp and the level. Two long
    // integers side by side at the head of a line are never the fact.
    {
        let mut j = i;
        let mut nums = 0;
        while nums < 2 {
            while j < n && b[j] == b' ' { j += 1; }
            let s = j;
            while j < n && b[j].is_ascii_digit() { j += 1; }
            if j - s < 3 || j - s > 7 { break; }
            nums += 1;
        }
        if nums == 2 { out.push_str("# # "); i = j; while i < n && b[i] == b' ' { i += 1; } }
    }

    let mut last_space = false;
    while i < n {
        let c = b[i];

        // A quoted run longer than a few characters is a payload, not a
        // signature. Short ones are field names and are kept.
        if c == b'"' {
            let mut j = i + 1;
            while j < n && b[j] != b'"' { if b[j] == b'\\' { j += 1; } j += 1; }
            let inner = j.saturating_sub(i + 1);
            if j < n && inner >= 24 { out.push_str("\"…\""); i = j + 1; last_space = false; continue; }
        }

        // 0x-prefixed hex.
        if c == b'0' && i + 2 < n && (b[i + 1] == b'x' || b[i + 1] == b'X') && is_hex(b[i + 2]) {
            let mut j = i + 2;
            while j < n && is_hex(b[j]) { j += 1; }
            out.push('X'); i = j; last_space = false; continue;
        }

        if c.is_ascii_digit() || (c.is_ascii_hexdigit() && c.is_ascii_alphabetic()) {
            // Measure the whole run of hex-or-digit plus the dashes a uuid uses.
            let start = i;
            let mut j = i;
            let mut dashes = 0;
            let mut any_alpha = false;
            while j < n {
                let d = b[j];
                if d.is_ascii_digit() { j += 1; }
                else if is_hex(d) { any_alpha = true; j += 1; }
                else if d == b'-' && j + 1 < n && is_hex(b[j + 1]) && j - start >= 8 { dashes += 1; j += 1; }
                else { break; }
            }
            let run = j - start;
            let word_boundary = start == 0 || !(b[start - 1].is_ascii_alphanumeric() || b[start - 1] == b'_');
            // A uuid: 8-4-4-4-12 with four dashes. A hash: twelve or more hex
            // digits. Both are identity, never the fact.
            if word_boundary && (dashes == 4 && run >= 32 || (run >= 12 && any_alpha)) {
                out.push('X'); i = j; last_space = false; continue;
            }
            if word_boundary && !any_alpha {
                // A plain number, with the unit kept: `240ms` and `240MB` are
                // different events and must not collapse into one signature.
                let mut k = start;
                while k < n && (b[k].is_ascii_digit() || (b[k] == b'.' && k + 1 < n && b[k + 1].is_ascii_digit())) { k += 1; }
                let unit_start = k;
                let mut u = k;
                while u < n && u - unit_start < 2 && b[u].is_ascii_alphabetic() { u += 1; }
                let unit = &line[unit_start..u];
                let known = matches!(unit.to_ascii_lowercase().as_str(), "ms" | "s" | "kb" | "mb" | "gb" | "b" | "k" | "m" | "g" | "%");
                out.push('#');
                if known { out.push_str(unit); i = u; } else { i = k; }
                if i < n && b[i] == b'%' { out.push('%'); i += 1; }
                last_space = false; continue;
            }
        }

        // A path of two or more segments. One segment is a word with a slash in
        // it and is usually the fact (`GET /health`).
        if c == b'/' && i + 1 < n && (b[i + 1].is_ascii_alphanumeric() || b[i + 1] == b'_' || b[i + 1] == b'.') {
            let mut j = i;
            let mut segs = 0;
            while j < n && b[j] == b'/' {
                j += 1;
                let s = j;
                while j < n && (b[j].is_ascii_alphanumeric() || matches!(b[j], b'_' | b'-' | b'.' | b'@' | b'+')) { j += 1; }
                if j == s { j = s; break; }
                segs += 1;
            }
            if segs >= 3 { out.push('P'); i = j; last_space = false; continue; }
        }

        if c == b' ' || c == b'\t' {
            if !last_space && !out.is_empty() { out.push(' '); last_space = true; }
            i += 1;
            continue;
        }

        last_space = false;
        // Copy one whole UTF-8 character so a multibyte log line is not torn.
        let len = if c < 0x80 { 1 } else if c >> 5 == 0b110 { 2 } else if c >> 4 == 0b1110 { 3 } else if c >> 3 == 0b11110 { 4 } else { 1 };
        let end = (i + len).min(n);
        match std::str::from_utf8(&b[i..end]) {
            Ok(s) => out.push_str(s),
            Err(_) => out.push('?'),
        }
        i = end;
        if out.len() >= MAX_SIGNATURE { break; }
    }

    while out.ends_with(' ') { out.pop(); }
    if out.len() > MAX_SIGNATURE {
        let mut cut = MAX_SIGNATURE;
        while cut > 0 && !out.is_char_boundary(cut) { cut -= 1; }
        out.truncate(cut);
    }
    out
}

struct Bucket { id: String, severity: String, pattern: String, says: String, n: u64, sample: String }

/// One file: read the new bytes, count the shapes, name the known failures.
fn one(file: &Json, cap: u64, top: usize, level: char, grep: &str, buckets: &mut [Bucket], sample: bool) -> Json {
    let path = file.string("path", "");
    let mut o = Json::obj();
    o.set("path", path.clone().into());
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => { o.set("why", format!("unreadable: {}", e).into()); o.set("bytes", Json::Num(0.0)); return o; }
    };
    let size = meta.len();
    let asked = file.num("from", 0.0).max(0.0) as u64;
    // A truncated or rotated file is shorter than its cursor. Starting over is
    // the honest answer; reporting "nothing arrived" would hide a restart.
    let rotated = size < asked;
    let mut from = if rotated { 0 } else { asked };
    if size - from > cap { from = size - cap; }
    let len = (size - from) as usize;

    let mut text = String::new();
    if len > 0 {
        match File::open(&path).and_then(|mut f| { f.seek(SeekFrom::Start(from))?; let mut buf = vec![0u8; len]; f.read_exact(&mut buf)?; Ok(buf) }) {
            Ok(buf) => text = String::from_utf8_lossy(&buf).into_owned(),
            Err(e) => { o.set("why", format!("unreadable: {}", e).into()); }
        }
    }

    let mut counts: HashMap<String, (u64, String)> = HashMap::new();
    let mut lines = 0u64;
    let mut kept = 0u64;
    let mut errs = 0u64;
    let mut warns = 0u64;
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() { continue; }
        lines += 1;
        let lv = level_of(line);
        if lv == 'E' { errs += 1; } else if lv == 'W' { warns += 1; }
        // Buckets match the raw line and are counted before any filter, because
        // a known failure that a `--level` hid is a known failure that fired.
        for bk in buckets.iter_mut() {
            if rx::test(&bk.pattern, line).unwrap_or(false) {
                bk.n += 1;
                if bk.sample.is_empty() { bk.sample = line.chars().take(200).collect(); }
            }
        }
        if level != ' ' && lv != level { continue; }
        if !grep.is_empty() && !rx::test(grep, line).unwrap_or(false) { continue; }
        kept += 1;
        let sig = signature(line);
        if sig.is_empty() { continue; }
        let e = counts.entry(sig).or_insert_with(|| (0, if sample { line.chars().take(200).collect() } else { String::new() }));
        e.0 += 1;
    }

    let mut rows: Vec<(String, u64, String)> = counts.into_iter().map(|(k, (n, s))| (k, n, s)).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let distinct = rows.len();
    let mut arr = Vec::new();
    for (sig, n, s) in rows.into_iter().take(top) {
        let mut r = Json::obj();
        r.set("sig", sig.into());
        r.set("n", Json::Num(n as f64));
        if sample && !s.is_empty() { r.set("sample", s.into()); }
        arr.push(r);
    }

    o.set("bytes", Json::Num(len as f64));
    o.set("from", Json::Num(from as f64));
    o.set("to", Json::Num(size as f64));
    o.set("rotated", rotated.into());
    o.set("lines", Json::Num(lines as f64));
    o.set("kept", Json::Num(kept as f64));
    o.set("errors", Json::Num(errs as f64));
    o.set("warnings", Json::Num(warns as f64));
    o.set("distinct", Json::Num(distinct as f64));
    o.set("signatures", Json::Arr(arr));
    o
}

pub fn op_digest(input: &Json) -> Json {
    let cap = { let c = input.num("cap", DEFAULT_CAP as f64); if c > 0.0 { c as u64 } else { DEFAULT_CAP } };
    let top = { let t = input.num("top", DEFAULT_TOP as f64); if t > 0.0 { t as usize } else { DEFAULT_TOP } };
    let level = input.string("level", "").chars().next().unwrap_or(' ').to_ascii_uppercase();
    let grep = input.string("grep", "");
    let sample = input.get("sample").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut buckets: Vec<Bucket> = input.get("buckets").and_then(|v| v.as_arr()).map(|a| a.iter().map(|b| Bucket {
        id: b.string("id", "?"), severity: b.string("severity", "medium"),
        pattern: b.string("match", ""), says: b.string("says", ""), n: 0, sample: String::new(),
    }).collect()).unwrap_or_default();
    // A bucket whose pattern the subset refuses is reported, never skipped in
    // silence: a failure nobody is matching for must not read as a failure that
    // did not happen.
    let mut refused = Vec::new();
    buckets.retain(|b| match rx::test(&b.pattern, "") {
        Ok(_) => true,
        Err(e) => { let mut r = Json::obj(); r.set("id", b.id.clone().into()); r.set("why", e.into()); refused.push(r); false }
    });

    let empty = Vec::new();
    let files = input.get("files").and_then(|v| v.as_arr()).unwrap_or(&empty);
    let mut out = Vec::new();
    let (mut bytes, mut lines, mut errs, mut warns) = (0f64, 0f64, 0f64, 0f64);
    for f in files {
        let r = one(f, cap, top, level, &grep, &mut buckets, sample);
        bytes += r.num("bytes", 0.0);
        lines += r.num("lines", 0.0);
        errs += r.num("errors", 0.0);
        warns += r.num("warnings", 0.0);
        out.push(r);
    }

    let mut fired = Vec::new();
    let mut high = false;
    for b in buckets.iter().filter(|b| b.n > 0) {
        if b.severity == "high" { high = true; }
        let mut r = Json::obj();
        r.set("id", b.id.clone().into());
        r.set("severity", b.severity.clone().into());
        r.set("n", Json::Num(b.n as f64));
        r.set("says", b.says.clone().into());
        r.set("sample", b.sample.clone().into());
        fired.push(r);
    }
    fired.sort_by_key(|r| match r.string("severity", "").as_str() { "high" => 0, "medium" => 1, _ => 2 });

    let mut o = Json::obj();
    o.set("ok", true.into());
    o.set("files", Json::Arr(out));
    o.set("buckets", Json::Arr(fired));
    o.set("refused", Json::Arr(refused));
    o.set("high", high.into());
    let mut t = Json::obj();
    t.set("bytes", Json::Num(bytes));
    t.set("lines", Json::Num(lines));
    t.set("errors", Json::Num(errs));
    t.set("warnings", Json::Num(warns));
    o.set("totals", t);
    o
}
