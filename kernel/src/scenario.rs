//! scenario.rs — run a corpus of scenarios against a running system, fast.
//!
//! A detector asks what the FILES say. A scenario asks what the running system
//! DOES, with a persona whose week is dense enough to reach the paths that only
//! fire under state. That is the one class of question in this factory that
//! makes a request, and it is here rather than in the CLI for one reason: a
//! corpus is hundreds of steps, each of them a socket, and a scripting runtime
//! spends the wall clock on its own scheduler. Threads, one connection per
//! worker, one shared pacer.
//!
//! Four properties the runner enforces, each because the alternative produces a
//! board that is green for the wrong reason:
//!
//! 1. **Pacing is part of the design.** A service that limits to 60 requests a
//!    minute turns an unpaced 130-step corpus into an all-red board about the
//!    limiter. `rpm` throttles globally and a 429 is retried, not recorded.
//! 2. **A failed `precondition` BLOCKS its scenario** instead of cascading. One
//!    unwritable directory used to read as nineteen product defects.
//! 3. **An unresolved `{{token}}` is an error**, never a literal comparison.
//! 4. **Green means something was checked.** A step that asserts nothing is
//!    reported `empty`, and the caller's `check` refuses the corpus.
use crate::http::{parse_url, Conn, Resp};
use crate::json::Json;
use crate::rx;
use crate::subst::{self, at, len_of, show, type_name, Clock};
use std::collections::BTreeMap;
use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Pacer { gap: Duration, next: Mutex<Instant> }
impl Pacer {
    fn new(rpm: f64) -> Option<Pacer> {
        if rpm <= 0.0 { return None; }
        Some(Pacer { gap: Duration::from_secs_f64(60.0 / rpm), next: Mutex::new(Instant::now()) })
    }
    fn wait(&self) {
        let sleep_for = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let at = if *next > now { *next } else { now };
            *next = at + self.gap;
            at.saturating_duration_since(now)
        };
        if !sleep_for.is_zero() { std::thread::sleep(sleep_for); }
    }
}

struct Run {
    host: String,
    port: u16,
    base_path: String,
    base: String,
    headers: Json,
    clock: Clock,
    globals: BTreeMap<String, Json>,
    actors: Json,
    pacer: Option<Pacer>,
    timeout: Duration,
    cap: usize,
    root: String,
    max_429: u32,
    requests: AtomicUsize,
    throttled: AtomicUsize,
}

struct Step { name: String, kind: &'static str, state: String, status: Option<u16>, ms: f64, why: Vec<String>, request: String, evidence: Json }

fn s(v: &str) -> Json { Json::Str(v.to_string()) }

impl Step {
    fn to_json(&self) -> Json {
        let mut o = Json::obj();
        o.set("name", s(&self.name));
        o.set("kind", s(self.kind));
        o.set("state", s(&self.state));
        o.set("status", self.status.map(|x| Json::Num(x as f64)).unwrap_or(Json::Null));
        o.set("ms", Json::Num((self.ms * 10.0).round() / 10.0));
        o.set("why", Json::Arr(self.why.iter().map(|w| s(w)).collect()));
        o.set("request", s(&self.request));
        o.set("evidence", self.evidence.clone());
        o
    }
}

// ── expectations ────────────────────────────────────────────────────────────

fn each_pair(v: Option<&Json>, mut f: impl FnMut(&str, &Json)) {
    if let Some(Json::Obj(m)) = v { for (k, val) in m { f(k, val); } }
}

fn eq(a: &Json, b: &Json) -> bool {
    match (a, b) { (Json::Num(x), Json::Num(y)) => (x - y).abs() < 1e-9, _ => a == b }
}

fn num_of(v: &Json) -> Option<f64> { match v { Json::Num(n) => Some(*n), Json::Str(s) => s.parse().ok(), _ => None } }

/// Every expectation that did not hold, in the corpus's own words. An empty
/// result and "nothing was asserted" are different states and the caller
/// separates them: `asserts()` counts the keys.
fn check(expect: &Json, body: &Json, status: u16, ms: f64, got: &mut Json) -> Vec<String> {
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

// ── steps ───────────────────────────────────────────────────────────────────

fn body_json(raw: &str) -> Json {
    let t = raw.trim();
    if t.is_empty() { return Json::obj(); }
    match crate::json::parse(t) {
        Ok(Json::Arr(a)) => { let mut o = Json::obj(); o.set("_list", Json::Arr(a)); o }
        Ok(v) => v,
        Err(_) => { let mut o = Json::obj(); o.set("_text", s(t)); o }
    }
}

fn tail(s: &str, cap: usize) -> String { if s.len() <= cap { s.to_string() } else { format!("…{}", &s[s.len() - cap..]) } }

fn header_list(run: &Run, extra: Option<&Json>, actor: &str, vars: &BTreeMap<String, Json>, missing: &mut Vec<String>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |j: &Json, out: &mut Vec<(String, String)>| {
        if let Json::Obj(m) = j {
            for (k, v) in m {
                let val = subst::subst(v, &run.clock, vars, missing);
                out.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
                out.push((k.clone(), show(&val)));
            }
        }
    };
    push(&run.headers, &mut out);
    if !actor.is_empty() { if let Some(a) = run.actors.get(actor).and_then(|a| a.get("headers")) { push(a, &mut out); } }
    if let Some(e) = extra { push(e, &mut out); }
    out
}

fn http_step(run: &Run, conn: &mut Conn, step: &Json, vars: &mut BTreeMap<String, Json>, name: &str) -> Step {
    let mut missing: Vec<String> = Vec::new();
    let spec = show(&subst::subst(&s(&step.string("do", "")), &run.clock, vars, &mut missing));
    let mut parts = spec.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_uppercase();
    let rest: String = parts.collect::<Vec<_>>().join("");
    let path = if rest.starts_with("http") {
        match parse_url(&rest) { Ok(u) => u.path, Err(_) => rest.clone() }
    } else if run.base_path.len() > 1 { format!("{}{}", run.base_path.trim_end_matches('/'), rest) } else { rest.clone() };
    let actor = step.string("as", "");
    let headers = header_list(run, step.get("headers"), &actor, vars, &mut missing);
    let body = step.get("body").map(|b| subst::subst(b, &run.clock, vars, &mut missing).to_string());
    let expect = step.get("expect").cloned().unwrap_or_else(Json::obj);
    let expect = subst::subst(&expect, &run.clock, vars, &mut missing);
    let request = format!("{} {}", method, path);

    if !missing.is_empty() {
        missing.sort(); missing.dedup();
        return Step { name: name.into(), kind: "http", state: "error".into(), status: None, ms: 0.0,
            why: vec![format!("unresolved token(s): {{{{{}}}}} — nothing in this scenario saved them", missing.join("}}, {{"))],
            request, evidence: Json::obj() };
    }

    let attempts = step.get("poll").and_then(|p| p.get("attempts")).and_then(|v| v.as_f64()).unwrap_or(1.0).max(1.0) as u32;
    let gap = Duration::from_millis(step.get("poll").and_then(|p| p.get("ms")).and_then(|v| v.as_f64()).unwrap_or(500.0) as u64);
    let mut last: Option<Resp> = None;
    let mut why: Vec<String> = Vec::new();
    let mut got = Json::obj();
    let mut err: Option<String> = None;
    let mut total_ms = 0.0;
    for attempt in 0..attempts {
        if attempt > 0 { std::thread::sleep(gap); }
        let mut throttle_left = run.max_429;
        loop {
            if let Some(p) = &run.pacer { p.wait(); }
            run.requests.fetch_add(1, Ordering::Relaxed);
            match conn.request(&method, &path, &headers, body.as_deref()) {
                Ok(r) => {
                    total_ms += r.ms;
                    // A 429 is the limiter, not the product. Ride it out and try
                    // again; recording it would put the corpus's own pace in the board.
                    let expected_429 = expect.get("status").and_then(|v| v.as_f64()).map(|n| n as u16 == 429).unwrap_or(false);
                    if r.status == 429 && throttle_left > 0 && !expected_429 {
                        run.throttled.fetch_add(1, Ordering::Relaxed);
                        throttle_left -= 1;
                        std::thread::sleep(Duration::from_secs_f64(r.retry_after().unwrap_or(2.0).min(30.0)));
                        continue;
                    }
                    last = Some(r);
                    err = None;
                    break;
                }
                Err(e) => { err = Some(e); break; }
            }
        }
        let Some(r) = last.as_ref() else { break };
        got = Json::obj();
        why = check(&expect, &body_json(&r.body), r.status, r.ms, &mut got);
        if why.is_empty() { break; }
    }

    let mut evidence = Json::obj();
    evidence.set("request", s(&request));
    if let Some(b) = &body { evidence.set("sent", s(&tail(b, run.cap.min(600)))); }
    evidence.set("got", got);
    let (n_assert, unknown) = asserts(&expect);
    match (last, err) {
        (_, Some(e)) => { evidence.set("error", s(&e)); Step { name: name.into(), kind: "http", state: "error".into(), status: None, ms: total_ms, why: vec![format!("request failed: {}", e)], request, evidence } }
        (Some(r), _) => {
            evidence.set("status", Json::Num(r.status as f64));
            evidence.set("body", s(&tail(&r.body, run.cap)));
            let mut why = why;
            for u in unknown { why.push(format!("unknown expectation key `{}` — nothing checked it", u)); }
            let state = if !why.is_empty() { "failed" } else if n_assert == 0 { "empty" } else { "passed" };
            // A save runs only on a step that held: saving off a red response
            // propagates one defect into every step after it.
            if state == "passed" {
                let parsed = body_json(&r.body);
                each_pair(step.get("save"), |k, p| { if let Some(v) = at(&parsed, &show(p)) { vars.insert(k.to_string(), v.clone()); } });
            }
            Step { name: name.into(), kind: "http", state: state.into(), status: Some(r.status), ms: total_ms, why, request, evidence }
        }
        (None, None) => Step { name: name.into(), kind: "http", state: "error".into(), status: None, ms: total_ms, why: vec!["no response and no error".into()], request, evidence },
    }
}

fn static_step(run: &Run, step: &Json, vars: &BTreeMap<String, Json>, name: &str) -> Step {
    let mut missing = Vec::new();
    let spec = subst::subst(step.get("static").unwrap_or(&Json::Null), &run.clock, vars, &mut missing);
    let file = spec.string("file", "");
    let full = std::path::Path::new(&run.root).join(&file);
    let mut evidence = Json::obj();
    evidence.set("file", s(&file));
    let text = match std::fs::read_to_string(&full) { Ok(t) => t, Err(e) => {
        return Step { name: name.into(), kind: "static", state: "failed".into(), status: None, ms: 0.0, why: vec![format!("{}: {}", file, e)], request: format!("static {}", file), evidence } } };
    let mut why = Vec::new();
    let mut n = 0;
    for (key, want_present) in [("contains", true), ("absent", false)] {
        match spec.get(key) {
            Some(Json::Str(needle)) => { n += 1; if text.contains(needle.as_str()) != want_present { why.push(format!("{} {} {:?}", file, if want_present { "does not contain" } else { "contains" }, needle)); } }
            Some(Json::Arr(a)) => { for needle in a.iter().filter_map(|x| x.as_str()) { n += 1; if text.contains(needle) != want_present { why.push(format!("{} {} {:?}", file, if want_present { "does not contain" } else { "contains" }, needle)); } } }
            _ => {}
        }
    }
    if let Some(Json::Str(p)) = spec.get("matches") {
        n += 1;
        match rx::test(p, &text) { Ok(true) => {}, Ok(false) => why.push(format!("{} does not match /{}/", file, p)), Err(e) => why.push(format!("pattern /{}/ is outside the kernel's subset ({})", p, e)) }
    }
    let lines: Vec<&str> = text.lines().collect();
    evidence.set("lines", Json::Num(lines.len() as f64));
    let state = if !why.is_empty() { "failed" } else if n == 0 { "empty" } else { "passed" };
    Step { name: name.into(), kind: "static", state: state.into(), status: None, ms: 0.0, why, request: format!("static {}", file), evidence }
}

fn cmd_step(run: &Run, step: &Json, vars: &BTreeMap<String, Json>, name: &str) -> Step {
    let mut missing = Vec::new();
    let cmd = show(&subst::subst(&s(&step.string("run", "")), &run.clock, vars, &mut missing));
    let expect = subst::subst(step.get("expect").unwrap_or(&Json::Null), &run.clock, vars, &mut missing);
    let mut evidence = Json::obj();
    evidence.set("cmd", s(&cmd));
    if !missing.is_empty() {
        return Step { name: name.into(), kind: "cmd", state: "error".into(), status: None, ms: 0.0, why: vec![format!("unresolved token(s): {}", missing.join(", "))], request: cmd, evidence };
    }
    let t0 = Instant::now();
    // Same shell selection as the gate: `bash` does not exist on Windows, and a
    // spawn error there is not a failing step, it is no step at all. stderr is
    // kept separate here, so the merge is off.
    let child = crate::gate::shell(&cmd, false).current_dir(&run.root)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let mut child = match child { Ok(c) => c, Err(e) => return Step { name: name.into(), kind: "cmd", state: "error".into(), status: None, ms: 0.0, why: vec![format!("spawn: {}", e)], request: cmd, evidence } };
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ho = std::thread::spawn(move || { let mut b = String::new(); let _ = so.read_to_string(&mut b); b });
    let he = std::thread::spawn(move || { let mut b = String::new(); let _ = se.read_to_string(&mut b); b });
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() { Ok(Some(st)) => break Some(st), Ok(None) => {}, Err(_) => break None }
        if t0.elapsed() > run.timeout { let _ = child.kill(); timed_out = true; break child.wait().ok(); }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = ho.join().unwrap_or_default();
    let stderr = he.join().unwrap_or_default();
    let rc = status.and_then(|s| s.code()).unwrap_or(if timed_out { 124 } else { 1 });
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    evidence.set("rc", Json::Num(rc as f64));
    evidence.set("stdout", s(&tail(&stdout, run.cap)));
    if !stderr.trim().is_empty() { evidence.set("stderr", s(&tail(&stderr, run.cap.min(1200)))); }
    let mut why = Vec::new();
    let mut n = 0;
    if let Some(want) = expect.get("rc").and_then(|v| v.as_f64()) { n += 1; if rc as f64 != want { why.push(format!("rc {}, expected {}", rc, want as i64)); } }
    for (key, hay, label) in [("stdout_contains", &stdout, "stdout"), ("stderr_contains", &stderr, "stderr")] {
        match expect.get(key) {
            Some(Json::Str(needle)) => { n += 1; if !hay.contains(needle.as_str()) { why.push(format!("{} does not contain {:?}", label, needle)); } }
            Some(Json::Arr(a)) => { for needle in a.iter().filter_map(|x| x.as_str()) { n += 1; if !hay.contains(needle) { why.push(format!("{} does not contain {:?}", label, needle)); } } }
            _ => {}
        }
    }
    if let Some(b) = expect.get("max_ms").and_then(|v| v.as_f64()) { n += 1; if ms > b { why.push(format!("took {:.0}ms, budget {:.0}ms", ms, b)); } }
    if timed_out { why.push(format!("timed out after {:.0}s", run.timeout.as_secs_f64())); }
    if n == 0 && expect == Json::Null { n = 1; if rc != 0 { why.push(format!("rc {} and nothing was asserted; a bare `run` step expects 0", rc)); } }
    let state = if !why.is_empty() { "failed" } else if n == 0 { "empty" } else { "passed" };
    Step { name: name.into(), kind: "cmd", state: state.into(), status: Some(rc as u16), ms, why, request: cmd, evidence }
}

fn run_steps(run: &Run, conn: &mut Conn, steps: &[Json], vars: &mut BTreeMap<String, Json>) -> (Vec<Step>, Option<String>) {
    let mut out = Vec::new();
    let mut blocked: Option<String> = None;
    for (i, step) in steps.iter().enumerate() {
        let name = step.string("name", &format!("step {}", i + 1));
        let cleanup = step.get("cleanup").and_then(|v| v.as_bool()).unwrap_or(false);
        if blocked.is_some() && !cleanup {
            out.push(Step { name, kind: "blocked", state: "blocked".into(), status: None, ms: 0.0,
                why: vec![blocked.clone().unwrap_or_default()], request: String::new(), evidence: Json::obj() });
            continue;
        }
        let r = if step.get("static").is_some() { static_step(run, step, vars, &name) }
            else if !step.string("run", "").is_empty() { cmd_step(run, step, vars, &name) }
            else if !step.string("do", "").is_empty() { http_step(run, conn, step, vars, &name) }
            else { Step { name: name.clone(), kind: "none", state: "empty".into(), status: None, ms: 0.0, why: vec!["a step must have `do`, `run` or `static`".into()], request: String::new(), evidence: Json::obj() } };
        let is_pre = step.get("precondition").and_then(|v| v.as_bool()).unwrap_or(false);
        if is_pre && r.state != "passed" {
            blocked = Some(format!("blocked by precondition `{}`: {}", r.name, r.why.first().cloned().unwrap_or_default()));
        }
        out.push(r);
    }
    (out, blocked)
}

fn conn_of(run: &Run) -> Conn { Conn::new(&run.host, run.port, run.timeout) }

fn scenario_json(sc: &Json, steps: Vec<Step>, seconds: f64) -> Json {
    let mut o = Json::obj();
    for k in ["id", "surface", "severity", "title", "question"] { o.set(k, s(&sc.string(k, ""))); }
    if let Some(r) = sc.get("rule") { o.set("rule", r.clone()); }
    let state = if steps.iter().any(|x| x.state == "error") { "error" }
        else if steps.iter().any(|x| x.state == "failed") { "failed" }
        else if steps.iter().any(|x| x.state == "blocked") { "blocked" }
        else if steps.iter().any(|x| x.state == "empty") { "empty" }
        else { "passed" };
    o.set("state", s(state));
    o.set("seconds", Json::Num((seconds * 100.0).round() / 100.0));
    o.set("steps", Json::Arr(steps.iter().map(|x| x.to_json()).collect()));
    o
}

pub fn op_scenario(input: &Json) -> Json {
    let mut out = Json::obj();
    let base_raw = input.string("base", "");
    let url = match parse_url(&base_raw) { Ok(u) => u, Err(e) => { out.set("ok", Json::Bool(false)); out.set("why", s(&e)); return out; } };
    if url.scheme == "https" {
        out.set("ok", Json::Bool(false));
        out.set("why", s("the kernel speaks http only (TLS would be a dependency); run this corpus with --engine js"));
        return out;
    }
    let scenarios: Vec<Json> = input.get("scenarios").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
    let mut globals: BTreeMap<String, Json> = BTreeMap::new();
    if let Json::Obj(m) = input.get("vars").cloned().unwrap_or_else(Json::obj) { for (k, v) in m { globals.insert(k, v); } }
    let now = subst::now_secs();
    let run = Run {
        host: url.host.clone(), port: url.port, base_path: url.path.clone(), base: base_raw.clone(),
        headers: input.get("headers").cloned().unwrap_or_else(Json::obj),
        clock: Clock { now, tz_offset_minutes: input.num("tz_offset_minutes", 0.0) as i64,
            timezone: input.string("timezone", "UTC"), run: input.string("run", &subst::stamp(now)) },
        globals: BTreeMap::new(),
        actors: input.get("actors").cloned().unwrap_or_else(Json::obj),
        pacer: Pacer::new(input.num("rpm", 0.0)),
        timeout: Duration::from_millis(input.num("timeout_ms", 20000.0) as u64),
        cap: input.num("cap_bytes", 1200.0) as usize,
        root: input.string("root", "."),
        max_429: input.num("max_429", 6.0) as u32,
        requests: AtomicUsize::new(0), throttled: AtomicUsize::new(0),
    };
    let t0 = Instant::now();

    // Setup runs once, sequentially, and what it saves is global. A corpus with
    // a sign-in writes it here rather than in every scenario.
    let setup_steps: Vec<Json> = input.get("setup").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
    let mut setup_vars = globals.clone();
    let (setup_rows, setup_blocked) = if setup_steps.is_empty() { (Vec::new(), None) } else {
        let mut c = conn_of(&run);
        run_steps(&run, &mut c, &setup_steps, &mut setup_vars)
    };
    let setup_failed = setup_rows.iter().any(|r| r.state == "failed" || r.state == "error") || setup_blocked.is_some();
    let mut setup_out = Json::obj();
    setup_out.set("state", s(if setup_steps.is_empty() { "none" } else if setup_failed { "failed" } else { "passed" }));
    setup_out.set("steps", Json::Arr(setup_rows.iter().map(|x| x.to_json()).collect()));

    let run = Run { globals: setup_vars, ..run };
    let results: Mutex<Vec<(usize, Json)>> = Mutex::new(Vec::new());

    if setup_failed {
        // Nothing after a failed setup means anything about the product.
        let mut rows = Vec::new();
        for (i, sc) in scenarios.iter().enumerate() {
            let steps: Vec<Step> = sc.get("steps").and_then(|v| v.as_arr()).cloned().unwrap_or_default().iter().enumerate()
                .map(|(j, st)| Step { name: st.string("name", &format!("step {}", j + 1)), kind: "blocked", state: "blocked".into(), status: None, ms: 0.0,
                    why: vec!["setup failed; nothing after it is a claim about the product".into()], request: String::new(), evidence: Json::obj() }).collect();
            rows.push((i, scenario_json(sc, steps, 0.0)));
        }
        *results.lock().unwrap() = rows;
    } else {
        let parallel = (input.num("parallel", 1.0) as usize).clamp(1, 32);
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..parallel.min(scenarios.len().max(1)) {
                scope.spawn(|| {
                    let mut conn = conn_of(&run);
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(sc) = scenarios.get(i) else { break };
                        let st0 = Instant::now();
                        let steps: Vec<Json> = sc.get("steps").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
                        let mut vars = run.globals.clone();
                        let (rows, _) = run_steps(&run, &mut conn, &steps, &mut vars);
                        results.lock().unwrap_or_else(|e| e.into_inner()).push((i, scenario_json(sc, rows, st0.elapsed().as_secs_f64())));
                    }
                });
            }
        });
    }

    let mut rows = results.into_inner().unwrap_or_else(|e| e.into_inner());
    rows.sort_by_key(|(i, _)| *i);
    let mut totals: BTreeMap<&str, usize> = BTreeMap::new();
    for (_, sc) in &rows {
        for st in sc.get("steps").and_then(|v| v.as_arr()).cloned().unwrap_or_default() {
            *totals.entry(match st.string("state", "").as_str() {
                "passed" => "passed", "failed" => "failed", "blocked" => "blocked", "error" => "error", _ => "empty" }).or_insert(0) += 1;
        }
    }
    let mut t = Json::obj();
    for k in ["passed", "failed", "blocked", "error", "empty"] { t.set(k, Json::Num(*totals.get(k).unwrap_or(&0) as f64)); }
    out.set("ok", Json::Bool(true));
    out.set("engine", s("kernel"));
    out.set("base", s(&run.base));
    out.set("setup", setup_out);
    out.set("scenarios", Json::Arr(rows.into_iter().map(|(_, v)| v).collect()));
    out.set("totals", t);
    out.set("seconds", Json::Num((t0.elapsed().as_secs_f64() * 10.0).round() / 10.0));
    out.set("requests", Json::Num(run.requests.load(Ordering::Relaxed) as f64));
    out.set("throttled", Json::Num(run.throttled.load(Ordering::Relaxed) as f64));
    out.set("rpm", Json::Num(input.num("rpm", 0.0)));
    out
}
