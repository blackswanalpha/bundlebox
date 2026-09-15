//! scenario/steps.rs — the three things a step can be, and never two.
//!
//! `do` makes a request, `run` shells out, `static` reads a file. Each returns
//! the same `Step`, so the board does not care which kind produced a red row.
//! An unresolved `{{token}}` is an error here rather than a literal comparison:
//! a corpus that silently compares against the string "{{item}}" is green for
//! the wrong reason.
use super::expect::{asserts, check, each_pair, BODY_KEYS};
use super::{s, Run, Step};
use crate::http::{parse_url, Conn, Resp};
use crate::json::Json;
use crate::rx;
use crate::subst::{self, at, show};
use std::collections::BTreeMap;
use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub fn body_json(raw: &str) -> Json {
    let t = raw.trim();
    if t.is_empty() { return Json::obj(); }
    match crate::json::parse(t) {
        Ok(Json::Arr(a)) => { let mut o = Json::obj(); o.set("_list", Json::Arr(a)); o }
        Ok(v) => v,
        Err(_) => { let mut o = Json::obj(); o.set("_text", s(t)); o }
    }
}

pub fn tail(s: &str, cap: usize) -> String { if s.len() <= cap { s.to_string() } else { format!("…{}", &s[s.len() - cap..]) } }

pub fn header_list(run: &Run, extra: Option<&Json>, actor: &str, vars: &BTreeMap<String, Json>, missing: &mut Vec<String>) -> Vec<(String, String)> {
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

pub fn http_step(run: &Run, conn: &mut Conn, step: &Json, vars: &mut BTreeMap<String, Json>, name: &str) -> Step {
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

pub fn static_step(run: &Run, step: &Json, vars: &BTreeMap<String, Json>, name: &str) -> Step {
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

pub fn cmd_step(run: &Run, step: &Json, vars: &BTreeMap<String, Json>, name: &str) -> Step {
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

    // Body assertions against stdout. A command with a `--json` flag should be
    // assertable the way a response is, rather than through `stdout_contains`
    // against a serialised object, which breaks on key order.
    //
    // The sub-block carries only body keys, so `status` and `max_ms` inside
    // `check` cannot fire a second time; `rc` and `max_ms` are the command's own
    // and were handled above. Kept in step with `src/cookbook/expect.js`, which
    // does exactly this — two engines that disagreed about what a corpus
    // asserts would produce a board that is green on one and red on the other.
    let body_keys: Vec<&str> = BODY_KEYS.iter().copied().filter(|k| expect.get(k).is_some()).collect();
    if !body_keys.is_empty() {
        let parsed = { let t = stdout.trim();
            if t.starts_with('{') || t.starts_with('[') { crate::json::parse(t).ok() } else { None } };
        match parsed {
            None => {
                n += body_keys.len();
                why.push(format!("stdout is not a JSON object or array, so {} could not be checked (add --json to the command?)", body_keys.join(", ")));
            }
            Some(body) => {
                let mut sub = Json::obj();
                for k in &body_keys { if let Some(v) = expect.get(k) { sub.set(k, v.clone()); } }
                let mut got = Json::obj();
                let (an, _) = asserts(&sub);
                n += an;
                why.extend(check(&sub, &body, rc as u16, ms, &mut got));
                if let Json::Obj(m) = &got { if !m.is_empty() { evidence.set("got", got.clone()); } }
            }
        }
    }
    if timed_out { why.push(format!("timed out after {:.0}s", run.timeout.as_secs_f64())); }
    if n == 0 && expect == Json::Null { n = 1; if rc != 0 { why.push(format!("rc {} and nothing was asserted; a bare `run` step expects 0", rc)); } }
    let state = if !why.is_empty() { "failed" } else if n == 0 { "empty" } else { "passed" };
    Step { name: name.into(), kind: "cmd", state: state.into(), status: Some(rc as u16), ms, why, request: cmd, evidence }
}

pub fn run_steps(run: &Run, conn: &mut Conn, steps: &[Json], vars: &mut BTreeMap<String, Json>) -> (Vec<Step>, Option<String>) {
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

pub fn conn_of(run: &Run) -> Conn { Conn::new(&run.host, run.port, run.timeout) }

pub fn scenario_json(sc: &Json, steps: Vec<Step>, seconds: f64) -> Json {
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
