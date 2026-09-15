//! simulate.rs — the situation simulator: the same request at rising levels of
//! concurrency, and what the service does as the level climbs.
//!
//! Latency budgets here are honest by construction. A profile never names a
//! millisecond figure, because a number written on one box is wrong on every
//! other one. It names a MULTIPLE of the floor this run measured, clamped, with
//! a slack floor under it so ordinary jitter is not reported as a regression.
//! `mainboard/thresholds` owns the multiple; the kernel just reports the floor
//! and the distribution it measured, and says how many requests it actually made.
use crate::http::{parse_url, Conn};
use crate::json::Json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    let idx = ((p * sorted.len() as f64).ceil() as usize).max(1) - 1;
    sorted[idx.min(sorted.len() - 1)]
}
fn round1(x: f64) -> f64 { (x * 10.0).round() / 10.0 }

pub fn op_simulate(input: &Json) -> Json {
    let mut out = Json::obj();
    let base = input.string("base", "");
    let url = match parse_url(&base) { Ok(u) => u, Err(e) => { out.set("ok", Json::Bool(false)); out.set("why", e.into()); return out; } };
    if url.scheme == "https" { out.set("ok", Json::Bool(false)); out.set("why", "the kernel speaks http only; simulate against a local base".into()); return out; }
    let req = input.get("request").cloned().unwrap_or_else(Json::obj);
    let method = req.string("method", "GET").to_uppercase();
    let path = { let p = req.string("path", "/"); if url.path.len() > 1 { format!("{}{}", url.path.trim_end_matches('/'), p) } else { p } };
    let headers: Vec<(String, String)> = match req.get("headers") {
        Some(Json::Obj(m)) => m.iter().map(|(k, v)| (k.clone(), match v { Json::Str(s) => s.clone(), other => other.to_string() })).collect(),
        _ => Vec::new(),
    };
    let body = req.get("body").map(|b| b.to_string());
    let timeout = Duration::from_millis(input.num("timeout_ms", 20000.0) as u64);
    let levels: Vec<Json> = input.get("levels").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
    let max_requests = input.num("max_requests", 20000.0) as usize;

    let mut rows: Vec<Json> = Vec::new();
    let mut floor = f64::INFINITY;
    for level in &levels {
        let concurrency = (level.num("concurrency", 1.0) as usize).clamp(1, 256);
        let seconds = level.num("seconds", 3.0).clamp(0.1, 600.0);
        let deadline = Instant::now() + Duration::from_secs_f64(seconds);
        let lat: Mutex<Vec<f64>> = Mutex::new(Vec::new());
        let errors = AtomicUsize::new(0);
        let non2xx = AtomicUsize::new(0);
        let made = AtomicUsize::new(0);
        let t0 = Instant::now();
        std::thread::scope(|scope| {
            for _ in 0..concurrency {
                scope.spawn(|| {
                    let mut conn = Conn::new(&url.host, url.port, timeout);
                    let mut mine: Vec<f64> = Vec::new();
                    while Instant::now() < deadline {
                        if made.fetch_add(1, Ordering::Relaxed) >= max_requests { break; }
                        match conn.request(&method, &path, &headers, body.as_deref()) {
                            Ok(r) => { mine.push(r.ms); if !(200..300).contains(&r.status) { non2xx.fetch_add(1, Ordering::Relaxed); } }
                            Err(_) => { errors.fetch_add(1, Ordering::Relaxed); conn.close(); }
                        }
                    }
                    lat.lock().unwrap_or_else(|e| e.into_inner()).extend(mine);
                });
            }
        });
        let mut xs = lat.into_inner().unwrap_or_else(|e| e.into_inner());
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let elapsed = t0.elapsed().as_secs_f64();
        let ok = xs.len();
        let err = errors.load(Ordering::Relaxed);
        let bad = non2xx.load(Ordering::Relaxed);
        if let Some(m) = xs.first() { if *m < floor { floor = *m; } }
        let mut r = Json::obj();
        r.set("concurrency", Json::Num(concurrency as f64));
        r.set("seconds", Json::Num(round1(elapsed)));
        r.set("requests", Json::Num((ok + err) as f64));
        r.set("errors", Json::Num(err as f64));
        r.set("non_2xx", Json::Num(bad as f64));
        r.set("error_pct", Json::Num(if ok + err == 0 { 0.0 } else { round1((err + bad) as f64 * 100.0 / (ok + err) as f64) }));
        r.set("rps", Json::Num(if elapsed > 0.0 { round1(ok as f64 / elapsed) } else { 0.0 }));
        r.set("min", Json::Num(round1(xs.first().copied().unwrap_or(0.0))));
        r.set("p50", Json::Num(round1(pct(&xs, 0.50))));
        r.set("p95", Json::Num(round1(pct(&xs, 0.95))));
        r.set("p99", Json::Num(round1(pct(&xs, 0.99))));
        r.set("max", Json::Num(round1(xs.last().copied().unwrap_or(0.0))));
        r.set("mean", Json::Num(round1(if ok == 0 { 0.0 } else { xs.iter().sum::<f64>() / ok as f64 })));
        rows.push(r);
    }
    out.set("ok", Json::Bool(true));
    out.set("engine", "kernel".into());
    out.set("base", base.into());
    out.set("request", format!("{} {}", method, path).into());
    out.set("floor_ms", if floor.is_finite() { Json::Num(round1(floor)) } else { Json::Null });
    out.set("levels", Json::Arr(rows));
    out
}

/// Is it up. One request per target, no retries, no pacing: the answer a status
/// line needs and nothing more.
pub fn op_probe(input: &Json) -> Json {
    let targets: Vec<Json> = input.get("targets").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
    let timeout = Duration::from_millis(input.num("timeout_ms", 3000.0) as u64);
    // `wait_ms` turns a probe into a READINESS GATE: keep asking until the
    // target answers or the deadline passes. A scenario run against a service
    // that has not finished booting is the most expensive kind of red board
    // there is — every step fails, every failure is filed, and a session pays
    // to read a board about nothing. Waiting here costs wall clock and no
    // tokens, so it is always the cheaper half of that trade.
    let wait = Duration::from_millis(input.num("wait_ms", 0.0).max(0.0) as u64);
    let gap = Duration::from_millis(input.num("gap_ms", 250.0).max(50.0) as u64);
    let results: Mutex<Vec<(usize, Json)>> = Mutex::new(Vec::new());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..targets.len().min(16).max(1) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(t) = targets.get(i) else { break };
                let deadline = std::time::Instant::now() + wait;
                let mut attempts = 0u32;
                let mut r;
                loop {
                    attempts += 1;
                    r = Json::obj();
                    r.set("name", t.string("name", "").into());
                    let u = t.string("url", "");
                    r.set("url", u.clone().into());
                    match parse_url(&u) {
                        Err(e) => { r.set("state", "error".into()); r.set("why", e.into()); }
                        Ok(url) if url.scheme == "https" => { r.set("state", "unknown".into()); r.set("why", "https: the kernel cannot probe TLS".into()); }
                        Ok(url) => {
                            let mut c = Conn::new(&url.host, url.port, timeout);
                            match c.request(&t.string("method", "GET").to_uppercase(), &url.path, &[], None) {
                                Ok(resp) => {
                                    r.set("state", (if (200..500).contains(&resp.status) { "up" } else { "degraded" }).into());
                                    r.set("status", Json::Num(resp.status as f64));
                                    r.set("ms", Json::Num(round1(resp.ms)));
                                }
                                Err(e) => { r.set("state", "down".into()); r.set("why", e.into()); }
                            }
                        }
                    }
                    // `error` is the URL itself being wrong and `unknown` is a
                    // scheme this kernel cannot read. Neither becomes true by
                    // waiting, so only a transport failure is retried.
                    let again = r.string("state", "") == "down" && std::time::Instant::now() + gap < deadline;
                    if !again { break; }
                    std::thread::sleep(gap);
                }
                if wait > Duration::from_millis(0) { r.set("attempts", Json::Num(attempts as f64)); }
                results.lock().unwrap_or_else(|e| e.into_inner()).push((i, r));
            });
        }
    });
    let mut rows = results.into_inner().unwrap_or_else(|e| e.into_inner());
    rows.sort_by_key(|(i, _)| *i);
    let mut out = Json::obj();
    out.set("targets", Json::Arr(rows.into_iter().map(|(_, v)| v).collect()));
    out
}
