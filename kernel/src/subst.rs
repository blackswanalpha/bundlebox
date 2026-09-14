//! subst.rs — the substitution tokens a scenario is written in, the clock they
//! resolve against, and the dotted paths an expectation reads.
//!
//! Two properties matter more than the list of tokens:
//!
//! **A string that is EXACTLY one token keeps that value's type.** Comparing a
//! byte count against `"4096"` fails on `4096 != "4096"` and reads as a product
//! defect, so `{{used_before}}` alone returns the number it saved.
//!
//! **An unresolved token is an ERROR, not a literal.** A typo would otherwise
//! be compared as the text `{{tenatn}}`, which is a red step about nothing, or
//! worse, a green one. Every unresolved token is collected and the step is
//! reported as `error` with the name it could not resolve.
use crate::json::Json;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Clock { pub now: f64, pub tz_offset_minutes: i64, pub timezone: String, pub run: String }

pub fn now_secs() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0) }

/// Days since 1970-01-01 from a civil date, and back. Howard Hinnant's
/// algorithm: exact for the whole proleptic Gregorian range and no table.
#[allow(dead_code)] // the inverse of civil_from_days; one without the other is half an implementation
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
pub fn fmt_date(secs: f64) -> String {
    let (y, m, d) = civil_from_days((secs / 86400.0).floor() as i64);
    format!("{:04}-{:02}-{:02}", y, m, d)
}
pub fn fmt_iso(secs: f64) -> String {
    let day = (secs / 86400.0).floor();
    let (y, m, d) = civil_from_days(day as i64);
    let rem = (secs - day * 86400.0).max(0.0) as i64;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}
pub fn stamp(secs: f64) -> String { fmt_iso(secs).replace(['-', ':'], "") }

fn offset(spec: &str) -> Option<f64> {
    // "+90m" "-3d" "+20h" "+30s" — the unit is mandatory, so "+90" is unresolved
    // rather than silently seconds.
    let (sign, rest) = match spec.as_bytes().first()? { b'+' => (1.0, &spec[1..]), b'-' => (-1.0, &spec[1..]), _ => return None };
    let (num, unit) = rest.split_at(rest.len().checked_sub(1)?);
    let n: f64 = num.parse().ok()?;
    let mul = match unit { "s" => 1.0, "m" => 60.0, "h" => 3600.0, "d" => 86400.0, "w" => 604800.0, _ => return None };
    Some(sign * n * mul)
}

pub fn rand_hex(n: usize) -> String {
    let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(88172645463325252);
    let mut s = String::new();
    while s.len() < n {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        s.push_str(&format!("{:016x}", x));
    }
    s.truncate(n);
    s
}

/// One token's value, or None when nothing in this scope defines it.
pub fn token(name: &str, clock: &Clock, vars: &BTreeMap<String, Json>) -> Option<Json> {
    let tz = clock.tz_offset_minutes as f64 * 60.0;
    if let Some(v) = vars.get(name) { return Some(v.clone()); }
    match name {
        "now" => return Some(fmt_iso(clock.now).into()),
        "today" => return Some(fmt_date(clock.now).into()),
        "localdate" => return Some(fmt_date(clock.now + tz).into()),
        "tzoffset" => return Some((clock.tz_offset_minutes as f64).into()),
        "timezone" => return Some(clock.timezone.clone().into()),
        "run" => return Some(clock.run.clone().into()),
        "rand" => return Some(rand_hex(8).into()),
        "epoch" => return Some(clock.now.floor().into()),
        _ => {}
    }
    if let Some(rest) = name.strip_prefix("rand:") { return rest.parse::<usize>().ok().map(|n| rand_hex(n.min(64)).into()); }
    if let Some(rest) = name.strip_prefix("now") { return offset(rest).map(|d| fmt_iso(clock.now + d).into()); }
    if let Some(rest) = name.strip_prefix("localdate") { return offset(rest).map(|d| fmt_date(clock.now + tz + d).into()); }
    if let Some(rest) = name.strip_prefix("localday") {
        // Local midnight plus the offset, expressed in UTC, clamped FORWARD by
        // whole days until it is in the future. The clamp is unconditional on
        // purpose: anything that only fires late in the day is a bug that is
        // green for most of it.
        let d = offset(rest)?;
        let local_midnight = ((clock.now + tz) / 86400.0).floor() * 86400.0;
        let mut t = local_midnight + d - tz;
        while t <= clock.now { t += 86400.0; }
        return Some(fmt_iso(t).into());
    }
    if name.starts_with('+') || name.starts_with('-') { return offset(name).map(|d| fmt_date(clock.now + d).into()); }
    None
}

fn tokens_of(s: &str) -> Vec<(usize, usize, String)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'{' && b[i + 1] == b'{' {
            if let Some(j) = s[i + 2..].find("}}") {
                let end = i + 2 + j + 2;
                out.push((i, end, s[i + 2..i + 2 + j].trim().to_string()));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

pub fn subst_str(s: &str, clock: &Clock, vars: &BTreeMap<String, Json>, missing: &mut Vec<String>) -> Json {
    let found = tokens_of(s);
    if found.is_empty() { return s.into(); }
    if found.len() == 1 && found[0].0 == 0 && found[0].1 == s.len() {
        return match token(&found[0].2, clock, vars) { Some(v) => v, None => { missing.push(found[0].2.clone()); s.into() } };
    }
    let mut out = String::new();
    let mut last = 0;
    for (a, b, name) in &found {
        out.push_str(&s[last..*a]);
        match token(name, clock, vars) {
            Some(Json::Str(v)) => out.push_str(&v),
            Some(v) => out.push_str(&v.to_string().trim_matches('"').to_string()),
            None => { missing.push(name.clone()); out.push_str(&s[*a..*b]); }
        }
        last = *b;
    }
    out.push_str(&s[last..]);
    out.into()
}

pub fn subst(v: &Json, clock: &Clock, vars: &BTreeMap<String, Json>, missing: &mut Vec<String>) -> Json {
    match v {
        Json::Str(s) => subst_str(s, clock, vars, missing),
        Json::Arr(a) => Json::Arr(a.iter().map(|x| subst(x, clock, vars, missing)).collect()),
        Json::Obj(m) => {
            let mut o = Json::obj();
            for (k, val) in m {
                let key = match subst_str(k, clock, vars, missing) { Json::Str(s) => s, other => other.to_string() };
                o.set(&key, subst(val, clock, vars, missing));
            }
            o
        }
        other => other.clone(),
    }
}

/// `event.version`, `briefs.0.brief_date`. A bare JSON array response is wrapped
/// as `_list` by the caller, so `_list.0.id` addresses it like any other body.
pub fn at<'a>(v: &'a Json, path: &str) -> Option<&'a Json> {
    let mut cur = v;
    if path.is_empty() { return Some(cur); }
    for seg in path.split('.') {
        cur = match cur {
            Json::Obj(m) => m.get(seg)?,
            Json::Arr(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

pub fn len_of(v: &Json) -> Option<usize> {
    match v { Json::Arr(a) => Some(a.len()), Json::Obj(m) => Some(m.len()), Json::Str(s) => Some(s.chars().count()), _ => None }
}

pub fn type_name(v: &Json) -> &'static str {
    match v { Json::Null => "null", Json::Bool(_) => "bool", Json::Num(n) => if n.fract() == 0.0 { "int" } else { "float" }, Json::Str(_) => "str", Json::Arr(_) => "list", Json::Obj(_) => "dict" }
}

pub fn show(v: &Json) -> String { match v { Json::Str(s) => s.clone(), other => other.to_string() } }
