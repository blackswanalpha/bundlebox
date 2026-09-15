//! scenario/expect.rs — what a step asserted, and what the system actually did.
//!
//! One function decides every red step in the factory, so it lives on its own:
//! a change to how `json_matches` compares must not be made in the same file as
//! a change to how a socket is opened. `asserts` is the other half of the same
//! rule — it counts what a step checks, and a step that checks nothing is
//! reported `empty` rather than green.
use crate::json::Json;
use crate::rx;
use crate::subst::{at, len_of, show, type_name};

pub fn each_pair(v: Option<&Json>, mut f: impl FnMut(&str, &Json)) {
    if let Some(Json::Obj(m)) = v { for (k, val) in m { f(k, val); } }
}

pub fn eq(a: &Json, b: &Json) -> bool {
    match (a, b) { (Json::Num(x), Json::Num(y)) => (x - y).abs() < 1e-9, _ => a == b }
}

pub fn num_of(v: &Json) -> Option<f64> { match v { Json::Num(n) => Some(*n), Json::Str(s) => s.parse().ok(), _ => None } }

/// Every expectation that did not hold, in the corpus's own words. An empty
/// result and "nothing was asserted" are different states and the caller
/// separates them: `asserts()` counts the keys.
pub fn check(expect: &Json, body: &Json, status: u16, ms: f64, got: &mut Json) -> Vec<String> {
    let mut why = Vec::new();
    // `got` is evidence a person reads, not the response: a 900-row list under
    // one path would push the actual failure off the board.
    let mut note = |path: &str, v: Option<&Json>| {
        let val = v.cloned().unwrap_or(Json::Null);
        let txt = val.to_string();
        got.set(path, if txt.len() > 240 { Json::Str(format!("{}… ({} bytes)", &txt[..240.min(txt.len())], txt.len())) } else { val });
    };
    if let Some(Json::Num(want)) = expect.get("status") {
        if status as f64 != *want { why.push(format!("status {}, expected {}", status, *want as i64)); }
    }
    if let Some(Json::Arr(a)) = expect.get("status_in") {
        if !a.iter().any(|x| x.as_f64().map(|n| n as u16 == status).unwrap_or(false)) {
            why.push(format!("status {}, expected one of {}", status, Json::Arr(a.clone()).to_string()));
        }
    }
    if let Some(Json::Num(b)) = expect.get("max_ms") {
        if ms > *b { why.push(format!("took {:.0}ms, budget {:.0}ms", ms, b)); }
    }
    each_pair(expect.get("json"), |p, want| {
        let have = at(body, p);
        note(p, have);
        match have { Some(v) if eq(v, want) => {}, Some(v) => why.push(format!("{} = {}, expected {}", p, show(v), show(want))), None => why.push(format!("{} is absent, expected {}", p, show(want))) }
    });
    each_pair(expect.get("json_not"), |p, want| {
        let have = at(body, p);
        note(p, have);
        if let Some(v) = have { if eq(v, want) { why.push(format!("{} = {}, expected anything else", p, show(v))); } }
    });
    each_pair(expect.get("json_in"), |p, set| {
        let have = at(body, p);
        note(p, have);
        let ok = match (have, set) { (Some(v), Json::Arr(a)) => a.iter().any(|x| eq(x, v)), _ => false };
        if !ok { why.push(format!("{} = {}, expected one of {}", p, have.map(show).unwrap_or("absent".into()), set.to_string())); }
    });
    each_pair(expect.get("json_type"), |p, want| {
        let have = at(body, p);
        note(p, have);
        let want_s = show(want);
        let ok = match have {
            Some(v) => { let t = type_name(v); t == want_s || (want_s == "number" && matches!(v, Json::Num(_))) || (want_s == "float" && matches!(v, Json::Num(_))) }
            None => false,
        };
        if !ok { why.push(format!("{} is {}, expected {}", p, have.map(|v| type_name(v).to_string()).unwrap_or("absent".into()), want_s)); }
    });
    if let Some(Json::Arr(a)) = expect.get("json_present") {
        for p in a.iter().filter_map(|x| x.as_str()) {
            let have = at(body, p);
            note(p, have);
            if !matches!(have, Some(v) if !matches!(v, Json::Null)) { why.push(format!("{} is absent or null", p)); }
        }
    }
    if let Some(Json::Arr(a)) = expect.get("json_absent") {
        for p in a.iter().filter_map(|x| x.as_str()) {
            let have = at(body, p);
            note(p, have);
            if matches!(have, Some(v) if !matches!(v, Json::Null)) { why.push(format!("{} is present ({}), expected absent", p, show(have.unwrap()))); }
        }
    }
    each_pair(expect.get("json_len_at_least"), |p, want| {
        let have = at(body, p);
        note(p, have);
        let n = have.and_then(len_of);
        match (n, num_of(want)) { (Some(n), Some(w)) if (n as f64) >= w => {}, (Some(n), Some(w)) => why.push(format!("{} has {} items, expected at least {}", p, n, w as i64)), _ => why.push(format!("{} has no length", p)) }
    });
    each_pair(expect.get("json_len_at_most"), |p, want| {
        let have = at(body, p);
        note(p, have);
        let n = have.and_then(len_of);
        match (n, num_of(want)) { (Some(n), Some(w)) if (n as f64) <= w => {}, (Some(n), Some(w)) => why.push(format!("{} has {} items, expected at most {}", p, n, w as i64)), _ => why.push(format!("{} has no length", p)) }
    });
    each_pair(expect.get("json_gte"), |p, want| {
        let have = at(body, p);
        note(p, have);
        match (have.and_then(num_of), num_of(want)) { (Some(v), Some(w)) if v >= w => {}, (Some(v), Some(w)) => why.push(format!("{} = {}, expected >= {}", p, v, w)), _ => why.push(format!("{} is not a number", p)) }
    });
    each_pair(expect.get("json_lte"), |p, want| {
        let have = at(body, p);
        note(p, have);
        match (have.and_then(num_of), num_of(want)) { (Some(v), Some(w)) if v <= w => {}, (Some(v), Some(w)) => why.push(format!("{} = {}, expected <= {}", p, v, w)), _ => why.push(format!("{} is not a number", p)) }
    });
    each_pair(expect.get("json_matches"), |p, pat| {
        let have = at(body, p);
        note(p, have);
        let subject = have.map(show).unwrap_or_default();
        match rx::test(&show(pat), &subject) {
            Ok(true) => {}
            Ok(false) => why.push(format!("{} = {:?}, expected to match /{}/", p, subject, show(pat))),
            Err(e) => why.push(format!("{}: pattern /{}/ is outside the kernel's subset ({}) — run this corpus with --engine js", p, show(pat), e)),
        }
    });
    each_pair(expect.get("each"), |p, nested| {
        match at(body, p) {
            Some(Json::Arr(items)) => {
                for (i, item) in items.iter().enumerate() {
                    let mut sub = Json::obj();
                    for w in check(nested, item, status, ms, &mut sub) { why.push(format!("{}[{}]: {}", p, i, w)); }
                }
            }
            Some(v) => why.push(format!("{} is {}, expected a list to iterate", p, type_name(v))),
            None => why.push(format!("{} is absent, expected a list to iterate", p)),
        }
    });
    each_pair(expect.get("contains"), |p, want| {
        match at(body, p) {
            Some(Json::Arr(items)) => {
                let hit = items.iter().any(|item| {
                    let mut all = true;
                    each_pair(Some(want), |f, v| { if !at(item, f).map(|x| eq(x, v)).unwrap_or(false) { all = false; } });
                    all
                });
                if !hit { why.push(format!("no item of {} ({} of them) matches {}", p, items.len(), want.to_string())); }
            }
            Some(v) => why.push(format!("{} is {}, expected a list", p, type_name(v))),
            None => why.push(format!("{} is absent, expected a list", p)),
        }
    });
    if let Some(Json::Arr(sides)) = expect.get("not_both") {
        if sides.len() == 2 {
            let holds = |side: &Json| { let mut all = true; each_pair(Some(side), |p, v| { if !at(body, p).map(|x| eq(x, v)).unwrap_or(false) { all = false; } }); all };
            if holds(&sides[0]) && holds(&sides[1]) {
                why.push(format!("both held and they contradict: {} AND {}", sides[0].to_string(), sides[1].to_string()));
            }
        } else { why.push("not_both takes exactly two blocks".into()); }
    }
    why
}

const KEYS: &[&str] = &["status", "status_in", "max_ms", "json", "json_not", "json_in", "json_type", "json_present", "json_absent",
    "json_len_at_least", "json_len_at_most", "json_gte", "json_lte", "json_matches", "each", "contains", "not_both",
    "rc", "stdout_contains", "stderr_contains", "contains_text", "absent_text", "matches"];

/// How many expectation keys a block actually carries, and which keys it used
/// that this runner does not implement. A key nobody implements is silently
/// green, which is the failure mode `check` exists to prevent.
pub fn asserts(expect: &Json) -> (usize, Vec<String>) {
    let mut n = 0;
    let mut unknown = Vec::new();
    if let Json::Obj(m) = expect {
        for k in m.keys() { if KEYS.contains(&k.as_str()) { n += 1; } else { unknown.push(k.clone()); } }
    }
    (n, unknown)
}
